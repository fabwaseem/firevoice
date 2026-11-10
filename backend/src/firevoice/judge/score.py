"""Stage `judge` (runs in .envs/judge): SpeechJudge naturalness score for every clip, one clip at a time.

Why not only pairwise tournaments: on this hardware (4-bit and bf16 alike) the pairwise prompt shows a strong
second-clip preference whenever two clips are close in quality: identical clips score 6 vs 9, and with VoxCPM2's
uniformly good output the order decided almost every match. Reversed speech and noise score 1, so the model does
listen; it simply cannot separate near-equal clips pairwise without bias.

The single-output prompt (SpeechJudge's own reward-model prompt, `build_rm_conversation` upstream) has no position
to be biased by. Instead of the sampled digit, the score is the probability-weighted mean over the answer digits
1-9 at the first answer token: a continuous naturalness estimate that keeps the small differences a single digit
would round away. Each clip is scored with its own target text.

    .envs/judge/Scripts/python.exe -m firevoice.judge.score samples/voxcpm2
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import torch

from .grm import SYSTEM, Judge, _load16k


def conversation(text: str, wav: str) -> list:
    return [{"role": "system", "content": [{"type": "text", "text": SYSTEM}]},
            {"role": "user", "content": [
                {"type": "text", "text": "We are evaluating the naturalness of Text-to-Speech model's output. The model need to generate a natural speech for the target text."},
                {"type": "text", "text": f"Target text: {text}"},
                {"type": "text", "text": "Output:"},
                {"type": "audio", "audio": wav},
                {"type": "text", "text": "Analysis the output above, and score it with number from 1 to 10. Note that: you only need to reply me a score (such as 7) and nothing else."}]}]


class Scorer:
    def __init__(self, bits: int = 4):
        self.j = Judge(bits)
        tok = self.j.proc.tokenizer
        self.digits = [tok.convert_tokens_to_ids(str(d)) for d in range(1, 10)]

    @torch.inference_mode()
    def score_many(self, items: list[tuple[str, str]]) -> list[dict]:
        prompts, audios = [], []
        for text, wav in items:
            pr = self.j.proc.apply_chat_template(conversation(text, wav), add_generation_prompt=True, tokenize=False)
            prompts.append(pr[0] if isinstance(pr, list) else pr)
            audios.append(_load16k(wav))
        inp = self.j.proc(text=prompts, audio=audios, images=None, videos=None, return_tensors="pt", padding=True, use_audio_in_video=False).to(self.j.m.device)
        inp["input_features"] = inp["input_features"].to(torch.bfloat16)
        logits = self.j.m(**inp).logits[:, -1].float()           # left padding: the last position is the answer slot
        p_all = torch.softmax(logits, dim=-1)
        out = []
        for i in range(len(items)):
            p = p_all[i, self.digits]
            mass = float(p.sum())
            p = p / p.sum()
            exp = float(sum((d + 1) * p[d] for d in range(9)))
            out.append({"judge": round(exp, 4), "judge_top": int(torch.argmax(p)) + 1, "judge_mass": round(mass, 3),
                        "judge_dist": [round(float(x), 3) for x in p]})
        return out


def run(samples_dir: str, bits: int = 4, batch: int = 2) -> int:
    jd = Path(samples_dir) / "judge"
    clips = json.loads((jd / "clips.json").read_text(encoding="utf-8"))["clips"]
    out = jd / "judge_scores.jsonl"
    done = set()
    if out.exists():
        done = {json.loads(l)["key"] for l in out.read_text(encoding="utf-8").splitlines() if l.strip()}
    todo = [c for c in clips if c["key"] not in done]
    print(f"[judge] {len(todo)} of {len(clips)} clips to score", flush=True)
    if not todo:
        return 0
    s = Scorer(bits)
    with open(out, "a", encoding="utf-8") as fh:
        for i in range(0, len(todo), batch):
            chunk = todo[i:i + batch]
            # long clips (70 s stories) go alone so a batch never pads everything to the longest
            if any((c.get("duration") or 0) > 30 for c in chunk) and len(chunk) > 1:
                res = [r for c in chunk for r in s.score_many([(c["text"], c["file"])])]
            else:
                res = s.score_many([(c["text"], c["file"]) for c in chunk])
            for c, r in zip(chunk, res):
                fh.write(json.dumps({"key": c["key"], **r}) + chr(10))
            fh.flush()
            torch.cuda.empty_cache()   # varied lengths: give cached blocks back so the driver never pages VRAM
            if (i // batch) % 10 == 0:
                print(f"[judge] {i + len(chunk)}/{len(todo)}  {chunk[-1]['key']}  {res[-1]['judge']:.2f}", flush=True)
    return 0


def main() -> int:
    return run(sys.argv[1], int(sys.argv[2]) if len(sys.argv) > 2 else 4, int(sys.argv[3]) if len(sys.argv) > 3 else 2)


if __name__ == "__main__":
    sys.exit(main())
