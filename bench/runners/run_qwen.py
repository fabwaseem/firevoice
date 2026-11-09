"""Qwen3-TTS 12Hz 1.7B. venv: .envs/qwen
  --mode clone   : Base model, zero-shot clone from --ref (+ transcript)
  --mode design  : VoiceDesign model, voice from --voice-desc
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _common as C  # noqa: E402

W = C.ROOT / ".envs" / "weights"


def main():
    a = C.parse_args("qwen")
    engine = "qwen-design" if a.mode == "design" else "qwen"
    if a.out.endswith("qwen") and a.mode == "design":
        a.out = a.out + "-design"

    def load():
        import torch
        from qwen_tts import Qwen3TTSModel
        path = W / ("qwen3-tts-1.7b-voicedesign" if a.mode == "design" else "qwen3-tts-1.7b-base")
        src = str(path) if path.exists() else ("Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign" if a.mode == "design" else "Qwen/Qwen3-TTS-12Hz-1.7B-Base")
        m = Qwen3TTSModel.from_pretrained(src, device_map="cuda:0", dtype=torch.bfloat16, attn_implementation="sdpa")
        st = {"sr": 24000}
        if a.mode != "design":
            st["prompt"] = m.create_voice_clone_prompt(ref_audio=a.ref, ref_text=a.ref_text)
        return (m, st), 24000

    def synth(ms, text, item):
        m, st = ms
        if a.mode == "design":
            wavs, sr = m.generate_voice_design(text=text, language="English", instruct=a.voice_desc)
        else:
            wavs, sr = m.generate_voice_clone(text=text, language="English", voice_clone_prompt=st["prompt"])
        st["sr"] = sr
        return wavs[0]

    C.run(engine, a, load, synth, supports_tags=False, notes="Qwen3-TTS 1.7B, Apache-2.0, 12Hz codec, 24 kHz")


if __name__ == "__main__":
    main()
