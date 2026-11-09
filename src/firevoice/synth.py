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

import hashlib
import json
import re
import threading
import time
from concurrent.futures import Future, ThreadPoolExecutor
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
        ch.pending += 1
        ch.attempts += 1
        stats.takes += 1
        fut = self.pool.submit(ch.text, voice, style.params(), seed)

        def on_done(f: Future):
            def work():
                try:
                    raw = f.result()
                    a = A.trim_silence(raw, self.sr)
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
    ) -> Result:
        """`lang` (e.g. "en", "ur", "hi") picks text normalisation and whether takes are ASR-validated; when omitted
        it is guessed from the script (non-Latin text is read as-is and checked only for signal problems).

        `on_chunk` (streaming / progress): called in order as soon as each sentence chunk and everything before it is
        final, with {"index", "total", "audio", "sr", "start", "words", "text"}; the audio covers the timeline since the
        previous call (pauses included), loudness-matched but before the final studio chain. `cancel`: an Event; when
        set, the render stops at the next chunk boundary with `Cancelled`."""
        if not self.pool.started:
            self.pool.start()          # boot is not part of the request's wall time
        t_start = time.perf_counter()
        stats = Stats()
        base_style = custom_style or get_style(style)
        items = parse(text, base_style.name if custom_style is None else "custom", pace)
        sr = self.sr
        caps = self.pool.caps
        res = Result(audio=np.zeros(0, np.float32), sr=sr, voice=voice)

        # voice resolution: a registered clip, the library default, or a designed voice (description only)
        # a voice may carry per-style reference clips (a whispered take for horror/asmr, a bright one for excited)
        v = self.voices.resolve(voice, needs_reference=caps.get("needs_reference", True), engine=self.pool.spec.name, style=base_style.name)
        voice_key = self._file_key(v.get("ref")) if v.get("ref") else hashlib.sha1((v.get("desc") or v["voice_id"]).encode()).hexdigest()[:16]
        # workers cache conditioning by id: fingerprint the clip and transcript so an edited voice is prepared afresh
        fp = hashlib.sha1(f"{voice_key}|{v.get('ref_text') or ''}|{v.get('desc') or ''}".encode()).hexdigest()[:8]
        pool_voice = Voice(f"{v['voice_id']}#{fp}", ref=v.get("ref"), ref_text=v.get("ref_text"), desc=v.get("desc"))
        voice_key = f"{voice_key}#{fp}"   # cached takes depend on the transcript too (it switches the cloning mode)
        self.pool.prepare_voice(pool_voice)

        # 1) plan every chunk
        chunks: list[_Chunk] = []
        plan: list = []   # Pause | _Chunk, in order, plus the gap decisions
        ci = 0
        for idx, it in enumerate(items):
            if isinstance(it, Pause):
                plan.append(it)
                continue
            st = base_style if custom_style is not None else get_style(it.style)
            if it.style == "custom" and custom_style is not None:
                st = custom_style
            english = is_english_text(it.text, lang)
            spoken = normalize(it.text, self.lexicon, lang)
            if not caps.get("supports_tags", False):
                spoken = strip_tags(spoken)
            sentence_chunks = make_chunks(spoken)
            next_is_pause = idx + 1 < len(items) and isinstance(items[idx + 1], Pause)
            for j, ch_text in enumerate(sentence_chunks):
                ch = _Chunk(index=ci, text=ch_text, style=st, pace=it.pace, seed=seed + ci * 101, asr=english)
                chunks.append(ch)
                last = j == len(sentence_chunks) - 1
                gap = 0
                if not (last and (next_is_pause or idx == len(items) - 1)):
                    nxt = sentence_chunks[j + 1] if not last else (getattr(items[idx + 1], "text", "") if idx + 1 < len(items) else "")
                    breath = 1.0 + min(0.25, len(nxt.split()) / 80.0)
                    gap = int(gap_after_ms(ch_text) * st.pause * breath * _seeded_jitter(seed + ci + 1) / max(0.7, it.pace))
                plan.append((ch, gap))
                ci += 1
        stats.chunks = len(chunks)

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
                for k in range(self.candidates):
                    self._launch(ch, pool_voice, ch.style, ch.seed + k * 7919, stats)

        # 3) gather in order, finish each take, stitch
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
            ch.done.result()
            if ch.cached is not None:
                a, words, take = ch.cached
            else:
                best: _Cand = ch.done.result()
                a = A.change_tempo(best.audio, sr, ch.pace * ch.style.pace) if len(best.audio) else best.audio
                a = A.rms_match(a, sr)
                a = A.fade(a, sr)
                factor = len(a) / max(1, len(best.audio))
                words = [Word(w.text, w.start * factor, w.end * factor) for w in best.words]
                take = Take(text=ch.text, spoken=best.said, seed=best.seed, score=round(best.score, 3), attempts=ch.attempts, duration=len(a) / sr,
                            validated=self.validating and best.score >= self.accept)
                key = getattr(ch, "_key", None)
                if key and len(a):
                    try:
                        self._cache_put(key, a, words, take)
                    except Exception:
                        pass
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
