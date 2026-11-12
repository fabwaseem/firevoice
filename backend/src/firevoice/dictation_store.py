"""What dictation remembers: your words, replacements and snippets (FIREVOICE_HOME/dictation.json), and every dictation
you made (FIREVOICE_HOME/dictation/history.jsonl, newest last; searchable, kept until you delete it).

    words          names and terms to spell your way ("FireVoice", "Kubernetes"): the speech model is told to expect
                   them, and any other casing it writes is fixed
    replacements   what the speech model writes wrongly, and what you want instead ("fire voice" -> "FireVoice")
    snippets       a short phrase you say, and the longer text it types ("my address" -> your address)
"""
from __future__ import annotations

import json
import threading
import time
import uuid
from pathlib import Path
from typing import Optional

from .dictation_text import PhraseRules, words_of

MAX_WORDS = 500
MAX_RULES = 500
MAX_SNIPPET = 4000
HISTORY_KEEP = 20000
PROFILE_P = 0.8              # a detected language teaches the profile only when the detector was at least this sure
# ...and never one of a group of spoken siblings (Urdu and Hindi): which of them was written is a choice, not something
# the detector heard, and a first pick must not become a habit
from .dictation import SIBLINGS as _SIBLINGS  # noqa: E402
_SIBLING_CODES = {c for g in _SIBLINGS for c in g}         # entries; the oldest go first past this


def _id() -> str:
    return uuid.uuid4().hex[:12]


class DictationStore:
    def __init__(self, home: Path):
        self.path = Path(home) / "dictation.json"
        self.hist = Path(home) / "dictation" / "history.jsonl"
        self._lock = threading.RLock()

    # ------------------------------------------------------------------------------------------------ words, rules
    def load(self) -> dict:
        with self._lock:
            try:
                d = json.loads(self.path.read_text(encoding="utf-8")) if self.path.exists() else {}
            except Exception:
                from .voices import back_up_unreadable
                back_up_unreadable(self.path)
                d = {}
            return {"words": [str(w) for w in d.get("words") or [] if str(w).strip()],
                    "replacements": [r for r in d.get("replacements") or [] if isinstance(r, dict)],
                    "snippets": [s for s in d.get("snippets") or [] if isinstance(s, dict)],
                    "wake_names": [str(w) for w in d.get("wake_names") or [] if str(w).strip()]}

    def _save(self, d: dict) -> dict:
        from .voices import write_json_atomic
        self.path.parent.mkdir(parents=True, exist_ok=True)
        write_json_atomic(self.path, d)
        return d

    def add_wake_names(self, forms: list) -> list[str]:
        """Forms of "FireVoice" as the speech model hears this user say it ("fireboys"), taught on the Dictation page:
        the wake phrase accepts them. The newest twelve are kept."""
        with self._lock:
            d = self.load()
            out = [f for f in d["wake_names"] if f not in forms] + [f for f in dict.fromkeys(forms) if f]
            d["wake_names"] = out[-12:]
            self._save(d)
            return d["wake_names"]

    def clear_wake_names(self) -> None:
        with self._lock:
            d = self.load()
            d["wake_names"] = []
            self._save(d)

    def set_words(self, words: list) -> list[str]:
        """Replace the word list (one entry per name or term; duplicates and blanks dropped, order kept)."""
        seen, out = set(), []
        for w in words or []:
            w = " ".join(str(w).split())[:80]
            if w and w.lower() not in seen:
                seen.add(w.lower())
                out.append(w)
        if len(out) > MAX_WORDS:
            raise ValueError(f"at most {MAX_WORDS} words")
        with self._lock:
            d = self.load()
            d["words"] = out
            self._save(d)
        return out

    def add_word(self, word: str) -> list[str]:
        with self._lock:
            return self.set_words(self.load()["words"] + [word])

    def _upsert(self, kind: str, item: dict, keys: tuple[str, str]) -> dict:
        a, b = keys
        first = " ".join(str(item.get(a) or "").split())[:120]
        second = str(item.get(b) or "")
        second = second.strip() if kind == "replacements" else second[:MAX_SNIPPET]
        if not words_of(first):
            raise ValueError(f"{a} needs at least one word")
        if not second.strip():
            raise ValueError(f"{b} is empty")
        with self._lock:
            d = self.load()
            items = d[kind]
            rid = str(item.get("id") or "") or _id()
            row = {"id": rid, a: first, b: second, "updated": time.time()}
            for i, x in enumerate(items):
                if x.get("id") == rid or words_of(x.get(a, "")) == words_of(first):
                    row["id"] = x.get("id") or rid
                    items[i] = row
                    break
            else:
                if len(items) >= MAX_RULES:
                    raise ValueError(f"at most {MAX_RULES}")
                items.append(row)
            self._save(d)
            return row

    def save_replacement(self, item: dict) -> dict:
        return self._upsert("replacements", item, ("heard", "write"))

    def save_snippet(self, item: dict) -> dict:
        return self._upsert("snippets", item, ("trigger", "text"))

    def delete(self, kind: str, rid: str) -> bool:
        with self._lock:
            d = self.load()
            before = len(d[kind])
            d[kind] = [x for x in d[kind] if x.get("id") != rid]
            if len(d[kind]) == before:
                return False
            self._save(d)
            return True

    def rules(self, commands: bool = True, extra_words: Optional[list] = None) -> PhraseRules:
        """The phrase rules for a dictation: built-in commands, then your words (any casing -> yours), replacements and
        snippets (the later ones win where the same words are said)."""
        d = self.load()
        words = [{"heard": w, "write": w} for w in d["words"] + list(extra_words or [])]
        return PhraseRules.build(commands=commands, punctuation=commands, replacements=words + d["replacements"], snippets=d["snippets"])

    def hotwords(self) -> list[str]:
        """What the speech model is told to expect: your words, and what your replacements and snippets turn into words."""
        d = self.load()
        out = list(d["words"]) + [r.get("write", "") for r in d["replacements"] if len(str(r.get("write", ""))) <= 40]
        return [w for w in out if w.strip()]

    # ------------------------------------------------------------------------------------------------ history
    def record(self, text: str, seconds: float, language: Optional[str] = None, app: Optional[str] = None,
               raw: Optional[str] = None, mode: str = "dictation", language_probability: Optional[float] = None,
               language_chosen: bool = False, translated_to: Optional[str] = None) -> Optional[dict]:
        text = (text or "").strip()
        if not text:
            return None
        e = {"id": _id(), "at": time.time(), "text": text, "words": len(text.split()), "seconds": round(float(seconds or 0), 2),
             "language": language, "app": app, "mode": mode}
        if language_probability is not None:
            e["language_p"] = round(float(language_probability), 3)
        if language_chosen:
            e["language_chosen"] = True
        if translated_to and translated_to != language:
            e["translated_to"] = translated_to
        if raw and raw.strip() != text:
            e["raw"] = raw.strip()
        with self._lock:
            self.hist.parent.mkdir(parents=True, exist_ok=True)
            with open(self.hist, "a", encoding="utf-8") as f:
                f.write(json.dumps(e, ensure_ascii=False) + "\n")
            self._maybe_trim()
        return e

    def _all(self) -> list[dict]:
        if not self.hist.exists():
            return []
        out = []
        for line in self.hist.read_text(encoding="utf-8", errors="replace").splitlines():
            try:
                out.append(json.loads(line))
            except Exception:  # noqa: BLE001  (a torn last line after a crash)
                continue
        return out

    def _write_all(self, rows: list[dict]) -> None:
        tmp = self.hist.with_suffix(".tmp")
        tmp.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows), encoding="utf-8")
        tmp.replace(self.hist)

    def _maybe_trim(self) -> None:
        try:
            if self.hist.stat().st_size < 4_000_000:
                return
        except OSError:
            return
        rows = self._all()
        if len(rows) > HISTORY_KEEP:
            self._write_all(rows[-HISTORY_KEEP:])

    def history(self, q: str = "", limit: int = 50, offset: int = 0) -> dict:
        """Newest first. q: words that must all appear (any order, any case)."""
        with self._lock:
            rows = self._all()
        rows.reverse()
        terms = [t for t in str(q or "").lower().split() if t]
        if terms:
            rows = [r for r in rows if all(t in str(r.get("text", "")).lower() for t in terms)]
        total_words = sum(int(r.get("words") or 0) for r in rows)
        total_seconds = sum(float(r.get("seconds") or 0) for r in rows)
        limit = max(1, min(int(limit or 50), 500))
        return {"items": rows[offset: offset + limit], "total": len(rows), "words": total_words, "seconds": round(total_seconds, 1)}

    def language_profile(self, last: int = 200) -> dict[str, float]:
        """Which languages the speaker dictates in, from their recent history: {code: share}."""
        with self._lock:
            rows = self._all()[-last:]
        counts: dict[str, int] = {}
        for r in rows:
            c = r.get("language")
            # only what is certain teaches: a language the speaker chose, or one the detector was sure of (a wrong
            # guess on a short clip must not become a habit)
            sure = r.get("language_chosen") or ((r.get("language_p") or 0) >= PROFILE_P and c not in _SIBLING_CODES)
            if c and sure and r.get("words", 0) >= 2:
                counts[c] = counts.get(c, 0) + 1
        n = sum(counts.values())
        return {c: k / n for c, k in counts.items()} if n else {}

    def delete_history(self, hid: Optional[str] = None) -> int:
        """One entry by id, or every entry (hid=None). -> how many went."""
        with self._lock:
            rows = self._all()
            keep = [] if hid is None else [r for r in rows if r.get("id") != hid]
            gone = len(rows) - len(keep)
            if gone:
                self.hist.parent.mkdir(parents=True, exist_ok=True)
                self._write_all(keep)
            return gone
