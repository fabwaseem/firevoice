"""Multi-speaker dialogue: a script of "Name: line" turns, a cast that maps speakers to voices, one mix plus stems.

Script forms (one turn per line):
  Evelyn: Hello, and welcome to today's episode.
  [Arthur] Absolutely. Let's go.
  Narrator: The two of them sat down.
A line without a speaker continues the previous speaker's turn; blank lines are ignored; "(laughs)", "(sighs)" and
similar stage directions become sound tags for engines that support them and are dropped by the others.

Sound cues (need the sound engines installed):
  [sfx: a door creaks open, 2s]     a sound effect in the timeline, between the turns around it
  [music: calm lo-fi piano]         a music bed under the whole dialogue (one per script)
"""
from __future__ import annotations

import re
from typing import Optional

STAGE = {"laughs": "[laugh]", "laughing": "[laugh]", "chuckles": "[chuckle]", "giggles": "[giggle]", "sighs": "[sigh]", "gasps": "[gasp]",
         "coughs": "[cough]", "clears throat": "[clear throat]", "sniffs": "[sniff]", "groans": "[groan]"}


CUE = re.compile(r"^\[?\s*(?P<k>sfx|sound|music)\s*:\s*(?P<d>[^\]]+?)\s*(?:,\s*(?P<s>\d+(?:\.\d+)?)\s*s(?:ec(?:onds?)?)?)?\s*\]?$", re.I)


def parse(script: str) -> list[dict]:
    """-> [{"speaker", "text"}] plus cue turns {"speaker": "SFX" | "Music", "kind": "sfx" | "music", "text", "seconds"}.
    A speaker label is "Name:" (up to 40 characters) or "[Name]" at the start of a line."""
    turns: list[dict] = []
    for raw in (script or "").replace("\r\n", "\n").split("\n"):
        line = raw.strip()
        if not line:
            continue
        cue = CUE.match(line)
        if cue:
            kind = "music" if cue.group("k").lower() == "music" else "sfx"
            turns.append({"speaker": "Music" if kind == "music" else "SFX", "kind": kind, "text": cue.group("d").strip(),
                          "seconds": float(cue.group("s")) if cue.group("s") else None})
            continue
        m = re.match(r"^\[(?P<b>[^\]\n]{1,40})\]\s*(?P<t>.+)$", line) or re.match(r"^(?P<n>[^\W\d_][\w .'-]{0,39}?)\s*:\s+(?P<t>.+)$", line)
        if m and not re.match(r"^(pause|style|pace)\b", (m.groupdict().get("b") or m.groupdict().get("n") or ""), re.I):
            speaker = (m.groupdict().get("b") or m.groupdict().get("n")).strip()
            text = m.group("t").strip()
        elif turns and not turns[-1].get("kind"):
            turns[-1]["text"] += " " + line
            continue
        elif turns:
            speaker, text = "Narrator", line
        else:
            speaker, text = "Narrator", line
        text = re.sub(r"\((%s)\)" % "|".join(map(re.escape, STAGE)), lambda x: STAGE[x.group(1).lower()], text, flags=re.I)
        if turns and turns[-1]["speaker"] == speaker and not turns[-1].get("kind"):
            turns[-1]["text"] += " " + text
        else:
            turns.append({"speaker": speaker, "text": text})
    return turns


def speakers(turns: list[dict]) -> list[str]:
    """The people who speak (sound cues are not speakers)."""
    seen: list[str] = []
    for t in turns:
        if not t.get("kind") and t["speaker"] not in seen:
            seen.append(t["speaker"])
    return seen


def auto_cast(names: list[str], voices: list[dict], cast: Optional[dict] = None) -> dict:
    """Fill in voices for speakers the cast does not name: a library voice with the same name first, then distinct
    voices from the top of the library, alternating genders. -> {speaker: {"voice", ...}}"""
    out = {k: (v if isinstance(v, dict) else {"voice": v}) for k, v in (cast or {}).items()}
    used = {c.get("voice") for c in out.values()}
    by_name = {str(v.get("name") or "").lower(): v["voice_id"] for v in voices}
    ranked = sorted([v for v in voices if v.get("has_ref", True) is not False],
                    key=lambda v: ((v.get("quality") or {}).get("rank") or 999, v["voice_id"]))
    pools = {"female": [v["voice_id"] for v in ranked if v.get("gender") == "female"],
             "male": [v["voice_id"] for v in ranked if v.get("gender") == "male"]}
    turn = 0
    for name in names:
        if name in out:
            continue
        vid = by_name.get(name.lower())
        if vid is None or vid in used:
            order = ("female", "male") if turn % 2 == 0 else ("male", "female")
            vid = next((x for g in order for x in pools[g] if x not in used), None) or next((v["voice_id"] for v in ranked if v["voice_id"] not in used), "default")
            turn += 1
        out[name] = {"voice": vid}
        used.add(vid)
    return out
