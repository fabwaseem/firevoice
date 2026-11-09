"""Chatterbox Turbo (baseline). venv: firevoice/.venv"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _common as C  # noqa: E402


def main():
    a = C.parse_args("chatterbox")

    def load():
        import torch
        from chatterbox.tts_turbo import ChatterboxTurboTTS
        m = ChatterboxTurboTTS.from_pretrained(device="cuda" if torch.cuda.is_available() else "cpu")
        m.prepare_conditionals(a.ref, norm_loudness=True)
        return m, int(m.sr)

    def synth(m, text, item):
        w = m.generate(text, temperature=0.8, top_p=0.95, repetition_penalty=1.2, norm_loudness=False)
        return w.squeeze()

    C.run("chatterbox", a, load, synth, supports_tags=True, notes="Chatterbox Turbo 350M, MIT, 24 kHz, PerTh watermark")


if __name__ == "__main__":
    main()
