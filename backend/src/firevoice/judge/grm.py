"""Stage `tournament` (runs in .envs/judge): SpeechJudge-GRM listening tournaments.

SpeechJudge-GRM (Zhang et al., ICLR 2026; CC-BY-NC-4.0) is Qwen2.5-Omni-7B fine-tuned on 99K human A/B naturalness
judgements of zero-shot TTS output, then refined with GRPO. Given the target text and two clips it reasons about
prosody and intonation, pacing and rhythm, articulation and clarity, and overall naturalness, then writes
"Output A: x, Output B: y" (1-10). The prompt below is the one it was trained with.

Each comparison group holds clips of the same text (gallery voices, designed voices, one style across voices, one
voice across knob settings...). Swiss-system rounds pair clips with similar records, so a few rounds rank a large
field; a Bradley-Terry fit over all results gives the arena rating. Every judgement (scores + written rationale)
is cached in judge/grm.jsonl, so re-runs only add what is missing.

    .envs/judge/Scripts/python.exe -m firevoice.judge.grm samples/voxcpm2 [--bits 8|4] [--orders 1|2] [--groups gallery,style:*]
"""
from __future__ import annotations

import argparse
import fnmatch
import hashlib
import json
import math
import random
import re
import sys
import time
from collections import defaultdict
from pathlib import Path

import torch

W = Path(__file__).resolve().parents[3] / ".envs" / "weights" / "speechjudge-grm"
SYSTEM = ("You are Qwen, a virtual human developed by the Qwen Team, Alibaba Group, capable of perceiving auditory and visual inputs, "
          "as well as generating text and speech.")


def conversation(text: str, wav_a: str, wav_b: str) -> list:
    return [
        {"role": "system", "content": [{"type": "text", "text": SYSTEM}]},
        {"role": "user", "content": [
            {"type": "text", "text": "We are comparing the naturalness of two Text-to-Speech models' outputs. The models need to generate the target text."},
            {"type": "text", "text": f"Target text: {text}"},
            {"type": "text", "text": "Output A:"},
            {"type": "audio", "audio": wav_a},
            {"type": "text", "text": "Output B:"},
            {"type": "audio", "audio": wav_b},
            {"type": "text", "text": "Analysis the two output above, and score them with number from 1 to 10."},
            {"type": "text", "text": "Note: (1) Please evaluate the naturalness of both audio outputs based on the following criteria: Prosody and Intonation, "
                                     "Pacing and Rhythm, Articulation and Clarity, and Overall Naturalness. (2) After conducting a detailed analysis of each "
                                     "criterion, using the following output template to highlight your conclusion: Output A: X, Output B: X."},
        ]},
    ]


def _load16k(path: str):
    import librosa
    import numpy as np
    import soundfile as sf
    a, sr = sf.read(path, dtype="float32", always_2d=False)
    if a.ndim > 1:
        a = a.mean(axis=1)
    if sr != 16000:
        a = librosa.resample(a, orig_sr=sr, target_sr=16000)
    return np.ascontiguousarray(a, dtype=np.float32)


def extract(text: str):
    m = re.findall(r"Output A: (\d+(?:\.\d+)?).*?Output B: (\d+(?:\.\d+)?)", text.replace("**", ""), re.DOTALL)
    return (float(m[-1][0]), float(m[-1][1])) if m else None


class Judge:
    def __init__(self, bits: int = 8):
        from transformers import BitsAndBytesConfig, Qwen2_5OmniProcessor, Qwen2_5OmniThinkerForConditionalGeneration
        skip = ["audio_tower", "visual", "lm_head"]
        q = (BitsAndBytesConfig(load_in_8bit=True, llm_int8_skip_modules=skip) if bits == 8 else
             BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type="nf4", bnb_4bit_compute_dtype=torch.bfloat16,
                                bnb_4bit_use_double_quant=True, llm_int8_skip_modules=skip) if bits == 4 else None)
        t0 = time.time()
        self.proc = Qwen2_5OmniProcessor.from_pretrained(str(W))
        if q is None:   # full precision does not fit 16 GB: keep what fits on the GPU, the rest in system RAM (slow)
            self.m = Qwen2_5OmniThinkerForConditionalGeneration.from_pretrained(
                str(W), torch_dtype=torch.bfloat16, device_map="auto", max_memory={0: "13GiB", "cpu": "48GiB"}, attn_implementation="sdpa").eval()
        else:
            self.m = Qwen2_5OmniThinkerForConditionalGeneration.from_pretrained(
                str(W), torch_dtype=torch.bfloat16, device_map="cuda:0", attn_implementation="sdpa", quantization_config=q).eval()
        print(f"[grm] loaded in {time.time() - t0:.0f}s ({bits}-bit), vram {torch.cuda.memory_allocated() / 1e9:.1f} GB", flush=True)
        self.proc.tokenizer.padding_side = "left"   # batched generation
        # the judge only listens: drop the vision encoder (~1.3 GB) so the batch has room (16 GB cards page otherwise)
        if getattr(self.m, "visual", None) is not None:
            self.m.visual = None
            torch.cuda.empty_cache()
        print(f"[grm] audio-only judge: vram {torch.cuda.memory_allocated() / 1e9:.1f} GB", flush=True)

    def compare(self, text: str, wav_a: str, wav_b: str, seed: int = 0) -> dict:
        return self.compare_many([(text, wav_a, wav_b)], seed)[0]

    @torch.inference_mode()
    def compare_many(self, jobs: list[tuple[str, str, str]], seed: int = 0) -> list[dict]:
        """Several comparisons in one batch: decoding is memory-bound, so 8 at once costs little more than one."""
        prompts, audios = [], []
        for text, wa, wb in jobs:
            pr = self.proc.apply_chat_template(conversation(text, wa, wb), add_generation_prompt=True, tokenize=False)
            prompts.append(pr[0] if isinstance(pr, list) else pr)
            audios += [_load16k(wa), _load16k(wb)]   # what qwen_omni_utils.process_mm_info does for audio paths
        inp = self.proc(text=prompts, audio=audios, images=None, videos=None, return_tensors="pt", padding=True, use_audio_in_video=False)
        inp = inp.to(self.m.device)
        if "input_features" in inp:
            inp["input_features"] = inp["input_features"].to(torch.bfloat16)
        n = inp["input_ids"].shape[1]
        torch.manual_seed(seed)
        t0 = time.time()
        ids = self.m.generate(**inp, use_audio_in_video=False, do_sample=True, max_new_tokens=1024, eos_token_id=[151645], pad_token_id=151643)
        outs = self.proc.batch_decode(ids[:, n:], skip_special_tokens=True, clean_up_tokenization_spaces=False)
        dt = round((time.time() - t0) / len(jobs), 2)
        return [{"scores": extract(o), "rationale": o, "seconds": dt, "tokens": int((ids[i, n:] != 151643).sum())} for i, o in enumerate(outs)]


# ------------------------------------------------------------------------------------------------ groups
def groups_from(clips: list[dict]) -> dict[str, list[dict]]:
    g: dict[str, list[dict]] = defaultdict(list)
    for c in clips:
        if not c["lang"].startswith("en"):
            continue   # the judge was trained on English and Chinese; other languages are ranked by the metric suite
        s = c["section"]
        if s == "gallery":
            g["gallery"].append(c)
        elif s == "design":
            g["design"].append(c)
        elif s == "styles":
            g[f"style:{c['style']}"].append(c)
        elif s == "clone_modes":
            g[f"clone:{c['voice']}"].append(c)
        elif s == "knobs":
            g[f"knobs:{c['voice']}"].append(c)
        elif s == "longform":
            g["longform"].append(c)
        elif s == "emotion":
            g[f"emotion:{c['variant']}"].append(c)   # same instruction, different voices: who performs it most naturally
    return dict(g)


def rounds_for(n: int) -> int:
    if n <= 2:
        return 1
    if n <= 5:
        return n - 1 if n % 2 == 0 else n   # round robin
    return min(8, max(4, math.ceil(math.log2(n)) + 1))


def bt_fit(players: list[str], results: list[tuple[str, str, float]], iters: int = 300) -> dict[str, float]:
    """Bradley-Terry by MM with one virtual draw against an average player (keeps unbeaten players finite)."""
    s = {p: 1.0 for p in players}
    wins = defaultdict(float)
    games = defaultdict(lambda: defaultdict(float))
    for a, b, ra in results:
        wins[a] += ra
        wins[b] += 1 - ra
        games[a][b] += 1
        games[b][a] += 1
    for _ in range(iters):
        new = {}
        for p in players:
            denom = sum(n / (s[p] + s[q]) for q, n in games[p].items()) + 1.0 / (s[p] + 1.0)
            new[p] = (wins[p] + 0.5) / denom
        gm = math.exp(sum(math.log(v) for v in new.values()) / len(new))
        s = {p: v / gm for p, v in new.items()}
    return {p: round(1500 + 400 * math.log10(v), 1) for p, v in s.items()}


def run(samples_dir: str, bits: int = 8, orders: int = 1, only: list[str] | None = None, max_groups: int = 0, batch: int = 8) -> int:
    jd = Path(samples_dir) / "judge"
    clips = json.loads((jd / "clips.json").read_text(encoding="utf-8"))["clips"]
    cache_f = jd / "grm.jsonl"
    cache: dict[str, dict] = {}
    if cache_f.exists():
        for line in cache_f.read_text(encoding="utf-8").splitlines():
            if line.strip():
                r = json.loads(line)
                cache[r["id"]] = r
    groups = groups_from(clips)
    if only:
        groups = {k: v for k, v in groups.items() if any(fnmatch.fnmatch(k, p) for p in only)}
    order = sorted(groups, key=lambda k: (k != "gallery", k != "design", not k.startswith("style:"), k))
    if max_groups:
        order = order[:max_groups]
    total = sum(sum(max(1, len(groups[k]) // 2) for _ in range(rounds_for(len(groups[k])))) for k in order)
    print(f"[grm] {len(order)} groups, about {total * orders} judgements ({len(cache)} cached)", flush=True)
    fh = open(cache_f, "a", encoding="utf-8")
    st_f = jd / "standings.json"
    standings = json.loads(st_f.read_text(encoding="utf-8")) if st_f.exists() else {}

    def jid_of(a: str, b: str, k: int) -> str:
        return hashlib.sha1(f"{a}|{b}|{k}".encode()).hexdigest()[:16]

    # per-group tournament state; round r of every group is judged together so batches stay full
    T = {}
    for gname in order:
        members = groups[gname]
        if len(members) < 2:
            continue
        players = [c["key"] for c in members]
        T[gname] = {"pid": {c["key"]: c for c in members}, "players": players, "rng": random.Random(int(hashlib.sha1(gname.encode()).hexdigest()[:8], 16)),
                    "pts": defaultdict(float), "met": set(), "results": [], "scores": defaultdict(list), "R": rounds_for(len(players)),
                    "all_pairs": [(players[i], players[j]) for i in range(len(players)) for j in range(i + 1, len(players))]}
    judge = None
    done_n = 0
    t0 = time.time()
    max_r = max((t["R"] for t in T.values()), default=0)
    for rnd in range(max_r):
        jobs = []   # (group, p, q, k, first, second)
        for gname, t in T.items():
            if rnd >= t["R"]:
                continue
            if len(t["players"]) <= 5:
                pairs = t["all_pairs"][rnd::t["R"]] if t["R"] > 1 else t["all_pairs"]
            else:
                ranking = sorted(t["players"], key=lambda p: (-t["pts"][p], t["rng"].random()))
                pairs, used = [], set()
                for i, p in enumerate(ranking):
                    if p in used:
                        continue
                    q = next((x for x in ranking[i + 1:] if x not in used and frozenset((p, x)) not in t["met"]), None)
                    if q is None:
                        q = next((x for x in ranking[i + 1:] if x not in used), None)
                    if q is None:
                        break
                    used.update((p, q))
                    pairs.append((p, q))
            for p, q in pairs:
                t["met"].add(frozenset((p, q)))
                for k in range(orders):
                    first, second = (p, q) if (t["rng"].random() < 0.5) ^ (k == 1) else (q, p)
                    jobs.append((gname, p, q, k, first, second))
        todo = [j for j in jobs if jid_of(j[4], j[5], j[3]) not in cache]
        for i in range(0, len(todo), batch):
            chunk = todo[i:i + batch]
            if judge is None:
                judge = Judge(bits)
            outs = judge.compare_many([(T[g]["pid"][f]["text"], T[g]["pid"][f]["file"], T[g]["pid"][sd]["file"]) for g, p, q, k, f, sd in chunk], seed=rnd * 1000 + i)
            for (g, p, q, k, f, sd), r in zip(chunk, outs):
                rec = {"id": jid_of(f, sd, k), "group": g, "a": f, "b": sd, "seed": k, **r}
                cache[rec["id"]] = rec
                fh.write(json.dumps(rec, ensure_ascii=False) + chr(10))
            fh.flush()
            done_n += len(chunk)
            el = time.time() - t0
            print(f"[grm] round {rnd + 1}/{max_r}  {done_n} judged this run  {el / 60:.1f} min  ({el / max(1, done_n):.1f} s each)", flush=True)
        # score the round
        agg = defaultdict(lambda: [0.0, 0.0, 0])
        for g, p, q, k, f, sd in jobs:
            r = cache.get(jid_of(f, sd, k))
            if not r or not r.get("scores"):
                continue
            s1, s2 = r["scores"]
            a = agg[(g, p, q)]
            if f == p:
                a[0] += s1; a[1] += s2
            else:
                a[0] += s2; a[1] += s1
            a[2] += 1
        for (g, p, q), (sa, sb, n_ok) in agg.items():
            t = T[g]
            sa, sb = sa / n_ok, sb / n_ok
            t["scores"][p].append(sa)
            t["scores"][q].append(sb)
            res = 1.0 if sa > sb else 0.0 if sa < sb else 0.5
            t["pts"][p] += res
            t["pts"][q] += 1 - res
            t["results"].append((p, q, res))
        for gname, t in T.items():
            rating = bt_fit(t["players"], t["results"])
            sc = t["scores"]
            standings[gname] = sorted(({"key": p, "rating": rating[p], "points": t["pts"][p], "games": len(sc[p]),
                                        "judge_score": round(sum(sc[p]) / len(sc[p]), 2) if sc[p] else None} for p in t["players"]),
                                      key=lambda x: -x["rating"])
        st_f.write_text(json.dumps(standings, indent=1), encoding="utf-8")
        print(f"[grm] round {rnd + 1}/{max_r} scored ({len(jobs)} judgements in the round)", flush=True)
    fh.close()
    print(f"[grm] done: {len(standings)} groups -> {jd / 'standings.json'}", flush=True)
    return 0


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("samples")
    ap.add_argument("--bits", type=int, default=8, choices=[4, 8, 16])
    ap.add_argument("--orders", type=int, default=1, choices=[1, 2], help="2 = judge each pair in both A/B orders (cancels position bias)")
    ap.add_argument("--groups", default=None, help="glob patterns, e.g. gallery,style:*")
    ap.add_argument("--max-groups", type=int, default=0)
    ap.add_argument("--batch", type=int, default=8, help="comparisons generated together (memory-bound decoding: more = faster)")
    a = ap.parse_args()
    sys.exit(run(a.samples, a.bits, a.orders, a.groups.split(",") if a.groups else None, a.max_groups, a.batch))
