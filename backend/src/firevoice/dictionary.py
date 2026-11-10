"""Pronunciation dictionary: your own rules for how words are said.

A rule rewrites written text into what the engine should read, before anything else in the text pass:
  {"match": "Siobhan", "say": "Shi-vawn"}             a name said your way
  {"match": "SQL", "say": "sequel"}                    an acronym said as a word
  {"match": "kg", "say": "kilograms", "case": true}    only this exact casing

`case` (default false) makes the match case-sensitive. `whole_word` (default true) only matches whole words, so
"cat" does not touch "concatenate". Your rules run before the built-in list (numbers, money, dates, tech terms) and
win over it, and they apply to every language. A request may also carry its own rules (TTSRequest.dictionary).
"""
from __future__ import annotations

import re
import threading
import time
import uuid
from pathlib import Path
from typing import Optional

from .frontend.normalize import DEFAULT_LEXICON

FIELDS = ("match", "say", "case", "whole_word", "note")


def clean_rule(r: dict, *, keep_id: bool = True) -> dict:
    """Validate one rule; raises ValueError with a readable message."""
    if not isinstance(r, dict):
        raise ValueError("a rule must be an object like {\"match\": \"SQL\", \"say\": \"sequel\"}")
    match = str(r.get("match") or "").strip()
    say = str(r.get("say") if r.get("say") is not None else "").strip()
    if not match:
        raise ValueError("a rule needs a non-empty 'match'")
    if len(match) > 200 or len(say) > 400:
        raise ValueError("a rule's 'match' is limited to 200 characters and 'say' to 400")
    out = {"match": match, "say": say, "case": bool(r.get("case", False)), "whole_word": bool(r.get("whole_word", True)),
           "note": str(r.get("note") or "")[:300]}
    if keep_id:
        out["id"] = str(r.get("id") or uuid.uuid4().hex[:10])
        out["created"] = float(r.get("created") or time.time())
    return out


def parse_rules(spec) -> list[dict]:
    """Rules from the shapes people write: a list of rule objects, or a {written: spoken} map."""
    if not spec:
        return []
    if isinstance(spec, dict):
        return [clean_rule({"match": k, "say": v}, keep_id=False) for k, v in spec.items()]
    if isinstance(spec, list):
        return [clean_rule(r, keep_id=False) for r in spec]
    raise ValueError("a dictionary must be a list of rules or a {written: spoken} object")


def compile_rules(rules: list[dict]) -> list[tuple[re.Pattern, str]]:
    """Longest matches first, so "New York City" wins over "New York"."""
    out = []
    for r in sorted(rules, key=lambda r: len(r["match"]), reverse=True):
        body = re.escape(r["match"])
        if r.get("whole_word", True):
            body = r"(?<![\w])" + body + r"(?![\w])"
        out.append((re.compile(body, 0 if r.get("case") else re.IGNORECASE), r["say"]))
    return out


def apply_rules(text: str, compiled: list[tuple[re.Pattern, str]]) -> str:
    for pat, say in compiled:
        text = pat.sub(lambda _m, s=say: s, text)
    return text


class Dictionary:
    """Your rules, stored as JSON in FIREVOICE_HOME/dictionary.json."""

    def __init__(self, path: Path):
        self.path = Path(path)
        self._lock = threading.RLock()

    # -- storage
    def rules(self) -> list[dict]:
        import json
        with self._lock:
            if not self.path.exists():
                return []
            try:
                data = json.loads(self.path.read_text(encoding="utf-8"))
            except Exception:
                import logging

                from .voices import back_up_unreadable
                kept = back_up_unreadable(self.path)
                logging.getLogger("firevoice").warning("pronunciation dictionary could not be read; moved to %s and started empty", kept)
                return []
            return [clean_rule(r) for r in (data.get("rules") or [])]

    def _save(self, rules: list[dict]) -> None:
        from .voices import write_json_atomic
        self.path.parent.mkdir(parents=True, exist_ok=True)
        write_json_atomic(self.path, {"rules": rules})

    def add(self, rule: dict) -> dict:
        r = clean_rule({k: rule.get(k) for k in FIELDS if k in rule}, keep_id=True)
        with self._lock:
            rules = [x for x in self.rules() if not (x["match"].lower() == r["match"].lower() and x["case"] == r["case"])]
            rules.append(r)       # same match again replaces the old rule
            self._save(rules)
        return r

    def update(self, rule_id: str, fields: dict) -> dict:
        with self._lock:
            rules = self.rules()
            for i, x in enumerate(rules):
                if x["id"] == rule_id:
                    rules[i] = clean_rule({**x, **{k: v for k, v in fields.items() if k in FIELDS and v is not None}}, keep_id=True)
                    self._save(rules)
                    return rules[i]
        raise KeyError(rule_id)

    def remove(self, rule_id: str) -> None:
        with self._lock:
            rules = self.rules()
            keep = [x for x in rules if x["id"] != rule_id]
            if len(keep) == len(rules):
                raise KeyError(rule_id)
            self._save(keep)

    def replace(self, rules: list[dict]) -> list[dict]:
        clean = [clean_rule(r, keep_id=True) for r in rules]
        with self._lock:
            self._save(clean)
        return clean

    # -- use
    @staticmethod
    def builtin() -> list[dict]:
        return [{"match": k, "say": v, "case": True, "whole_word": True, "builtin": True} for k, v in sorted(DEFAULT_LEXICON.items(), key=lambda kv: kv[0].lower())]

    def compiled(self, extra: Optional[list[dict]] = None) -> list[tuple[re.Pattern, str]]:
        """Request rules first (they win), then yours."""
        return compile_rules(list(extra or [])) + compile_rules(self.rules())
