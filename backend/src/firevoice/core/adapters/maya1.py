"""Maya1 (Maya Research, 3B, Apache-2.0, 24 kHz): the voice is a text description; 20 inline emotion tags.
venv: .envs/maya1. Prompt format and SNAC unpacking follow the model card."""
from __future__ import annotations

import re
from pathlib import Path

import numpy as np

from ...paths import weights
from .base import Adapter

WEIGHTS = weights("maya1")
BOS, EOT, SOH, EOH, SOA, CODE_START, CODE_END, OFFSET = 128000, 128009, 128259, 128260, 128261, 128257, 128258, 128266
TAGMAP = {"laugh": "<laugh>", "chuckle": "<chuckle>", "sigh": "<sigh>", "gasp": "<gasp>", "cough": "<cough>", "giggle": "<giggle>",
          "clear throat": "<clear_throat>", "sniff": "<sniffle>", "groan": "<groan>", "hmm": "<hmm>"}


class Maya1Adapter(Adapter):
    name = "maya1"
    sr = 24000
    needs_reference = False
    supports_tags = True
    supports_design = True
    license = "Apache-2.0"
    commercial = True
    vram_gb = 9.0

    def _load(self) -> None:
        import torch
        from snac import SNAC
        from transformers import AutoModelForCausalLM, AutoTokenizer
        src = str(WEIGHTS) if (WEIGHTS / "config.json").exists() else "maya-research/maya1"
        self.tok = AutoTokenizer.from_pretrained(src)
        self.m = AutoModelForCausalLM.from_pretrained(src, dtype=torch.bfloat16, device_map=self.device)
        self.snac = SNAC.from_pretrained("hubertsiuzdak/snac_24khz").eval().to(self.device)

    def _prepare_voice(self, ref_path, ref_text, desc):
        return {"desc": desc or "A warm, clear adult voice with natural delivery."}

    def _synth(self, text, cond, params, seed):
        import torch
        t = re.sub(r"\[(laugh|chuckle|sigh|gasp|cough|clear throat|sniff|groan|giggle|hmm)\]", lambda x: TAGMAP.get(x.group(1).lower(), ""), text, flags=re.I)
        body = f'<description="{(cond or {}).get("desc", "")}"> {t}'
        tok = self.tok
        prompt = tok.decode([SOH]) + tok.decode([BOS]) + body + tok.decode([EOT]) + tok.decode([EOH]) + tok.decode([SOA]) + tok.decode([CODE_START])
        ids = tok(prompt, return_tensors="pt", add_special_tokens=False).input_ids.to(self.device)
        with torch.inference_mode():
            out = self.m.generate(ids, max_new_tokens=int(params.get("max_new_tokens", 2048)), min_new_tokens=28, do_sample=True,
                                  temperature=float(params.get("temperature", 0.4)), top_p=float(params.get("top_p", 0.9)),
                                  repetition_penalty=float(params.get("repetition_penalty", 1.1)), eos_token_id=CODE_END, pad_token_id=tok.pad_token_id or EOT)
        gen = out[0, ids.shape[1]:].tolist()
        if CODE_END in gen:
            gen = gen[: gen.index(CODE_END)]
        codes = [c for c in gen if OFFSET <= c < OFFSET + 7 * 4096]
        n = len(codes) // 7
        if n == 0:
            return np.zeros(0, np.float32)
        l1, l2, l3 = [], [], []
        for i in range(n):
            f = [(codes[7 * i + k] - OFFSET) % 4096 for k in range(7)]
            l1.append(f[0]); l2 += [f[1], f[4]]; l3 += [f[2], f[3], f[5], f[6]]
        with torch.inference_mode():
            z = self.snac.quantizer.from_codes([torch.tensor(x, device=self.device).unsqueeze(0) for x in (l1, l2, l3)])
            wav = self.snac.decoder(z).squeeze().float().cpu().numpy()
        return wav[2048:]
