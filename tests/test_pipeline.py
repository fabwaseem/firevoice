import numpy as np
import pytest

from firevoice.asr import match_score
from firevoice.voices import VoiceLibrary


def test_pauses_are_honoured(make):
    s = make()
    plain = s.speak("One two three four five six. One two three four five six.", lufs=None).duration
    paused = s.speak("One two three four five six. [pause 2s] One two three four five six.", lufs=None).duration
    assert paused - plain > 1.6


def test_words_are_monotonic_and_inside_audio(make):
    r = make().speak("Hello there my friend. How are you doing today? Fine, thanks.", lufs=None)
    assert r.words
    starts = [w.start for w in r.words]
    assert starts == sorted(starts)
    assert r.words[-1].end <= r.duration + 0.01


def test_polish_hits_target_loudness(make):
    r = make().speak("A steady test sentence for loudness measurement purposes only.", lufs=-16.0)
    rms = float(np.sqrt((r.audio ** 2).mean()))
    assert 0.0 < rms < 0.9 and np.abs(r.audio).max() <= 1.0


def test_stats_and_concurrency(make):
    s = make(adapter_kwargs={"delay": "0.2"}, workers=3)
    text = " ".join(f"Sentence number {i} is here and it is long enough." for i in range(6))
    r = s.speak(text, lufs=None)
    assert r.stats.chunks == 6 and r.stats.takes == 6
    # 6 takes of 0.2 s on 3 workers: well under the 1.2 s a serial loop would need
    assert r.stats.wall_seconds < 1.0
    assert r.stats.rtf is not None and r.stats.audio_seconds > 0


def test_candidates_pick_best_and_failed_takes_do_not_crash(make):
    s = make(candidates=2, adapter_kwargs={"fail_on": "BOOM"})
    r = s.speak("Fine sentence number one here. This one goes BOOM in the engine. Fine sentence number three here.", lufs=None)
    assert len(r.takes) == 3
    assert r.takes[0].attempts == 2 and r.takes[0].score == 1.0
    assert r.takes[1].score == 0.0 and any("no audio" in w for w in r.warnings)


def test_match_score():
    assert match_score("forty percent of pull requests", "forty percent of pull requests") == 1.0
    assert match_score("forty percent of pull requests", "pull") < 0.5


def test_voice_requires_consent(tmp_path):
    import soundfile as sf
    sr = 24000
    t = np.arange(sr * 8) / sr
    sf.write(tmp_path / "ref.wav", (0.3 * np.sin(2 * np.pi * 200 * t)).astype("float32"), sr)
    lib = VoiceLibrary(tmp_path / "home")
    with pytest.raises(PermissionError):
        lib.add("Me", tmp_path / "ref.wav", consent=False, transcribe=False)
    meta = lib.add("Me", tmp_path / "ref.wav", consent=True, transcribe=False, gender="female", transcript="la la la")
    assert meta["voice_id"] == "me" and lib.ref_path("me") and lib.ref_text("me") == "la la la"
    assert lib.default_id() == "me"            # a single clip voice is the implicit default
    with pytest.raises(KeyError):
        lib.ref_path("nobody")
    designed = lib.add("Ghost", description="a hushed male horror narrator")
    assert designed["category"] == "designed" and lib.ref_path("ghost") is None
    with pytest.raises(ValueError):
        lib.resolve("ghost", needs_reference=True)
    assert lib.resolve("ghost", needs_reference=False)["desc"].startswith("a hushed")


def test_styles_load_and_change_timing(make):
    from firevoice.styles import all_styles, get_style
    assert {"horror", "explainer", "storyteller", "excited", "calm"} <= set(all_styles())
    assert get_style("story").name == "storyteller"
    assert get_style("horror").params()["instruct"]
    s = make()
    text = "One two three four five six seven. Eight nine ten eleven twelve."
    assert s.speak(text, lufs=None, style="calm").duration > s.speak(text, lufs=None, style="excited").duration
