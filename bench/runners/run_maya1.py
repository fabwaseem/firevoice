"""Maya1 (Maya Research, 3B, Apache-2.0). Voice from a text description, 20 emotion tags, no cloning. venv: .envs/maya1

Prompt format and SNAC unpacking follow the model card's transformers example.
"""
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _common as C  # noqa: E402

W = C.ROOT / ".envs" / "weights" / "maya1"
BOS, EOT, SOH, EOH, SOA, CODE_START, CODE_END, OFFSET = 128000, 128009, 128259, 128260, 128261, 128257, 128258, 128266
TAGMAP = {"laugh": "<laugh>", "chuckle": "<chuckle>", "sigh": "<sigh>", "gasp": "<gasp>", "cough": "<cough>", "giggle": "<giggle>", "clear throat": "<clear_throat>", "sniff": "<sniffle>", "groan": "<groan>", "hmm": "<hmm>"}


def main():
    a = C.parse_args("maya1")
    a.mode = "design"

    def load():
        import torch
        from snac import SNAC
        from transformers import AutoModelForCausalLM, AutoTokenizer
        src = str(W) if W.exists() else "maya-research/maya1"
        tok = AutoTokenizer.from_pretrained(src)
        m = AutoModelForCausalLM.from_pretrained(src, dtype=torch.bfloat16, device_map="cuda:0")
        snac = SNAC.from_pretrained("hubertsiuzdak/snac_24khz").eval().to("cuda")
        return (m, tok, snac), 24000

    def synth(ms, text, item):
        import re
        import torch
        m, tok, snac = ms
        t = re.sub(r"\[(laugh|chuckle|sigh|gasp|cough|clear throat|sniff|groan|giggle|hmm)\]", lambda x: TAGMAP.get(x.group(1).lower(), ""), text, flags=re.I)
        body = f'<description="{a.voice_desc}"> {t}'
        prompt = tok.decode([SOH]) + tok.decode([BOS]) + body + tok.decode([EOT]) + tok.decode([EOH]) + tok.decode([SOA]) + tok.decode([CODE_START])
        ids = tok(prompt, return_tensors="pt", add_special_tokens=False).input_ids.to("cuda")
        with torch.inference_mode():
            out = m.generate(ids, max_new_tokens=2048, min_new_tokens=28, do_sample=True, temperature=0.4, top_p=0.9, repetition_penalty=1.1, eos_token_id=CODE_END, pad_token_id=tok.pad_token_id or EOT)
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
            z = snac.quantizer.from_codes([torch.tensor(x, device="cuda").unsqueeze(0) for x in (l1, l2, l3)])
            wav = snac.decoder(z).squeeze().float().cpu().numpy()
        return wav[2048:]

    C.run("maya1", a, load, synth, supports_tags=True, notes="Maya1 3B, Apache-2.0, 24 kHz, description-designed voice")


if __name__ == "__main__":
    main()
