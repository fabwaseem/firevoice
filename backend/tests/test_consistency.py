"""One speaker for the whole script: VoxCPM2 continues from the clip and its transcript unless asked not to."""
from firevoice.core.adapters.voxcpm2 import VoxCPM2Adapter
from firevoice.service import TTSRequest


class _FakeModel:
    def __init__(self):
        self.calls = []

    def generate(self, **kw):
        self.calls.append(kw)
        return [0.0] * 480


def _adapter():
    a = VoxCPM2Adapter()
    a.m = _FakeModel()
    return a


COND = {"ref": "ref.wav", "ref_text": "the words in the clip", "desc": None}
STYLE = {"cfg_value": 2.0, "instruct": "Speak casually and naturally."}


def test_transcript_means_continuation_without_the_instruction():
    a = _adapter()
    a._synth("Hello there.", COND, STYLE, 1)
    call = a.m.calls[-1]
    assert call["prompt_text"] == "the words in the clip" and call["prompt_wav_path"] == "ref.wav"
    assert call["text"] == "Hello there."            # the model would read an instruction aloud in this mode


def test_clip_only_when_no_transcript_or_turned_off():
    a = _adapter()
    a._synth("Hello there.", {**COND, "ref_text": None}, STYLE, 1)
    assert "prompt_text" not in a.m.calls[-1] and a.m.calls[-1]["text"].startswith("(Speak casually")
    a._synth("Hello there.", COND, {**STYLE, "ultimate": False}, 1)
    assert "prompt_text" not in a.m.calls[-1]


def test_explicit_instruction_switches_to_clip_only(svc):
    _, style, _, _ = svc.prepare(TTSRequest(text="Hi.", engine="voxcpm2", voice="design:a calm voice", instruct="Whisper it."))
    assert style.params()["ultimate"] is False and style.params()["instruct"] == "Whisper it."
    _, style, _, _ = svc.prepare(TTSRequest(text="Hi.", engine="voxcpm2", voice="design:a calm voice", style="excited"))
    assert "ultimate" not in style.params()          # a style preset keeps the consistent default
    _, style, _, _ = svc.prepare(TTSRequest(text="Hi.", engine="voxcpm2", voice="design:a calm voice", instruct="Whisper it.", params={"ultimate": True}))
    assert style.params()["ultimate"] is True        # an explicit choice wins
