"""OmniVoice (k2-fsa, 0.6B, CC-BY-NC weights). venv: .envs/omnivoice
  --mode clone  : zero-shot clone from --ref + transcript
  --mode design : voice design from --voice-desc
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _common as C  # noqa: E402

W = C.ROOT / ".envs" / "weights" / "omnivoice"


def main():
    a = C.parse_args("omnivoice")
    engine = "omnivoice" if a.mode == "clone" else "omnivoice-design"
    if a.out.endswith("omnivoice") and a.mode == "design":
        a.out = a.out + "-design"

    def load():
        import torch
        from omnivoice import OmniVoice
        src = str(W) if W.exists() else "k2-fsa/OmniVoice"
        m = OmniVoice.from_pretrained(src, device_map="cuda:0", dtype=torch.float16)
        st = {}
        if a.mode == "clone":
            try:
                st["prompt"] = m.create_voice_clone_prompt(ref_audio=a.ref, ref_text=a.ref_text)
            except Exception:
                st["prompt"] = None
        return (m, st), 24000

    def synth(ms, text, item):
        m, st = ms
        if a.mode == "design":
            out = m.generate(text=text, language="English", instruct=a.voice_desc)
        elif st.get("prompt") is not None:
            out = m.generate(text=text, language="English", voice_clone_prompt=st["prompt"])
        else:
            out = m.generate(text=text, language="English", ref_audio=a.ref, ref_text=a.ref_text)
        return out[0]

    C.run(engine, a, load, synth, supports_tags=False, notes="OmniVoice 0.6B, CC-BY-NC, 24 kHz")


if __name__ == "__main__":
    main()
