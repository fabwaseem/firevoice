"""Stage `listen` (runs in .envs/judge): UTMOSv2 naturalness MOS, emotion2vec+ large emotion classes and the
audEERING arousal / dominance / valence regressor for every clip. Writes judge/listen.jsonl (resumable).

    .envs/judge/Scripts/python.exe -m firevoice.judge.listen samples/voxcpm2
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import soundfile as sf
import torch

W = Path(__file__).resolve().parents[3] / ".envs" / "weights"


def load(path: str, sr_to: int | None = None) -> tuple[np.ndarray, int]:
    a, sr = sf.read(path, dtype="float32", always_2d=False)
    if a.ndim > 1:
        a = a.mean(axis=1)
    if sr_to and sr != sr_to:
        import librosa
        a, sr = librosa.resample(a, orig_sr=sr, target_sr=sr_to), sr_to
    return a.astype(np.float32), sr


class UTMOS:
    def __init__(self, dev):
        from transformers import AutoModel
        self.m = AutoModel.from_pretrained(str(W / "utmosv2"), trust_remote_code=True).eval().to(dev)
        self.dev = dev

    @torch.inference_mode()
    def __call__(self, a: np.ndarray, sr: int) -> float:
        return float(self.m(torch.from_numpy(a).to(self.dev), sampling_rate=sr).scores[0])


class AVD:
    """audEERING wav2vec2-large-robust-12-ft-emotion-msp-dim (MSP-Podcast): arousal, dominance, valence in ~0..1."""

    def __init__(self, dev):
        from torch import nn
        from transformers import Wav2Vec2FeatureExtractor, Wav2Vec2Model, Wav2Vec2PreTrainedModel

        class RegressionHead(nn.Module):
            def __init__(self, config):
                super().__init__()
                self.dense = nn.Linear(config.hidden_size, config.hidden_size)
                self.dropout = nn.Dropout(config.final_dropout)
                self.out_proj = nn.Linear(config.hidden_size, config.num_labels)

            def forward(self, x):
                return self.out_proj(self.dropout(torch.tanh(self.dense(self.dropout(x)))))

        class EmotionModel(Wav2Vec2PreTrainedModel):
            def __init__(self, config):
                super().__init__(config)
                self.wav2vec2 = Wav2Vec2Model(config)
                self.classifier = RegressionHead(config)
                self.init_weights()

            def forward(self, input_values):
                h = self.wav2vec2(input_values)[0].mean(dim=1)
                return self.classifier(h)

        p = str(W / "audeering-msp-dim")
        self.fe = Wav2Vec2FeatureExtractor.from_pretrained(p)
        self.m = EmotionModel.from_pretrained(p).eval().to(dev)
        self.dev = dev

    @torch.inference_mode()
    def __call__(self, a16: np.ndarray) -> dict:
        x = self.fe(a16, sampling_rate=16000, return_tensors="pt").input_values.to(self.dev)
        ar, dom, val = self.m(x)[0].float().cpu().tolist()
        return {"arousal": round(ar, 4), "dominance": round(dom, 4), "valence": round(val, 4)}


class Emo2Vec:
    """emotion2vec+ large: angry, disgusted, fearful, happy, neutral, other, sad, surprised, unknown."""

    def __init__(self, dev):
        from funasr import AutoModel
        self.m = AutoModel(model=str(W / "emotion2vec-plus-large"), device=dev, disable_update=True, disable_pbar=True, log_level="ERROR")

    def __call__(self, a16: np.ndarray) -> dict:
        r = self.m.generate(a16, granularity="utterance", extract_embedding=False, disable_pbar=True)[0]
        out = {}
        for lab, s in zip(r["labels"], r["scores"]):
            out[lab.split("/")[-1]] = round(float(s), 4)
        return out


def run(samples_dir: str, part: str = "emotion") -> int:
    """part="emotion": emotion2vec+ and arousal/valence/dominance -> listen.jsonl
    part="utmos": UTMOSv2 (runs the model's own code from its Hugging Face repo, trust_remote_code) -> utmos.jsonl"""
    jd = Path(samples_dir) / "judge"
    clips = json.loads((jd / "clips.json").read_text(encoding="utf-8"))["clips"]
    out = jd / ("utmos.jsonl" if part == "utmos" else "listen.jsonl")
    done = set()
    if out.exists():
        done = {json.loads(l)["key"] for l in out.read_text(encoding="utf-8").splitlines() if l.strip()}
    todo = [c for c in clips if c["key"] not in done]
    print(f"listen: {len(todo)} of {len(clips)} clips", flush=True)
    if not todo:
        return 0
    dev = "cuda" if torch.cuda.is_available() else "cpu"
    if part == "utmos":
        utmos = UTMOS(dev)
    else:
        avd, e2v = AVD(dev), Emo2Vec(dev)
    with open(out, "a", encoding="utf-8") as fh:
        for i, c in enumerate(todo, 1):
            if part == "utmos":
                a, sr = load(c["file"])
                rec = {"key": c["key"], "utmos": round(utmos(a, sr), 4)}
            else:
                a16, _ = load(c["file"], 16000)
                rec = {"key": c["key"], **avd(a16), "emotion": e2v(a16)}
            fh.write(json.dumps(rec) + "\n")
            fh.flush()
            if i % 50 == 0:
                print(f"  {i}/{len(todo)} {c['key']}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(run(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else "emotion"))
