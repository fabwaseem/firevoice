"""VoxCPM2 (OpenBMB). venv: .envs/voxcpm
  --mode clone  : controllable cloning (reference audio only, no transcript)
  --mode ultimate: continuation cloning (reference + exact transcript), best similarity
  --mode design : voice design from --voice-desc (text in parentheses)
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _common as C  # noqa: E402

W = C.ROOT / ".envs" / "weights" / "voxcpm2"


def main():
    a = C.parse_args("voxcpm")
    engine = "voxcpm" if a.mode == "clone" else f"voxcpm-{a.mode}"
    if a.out.endswith("voxcpm") and a.mode != "clone":
        a.out = a.out + "-" + a.mode

    def load():
        from voxcpm import VoxCPM
        src = str(W) if W.exists() else "openbmb/VoxCPM2"
        m = VoxCPM.from_pretrained(src, load_denoiser=False, optimize=False)
        return m, int(m.tts_model.sample_rate)

    def synth(m, text, item):
        if a.mode == "design":
            return m.generate(text=f"({a.voice_desc}) {text}", cfg_value=2.0, inference_timesteps=10)
        if a.mode == "ultimate":
            return m.generate(text=text, prompt_wav_path=a.ref, prompt_text=a.ref_text, reference_wav_path=a.ref, cfg_value=2.0, inference_timesteps=10)
        return m.generate(text=text, reference_wav_path=a.ref, cfg_value=2.0, inference_timesteps=10)

    C.run(engine, a, load, synth, supports_tags=False, notes="VoxCPM2 2B, Apache-2.0, 48 kHz")


if __name__ == "__main__":
    main()
