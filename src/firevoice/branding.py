"""Voice branding: every voice gets a human name, a one-line tagline, character traits, use cases, a quality tier
and a short preview clip ("Hi, I'm Isla..."), the way a voice marketplace presents its catalogue.

The voice id never changes (scripts and APIs keep working); `name` is the display name and is also accepted
wherever a voice id is (`--voice Isla`).

    firevoice voices brand            # names + taglines + traits for every voice (keeps names you set yourself)
    firevoice voices previews         # render a branded preview clip for every voice
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from statistics import median
from typing import Optional

# ------------------------------------------------------------------------------------------------ names
# (accent code or source family, gender) -> names that fit
POOLS: dict[tuple[str, str], list] = {
    ("us", "female"): ["Ava", "Harper", "Riley", "Brooke", "Savannah", "Claire", "Paige"],
    ("us", "male"): ["Ethan", "Mason", "Wyatt", "Caleb", "Jordan", "Logan", "Carter"],
    ("uk", "female"): ["Charlotte", "Imogen", "Eleanor", "Poppy", "Harriet"],
    ("uk", "male"): ["Oliver", "Alfie", "Henry", "Rupert", "Edmund"],
    ("sco", "female"): ["Isla", "Eilidh", "Morag", "Catriona"],
    ("sco", "male"): ["Callum", "Angus", "Fraser", "Ewan"],
    ("ie", "female"): ["Niamh", "Aoife", "Saoirse", "Clodagh"],
    ("ie", "male"): ["Cian", "Darragh", "Ronan", "Oisin"],
    ("au", "female"): ["Matilda", "Chloe", "Tahlia"],
    ("au", "male"): ["Jack", "Lachlan", "Cooper"],
    ("nz", "female"): ["Aroha", "Ruby", "Mere"],
    ("nz", "male"): ["Nikau", "Tama", "Finn"],
    ("ca", "female"): ["Brooklyn", "Avery", "Sienna"],
    ("ca", "male"): ["Liam", "Owen", "Declan"],
    ("sas", "female"): ["Priya", "Ananya", "Zoya", "Kavya"],
    ("sas", "male"): ["Arjun", "Rohan", "Imran", "Vikram"],
    ("ph", "female"): ["Marisol", "Bea", "Lara"],
    ("ph", "male"): ["Paolo", "Miguel", "Rafael"],
    ("my", "female"): ["Nurul", "Mei Ling"],
    ("my", "male"): ["Hafiz", "Aiman", "Wei Jie"],
    ("za", "female"): ["Naledi", "Zanele"],
    ("za", "male"): ["Thabo", "Sipho", "Pieter"],
    ("de", "female"): ["Lena", "Greta"],
    ("de", "male"): ["Lukas", "Jonas", "Felix"],
    ("fr", "female"): ["Camille", "Margaux"],
    ("fr", "male"): ["Etienne", "Julien"],
    ("hk", "female"): ["Mei"],
    ("hk", "male"): ["Kai", "Ho Yin"],
    ("narrator", "female"): ["Rachel", "Grace", "Evelyn", "Hazel", "Iris", "Lydia", "Vivian", "Nora", "Audrey", "Clara"],
    ("narrator", "male"): ["Arthur", "Theodore", "Walter", "Graham", "Silas", "Edwin", "Russell", "Victor", "Desmond", "Harold"],
    ("narrator", "neutral"): ["Quinn", "Sage", "Rowan", "Jules"],
    ("studio", "female"): ["Ivy", "Stella"],
    ("studio", "male"): ["Marcus", "Dante"],
    ("studio", "neutral"): ["Remy", "Ari"],
    ("ur", "female"): ["Ayesha", "Zara", "Hira", "Mahnoor", "Sana", "Noor", "Iqra", "Anaya", "Mehwish"],
    ("ur", "male"): ["Bilal", "Hamza", "Faraz", "Usman", "Saad", "Danish", "Zain", "Kashif", "Omar", "Rehan", "Talha"],
}

# designed voices keep a name that matches their character
DESIGNED = {
    "old-british-gent": "Reginald", "young-us-woman": "Madison", "calm-guide-f": "Serena", "sports-caster": "Dex", "ghost-whisper-f": "Wren",
    "news-anchor-m": "Grant", "little-girl": "Lily", "teen-boy": "Toby", "pak-uncle": "Tariq", "desi-teacher-f": "Meera", "glasgow-m": "Hamish",
    "aussie-f": "Kylie", "trailer-voice": "Titan", "grandma": "Rosemary", "deadpan-m": "Monty", "podcast-f": "Jade", "villain-m": "Viktor",
    "sleepy-m": "Leo", "robot": "Axiom", "french-f": "Celine", "documentary-m": "Atticus", "radio-dj-f": "Roxy",
}
SPECIAL = {"firestack": "Ember"}

ACCENT_WORDS = {"us": "American", "uk": "British", "sco": "Scottish", "ie": "Irish", "au": "Australian", "nz": "New Zealand", "ca": "Canadian",
                "sas": "South Asian", "ph": "Filipino", "my": "Malaysian", "za": "South African", "de": "German", "fr": "French", "hk": "Hong Kong"}

DESIGN_USES = [(r"news|anchor", ["News", "Corporate"]), (r"trailer|epic", ["Trailers", "Promos"]), (r"ghost|whisper|horror|villain|menacing", ["Horror", "Characters"]),
               (r"grandma|bedtime|grandmother", ["Bedtime stories", "Audiobooks"]), (r"sports|commentator", ["Sports", "Hype"]), (r"podcast", ["Podcasts", "Explainers"]),
               (r"radio|dj", ["Ads", "Radio"]), (r"meditation|calm|soothing", ["Meditation", "Wellness"]), (r"girl|teen|boy", ["Characters", "Animation"]),
               (r"robot|ai assistant", ["Sci-fi", "Assistants"]), (r"documentary|nature", ["Documentary", "Narration"]), (r"storyteller|gravelly", ["Storytelling", "Audiobooks"]),
               (r"comedian|deadpan|sarcastic", ["Comedy", "Social"]), (r"teacher|patient", ["E-learning", "Explainers"])]


# ------------------------------------------------------------------------------------------------ traits
def _family(v: dict) -> str:
    vid = v["voice_id"]
    if v.get("language") == "ur" or vid.startswith("urd-"):
        return "ur"
    if vid.startswith("glb-"):
        return v.get("accent_code") or vid.split("-")[2]
    if vid.startswith("exp-"):
        return "studio"
    return "narrator"


def _pct(values: list[float], x: float) -> float:
    vs = sorted(values)
    return sum(1 for y in vs if y < x) / max(1, len(vs) - 1) if vs else 0.5


def measure(lib, report: Optional[dict] = None) -> dict[str, dict]:
    """Per-voice acoustic facts: median pitch, pitch movement, pace, energy, warmth, listening-test score. The gallery
    renders from the listening test (same sentence for every voice) are used when available; otherwise the pitch of the
    reference clip."""
    gallery = {r["voice"]: r for r in ((report or {}).get("sections", {}).get("gallery") or [])}
    out = {}
    for v in lib.list():
        g = gallery.get(v["voice_id"], {})
        f0 = g.get("f0_median") or _ref_f0(lib, v["voice_id"])
        out[v["voice_id"]] = {"f0": f0, "range": g.get("pitch_range_st"), "rate": g.get("rate_wps"), "arousal": g.get("arousal"),
                              "valence": g.get("valence"), "score": g.get("score"), "judge": g.get("judge"), "rank": g.get("rank"), "err": g.get("err")}
    return out


def _ref_f0(lib, vid: str) -> Optional[float]:
    try:
        import librosa
        import numpy as np
        import soundfile as sf
        p = lib.ref_path(vid)
        if not p:
            return None
        a, sr = sf.read(p, dtype="float32", always_2d=False)
        f0 = librosa.yin(a[: sr * 12], fmin=60, fmax=400, sr=sr)
        return float(np.median(f0))
    except Exception:
        return None


def traits_for(v: dict, m: dict, pop: dict[str, list[float]]) -> list[str]:
    g = v.get("gender") or "neutral"
    t = []
    f0s = pop.get("f0:" + g) or []
    if m.get("f0") and f0s:
        p = _pct(f0s, m["f0"])
        t.append(("deep" if g == "male" else "low") if p < 0.25 else ("bright" if p > 0.75 else "warm"))
    if m.get("range") is not None and pop.get("range"):
        p = _pct(pop["range"], m["range"])
        t.append("expressive" if p > 0.7 else "steady" if p < 0.3 else "natural")
    if m.get("rate") is not None and pop.get("rate"):
        p = _pct(pop["rate"], m["rate"])
        t.append("brisk" if p > 0.75 else "measured" if p < 0.25 else "")
    if m.get("arousal") is not None and pop.get("arousal"):
        p = _pct(pop["arousal"], m["arousal"])
        t.append("energetic" if p > 0.75 else "calm" if p < 0.25 else "")
    if m.get("valence") is not None and pop.get("valence") and _pct(pop["valence"], m["valence"]) > 0.75:
        t.append("friendly")
    return [x for x in t if x]


def uses_for(v: dict, traits: list[str]) -> list[str]:
    if v.get("kind") == "designed" or "designed" in (v.get("tags") or []):
        prompt = (v.get("design_prompt") or v.get("description") or "").lower()
        for pat, uses in DESIGN_USES:
            if re.search(pat, prompt):
                return uses
    u = []
    if v.get("language") == "ur":
        u += ["Urdu content"]
    if {"deep", "low"} & set(traits) and ({"steady", "calm", "measured"} & set(traits)):
        u += ["Audiobooks", "Documentary"]
    if "expressive" in traits:
        u += ["Storytelling", "Characters"]
    if {"bright", "energetic", "brisk"} & set(traits):
        u += ["Ads", "Social"]
    if "friendly" in traits or "warm" in traits:
        u += ["Podcasts", "Explainers"]
    if "calm" in traits:
        u += ["Meditation"]
    u += ["Narration"] if not u else []
    seen, out = set(), []
    for x in u:
        if x not in seen:
            seen.add(x)
            out.append(x)
    return out[:3]


def tagline_for(v: dict, traits: list[str], family: str) -> str:
    if v.get("kind") == "designed" or "designed" in (v.get("tags") or []):
        p = (v.get("design_prompt") or v.get("description") or "").strip()
        p = re.sub(r"^(a|an)\s+", "", p, flags=re.I)
        return p[:1].upper() + p[1:]
    g = v.get("gender") or ""
    noun = {"male": "man", "female": "woman"}.get(g, "voice")
    if family == "ur":
        where = "native Urdu speaker"
        noun = {"male": "Urdu-speaking man", "female": "Urdu-speaking woman"}.get(g, where)
    elif family in ACCENT_WORDS:
        acc = ACCENT_WORDS[family]
        noun = f"{noun} with {'an' if acc[0] in 'AEIOU' else 'a'} {acc} accent"
    elif family == "narrator":
        noun = {"male": "audiobook narrator", "female": "audiobook narrator"}.get(g, "audiobook narrator")
    elif family == "studio":
        noun = {"male": "studio voice actor", "female": "studio voice actress"}.get(g, "studio voice actor")
    words = [w for w in traits if w in ("deep", "low", "warm", "bright", "expressive", "steady", "calm", "energetic", "friendly", "brisk", "measured")][:2]
    lead = ", ".join(words) if words else "natural"
    s = f"{lead} {noun}"
    return s[:1].upper() + s[1:]


def tier_for(m: dict, ranks_total: int) -> Optional[str]:
    if m.get("rank") is None:
        return None
    if m.get("err") is not None and m["err"] > 0.2:
        return "C"
    q = m["rank"] / max(1, ranks_total)
    return "S" if q <= 0.1 else "A" if q <= 0.35 else "B" if q <= 0.75 else "C"


# ------------------------------------------------------------------------------------------------ apply
def brand(lib, report: Optional[dict] = None, *, force: bool = False, log=print) -> list[dict]:
    """Assign names, taglines, traits, use cases and quality tiers. A name set by hand (`branded_by: user`) is kept unless force."""
    voices = lib.list()
    m = measure(lib, report)
    pop: dict[str, list[float]] = {}
    for v in voices:
        x = m[v["voice_id"]]
        g = v.get("gender") or "neutral"
        for k, key in (("f0", "f0:" + g), ("range", "range"), ("rate", "rate"), ("arousal", "arousal"), ("valence", "valence")):
            if x.get(k) is not None:
                pop.setdefault(key, []).append(x[k])
    ranks_total = sum(1 for x in m.values() if x.get("rank") is not None)
    used: set[str] = set()
    for v in voices:   # names already chosen by hand are reserved first
        meta = lib.get(v["voice_id"])
        if meta.get("branded_by") == "user" and meta.get("name"):
            used.add(meta["name"].lower())
    pools = {k: list(v) for k, v in POOLS.items()}
    out = []
    order = sorted(voices, key=lambda v: (m[v["voice_id"]].get("rank") or 999, v["voice_id"]))   # best voices pick names first
    for v in order:
        vid = v["voice_id"]
        meta = lib.get(vid)
        if meta.get("branded_by") == "user" and not force:
            continue
        kind = "designed" if (meta.get("category") == "designed" or "designed" in (meta.get("tags") or [])) else "cloned"
        v = {**meta, "kind": kind, "voice_id": vid}
        fam = _family(v)
        name = None
        if vid in SPECIAL:
            name = SPECIAL[vid]
        elif kind == "designed":
            name = DESIGNED.get(re.sub(r"^dsg-", "", vid)) or vid.replace("dsg-", "").replace("-", " ").title()
        else:
            g = v.get("gender") or "neutral"
            for cand in pools.get((fam, g), []) + pools.get((fam, "neutral"), []) + pools.get(("narrator", g), []) + pools.get(("narrator", "neutral"), []):
                if cand.lower() not in used:
                    name = cand
                    break
        if not name or name.lower() in used:
            base = name or vid
            k = 2
            while f"{base} {k}".lower() in used:
                k += 1
            name = f"{base} {k}"
        used.add(name.lower())
        tr = traits_for(v, m[vid], pop)
        fields = {"name": name, "tagline": tagline_for(v, tr, fam), "traits": tr, "use_cases": uses_for(v, tr), "branded_by": "auto"}
        q = tier_for(m[vid], ranks_total)
        if q:
            fields["quality"] = {"tier": q, "rank": m[vid]["rank"], "of": ranks_total, "naturalness": round(m[vid]["judge"], 2) if m[vid].get("judge") else None}
        fields["featured"] = q == "S"
        lib.update(vid, **fields)
        out.append({"voice_id": vid, **fields})
        log(f"  {vid:22} -> {name:12} {q or '-'}  {fields['tagline'][:60]}")
    return out


# ------------------------------------------------------------------------------------------------ previews
def preview_text(v: dict) -> tuple[str, str]:
    """-> (text, lang): the voice introducing itself. Always written in English letters: Urdu voices speak Urdu,
    written in Roman Urdu; everyone else speaks English."""
    name = v.get("name") or v["voice_id"]
    if v.get("language") == "ur":
        return (f"Assalam o Alaikum, mera naam {name} hai. Aap ki kahani, aap ka paighaam, meri awaaz mein. Chaliye, shuru karte hain.", "ur")
    use = (v.get("use_cases") or ["narration"])[0].lower()
    return (f"Hi, I'm {name}. {v.get('tagline') or 'A natural, expressive voice'}, ready for your {use} projects. Let's make something great together.", "en")


def collections(voices: list[dict]) -> list[dict]:
    """Curated shelves for a voice browser."""
    def pick(pred, limit=24):
        return [v["voice_id"] for v in voices if pred(v)][:limit]
    ranked = sorted(voices, key=lambda v: (v.get("quality") or {}).get("rank") or 999)
    shelves = [
        ("featured", "Featured", "The most natural voices in the library, chosen by the listening test.", pick(lambda v: v.get("featured"), 12)),
        ("narrators", "Narrators", "Steady, warm voices for audiobooks and documentaries.",
         [v["voice_id"] for v in ranked if {"Audiobooks", "Documentary", "Narration"} & set(v.get("use_cases") or [])][:16]),
        ("conversational", "Conversational", "Friendly voices for podcasts, explainers and social.",
         [v["voice_id"] for v in ranked if {"Podcasts", "Explainers", "Social"} & set(v.get("use_cases") or [])][:16]),
        ("characters", "Characters", "Expressive and designed voices for stories, games and animation.",
         [v["voice_id"] for v in ranked if {"Characters", "Storytelling", "Horror", "Animation", "Comedy"} & set(v.get("use_cases") or [])][:16]),
        ("accents", "Accents of English", "Real speakers from Scotland to Manila.", pick(lambda v: v["voice_id"].startswith("glb-"), 40)),
        ("urdu", "Urdu", "Native Urdu speakers.", pick(lambda v: v.get("language") == "ur", 40)),
        ("designed", "Designed", "Voices invented from a description and locked.", pick(lambda v: v.get("kind") == "designed", 40)),
    ]
    by = {v["voice_id"]: v for v in voices}
    return [{"id": i, "title": t, "description": d, "voices": [x for x in ids if x in by]} for i, t, d, ids in shelves if ids]


def load_report(path: Optional[str]) -> Optional[dict]:
    if not path:
        return None
    p = Path(path)
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else None


def median_or(xs, d):
    xs = [x for x in xs if x is not None]
    return median(xs) if xs else d
