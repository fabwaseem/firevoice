"""text -> expressive, validated, polished speech with word timings, using every GPU worker at once.

Pipeline per request:
  parse markup -> normalise -> sentence chunks -> fan out ALL chunks x candidate takes to the engine pool
  -> as takes land, score them in parallel (GPU ASR agreement, speaking rate, stalls, clipping, stutters)
  -> chunks below the bar get extra takes (new seeds, then a calmer take) while the rest keep flowing
  -> best take per chunk -> level-match -> pace -> stitch with punctuation-aware, humanised pauses -> studio chain

The whole script is in flight at once, so a 3-worker pool on one GPU renders a 10-minute narration about
3x faster than the old one-sentence-at-a-time loop, and ASR scoring overlaps with generation instead of
serialising behind it.
"""
from __future__ import annotations

import difflib
import hashlib
import json
import re
import threading
import time
from concurrent.futures import Future, ThreadPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeout
from dataclasses import asdict, dataclass, field, replace
from pathlib import Path
from typing import Callable, Optional

import numpy as np
import soundfile as sf

from . import audio as A
from .asr import Aligner, NullAligner, match_score
from .core.adapters.base import TAG_RE, strip_tags
from .core.pool import EnginePool, Voice
from .frontend import make_chunks, normalize, parse
from .frontend.chunker import gap_after_ms
from .frontend.normalize import is_english_text
from .styles import Style, get_style
from .types import Cancelled, Pause, Result, Take, Word
from .voices import VoiceLibrary

WORD_RE = re.compile(r"[a-z0-9']+")


# bump when a change makes earlier cached takes wrong (2: VoxCPM2 clones from clip + transcript by default)
CACHE_REV = 2


def _speech_level_db(a: np.ndarray, sr: int) -> Optional[float]:
    """Speech level in dB as A.rms_match measures it (RMS of the louder 60% of 20 ms frames)."""
    frame = max(1, int(sr * 0.02))
    n = len(a) // frame
    if n < 3:
        return None
    rms = np.sqrt((a[: n * frame].reshape(n, frame) ** 2).mean(axis=1) + 1e-12)
    loud = np.sort(rms)[int(n * 0.4):]
    return float(20 * np.log10(max(float(np.sqrt(np.mean(loud ** 2))), 1e-6)))


def _seeded_jitter(seed: int, spread: float = 0.15) -> float:
    """Deterministic +-spread multiplier so pauses are not metronomic."""
    x = (seed * 2654435761) % 4294967296 / 4294967296
    return 1.0 + (x * 2 - 1) * spread


@dataclass
class _Cand:
    audio: np.ndarray
    words: list
    said: str
    score: float
    seed: int
    reasons: list


@dataclass
class _Chunk:
    index: int
    text: str
    style: Style
    pace: float
    seed: int
    takes: list = field(default_factory=list)   # _Cand
    attempts: int = 0
    pending: int = 0
    done: Future = field(default_factory=Future)
    cached: Optional[tuple] = None
    asr: bool = True          # validate takes with ASR (only meaningful for English text)
    # [pause]s generated through and cut in afterwards: (words of the chunk before the pause, milliseconds)
    cuts: list = field(default_factory=list)
    group: Optional[threading.Event] = None   # the render's cancel group (see EnginePool.submit)
    priority: int = 0
    streamed: bool = False    # pieces go to the listener while it renders (first passage of a stream); never retried
    parts: Optional[object] = None             # queue.Queue of streamed pieces


# Urdu takes pass the skeleton check from this similarity (an exact take scores about 0.95-1.0; another sentence ~0.3)
URDU_ACCEPT = 0.8


@dataclass
class _Sent:
    text: str
    style: Style
    pace: float
    english: bool


@dataclass
class Stats:
    chunks: int = 0
    takes: int = 0
    cache_hits: int = 0
    retries: int = 0
    gen_seconds: float = 0.0      # summed worker busy time
    asr_seconds: float = 0.0
    wall_seconds: float = 0.0
    audio_seconds: float = 0.0

    @property
    def rtf(self) -> Optional[float]:
        return round(self.wall_seconds / self.audio_seconds, 3) if self.audio_seconds else None


class Synthesizer:
    def __init__(
        self,
        engine: str | EnginePool = "chatterbox-turbo",
        aligner: Optional[Aligner] = None,
        voices: Optional[VoiceLibrary] = None,
        lexicon: Optional[dict[str, str]] = None,
        *,
        workers: Optional[int] = None,
        accept: float = 0.9,
        max_attempts: int = 4,
        candidates: int = 1,
        cache_dir: Optional[str | Path] = None,
        score_threads: int = 3,
    ):
        self.pool = engine if isinstance(engine, EnginePool) else EnginePool(engine, workers=workers)
        self.aligner = aligner
        self.voices = voices or VoiceLibrary()
        self.lexicon = lexicon
        self.accept = accept
        self.max_attempts = max_attempts
        self.candidates = max(1, candidates)
        self.cache_dir = Path(cache_dir) if cache_dir else None
        self.cache_hits = 0
        self.cache_misses = 0
        self._lex_key = hashlib.sha1(json.dumps(sorted((lexicon or {}).items())).encode("utf-8")).hexdigest()[:12]
        self._scorers = ThreadPoolExecutor(max_workers=max(1, score_threads), thread_name_prefix="score")
        self._lock = threading.Lock()

    # keep the old attribute name used by the server/batch code
    @property
    def engine(self):
        return self.pool

    @property
    def sr(self) -> int:
        if not self.pool.started:
            self.pool.start()
        return self.pool.sr

    @property
    def validating(self) -> bool:
        return bool(self.aligner is not None and getattr(self.aligner, "validating", False))

    def close(self) -> None:
        self.pool.stop()
        self._scorers.shutdown(wait=False)

    # ------------------------------------------------------------------ cache
    def _cache_key(self, text: str, style: Style, pace: float, seed: int, voice_key: str) -> str:
        parts = {"engine": self.pool.spec.name, "voice": voice_key, "style": asdict(style), "text": text, "pace": round(float(pace), 4), "seed": int(seed),
                 "candidates": self.candidates, "accept": self.accept, "asr": getattr(self.aligner, "model_name", "none") if self.aligner is not None else "none",
                 "validating": self.validating, "lexicon": self._lex_key, "rev": CACHE_REV}
        return hashlib.sha1(json.dumps(parts, sort_keys=True, default=str).encode("utf-8")).hexdigest()

    def _cache_paths(self, key: str) -> tuple[Path, Path]:
        d = self.cache_dir / key[:2]
        return d / f"{key}.wav", d / f"{key}.json"

    def _cache_get(self, key: str) -> Optional[tuple[np.ndarray, list, Take]]:
        wav, meta = self._cache_paths(key)
        if not (wav.exists() and meta.exists()):
            return None
        try:
            m = json.loads(meta.read_text(encoding="utf-8"))
            a, sr = sf.read(str(wav), dtype="float32", always_2d=False)
            if sr != self.sr:
                return None
            words = [Word(w["text"], float(w["start"]), float(w["end"])) for w in m["words"]]
            return np.asarray(a, dtype=np.float32), words, Take(**{**m["take"], "cached": True})
        except Exception:
            return None

    def _cache_put(self, key: str, a: np.ndarray, words: list, take: Take) -> None:
        wav, meta = self._cache_paths(key)
        wav.parent.mkdir(parents=True, exist_ok=True)
        tmp = wav.with_suffix(".tmp.wav")
        sf.write(str(tmp), a, self.sr, subtype="FLOAT")
        tmp.replace(wav)
        t = asdict(take)
        t["cached"] = False
        meta.write_text(json.dumps({"words": [asdict(w) for w in words], "take": t, "sr": self.sr}, indent=0), encoding="utf-8")

    @staticmethod
    def _file_key(path: Optional[str]) -> str:
        if not path:
            return "default"
        try:
            return hashlib.sha1(Path(path).read_bytes()).hexdigest()[:16]
        except Exception:
            return str(path)

    # ------------------------------------------------------------------ scoring
    def _score(self, a: np.ndarray, text: str, asr: bool = True) -> tuple[float, str, list, list]:
        """Quality of one take in 0..1 with the reasons it lost points. `asr=False` (non-English text) keeps the
        signal checks but skips the English-only ASR agreement and estimates word times instead."""
        sr = self.sr
        reasons: list[str] = []
        plain = strip_tags(text)
        nwords = max(1, len(WORD_RE.findall(plain.lower())))
        dur = len(a) / sr
        if dur < 0.12:
            return 0.0, "", [], ["empty"]
        words: list = []
        said = ""
        score = 1.0
        if not asr:
            words = NullAligner().transcribe(a, sr, plain)
            said = plain
        elif asr == "ur" and self.aligner is not None and self.validating:
            # Roman Urdu script against what Whisper hears in Urdu script, compared as consonant skeletons
            from . import urdu
            heard = self.aligner.transcribe(a, sr, language="ur")
            script = " ".join(w.text for w in heard)
            words = [Word(urdu.to_roman(w.text), w.start, w.end) for w in heard]
            said = urdu.to_roman(script)
            m = urdu.match(plain, script)
            score *= m
            if m < min(self.accept, URDU_ACCEPT):
                reasons.append(f"asr-ur {m:.2f}")
        elif asr == "ur":
            words = NullAligner().transcribe(a, sr, plain)
            said = plain
        elif self.aligner is not None:
            words = self.aligner.transcribe(a, sr) if self.validating else self.aligner.transcribe(a, sr, plain)
            said = " ".join(w.text for w in words)
            if self.validating:
                m = match_score(plain, said)
                score *= m
                if m < self.accept:
                    reasons.append(f"asr {m:.2f}")
                toks = WORD_RE.findall(said.lower())
                asked = WORD_RE.findall(plain.lower())
                rep = sum(1 for i in range(1, len(toks)) if toks[i] == toks[i - 1]) - sum(1 for i in range(1, len(asked)) if asked[i] == asked[i - 1])
                if rep > 0:
                    score *= 0.7
                    reasons.append("repeat")
        wps = nwords / dur
        if nwords >= 3 and (wps > 5.2 or wps < 1.4):
            score *= 0.5
            reasons.append(f"rate {wps:.1f}")
        frame = max(1, int(sr * 0.02))
        n = len(a) // frame
        if n > 10:
            rms = np.sqrt((a[: n * frame].reshape(n, frame) ** 2).mean(axis=1) + 1e-12)
            quiet = rms < rms.max() * 0.02
            run, longest = 0, 0
            for q in quiet[5:-5]:
                run = run + 1 if q else 0
                longest = max(longest, run)
            if longest * 0.02 > 0.8:
                score *= 0.75
                reasons.append(f"gap {longest * 0.02:.1f}s")
        if float(np.mean(np.abs(a) > 0.98)) > 0.002:
            score *= 0.8
            reasons.append("clip")
        return float(score), said, words, reasons

    # ------------------------------------------------------------------ scheduling
    def _launch(self, ch: _Chunk, voice: Optional[Voice], style: Style, seed: int, stats: Stats) -> None:
        """Submit one take for a chunk; when it lands, score it off-thread and decide whether more are needed."""
        if ch.group is not None and ch.group.is_set():
            if ch.pending == 0 and not ch.done.done():
                ch.done.set_exception(Cancelled("render cancelled"))
            return
        ch.pending += 1
        ch.attempts += 1
        stats.takes += 1
        fut = self.pool.submit(ch.text, voice, style.params(), seed, priority=ch.priority, group=ch.group,
                               on_part=ch.parts.put if ch.streamed and ch.attempts == 1 else None)

        def on_done(f: Future):
            def work():
                try:
                    raw = f.result()
                    a = raw if ch.streamed else A.trim_silence(raw, self.sr)
                    t0 = time.perf_counter()
                    score, said, words, reasons = self._score(a, ch.text, ch.asr)
                    stats.asr_seconds += time.perf_counter() - t0
                    cand = _Cand(a, words, said, score, seed, reasons)
                except Exception as e:  # a failed take is a zero-score candidate, never a crash of the request
                    cand = _Cand(np.zeros(0, np.float32), [], "", 0.0, seed, [f"error {str(e)[:80]}"])
                with self._lock:
                    ch.takes.append(cand)
                    ch.pending -= 1
                    self._decide(ch, voice, style, stats)
            self._scorers.submit(work)

        fut.add_done_callback(on_done)

    def _good(self, c: _Cand) -> bool:
        return c.score >= self.accept and not any(r.startswith(("rate", "gap", "repeat", "error", "empty")) for r in c.reasons)

    def _decide(self, ch: _Chunk, voice: Optional[Voice], style: Style, stats: Stats) -> None:
        """Called under the lock each time a take lands."""
        if ch.done.done() or ch.pending > 0:
            return  # wait until every in-flight take for this chunk is scored
        if ch.streamed and ch.takes:
            ch.done.set_result(ch.takes[0])   # already heard: no second take could replace it
            return
        good = [c for c in ch.takes if self._good(c)]
        if good and ch.attempts >= self.candidates:
            ch.done.set_result(max(good, key=lambda c: c.score))
            return
        if ch.attempts < self.max_attempts:
            stats.retries += 1
            self._launch(ch, voice, style, ch.seed + ch.attempts * 7919, stats)
            return
        if ch.attempts == self.max_attempts and self.validating and not good:
            # last resort: a calmer, more literal take often fixes a stumble on digits or lists
            stats.retries += 1
            calm = replace(style, temperature=min(style.temperature, 0.5), cfg=max(style.cfg, 2.2))
            self._launch(ch, voice, calm, ch.seed + 99991, stats)
            return
        best = max(ch.takes, key=lambda c: c.score) if ch.takes else _Cand(np.zeros(0, np.float32), [], "", 0.0, ch.seed, ["none"])
        ch.done.set_result(best)

    # ------------------------------------------------------------------ planning
    def _plan(self, items: list, base_style: Style, custom_style: Optional[Style], lang: Optional[str], seed: int, caps: dict,
              stream_first: bool = False, rules: Optional[list] = None) -> tuple[list, list]:
        """-> (chunks, plan): plan is Pause | [chunk, gap_ms] in order.

        Every separate generation re-imagines the delivery a little, so each seam is a place where the voice can change.
        Engines that hold a voice well over a passage (caps["passage_chars"] > 0) get consecutive sentences of the same
        style and pace packed into one generation, and a [pause] between two such passages is generated through and cut in
        afterwards at the word boundary (`_apply_cuts`). That needs the take's word timings, so it is only done for English
        text when an aligner is loaded; otherwise a pause still splits the script, as do style and pace changes."""
        budget = int(caps.get("passage_chars") or 0)
        bridge = budget > 0 and self.aligner is not None
        units: list = []
        for it in items:
            if isinstance(it, Pause):
                units.append(it)
                continue
            # the request's own style, unless the script switched style ([style horror], [whisper], ...). A switched-to
            # style keeps the request's engine settings (params) so the engine stays configured the same way.
            if custom_style is not None and it.style == "custom":
                st = custom_style
            else:
                try:
                    st = get_style(it.style)
                except KeyError:
                    raise ValueError(f"unknown style {it.style!r} in the script")
                if custom_style is not None:
                    st = replace(st, extra={**st.extra, **custom_style.extra})
            english = is_english_text(it.text, lang)
            spoken = normalize(it.text, self.lexicon, lang, spell_acronyms=caps.get("spell_acronyms", True), rules=rules)
            if not caps.get("supports_tags", False):
                spoken = strip_tags(spoken)
            # how a take is checked: English word match, the Urdu skeleton check, or signal checks only
            check = english or ("ur" if (lang or "").lower().startswith("ur") else False)
            units += [_Sent(s, st, it.pace, check) for s in make_chunks(spoken)]

        chunks: list[_Chunk] = []
        plan: list = []
        cur: Optional[dict] = None
        held: list = []      # pauses that may still be generated through

        def close() -> None:
            nonlocal cur
            if cur is None:
                return
            ch = _Chunk(index=len(chunks), text=" ".join(cur["sents"]), style=cur["style"], pace=cur["pace"],
                        seed=seed + len(chunks) * 101, asr=cur["english"], cuts=cur["cuts"])
            chunks.append(ch)
            plan.append([ch, 0])
            cur = None

        for u in units:
            if isinstance(u, Pause):
                # a streamed first passage is heard as it renders, so a pause cannot be cut into it afterwards
                if cur is not None and bridge and cur["english"] is True and u.ms <= 3000 and not (stream_first and not chunks):
                    held.append(u)
                else:
                    close()
                    plan.extend(held + [u])
                    held = []
                continue
            fits = (cur is not None and budget > 0 and cur["style"] == u.style and cur["pace"] == u.pace and cur["english"] == u.english
                    and len(" ".join(cur["sents"])) + 1 + len(u.text) <= budget)
            if fits and held:
                prev = cur["sents"][-1]
                if not re.search(r"""[.!?,;:\u2026]['")\]]*$""", prev):
                    cur["sents"][-1] = prev + ","          # a pause reads as a phrase end, not a run-on
                nwords = len(WORD_RE.findall(strip_tags(" ".join(cur["sents"])).lower()))
                cur["cuts"].append((nwords, sum(p.ms for p in held)))
                held = []
            if fits:
                cur["sents"].append(u.text)
            else:
                close()
                plan.extend(held)
                held = []
                cur = {"sents": [u.text], "style": u.style, "pace": u.pace, "english": u.english, "cuts": []}
        close()
        plan.extend(held)

        # natural silence between chunks that follow each other directly (a [pause] replaces it)
        for i, item in enumerate(plan):
            if isinstance(item, Pause) or i + 1 >= len(plan) or isinstance(plan[i + 1], Pause):
                continue
            ch, nxt = item[0], plan[i + 1][0]
            breath = 1.0 + min(0.25, len(nxt.text.split()) / 80.0)
            item[1] = int(gap_after_ms(ch.text) * ch.style.pause * breath * _seeded_jitter(seed + ch.index + 1) / max(0.7, ch.pace))
        return chunks, plan

    def _apply_cuts(self, a: np.ndarray, words: list, ch: _Chunk) -> tuple:
        """Put the [pause]s of a generated-through passage in place: find each boundary in the take's word timings,
        replace the natural gap there with exactly the requested silence (short fades either side), shift later words."""
        if not ch.cuts or not len(a):
            return a, words
        sr = self.sr
        dur = len(a) / sr
        text_toks = WORD_RE.findall(strip_tags(ch.text).lower())
        heard, owner = [], []
        for i, w in enumerate(words):
            for tok in WORD_RE.findall(str(w.text).lower()):
                heard.append(tok)
                owner.append(i)
        tmap: dict = {}
        for blk in difflib.SequenceMatcher(None, text_toks, heard, autojunk=False).get_matching_blocks():
            for k in range(blk.size):
                tmap.setdefault(blk.a + k, owner[blk.b + k])
        # The boundary is found in the audio itself: ASR word times are only a guide (Whisper often ends the last word of
        # a sentence 100-200 ms early, and cutting there clips its tail). Inside a window around the guessed boundary we
        # take the longest stretch that is really quiet (40 dB under the take's peak) and cut inside it.
        frame = max(1, int(sr * 0.01))
        nfr = len(a) // frame
        level = 20 * np.log10(np.sqrt((a[: nfr * frame].reshape(nfr, frame) ** 2).mean(axis=1)) + 1e-9) if nfr else np.zeros(0)
        quiet = level < (level.max() - 40.0 if nfr else 0)
        regions: list = []
        last_end = 0.0
        for widx, ms in ch.cuts:
            k = next((tmap[j] for j in range(widx, len(text_toks)) if j in tmap), None)
            if k is not None and 0 < k < len(words):
                lo, hi = float(words[k - 1].start), float(words[k].start) + 0.15
            else:                                   # boundary not heard: estimate it from the word count
                est = dur * widx / max(1, len(text_toks))
                lo, hi = est - 0.5, est + 0.5
            f0, f1 = max(int(lo * 100), int(last_end * 100)), min(nfr, int(hi * 100))
            best, run, best_end = 0, 0, f0
            for i in range(f0, f1):
                run = run + 1 if quiet[i] else 0
                if run > best:
                    best, best_end = run, i + 1
            if best >= 6:                            # a real gap: keep 30 ms of natural decay and 20 ms before the onset
                g0, g1 = (best_end - best) * 0.01, best_end * 0.01
                r0, r1 = g0 + min(0.03, (g1 - g0) / 3), g1 - min(0.02, (g1 - g0) / 3)
            elif f1 > f0:                            # words run together: cut at the quietest 10 ms in the window
                c = (f0 + int(np.argmin(level[f0:f1]))) * 0.01 + 0.005
                r0 = r1 = c
            else:
                r0 = r1 = max(0.0, min(dur, (lo + hi) / 2))
            r0 = max(r0, last_end)
            r1 = max(r1, r0)
            if r0 >= dur:
                continue
            regions.append((r0, min(r1, dur), ms))
            last_end = r1
        if not regions:
            return a, words
        ramp = max(1, int(sr * 0.012))
        parts, pos = [], 0
        for r0, r1, ms in regions:
            seg = a[pos: int(r0 * sr)].copy()
            if len(seg) > ramp:
                seg[-ramp:] *= np.linspace(1.0, 0.0, ramp, dtype=np.float32)
            parts += [seg, A.silence(ms, sr)]
            pos = int(r1 * sr)
        tail = a[pos:].copy()
        if len(tail) > ramp:
            tail[:ramp] *= np.linspace(0.0, 1.0, ramp, dtype=np.float32)
        parts.append(tail)

        def moved(t: float) -> float:
            return t + sum(ms / 1000.0 - (r1 - r0) for r0, r1, ms in regions if r1 <= t + 1e-6)
        return np.concatenate(parts).astype(np.float32), [Word(w.text, moved(w.start), moved(w.end)) for w in words]

    # ------------------------------------------------------------------ main
    def speak(
        self,
        text: str,
        *,
        voice: str = "default",
        style: str = "conversational",
        pace: float = 1.0,
        seed: int = 1234,
        lufs: Optional[float] = -16.0,
        custom_style: Optional[Style] = None,
        lead_ms: int = 120,
        tail_ms: int = 280,
        lang: Optional[str] = None,
        on_chunk: Optional[Callable[[dict], None]] = None,
        cancel: Optional[threading.Event] = None,
        priority: int = 0,
        rules: Optional[list] = None,
        keep_takes: bool = False,
    ) -> Result:
        """`lang` (e.g. "en", "ur", "hi") picks text normalisation and whether takes are ASR-validated; when omitted
        it is guessed from the script (non-Latin text is read as-is and checked only for signal problems).

        `on_chunk` (streaming / progress): called in order as soon as each sentence chunk and everything before it is
        final, with {"index", "total", "audio", "sr", "start", "words", "text"}; the audio covers the timeline since the
        previous call (pauses included), loudness-matched but before the final studio chain. `cancel`: an Event; when
        set, the render stops within a fraction of a second with `Cancelled`, and its generations still waiting for the
        GPU are dropped. `priority`: 0 for renders someone is waiting on, 1 for background jobs (they yield the GPU)."""
        if not self.pool.started:
            self.pool.start()          # boot is not part of the request's wall time
        t_start = time.perf_counter()
        stats = Stats()
        base_style = custom_style or get_style(style)
        items = parse(text, base_style.name if custom_style is None else "custom", pace)
        sr = self.sr
        caps = self.pool.caps
        res = Result(audio=np.zeros(0, np.float32), sr=sr, voice=voice)

        pool_voice, voice_key = self._voice(voice, base_style.name)

        # 1) plan every chunk
        stream_first = on_chunk is not None and bool(caps.get("streaming"))
        chunks, plan = self._plan(items, base_style, custom_style, lang, seed, caps, stream_first=stream_first, rules=rules)
        stats.chunks = len(chunks)
        if stream_first and chunks:
            import queue as _q
            chunks[0].streamed, chunks[0].parts = True, _q.Queue()
        group = threading.Event()
        for ch in chunks:
            ch.group, ch.priority = group, priority
            # a passage in the request's own style is re-taken with that style; a [style x] passage with style x
            ch.style_key = "request" if ch.style is base_style else ch.style.name
        try:
            return self._render(chunks, plan, res, stats, voice_key, pool_voice, sr, lead_ms, tail_ms, lufs, on_chunk, cancel, t_start, keep_takes)
        finally:
            group.set()      # finished, failed or abandoned: whatever is still queued for this render is dropped

    def _play_stream(self, ch, parts, t, emitted, emit_t, sr, total, on_chunk, cancel, res, stats):
        """Hand the pieces of a streamed passage to `on_chunk` as they decode, then record its words and take.
        One gain is set from the first half second (so the level does not pump) and kept for the whole passage."""
        import queue as _q
        ch.stream_t0 = t
        got: list = []
        gain = None
        pending: list = []
        rate = ch.pace * ch.style.pace
        tempo = A.StreamTempo(sr, rate) if abs(rate - 1.0) >= 0.01 else None
        raw_n = 0
        finished = False
        try:
            while not finished:
                try:
                    piece = ch.parts.get(timeout=0.05)
                except _q.Empty:
                    if not (ch.done.done() and ch.parts.empty()):
                        if cancel is not None and cancel.is_set():
                            raise Cancelled("render cancelled")
                        continue
                    finished = True
                    piece = None
                if piece is not None:
                    raw_n += len(piece)
                if tempo is not None:
                    if piece is not None:
                        tempo.push(piece)
                    piece = tempo.close() if finished else tempo.pull()
                if piece is None or not len(piece):
                    if not finished:
                        continue
                    piece = np.zeros(0, np.float32)
                pending.append(piece)
                if gain is None:
                    if sum(len(x) for x in pending) < int(sr * 0.5) and not finished:
                        continue
                    probe = np.concatenate(pending)
                    lvl = _speech_level_db(probe, sr)
                    gain = float(min(2.5, max(0.25, 10 ** ((-20.0 - lvl) / 20)))) if lvl is not None else 1.0
                for x in pending:
                    if not len(x):
                        continue
                    y = A.soft_limit(x * gain)
                    got.append(y)
                    parts.append(y)
                    t += len(y) / sr
                pending = []
                if on_chunk is not None and len(parts) > emitted:
                    on_chunk({"index": ch.index, "total": total, "audio": np.concatenate(parts[emitted:]).astype(np.float32), "sr": sr,
                              "start": round(emit_t, 3), "words": [], "text": "", "partial": True})
                    emitted, emit_t = len(parts), t
        finally:
            if tempo is not None and not finished:
                tempo.kill()
        if pending:      # a very short passage: everything arrived before the gain was set
            probe = np.concatenate(pending)
            lvl = _speech_level_db(probe, sr)
            gain = float(min(2.5, max(0.25, 10 ** ((-20.0 - lvl) / 20)))) if lvl is not None else 1.0
            for x in pending:
                y = A.soft_limit(x * gain)
                got.append(y)
                parts.append(y)
                t += len(y) / sr
            if on_chunk is not None:
                on_chunk({"index": ch.index, "total": total, "audio": np.concatenate(parts[emitted:]).astype(np.float32), "sr": sr,
                          "start": round(emit_t, 3), "words": [], "text": "", "partial": True})
                emitted, emit_t = len(parts), t
        best: _Cand = self._wait(ch.done, cancel)
        a = np.concatenate(got) if got else np.zeros(0, np.float32)
        factor = len(a) / max(1, raw_n) if raw_n else 1.0       # word times were measured on the take before the tempo change
        for w in best.words:
            res.words.append(Word(w.text, ch.stream_t0 + w.start * factor, ch.stream_t0 + w.end * factor))
        take = Take(text=ch.text, spoken=best.said, seed=best.seed, score=round(best.score, 3), attempts=1, duration=len(a) / sr,
                    validated=self.validating and best.score >= self.accept)
        res.takes.append(take)
        if not take.validated and self.validating:
            res.warnings.append(f"low-confidence take ({take.score}), streamed so it was not retried: {ch.text[:60]!r}")
        if not len(a):
            res.warnings.append(f"no audio for: {ch.text[:60]!r}")
        return t, emitted, emit_t, _speech_level_db(a, sr) if len(a) else None

    def _voice(self, voice: str, style_name: str) -> tuple:
        """-> (pool Voice, cache key). A registered clip, the library default, or a designed voice (description only);
        a voice may carry per-style reference clips (a whispered take for horror/asmr, a bright one for excited)."""
        caps = self.pool.caps
        v = self.voices.resolve(voice, needs_reference=caps.get("needs_reference", True), engine=self.pool.spec.name, style=style_name)
        voice_key = self._file_key(v.get("ref")) if v.get("ref") else hashlib.sha1((v.get("desc") or v["voice_id"]).encode()).hexdigest()[:16]
        # workers cache conditioning by id: fingerprint the clip and transcript so an edited voice is prepared afresh
        fp = hashlib.sha1(f"{voice_key}|{v.get('ref_text') or ''}|{v.get('desc') or ''}".encode()).hexdigest()[:8]
        pool_voice = Voice(f"{v['voice_id']}#{fp}", ref=v.get("ref"), ref_text=v.get("ref_text"), desc=v.get("desc"))
        self.pool.prepare_voice(pool_voice)
        return pool_voice, f"{voice_key}#{fp}"   # cached takes depend on the transcript too (it switches the cloning mode)

    def _finish(self, cand: "_Cand", ch: "_Chunk", stream_level: Optional[float]) -> tuple:
        """A raw take as it is heard: pace, level, fade, then any [pause] cut in. -> (audio, words relative to it)."""
        sr = self.sr
        a = A.change_tempo(cand.audio, sr, ch.pace * ch.style.pace) if len(cand.audio) else cand.audio
        a = A.rms_match(a, sr, target_db=stream_level) if stream_level is not None else A.rms_match(a, sr)
        a = A.fade(a, sr)
        factor = len(a) / max(1, len(cand.audio))
        words = [Word(w.text, w.start * factor, w.end * factor) for w in cand.words]
        return self._apply_cuts(a, words, ch)

    @staticmethod
    def _chunk_record(ch: "_Chunk", takes: list, chosen: int) -> dict:
        return {"index": ch.index, "text": ch.text, "style": getattr(ch, "style_key", "request"), "pace": ch.pace, "seed": ch.seed,
                "cuts": [list(c) for c in ch.cuts], "asr": ch.asr, "takes": takes, "chosen": chosen}

    def _take_record(self, cand: "_Cand", audio: np.ndarray, words: list) -> dict:
        return {"audio": audio, "words": [Word(w.text, w.start, w.end) for w in words], "said": cand.said, "score": round(float(cand.score), 3),
                "reasons": list(cand.reasons), "seed": int(cand.seed), "validated": bool(self.validating and cand.score >= self.accept)}

    def retake(self, text: str, *, voice: str, style: Style, pace: float = 1.0, seed: int = 1234, cuts: Optional[list] = None,
               asr: bool = True, priority: int = 0, cancel: Optional[threading.Event] = None) -> dict:
        """One new take of one passage (already normalised text, as stored with a kept render): generated, checked and
        finished exactly like the passages of a full render. -> take record (see _take_record)."""
        if not self.pool.started:
            self.pool.start()
        pool_voice, _ = self._voice(voice, style.name)
        ch = _Chunk(index=0, text=text, style=style, pace=pace, seed=seed, asr=asr, cuts=list(cuts or []))
        ch.group, ch.priority = threading.Event(), priority
        stats = Stats()
        try:
            with self._lock:
                for k in range(self.candidates):
                    self._launch(ch, pool_voice, style, seed + k * 7919, stats)
            best: _Cand = self._wait(ch.done, cancel)
        finally:
            ch.group.set()
        a, words = self._finish(best, ch, None)
        return self._take_record(best, a, words)

    def _wait(self, fut: Future, cancel: Optional[threading.Event]):
        """Future.result() that notices a cancel request within 0.2 s instead of waiting for the GPU."""
        while True:
            try:
                return fut.result(timeout=0.2)
            except FutureTimeout:
                if cancel is not None and cancel.is_set():
                    raise Cancelled("render cancelled")

    def _render(self, chunks, plan, res, stats, voice_key, pool_voice, sr, lead_ms, tail_ms, lufs, on_chunk, cancel, t_start, keep_takes=False) -> Result:
        if keep_takes:
            res.plan = [{"pause": it.ms} if isinstance(it, Pause) else {"chunk": it[0].index, "gap": int(it[1])} for it in plan]

        # 2) fan out: cache first, then `candidates` takes per chunk, all at once
        with self._lock:
            for ch in chunks:
                key = self._cache_key(ch.text, ch.style, ch.pace, ch.seed, voice_key) if self.cache_dir else None
                if key:
                    hit = self._cache_get(key)
                    if hit is not None:
                        self.cache_hits += 1
                        stats.cache_hits += 1
                        ch.cached = hit
                        ch.done.set_result(None)
                        continue
                    self.cache_misses += 1
                ch._key = key  # type: ignore[attr-defined]
                for k in range(1 if ch.streamed else self.candidates):
                    self._launch(ch, pool_voice, ch.style, ch.seed + k * 7919, stats)

        # 3) gather in order, finish each take, stitch
        stream_level: Optional[float] = None    # later passages match the level of a streamed first passage
        parts: list[np.ndarray] = [A.silence(lead_ms, sr)]
        t = lead_ms / 1000.0
        emitted = 0          # parts already handed to on_chunk
        emit_t = 0.0
        done_chunks = 0
        for item in plan:
            if cancel is not None and cancel.is_set():
                raise Cancelled("render cancelled")
            if isinstance(item, Pause):
                parts.append(A.silence(item.ms, sr))
                t += item.ms / 1000.0
                continue
            ch, gap = item
            if ch.streamed and ch.cached is None:
                n0 = len(parts)
                t, emitted, emit_t, level = self._play_stream(ch, parts, t, emitted, emit_t, sr, len(chunks), on_chunk, cancel, res, stats)
                if keep_takes:
                    heard = np.concatenate(parts[n0:]).astype(np.float32) if len(parts) > n0 else np.zeros(0, np.float32)
                    best_s: _Cand = ch.done.result()
                    t0s = ch.stream_t0
                    rel = [Word(w.text, w.start - t0s, w.end - t0s) for w in res.words if w.start >= t0s - 1e-6]
                    res.chunks.append(self._chunk_record(ch, [self._take_record(best_s, heard, rel)], 0))
                # later passages match the streamed one, within a sane band (a quiet opening can leave it a bit hot)
                stream_level = None if level is None else min(-18.0, max(-26.0, level))
                if gap:
                    parts.append(A.silence(gap, sr))
                    t += gap / 1000.0
                done_chunks += 1
                if on_chunk is not None:
                    seg = np.concatenate(parts[emitted:]).astype(np.float32) if len(parts) > emitted else np.zeros(0, np.float32)
                    on_chunk({"index": ch.index, "total": len(chunks), "audio": seg, "sr": sr, "start": round(emit_t, 3),
                              "words": [w for w in res.words if w.start >= ch.stream_t0 - 1e-6], "text": ch.text})
                    emitted = len(parts)
                    emit_t = t
                continue
            self._wait(ch.done, cancel)
            best = None
            if ch.cached is not None:
                a, words, take = ch.cached
                a, words = self._apply_cuts(a, words, ch)
            else:
                best = ch.done.result()
                # the cache keeps the take before pauses are cut in (the cut depends on the plan, not the take)
                a0 = A.change_tempo(best.audio, sr, ch.pace * ch.style.pace) if len(best.audio) else best.audio
                a0 = A.rms_match(a0, sr, target_db=stream_level) if stream_level is not None else A.rms_match(a0, sr)
                a0 = A.fade(a0, sr)
                factor = len(a0) / max(1, len(best.audio))
                words0 = [Word(w.text, w.start * factor, w.end * factor) for w in best.words]
                take = Take(text=ch.text, spoken=best.said, seed=best.seed, score=round(best.score, 3), attempts=ch.attempts, duration=len(a0) / sr,
                            validated=self.validating and best.score >= self.accept)
                key = getattr(ch, "_key", None)
                if key and len(a0):
                    try:
                        self._cache_put(key, a0, words0, take)
                    except Exception:
                        pass
                a, words = self._apply_cuts(a0, words0, ch)
            if keep_takes:
                if best is None:     # from the cache: the one take we have
                    cand = _Cand(a, words, take.spoken, take.score, take.seed, [])
                    res.chunks.append(self._chunk_record(ch, [self._take_record(cand, a, words)], 0))
                else:
                    recs, chosen = [], 0
                    for c in ch.takes:
                        if c is best:
                            chosen = len(recs)
                            recs.append(self._take_record(c, a, words))
                        elif len(c.audio):
                            ca, cw = self._finish(c, ch, stream_level)
                            recs.append(self._take_record(c, ca, cw))
                    res.chunks.append(self._chunk_record(ch, recs, chosen))
            chunk_t0 = t
            for w in words:
                res.words.append(Word(w.text, t + w.start, t + w.end))
            res.takes.append(take)
            if not take.validated and self.validating:
                res.warnings.append(f"low-confidence take ({take.score}): {ch.text[:60]!r}")
            if len(a) == 0:
                res.warnings.append(f"no audio for: {ch.text[:60]!r}")
            parts.append(a)
            t += len(a) / sr
            if gap:
                parts.append(A.silence(gap, sr))
                t += gap / 1000.0
            done_chunks += 1
            if on_chunk is not None:
                seg = np.concatenate(parts[emitted:]).astype(np.float32)
                on_chunk({"index": done_chunks - 1, "total": len(chunks), "audio": seg, "sr": sr, "start": round(emit_t, 3),
                          "words": [Word(w.text, chunk_t0 + w.start, chunk_t0 + w.end) for w in words],
                          "text": ch.text})
                emitted = len(parts)
                emit_t = t
        parts.append(A.silence(tail_ms, sr))
        if on_chunk is not None and len(parts) > emitted:
            on_chunk({"index": done_chunks, "total": len(chunks), "audio": np.concatenate(parts[emitted:]).astype(np.float32), "sr": sr,
                      "start": round(emit_t, 3), "words": [], "text": "", "final": True})

        out = np.concatenate(parts).astype(np.float32)
        if lufs is not None and len(out) > sr // 10:
            out = A.studio_chain(out, sr, lufs)
        res.audio = out
        stats.audio_seconds = len(out) / sr
        stats.wall_seconds = time.perf_counter() - t_start
        res.stats = stats  # type: ignore[attr-defined]
        return res
