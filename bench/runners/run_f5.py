"""F5-TTS v1 Base (CC-BY-NC weights). venv: .envs/f5"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _common as C  # noqa: E402


def main():
    a = C.parse_args("f5")

    def load():
        from f5_tts.api import F5TTS
        m = F5TTS(model="F5TTS_v1_Base")
        return m, 24000

    def synth(m, text, item):
        wav, sr, _ = m.infer(ref_file=a.ref, ref_text=a.ref_text, gen_text=text, nfe_step=32, cfg_strength=2.0, seed=a.seed, show_info=lambda *x: None, progress=None)
        return wav

    C.run("f5", a, load, synth, supports_tags=False, notes="F5-TTS v1 Base, CC-BY-NC weights, 24 kHz, flow matching")


if __name__ == "__main__":
    main()
