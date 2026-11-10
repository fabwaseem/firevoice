"""IndexTTS-2 (Bilibili, non-commercial license). Emotion control via text description. venv: .envs/indextts
Repo code is imported from .envs/indextts-repo (not pip-installed); checkpoints from .envs/weights/indextts-2.
  --emo  : when set, derives emotion from the item's style (horror -> afraid/sad mix, excited -> happy ...)
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _common as C  # noqa: E402

REPO = C.ROOT / ".envs" / "indextts-repo"
W = C.ROOT / ".envs" / "weights" / "indextts-2"
# 8-float emotion vectors: happy, angry, sad, afraid, disgusted, melancholic, surprised, calm
EMO = {
    "horror": [0, 0, 0.2, 0.7, 0, 0.3, 0.2, 0],
    "excited": [0.8, 0, 0, 0, 0, 0, 0.5, 0],
    "calm": [0, 0, 0, 0, 0, 0, 0, 1.0],
    "storyteller": [0.2, 0, 0.1, 0, 0, 0.2, 0.1, 0.5],
    "explainer": [0.3, 0, 0, 0, 0, 0, 0.1, 0.6],
    "conversational": [0.3, 0, 0, 0, 0, 0, 0.1, 0.5],
}


def main():
    a = C.parse_args("indextts", extra=lambda p: p.add_argument("--emo", action="store_true"))
    engine = "indextts-emo" if a.emo else "indextts"
    if a.out.endswith("indextts") and a.emo:
        a.out += "-emo"
    sys.path.insert(0, str(REPO))

    def load():
        import os
        os.chdir(REPO)
        from indextts.infer_v2 import IndexTTS2
        m = IndexTTS2(cfg_path=str(W / "config.yaml"), model_dir=str(W), use_fp16=True, use_cuda_kernel=False, use_deepspeed=False)
        return m, 22050

    def synth(m, text, item):
        import tempfile
        import soundfile as sf
        tmp = Path(tempfile.mkdtemp()) / "o.wav"
        kw = {}
        if a.emo:
            kw = dict(emo_vector=EMO.get(item.get("style"), EMO["conversational"]), emo_alpha=0.8)
        m.infer(spk_audio_prompt=a.ref, text=text, output_path=str(tmp), verbose=False, **kw)
        wav, sr = sf.read(str(tmp), dtype="float32")
        synth.sr = sr
        return wav

    C.run(engine, a, load, synth, supports_tags=False, notes="IndexTTS-2, bilibili non-commercial license, emotion vectors")


if __name__ == "__main__":
    main()
