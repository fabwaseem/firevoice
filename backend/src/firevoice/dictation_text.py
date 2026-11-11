"""What dictated words become as text: spoken commands, your own words and snippets, corrections said out loud.

Everything here is plain rules, so it works the same live (word by word, as the words are released) and on the whole
dictation at the end. The local writing model (dictation_ai.py) goes further when it is installed; these rules are the
part that never depends on it.

Phrase rules turn a run of spoken words into text:

    built in    "new line" / "new paragraph" (line breaks), "comma", "full stop", "question mark", "exclamation mark",
                "colon", "semicolon", "open quote" / "close quote", "open bracket" / "close bracket"
    yours       replacements ("fire voice" -> "FireVoice": a word the speech model writes wrongly) and snippets
                ("my email" -> "me@example.com": a short phrase that types a longer text)

Backtracking ("scratch that", "no wait") is done on whole sentences, so only on the final text (backtrack()).
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Optional

_NORM = re.compile(r"[^\w']+", re.UNICODE)
FILLERS = {"um", "umm", "uh", "uhh", "uhm", "erm", "er", "hmm", "mm", "mhm", "ah", "eh"}


def norm(word: str) -> str:
    return _NORM.sub("", word.lower())


def words_of(phrase: str) -> tuple[str, ...]:
    return tuple(k for k in (norm(w) for w in str(phrase).split()) if k)


# What a piece of output is: "text" (a word or a typed snippet: spaced like a word), "punct" (sticks to the word before
# it), "break" (a line break: no space around it), "open" (an opening quote or bracket: sticks to the word after it).
LINE = ("break", "\n")
PARA = ("break", "\n\n")
COMMANDS: dict[tuple[str, ...], tuple[str, str]] = {
    ("new", "line"): LINE, ("newline",): LINE, ("next", "line"): LINE,
    ("new", "paragraph"): PARA, ("next", "paragraph"): PARA,
}
PUNCTUATION: dict[tuple[str, ...], tuple[str, str]] = {
    ("comma",): ("punct", ","), ("full", "stop"): ("punct", "."), ("question", "mark"): ("punct", "?"),
    ("exclamation", "mark"): ("punct", "!"), ("exclamation", "point"): ("punct", "!"), ("colon",): ("punct", ":"),
    ("semicolon",): ("punct", ";"), ("semi", "colon"): ("punct", ";"), ("open", "quote"): ("open", "“"),
    ("close", "quote"): ("punct", "”"), ("end", "quote"): ("punct", "”"), ("open", "bracket"): ("open", "("),
    ("close", "bracket"): ("punct", ")"), ("open", "paren"): ("open", "("), ("close", "paren"): ("punct", ")"),
    ("dash",): ("text", "–"), ("ellipsis",): ("punct", "…"),
}


@dataclass
class PhraseRules:
    """The spoken phrases to act on, longest first. Build one with PhraseRules.build()."""
    rules: dict[tuple[str, ...], tuple[str, str]] = field(default_factory=dict)
    prefixes: set[tuple[str, ...]] = field(default_factory=set)
    longest: int = 1

    @classmethod
    def build(cls, commands: bool = True, punctuation: bool = True, replacements: Optional[list] = None,
              snippets: Optional[list] = None) -> "PhraseRules":
        """replacements: [{"heard", "write"}]; snippets: [{"trigger", "text"}]. Yours win over the built-in phrases."""
        rules: dict[tuple[str, ...], tuple[str, str]] = {}
        if commands:
            rules.update(COMMANDS)
        if punctuation:
            rules.update(PUNCTUATION)
        for r in replacements or []:
            k = words_of(r.get("heard", ""))
            if k and str(r.get("write", "")).strip():
                rules[k] = ("text", str(r["write"]).strip())
        for s in snippets or []:
            k = words_of(s.get("trigger", ""))
            if k and str(s.get("text", "")):
                rules[k] = ("text", str(s["text"]))
        prefixes = {k[:i] for k in rules for i in range(1, len(k))}
        return cls(rules, prefixes, max((len(k) for k in rules), default=1))

    def match(self, keys: list[str], i: int) -> tuple[int, Optional[tuple[str, str]], bool]:
        """At word i: (how many words the longest rule takes, its output) or (0, None); and whether the words from i to
        the end are only the start of a longer rule (so a live caller should wait for the next word)."""
        for n in range(min(self.longest, len(keys) - i), 0, -1):
            hit = self.rules.get(tuple(keys[i:i + n]))
            if hit is not None:
                more = tuple(keys[i:]) in self.prefixes
                return n, hit, more
        return 0, None, tuple(keys[i:]) in self.prefixes


DEFAULT_RULES = PhraseRules.build()
NO_COMMANDS = PhraseRules.build(commands=False, punctuation=False)


def format_words(words: list[str], commands: bool = True, fillers: bool = True, final: bool = True,
                 rules: Optional[PhraseRules] = None) -> str:
    """The text for a run of released words. With final=False words that may be the start of a spoken phrase ("new"
    of "new line", the first word of a snippet) are held back, so the text for more words always starts with the text
    for fewer: what was typed never has to be taken back."""
    rules = rules if rules is not None else (DEFAULT_RULES if commands else NO_COMMANDS)
    keys = [norm(w) for w in words]
    out: list[tuple[str, str]] = []
    cap_next = False             # a dropped filler or a full stop opened the sentence: the next word takes a capital
    i, n = 0, len(words)
    while i < n:
        w, k = words[i], keys[i]
        if not k:                # punctuation on its own
            out.append(("punct", w.strip()))
            i += 1
            continue
        take, hit, more = rules.match(keys, i)
        if more and not final and (hit is None or i + take == n):
            break                # the next word decides between this phrase and a longer one: wait for it
        if hit is not None:
            kind, value = hit
            if kind == "punct" and value in ".?!":
                cap_next = True
            out.append((kind, value))
            # the speech model often writes punctuation on the phrase's last word ("comma." -> keep only ours)
            i += take
            continue
        if fillers and k in FILLERS:
            opens = not out or out[-1][0] == "break" or out[-1][1].endswith((".", "!", "?"))
            cap_next = cap_next or (opens and w[:1].isupper())
            i += 1
            continue
        if cap_next and w[:1].islower():
            w = w[:1].upper() + w[1:]
        cap_next = False
        out.append(("text", w))
        i += 1
    return join(out)


def join(pieces: list[tuple[str, str]]) -> str:
    text = ""
    glue = False                 # the last piece was an opening quote or bracket: no space after it
    for kind, value in pieces:
        if kind == "break":
            text = text.rstrip(" ") + value
        elif kind == "punct":
            text = text.rstrip(" ").rstrip(",;:") + value if value in ".?!" else text.rstrip(" ") + value
        elif kind == "open":
            text += ("" if not text or text.endswith(("\n", " ")) else " ") + value
            glue = True
            continue
        else:
            text += ("" if not text or text.endswith("\n") or glue else " ") + value
        glue = False
    return text


# ------------------------------------------------------------------------------------------------ backtracking
# "scratch that" / "delete that": the sentence (or clause) just said is dropped.
_SCRATCH = re.compile(r"[,.;:]?\s*\b(?:scratch that|delete that|strike that|cancel that)\b[,.!]?\s*", re.I)
# "..., no wait, ..." / "..., sorry, I meant ...": what follows replaces the end of what came before.
_FIX = re.compile(r",?\s*\b(?:no,? wait|wait,? no|sorry,? I meant|I meant to say|I meant|no,? sorry|correction|actually,? no)\b[,:]?\s*", re.I)
_SENT_END = re.compile(r"[.!?]\s+|\n")


def _drop_last_clause(before: str) -> str:
    """What remains when the clause (or sentence) at the end of `before` is taken back."""
    b = before.rstrip()
    if not b:
        return ""
    stops = [m.end() for m in re.finditer(r"[.!?]\s+|\n|[,;:]\s+", b)]
    return b[: stops[-1]] if stops else ""


# a correction that starts like this is a new clause, not a swapped word ("go home, no wait, let's stay")
_SUBJECTS = {"i", "we", "you", "he", "she", "they", "it", "let's", "lets", "there", "this", "that"}


def _correct(before: str, new: str, rest: str) -> str:
    """`new` corrects the end of `before` (the sentence it ends, or the one just finished). It restarts at the last place
    its first word was said ("due at 5pm, no wait, at 6pm": from "at"); with no such place, a short correction swaps
    the last word ("on Tuesday, no wait, Friday") and a long one the last clause."""
    if not new:
        return (before.rstrip() + (" " + rest if rest else "")).strip()
    b = before.rstrip()
    ended = b.endswith((".", "!", "?"))
    body = b[:-1] if ended else b
    stops = [x.end() for x in _SENT_END.finditer(body)]
    head, scope = (body[: stops[-1]], body[stops[-1]:]) if stops else ("", body)
    words = scope.split()
    first = norm(new.split()[0])
    at = next((i for i in range(len(words) - 1, max(-1, len(words) - 9), -1) if norm(words[i]) == first), None)
    if at is not None:
        kept = " ".join(words[:at])
    elif len(words) > 1 and norm(new.split()[0]) not in _SUBJECTS:
        # a word swapped ("on Tuesday, no wait, Friday at three"): the last word goes, the correction carries on
        kept = " ".join(words[:-1])
    else:
        kept = _drop_last_clause(scope).rstrip(" ,;:")
    lead = new if kept else new[:1].upper() + new[1:]
    sentence = (kept + " " + lead).strip() if kept else lead
    if ended and not sentence.endswith((".", "!", "?")):
        sentence += b[-1]
    return (head + sentence + (" " + rest if rest else "")).strip()


def backtrack(text: str) -> str:
    """Apply the corrections said out loud.

        "Send it to Tom. Scratch that. Send it to Anna."          -> "Send it to Anna."
        "Let's meet on Tuesday, no wait, Friday at noon."          -> "Let's meet on Friday at noon."
        "Book a table for four. Sorry, I meant a table for five."  -> "Book a table for five."
    """
    out = text
    for _ in range(20):                                   # one correction at a time, left to right
        m = _SCRATCH.search(out)
        f = _FIX.search(out)
        if m is None and f is None:
            break
        if m is not None and (f is None or m.start() <= f.start()):
            before, after = out[: m.start()], out[m.end():]
            # "scratch that" ends a sentence the speaker abandoned: drop that sentence
            stops = [x.end() for x in _SENT_END.finditer(before.rstrip())]
            kept = before.rstrip()[: stops[-1]] if stops else ""
            out = (kept.rstrip() + (" " if kept.strip() and after.strip() else "") + after.lstrip()).strip()
            continue
        before, after = out[: f.start()], out[f.end():]
        fix = re.split(r"(?<=[.!?])\s", after, maxsplit=1)
        new, rest = fix[0].strip(), (fix[1] if len(fix) > 1 else "")
        out = _correct(before, new, rest)
    return out


def tidy(text: str) -> str:
    """Final touches on a whole dictation: no doubled spaces or punctuation, a capital at the start of each sentence."""
    t = re.sub(r"[ \t]+", " ", text)
    t = re.sub(r" +([,.;:!?…])", r"\1", t)
    t = re.sub(r"([,;:])\1+", r"\1", t)
    t = re.sub(r"\.{2}(?!\.)", ".", t)
    t = re.sub(r"(^|[.!?]\s+|\n)([a-z])", lambda m: m.group(1) + m.group(2).upper(), t)
    return t.strip(" ")
