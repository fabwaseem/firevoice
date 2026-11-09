import pytest

from firevoice.asr import NullAligner
from firevoice.core.registry import get_engine
from firevoice.synth import Synthesizer
from firevoice.voices import VoiceLibrary


@pytest.fixture
def make(tmp_path):
    """Synthesizer on the null engine (2 worker processes); pools are stopped after the test."""
    made = []

    def _make(cache=False, candidates=1, workers=2, **kw):
        spec = get_engine("null")
        spec.adapter_kwargs = dict(kw.pop("adapter_kwargs", {}))
        s = Synthesizer(spec, NullAligner(), VoiceLibrary(tmp_path / "voices"), workers=workers, candidates=candidates,
                        cache_dir=(tmp_path / "cache") if cache else None, **kw)
        made.append(s)
        return s

    yield _make
    for s in made:
        s.close()


@pytest.fixture
def svc(tmp_path, monkeypatch):
    """FireVoice service on the null engine with an isolated home (voices, styles, renders) and no Whisper."""
    monkeypatch.setenv("FIREVOICE_HOME", str(tmp_path / "home"))
    from firevoice.service import FireVoice
    s = FireVoice(default_engine="null")
    s._aligner = NullAligner()
    yield s
    s.close()
