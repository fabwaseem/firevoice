# FireVoice: open-source models and tools worth adding (November 2026)

Research snapshot, 2026-11-09. Target box: one RTX 5080 (16 GB, Blackwell sm_120), Windows 11, FastAPI backend, one venv and one worker process per engine.

What FireVoice already has (not re-evaluated here except as a baseline): VoxCPM2 (main), OmniVoice, Chatterbox and Chatterbox-Turbo, Qwen3-TTS (+ design), dots, IndexTTS-2, Breeze TTS 2, F5-TTS, Kokoro, Maya1; faster-whisper for STT and validation; SpeechJudge-GRM, UTMOSv2 and emotion2vec for judging; resemblyzer for speaker similarity (seen in `judge/metrics.py`).

## How to read this report

- **Evidence grades.** `[ind]` means an independent leaderboard or third-party benchmark. `[vendor]` means numbers from the model's own authors. `[weak]` means aggregator or blog claims only. `(verify)` means I could not confirm the fact from a primary source; check the model card before relying on it.
- **License classes.** `P` = permissive (Apache-2.0, MIT, BSD). `A` = attribution or open-model licences that allow commercial use (CC-BY-4.0, NVIDIA Open Model License, OpenMDW). `C` = custom community licence with conditions (revenue caps, geofences, attribution, no hosted service). `NC` = research or non-commercial only. `GPL` = copyleft.
- **Code column.** `pip` = installs as a normal package. `repo` = you run code from a cloned repo (pin a commit). `TRC` = needs `trust_remote_code=True` in transformers (pin the HF `revision`). `Linux` = needs Linux or WSL2.
- **VRAM.** "Fits" means fits in 16 GB with the other engines unloaded. FireVoice's worker pool should keep only one heavy model resident.
- Arena Elo below is the Artificial Analysis open-weights Speech Arena as fetched on 2026-11-09 `[ind]`.

## Cross-cutting Windows and Blackwell notes

1. **sm_120 needs CUDA 12.8+ and PyTorch 2.7+.** Repos that pin torch 2.1 to 2.5 install but fail at the first CUDA kernel. Budget a "bump torch, re-test" step for every repo-based engine.
2. **Linux-only serving stacks.** vLLM, vLLM-Omni, SGLang(-Omni), Nano-vLLM (flash-attn plus Triton), NVIDIA NeMo and Meta fairseq2 (Omnilingual ASR) are Linux-first. On this box they mean a **WSL2 worker**. FireVoice's one-process-per-engine design already suits this: run the worker inside WSL2 and talk to it over localhost HTTP. Keep model files on the WSL ext4 disk; reading them across `/mnt/d` is slow.
3. **Painful native dependencies on Windows:** `pynini` (no Windows wheels; conda-forge only), `deepspeed` (Resemble Enhance), `flash-attn` (community wheels only, tied to exact torch and CUDA versions), `triton` (use `triton-windows`), and Montreal Forced Aligner (conda).
4. **Remote code is supply-chain risk.** For every `repo` or `TRC` entry, pin the git commit or HF `revision` hash in the engine manifest. Per-engine venvs isolate dependencies, not security.

---

## 1. Newer TTS models (2025-2026) FireVoice lacks

### 1a. Main comparison

| Model (org, date) | Size | License | VRAM / 16 GB | Strengths for FireVoice | Streaming | Code | Evidence |
|---|---|---|---|---|---|---|---|
| **Ming-3.0-tts-0.5B** (inclusionAI / Ant Group, Oct 2026) | 0.5B dense | P (MIT) | ~3 GB bf16; fits easily | Voice design from text, 14 inline paralinguistic tags (breath, cough, sigh, laughter, hesitation and more), "director mode" for emotion, pace and emphasis, built-in voices | Native Python path unclear; the SGLang-Omni server does not stream progressively | repo; needs `pynini==2.1.6` for text normalisation (conda on Windows) | Arena Elo 1187 for the family, #4 open weights and the best permissive model `[ind]`; claimed #1 open weights on AA Controlled Voice `[weak]`. Only 7 languages (zh, en, es, fr, de, ko, ja); weaker than Qwen3-TTS at open-ended voice design `[weak]` |
| **Ming-3.0-tts-tiny** (same) | 7.9B MoE, 1.3B active | P (MIT) | ~18 GB bf16; needs 8-bit or offload | Cloning, long-form narration, multi-speaker dialogue | As above | repo | Same family Elo; reviewers say it is not yet a safe pick for a 24 GB desktop card `[weak]` |
| **MOSS-TTS v1.5** (OpenMOSS / MOSI.AI, May 2026) | 8B | P (Apache-2.0) | Too big in bf16; README says 8 GB GPUs via its llama.cpp pipeline | Long-form, zero-shot cloning, `[pause X.Ys]` control, duration control, Pinyin and IPA, code-switching; 31 languages incl. Hindi and Persian (no Urdu) | Offline | TRC (`AutoModel`, `AutoProcessor`) | v1.5 claims better speaker similarity and less clone variance `[vendor]` |
| **MOSS-TTS-Local-Transformer v1.5** (Jun 2026) | 4B | P | ~8-10 GB bf16 (estimate); fits | 48 kHz stereo output (matches VoxCPM2's 48 kHz); cloning | Realtime streaming-decode examples | TRC | `[vendor]` |
| **MOSS-TTSD v1.0** (Feb 2026) | 8B | P | Quantise or llama.cpp | Multi-speaker dialogue, podcasts, dubbing | Offline | TRC | `[vendor]` |
| **MOSS-VoiceGenerator** | 1.7B | P | Fits | Voice design from a text prompt | - | TRC | `[vendor]` |
| **MOSS-TTS-Realtime** | 1.7B | P | Fits | Voice-agent streaming, multi-turn context, 180 ms TTFB claimed | Yes | TRC | `[vendor]` |
| **Audio8-TTS-Realistic** (Edge0, Oct 2026) | 0.6B | P (Apache-2.0, code and weights) | Small; fits | 23 languages incl. Hindi and Arabic (Urdu not listed); one-clip cloning | (verify) | (verify) | CV3 error 4.86%, reported better than Qwen3-TTS-1.7B and VoxCPM2; Higgs TTS 3 still leads CV3 `[vendor, via MarkTechPost]`. A Russian review flags weak low-resource output (Thai WER ~49%) `[weak]`. Under three weeks old |
| **Step-Audio-EditX** (StepFun, Nov 2025; Mar 2026 update) | 3B | P (Apache-2.0) | Official 32 GB; ComfyUI users report 10-12 GB; Int8 checkpoint exists | **Edits existing audio**: emotion, speaking style and paralinguistics, applied iteratively. It works on any engine's output, which makes it unique here | No | repo | Arena Elo 1101 `[ind]` |
| **IndexTTS-2.5** (Bilibili IndexTeam, Jan 2026) | ~IndexTTS-2 class | C (Bilibili Model License; verify it matches IndexTTS-2's) | ~6 GB reported | Drop-in upgrade for the existing IndexTTS-2 adapter: 2.28x faster, speech-rate control, adds ja, es, ar | Offline | repo | `[vendor]` paper arXiv 2601.03888 |
| **Dia2-1B / 2B** (Nari Labs) | 1-2B | P (Apache-2.0; the Mimi codec keeps its own licence) | Fits | English dialogue with non-verbals; starts speaking from the first few words of text | Model-level yes; streaming server still on the roadmap | repo or pip | English only, at most 2 min per generation `[vendor]` |
| **VibeVoice-Realtime-0.5B** (Microsoft, Dec 2025) | 0.5B | P (MIT) | Fits | ~300 ms to first audio; accepts streaming text input | Yes | repo | English, single speaker `[vendor]` |
| **VibeVoice 1.5B** (Microsoft, Aug 2025) | 1.5B | P (MIT; upstream repo was pulled in Sep 2025 over misuse, so check status) | Fits | Up to ~90 min, up to 4 speakers, podcast style | No | repo | Arena Elo 953 `[ind]`, which is low for single utterances |
| **Kyutai Pocket TTS** (Jan 2026; 5 more languages by Apr-May 2026; training code Aug 2026) | 100M | Code MIT; weights CC-BY-4.0 (verify); per-voice licences | CPU real-time | CPU fallback, instant previews, cloning | Yes | pip | `[vendor]` |
| **Gradium Phonon 31M** (Oct 2026) | 31M | P (Apache-2.0); the 40M variants are NC | 64 MB q8 GGUF | Tiny English preview voice | Yes | pip `ptts`, Transformers | Arena Elo 1114 `[ind]`; no open cloning |
| **NVIDIA Magpie TTS Multilingual** (v2607, Jul 2026) | 357-364M | A (NVIDIA Open Model License, commercial OK) | Fits | 12 languages incl. Hindi and Arabic; very low latency | Yes | NeMo (Linux/WSL2) or GGUF port | Arena Elo 1064 `[ind]`; **no zero-shot cloning** |
| **Fun-CosyVoice3-0.5B** (Alibaba, Dec 2025) | 0.5B | P (Apache-2.0, verify) | Fits | Bi-stream (text-in, audio-out) streaming; pronunciation control; Chinese dialects | Yes, true dual-stream | repo with submodules | (verify) |
| **SoulX-Podcast** (Soul AI, Oct 2025) | ~1.7B | P (Apache-2.0, verify) | Fits | Multi-speaker podcast dialogue, dialects, paralinguistics | No | repo | (verify) |

### 1b. Strong but licence- or VRAM-blocked (benchmark-only or watch list)

| Model | Why notable | Blocker |
|---|---|---|
| **Fish Audio Drama 3** (Oct 2026), 35B MoE (3B active) | #1 open-weights Elo 1275 `[ind]`; word-level infilling (replace one word and keep the timbre); ~80 languages in pre-training | Community licence: free under US$500k revenue, "Built with Fish Audio" attribution, no hosted service; the HF tag still says research licence, so verify. ~46 GB bf16; Q3 or Q4 GGUF is ~17-20 GB, so it **does not fit 16 GB without CPU offload** |
| **Fish Audio S2 Pro** (Mar 2026) | Elo 1108 `[ind]`; free-form inline tags such as `[laugh]` and `[whispers]`; 80+ languages; FP8 build ~12 GB | Fish Audio Research License (NC) |
| **Higgs Audio v3 TTS 4B** (Boson, Jun 2026) | 100+ languages (probably covers Urdu); vLLM-Omni recipe; leads CV3 `[vendor]` | Research and NC licence; Elo 1039 |
| **Voxtral TTS** (Mistral, Mar 2026), ~4B | Elo 1092; 3 s cloning; 9 languages incl. Hindi and Arabic; ~16 GB | CC-BY-NC-4.0 |
| Breeze TTS 2 (already installed) | Elo 1228, #3 open weights | Weights **and outputs** are NC under the BreezeBlue licence. Label that engine NC in the UI |

### 1c. Urdu specifically

No 2025-2026 permissive, high-quality TTS model I found lists Urdu. The practical options:

| Option | Licence | Notes |
|---|---|---|
| **OmniVoice** (already installed) | - | 600+ languages including Urdu; remains the main Urdu path |
| Hindi-capable engines fed Roman Urdu | varies | VoxCPM2, MOSS-TTS v1.5, Audio8, Chatterbox Multilingual, Magpie and Voxtral all do Hindi. Spoken Hindustani overlaps heavily with Urdu, so Roman Urdu input often comes out as acceptable Hindustani with Hindi-leaning vocabulary and pronunciation (for example "z", "q" and "kh" sounds get flattened). Worth a bake-off with Urdu-native listeners |
| Fish S2 Pro / Drama 3, Higgs v3 | NC / C | Broad language coverage, probably including Urdu (verify); fine for personal use only |
| XTTS-v2 Urdu fine-tune (`suhaibrashid17/XTTS-v2-Urdu-FT`) | Card says MIT, but the XTTS-v2 base is Coqui CPML (NC), so treat it as NC | Needs sentence splitting; takes Urdu-script input |
| MMS-TTS `urd` (Meta) and Matcha Urdu | NC / varies | Single speaker, fast, no cloning; useful as an intelligibility reference |

Recommendation: keep OmniVoice as the Urdu engine and run a listening bake-off of VoxCPM2 and Audio8 with Roman Urdu. If OmniVoice Urdu is good but its timbre is weak, add a **VC post-pass** (section 2) to restore the target voice.

---

## 2. Speech-to-speech voice conversion

Two uses for FireVoice: (a) **performance transfer**, where the user records the line with the delivery they want and VC swaps in the cloned voice (the most reliable route to exact emotion and timing); (b) **timbre repair**, where an engine with good prosody but weak speaker similarity is converted toward the reference.

| Tool | License | VRAM / speed | Zero-shot? | Singing | Streaming | Windows | Code | Notes / evidence |
|---|---|---|---|---|---|---|---|---|
| **Chatterbox VC** (`ChatterboxVC` in the installed `chatterbox-tts` package) | P (MIT) | Small; fast | Yes | No | No | Native (already works) | pip | Uses the S3Gen decoder already in the Chatterbox venv, at 24 kHz; applies the PerTh watermark. **Lowest-cost VC to add** |
| **Seed-VC** (v1 DiT plus v2 AR) | GPL-3.0 (weights and code) | ~4-8 GB; real-time variant | Yes | Yes (44.1 kHz SVC model) | Yes (real-time GUI) | Works | repo | De-facto open zero-shot VC baseline in 2025-2026 papers (R2-SVC, HQ-SVC compare against it) `[ind]`. v2 adds accent and emotion conversion. Keep GPL code inside its own worker process and never import it into the FastAPI app |
| **RVC / Applio 3.6.3** (Jun 2026) | P (MIT) | 2-4 GB; real-time | **No**, needs a per-voice trained model (~10-30 min of audio) | Yes, very strong | Yes | Native, the most Windows-friendly | repo / app | Applio reportedly entered maintenance mode in 2026 `[weak]`. Best for one or two "hero" voices that the user trains once |
| **OpenVoice v2** tone-colour converter | P (MIT) | Tiny; fast | Yes | No | Near | Works | repo | Lower fidelity than Seed-VC; as a TTS it sits at Elo 956 `[ind]`. Fallback only |
| **MeanVC2** (ASLP-lab, 2026) | Unclear: one mirror says Apache-2.0, the official card says research and non-commercial | 18M parameters | Yes | No | 110 ms end-to-end | Probably fine (small torch model) | repo | arXiv 2606.09050 `[vendor]`. Best low-latency candidate; check the licence |
| **Beatrice v2** (via w-okada voice-changer) | Proprietary freeware | Very light | No (pretrained voices) | - | Very low latency | Windows builds | app | Live monitoring only; not suitable to embed |
| CosyVoice 2/3 VC mode | P (Apache-2.0) | Fits | Yes | No | - | repo | repo | Usable if CosyVoice3 is added as an engine anyway |
| Scenema Audio (2026) | Inference code reportedly MIT | ? | Yes, disentangles identity and emotion | - | - | ? | ? | One news source only `[weak]`; watch list |

Recommendation: expose Chatterbox VC first (no new venv), then add Seed-VC as its own GPL-isolated worker for emotion-preserving and singing conversion.

---

## 3. Speech enhancement, denoising, dereverb, isolation, super-resolution

Most valuable placement: **clean the clone reference before cloning.** Clone quality is bounded by the reference, so noise, room reverb and a narrow band get copied into every output. Second placement: optional upsampling of 24 kHz engines to 48 kHz so they match VoxCPM2 output in mixed projects.

| Tool | Task | License | Rate | VRAM / speed | Windows | Code | Notes |
|---|---|---|---|---|---|---|---|
| **Sidon** (SaruLab, 2025; v0.1) | Denoise + dereverb + bandwidth restore (Miipher-style) | P (MIT per the GGUF repack; verify on the official repo) | Outputs 48 kHz | w2v-BERT 2.0 (600M) + DAC; GPU needed for speed | Pure torch; ONNX and GGUF ports exist | repo / HF | Trained on 4.5M hours in 143 languages and reported comparable to Google's Miipher `[vendor]`. Multilingual, which matters for Urdu references. **Top pick for reference cleanup** |
| **ClearerVoice-Studio** (Alibaba Tongyi) | `MossFormer2_SE_48K` enhancement, `MossFormer2_SR_48K` super-resolution, separation, target-speaker extraction | P (Apache-2.0) | 48 kHz | Moderate | pip `clearvoice` works | pip | SR is trained on clean speech, so run SE first and SR second (model card) `[vendor]` |
| **DeepFilterNet3** | Real-time denoise | P (MIT / Apache dual) | 48 kHz | CPU real-time | Prebuilt wheels | pip `deepfilternet` | Denoise only; mild and safe; good default pre-pass |
| **LavaSR** | Fast bandwidth extension (8-48 kHz to 48 kHz), optional denoise | P (Apache-2.0) | 48 kHz | Very fast (Vocos-based) | Should work | repo | Cheap upsampler for Kokoro, Chatterbox and other 24 kHz engines |
| Resemble Enhance | Denoise + enhance + BWE | P (MIT) | 44.1 kHz | ~4 GB | `deepspeed` dependency is painful | pip | Can hallucinate on hard input; superseded by Sidon |
| AudioSR | Generic audio SR | Code MIT (check weights) | 48 kHz | Slow diffusion | Works | pip | Slow; prefer LavaSR or MossFormer2_SR |
| NVIDIA A2SB | BWE and inpainting | NC | 44.1 kHz | Heavy | - | repo | Licence-blocked |
| **SAM Audio** (Meta, Dec 2025) | **Text-prompted separation** ("female narration", "keyboard typing"); span and visual variants | C (SAM License, gated HF) | 48 kHz? (verify) | small ~6 GB, large ~10-11 GB; a "lite" wrapper reports ~3-4 GB | Works in Python; GGUF port exists | repo | Excellent for **voice harvest**: pull a voice out of noisy source material by description |
| **python-audio-separator** (UVR model zoo) | Vocal/music separation (BS-RoFormer, Mel-Band RoFormer), de-reverb, de-echo, de-noise | Package MIT; model licences vary | 44.1 kHz | 2-6 GB | Native | pip | Workhorse for dubbing (keep the music and effects bed, replace the dialogue) |
| Demucs v4 | 4-stem separation | P (MIT) | 44.1 kHz | ~3 GB | Native | pip | Archived upstream; RoFormer models now beat it |

Guardrails: enhancement can remove breaths and "air" and make a clone sound processed. Keep the raw file, store the cleaned version alongside it, and A/B test the cloned output with UTMOSv2 plus a speaker-similarity check against the raw reference.

---

## 4. Sound effects, ambience and music

| Model | Task | License | VRAM / speed | Windows | Code | Notes |
|---|---|---|---|---|---|---|
| **Stable Audio 3 Small SFX** (May 2026) | Text-to-SFX and ambience | C (Stability AI Community License: free under US$1M annual revenue) | ~0.45B DiT; ~2 GB peak reported; CPU-capable | Yes (also ComfyUI) | repo `stable-audio-3`, gated HF | Trained on licensed data; LoRA training documented. **Best small SFX model** |
| Stable Audio 3 Small / Medium (music) | Music up to ~6 min | C (same) | Small fits easily; Medium probably fits (verify) | Yes | repo | Large (2.7B) is API-only |
| **MOSS-SoundEffect v2.0** (May 2026) | Text-to-SFX, 48 kHz, up to 30 s | P (Apache-2.0) | 1.3B DiT; fits | Probably | TRC / repo | Permissive alternative to SA3; bilingual prompts |
| Stable Audio Open 1.0 / Open Small | SFX up to 47 s, 44.1 kHz stereo | C | ~1.2B / ~0.3B | Yes | repo / diffusers | Older; trained on CC-licensed data |
| **ACE-Step 1.5** (early 2026; XL 4B DiT added Apr 2026) | Song and instrumental generation with lyrics | P (MIT; the card says outputs are usable commercially) | Under 4 GB; under 10 s per song on an RTX 3090 `[vendor]` | Yes | repo | SongEval 8.09, claimed above Suno v5 on that metric `[vendor]`; listeners place it between Suno v4.5 and v5 `[weak]`. **Best music-bed choice** |
| MMAudio | Video- or text-to-audio, synced foley | Code MIT, weights CC-BY-NC | ~6 GB | Yes | repo | Common V2A baseline; NC weights |
| HunyuanVideo-Foley (+XL) | Video-to-foley | C (Tencent Hunyuan community licence: excludes EU, UK and South Korea; verify) | Heavy | ? | repo | Strong claims `[vendor]`; licence geofence |
| ThinkSound | Video/text-to-audio with chain-of-thought | Card says Apache-2.0, but the README says research and education only, and the bundled VAE is under the Stability licence | Moderate | ? | repo | Treat as NC |
| Sony Woosh (May 2026) | Text- and video-to-SFX | NC weights | ? | ? | repo | Watch list |
| YuE, DiffRhythm | Lyrics-to-song | P (Apache-2.0) | YuE is heavy | - | repo | Superseded by ACE-Step 1.5 for local use |

Fit for FireVoice: ambience beds under narration ("rain on a window, distant traffic") and a music bed, mixed with ducking under speech. Add a loudness and side-chain step (pyloudnorm plus simple gain automation) rather than another model.

---

## 5. Alignment, word timestamps, diarization and ASR (including Urdu)

### 5a. Forced alignment and word timestamps

| Tool | License | Languages | Windows | Code | Notes |
|---|---|---|---|---|---|
| **WhisperX** | P (BSD-2) | wav2vec2 CTC models per language, including Urdu (`kingabzpro/wav2vec2-large-xls-r-300m-Urdu`) and Hindi | Native | pip | Uses its own trellis and backtrack code, so it is **not affected by torchaudio's forced-align removal**; reuses faster-whisper; optional pyannote diarization |
| **ctc-forced-aligner** (MahmoudAshraf97) on the MMS-300m-1130 aligner | Code BSD-style; the MMS aligner weights are CC-BY-NC | ~1,130 languages via `uroman` romanisation | Native | pip from git | **Aligns romanised text natively**, which fits FireVoice's Roman Urdu convention: no script conversion needed to align a Roman Urdu script against audio |
| **Qwen3-ForcedAligner-0.6B** (Jan 2026) | P (Apache-2.0) | 11 languages (zh, en, yue, fr, de, it, ja, ko, pt, ru, es); no Hindi or Urdu | Native | pip `qwen-asr` | Non-autoregressive; word or character timestamps for up to 5 min of audio |
| torchaudio `MMS_FA` / `forced_align` | BSD | Many | - | pip | Deprecated in 2.8 and slated for removal in 2.9 (docs are inconsistent). Do not build on it; pin torchaudio 2.8 if something depends on it |
| Montreal Forced Aligner 3.x | P (MIT) | Urdu dictionary exists (CC-BY-4.0); I found no Urdu acoustic model | conda | conda | Phone-level precision for research; heavy on Windows. A 2026 paper surveys the state of the art (arXiv 2606.18466) |
| faster-whisper `word_timestamps` (already installed) | MIT | All Whisper languages | Native | - | Cross-attention DTW; good enough for captions, weak at catching skipped or repeated words |

Use in FireVoice: (1) caption and SRT export; (2) **TTS QA**: align the intended script to the generated audio and flag low-confidence spans, which catches truncation, skipped words, repetitions and hallucinated tails far better than WER alone; (3) dubbing timing.

### 5b. Diarization

| Tool | License | Windows | Notes |
|---|---|---|---|
| **pyannote `speaker-diarization-community-1`** (pyannote.audio 4, Sep 2025) | Weights CC-BY-4.0, gated (verify) | Native | Best speaker-count agreement on the Soniqo set but worst DER there on real conversations `[ind]`. Easiest drop-in |
| NVIDIA Streaming Sortformer v2 | A (CC-BY-4.0, verify) | NeMo, so Linux/WSL2 | At most 4 speakers; streaming and offline close in accuracy `[ind]` |
| DiariZen | Some weights NC (WavLM-based; verify) | Probably | Best open system (13.3% DER) in the independent 196-hour benchmark, arXiv 2509.26177 `[ind]` |

Use: dubbing (one cloned voice per source speaker) and voice harvest (pick segments of a single speaker from long recordings).

### 5c. ASR

| Model | License | Langs (Urdu?) | VRAM | Windows | Code | Evidence |
|---|---|---|---|---|---|---|
| Whisper large-v3 / large-v3-turbo (in faster-whisper) | P (MIT) | 99 (**Urdu yes**) | ~3-6 GB | Native | pip | "WER We Stand" (arXiv 2409.11252): Whisper-large best on **conversational** Urdu `[ind]` |
| `kingabzpro/whisper-large-v3-turbo-urdu` | (check card) | Urdu | ~3-6 GB | Native | pip | ~25 WER claimed `[vendor]`. Cheap upgrade for Urdu validation; convert to CTranslate2 |
| **Meta Omnilingual ASR** (Nov 2025; 300M-7B, CTC and LLM variants) | P (Apache-2.0; data CC-BY) | 1,600+ (**Urdu yes**) | 7B LLM ~16 GB bf16 (tight); 1B and 3B variants fit | **No native Windows** (fairseq2): WSL2, Python 3.11 | pip in WSL2 | CER under 10% for 78% of 1,570 languages `[vendor]`; no Urdu-specific number found. Its CTC models double as aligners |
| SeamlessM4T v2 large | NC | ~100 (Urdu yes) | ~10 GB | Works | pip | Best on **read** Urdu in "WER We Stand" `[ind]` |
| **Qwen3-ASR-1.7B / 0.6B** (Jan 2026) | P (Apache-2.0) | 30 languages + 22 Chinese dialects; Hindi yes, **Urdu no** | ~4-5 GB | Native for offline; streaming needs vLLM | pip `qwen-asr` | 5.4-6.1% average English WER on the Open ASR leaderboard `[ind]` |
| IBM Granite Speech 4.1 2B | (verify, probably Apache-2.0) | Few languages (verify) | ~5 GB | Native | pip | #1 on the May 2026 Open ASR snapshot at 5.33% `[ind]` |
| Cohere Transcribe 03-2026 (2B) | P (Apache-2.0, gated) | 14 languages (Arabic variant Jul 2026); Urdu not listed | ~5 GB | Native | pip | 5.42% WER `[vendor]` |
| NVIDIA Parakeet-TDT-0.6B-v3 / Canary-1B-v2 | A (CC-BY-4.0) | 25 European languages | ~2-4 GB | NeMo (WSL2) or ONNX ports | - | Speed leader `[ind]` |
| NVIDIA Nemotron 3.5 ASR streaming 0.6B (Jun 2026) | A (OpenMDW-1.1) | 40 locales; Hindi ready; Urdu not listed | Small | Linux only per card | NeMo / Transformers 5.13+ | 80 ms to 1.12 s chunks `[vendor]` |
| Nemotron 3.5 Transcribe 30B MoE (Oct 2026) | A (OpenMDW-1.1) | 40 languages; translation for 31; speaker attribution for 13 | Too big for 16 GB without heavy quantisation | Linux | - | A hands-on review reports noticeable Urdu errors `[weak]` |
| VibeVoice-ASR (Microsoft, early 2026) | (verify) | Multilingual | ? | repo | repo | 60-min long-form with built-in diarization `[vendor]` |

**Urdu ASR plan:**
1. Validator: faster-whisper large-v3 (not turbo) with `language="ur"`, plus the Urdu-fine-tuned turbo as a second pass.
2. For **Roman Urdu scripts**, compare in a romanised space: romanise the ASR output with `uroman` and normalise the Roman Urdu reference with a small rule set (lower-case; fold "aa"/"a", "ee"/"i", "oo"/"u", drop doubled consonants), then compute CER. Raw WER against Roman Urdu text is meaningless because the spelling is not standardised. The "WER We Stand" authors also stress normalisation.
3. Optional third opinion: Omnilingual ASR 1B or 3B CTC in a WSL2 worker.

---

## 6. Dubbing and translation pipeline

### 6a. Local machine translation

| Model | License | Sizes | Urdu | Runtime on Windows | Notes |
|---|---|---|---|---|---|
| **Qwen3.5** family (2026) | P (Apache-2.0) | 0.8B to 397B MoE | Yes (general LLM) | llama.cpp / Ollama / LM Studio, native | Reported strongest open family for multilingual work `[weak]`. Best when you need **constraints**: length budgets, tone, glossary, preserving `[laugh]` tags |
| **Gemma 4** (Apr 2026) | P (Apache-2.0, a change from the Gemma terms) | E2B, E4B, 26B-A4B, 31B | 140+ languages | Native via llama.cpp | 26B-A4B at Q4 fits 16 GB; E4B leaves room for TTS |
| **TranslateGemma** (Jan 2026) | Gemma terms (verify) | 4B / 12B / 27B | Probably (WMT24++ includes Urdu; verify) | llama.cpp | Dedicated MT fine-tune; small sizes match larger baselines `[vendor]` |
| HY-MT1.5 1.8B / 7B (Tencent, Dec 2025) | C (Tencent licence; verify geography terms) | 1.8B / 7B | Reportedly in its 33 languages (verify) | llama.cpp | Successor to the WMT25-winning Hunyuan-MT-7B `[vendor]` |
| MiLMMT-46 (Feb 2026) | (verify) | ? | Yes | ? | Claims to beat Seed-X, HY-MT1.5 and TranslateGemma `[vendor]` |
| Seed-X 7B (ByteDance, Jul 2025) | (verify) | 7B | ? | llama.cpp | Common baseline |
| NLLB-200 (1.3B / 3.3B) | NC | - | Yes | CTranslate2, native | Fast sentence-level baseline |
| MADLAD-400 (3B-10B) | P (Apache-2.0) | - | Yes | CTranslate2 | Permissive sentence-level baseline |

### 6b. Pipeline and reference projects

- **OmniVoice Studio** (GitHub `debpalash/omnivoice-studio`): a local dubbing studio built on OmniVoice plus WhisperX, so it is a close architectural precedent; read its isochrony handling.
- VideoLingo (Apache-2.0), pyVideoTrans, open-dubbing (Apache-2.0) and Voice-Pro: full pipelines to borrow ideas from, not to embed.
- Lip-sync (optional, video scope): LatentSync (Apache-2.0), MuseTalk (MIT), VideoRetalking (Apache-2.0).

### 6c. Recommended FireVoice dubbing flow

1. Separate the source into dialogue and background (python-audio-separator, Mel-Band RoFormer).
2. Diarize (pyannote community-1) and transcribe plus align (WhisperX).
3. Harvest a clean reference per speaker (Sidon cleanup, then a speaker-similarity check).
4. Translate with an LLM given a **per-segment duration budget** (target syllables or characters derived from source duration times a language rate table), keeping speaker, emotion and non-verbal tags.
5. Synthesise with duration-aware engines first (IndexTTS-2 duration tokens, IndexTTS-2.5 rate control, MOSS-TTS duration control); otherwise synthesise and time-fit with WSOLA (`audiotsm`, permissive) within plus or minus 8-10%, and **re-translate shorter** if more than 10% off.
6. Validate (ASR round-trip, alignment, speaker similarity), then remix over the background with ducking and loudness-match to the source.

---

## 7. Watermarking, deepfake detection and consent

### 7a. Watermarking and provenance

| Tool | License | Payload | Notes |
|---|---|---|---|
| **AudioSeal** (Meta) | P (MIT) | 16 bits, sample-level localisation | Fast, pip `audioseal`, 16 kHz model (resample around it). Independent SoK work (arXiv 2503.19176) shows that robustness claims across these schemes often hold only for narrow attack sets `[ind]` |
| WavMark | P (MIT) | 32 bits per 1 s | Slower; good second layer |
| **PerTh** (Resemble) | P (MIT) | - | Already applied by the Chatterbox-Turbo adapter; could be applied to all engines for consistency |
| XAttnMark (ICML 2025) | (verify code release) | Detection + attribution | Better attribution than AudioSeal `[vendor]` |
| SilentCipher (Sony) | (verify) | 44.1 kHz | No robustness numbers found |
| **C2PA** (`c2pa-python`) | P (MIT / Apache) | Signed manifest in WAV and MP3 | Provenance metadata ("generated by FireVoice, engine X, consent ID Y"). Stripped by re-encoding, so pair it with a watermark |

Regulatory context (not legal advice): the EU AI Act Article 50 transparency duties apply from 2026-08-02. The final Code of Practice on marking and labelling AI-generated content (published 2026-06-10) favours **layered** marking: metadata plus an imperceptible watermark. A private local tool is low-risk, but published audio made with FireVoice may fall in scope. Layering AudioSeal with C2PA covers the expected approach cheaply.

### 7b. Deepfake detection

- Use the HF **Speech DeepFake Arena** (14 datasets, 12 open systems) to pick a detector. The paper (arXiv 2509.02859) finds **no open model wins across all sets**; XLSR+SLS generalises best among open systems `[ind]`. Treat detection as a self-check and as a "was this file made by FireVoice?" tool, not as proof.
- Candidates: XLSR-SLS, XLSR-AASIST, AASIST3 (MIT-style research code; check each checkpoint). Spoof-SUPERB (2026) helps pick an SSL backbone.

### 7c. Consent tooling (build, do not buy)

1. **Consent recording**: when a voice is created, the speaker reads a consent statement plus a randomly generated challenge sentence (anti-replay).
2. **Verification**: ASR checks the challenge text; a speaker-verification model checks that the consent speaker matches the reference clip. Use WeSpeaker or 3D-Speaker CAM++ / ERes2NetV2 (Apache-2.0) or SpeechBrain ECAPA (Apache-2.0).
3. **Ledger**: store the SHA-256 of the reference and the consent audio, timestamp, scope (personal, commercial, languages) and expiry in the voice registry. Put the voice ID into the AudioSeal payload (16 bits gives 65,536 voice indices) and into the C2PA manifest.
4. **Protected list**: block cloning when a reference's embedding matches a protected-voice list above a threshold. Note that Fish Drama 3's licence explicitly forbids cloning without consent; other licences say the same.

---

## 8. Automatic quality metrics for TTS

| Metric / model | Measures | License | Cost | Notes |
|---|---|---|---|---|
| UTMOSv2, SpeechJudge-GRM, emotion2vec (installed) | Naturalness MOS, LLM-judge preference, emotion | - | - | Keep. UTMOSv2 drops to 0.31 PCC on **conversational** speech (arXiv 2603.01467) `[ind]`, so do not trust it for dialogue outputs |
| **Speaker similarity: WavLM-large + ECAPA-TDNN** (Seed-TTS-eval convention) or ERes2NetV2 / CAM++ | Clone fidelity | MIT / Apache | ~1-2 GB | **Replace resemblyzer**: it is an old GE2E model that saturates and disagrees with the SIM numbers papers report, so FireVoice's SIM is not comparable to published results |
| **Audiobox Aesthetics** (Meta) | 4 axes: production quality, production complexity, content enjoyment, content usefulness | CC-BY-4.0 (verify) | Light | Also scores SFX and music (sections 4 and 6) |
| DNSMOS P.835 | Signal, background noise, overall | MIT | CPU | Gate clone references (reject BAK below ~3.5) |
| torchaudio SQUIM (objective) | Reference-free STOI, PESQ, SI-SDR estimates | BSD | Light | Check whether it survives the torchaudio 2.9 clean-up |
| ProxyMOS (2026) | Distilled MOS, beats DistillMOS, UTMOS and WhiSQA on its benchmarks `[vendor]` | Check encoder licence | Light | Candidate second MOS opinion |
| UrgentMOS (Jan 2026) | Multi-metric + preference MOS | (code release unconfirmed) | - | Watch |
| **TTSDS2** (2025-26) | Distributional similarity to real speech across factors; 14 languages; validated on 11,000+ ratings | `ttsds` package MIT (TTSDS2 code: verify) | Batch | Best for **engine-level** bake-offs, not per-take scoring |
| VERSA (WavLab) | 60+ metrics in one toolkit | (verify) | Varies | Use as a library of metrics instead of re-implementing them |
| SHEET toolkit | Train your own MOS head | Open | - | If you collect FireVoice A/B ratings, fine-tune a FireVoice-specific predictor |

**Add FireVoice-specific checks that MOS models miss.** "Beyond Naturalness" (arXiv 2608.09930) shows MOS predictors do not detect phonetic accuracy, lexical stress or prosodic-boundary errors:
- **Alignment confidence per word** (section 5a): catches skips, repeats and tails.
- **Long-form drift**: speaker-embedding cosine of chunk N against chunk 1; F0 median and range per chunk; speaking rate (syllables per second) per chunk; loudness (LUFS) per chunk; pause-length distribution. Flag a chunk deviating more than 2 sigma from the take's own mean.
- **Artefact detectors**: clipping ratio, DC offset, leading and trailing silence, sudden spectral discontinuities at chunk joins (spectral flux spike), click detection.
- **Round-trip CER** with language-appropriate ASR (Urdu as in 5c).
- Optional heavy judge: an audio-LLM such as Qwen3-Omni-30B-A3B (Apache-2.0) at 4-bit is about 17 GB, so borderline; run it in a separate session.

---

## 9. Real token-level streaming from autoregressive TTS (VoxCPM2 focus)

### 9a. Facts to design around

- VoxCPM2 is a tokenizer-free diffusion-autoregressive model (LocEnc, TSLM, RALM, LocDiT; AudioVAE V2 with 16 kHz in and 48 kHz out). The LM runs at **6.25 Hz**, so one AR step is about **160 ms of audio**; that is the natural streaming granularity. `model.generate_streaming(text=...)` yields chunks. RTF is ~0.30 on an RTX 4090 with the standard stack and ~0.13 with Nano-vLLM; ~8 GB VRAM (model card) `[vendor]`.
- vLLM-Omni (Jun 2026 engineering post) serves VoxCPM2, Qwen3-TTS, Fish S2 Pro and Higgs v3. VoxCPM2 there reaches RTF ~0.13 after whole-forward compile, and Qwen3-TTS reaches **70 ms** time to first audio packet at concurrency 1 on an H20 (versus 15.5 s in plain HF Transformers) `[ind-ish]`. These stacks are Linux-only, and Nano-vLLM-VoxCPM needs flash-attn plus Triton (Windows only through community wheels and `triton-windows`, so fragile).

### 9b. Techniques, roughly in order of value per effort

1. **Cache the voice prompt.** Encode the reference audio and its transcript once per voice and reuse the encoded features (and the KV prefix, if the API allows) across requests. For cloning this is usually the largest cut in time to first audio.
2. **Small first chunk, larger later chunks.** Yield after 1-2 AR steps (160-320 ms of audio) for the first packet, then 4-8 steps per packet. vLLM-Omni's key fix was to **decouple the hand-off chunk size from the decoder window**: emit small chunks, but decode each with left context (vLLM-Omni uses about 25 frames of left context in a 300-frame window for Qwen3-TTS), then drop the overlap region.
3. **Seam handling.** If the VAE decoder is not strictly causal, decode with left context and crossfade 5-20 ms (equal-power) at boundaries. Test for clicks with a spectral-flux check at joins (section 8).
4. **Fewer diffusion steps on the first chunk.** LocDiT runs a flow-matching solver per patch; use fewer timesteps for chunk 1 (for example 6 instead of 10) and the normal count afterwards. Validate with UTMOSv2 on the first second only.
5. **Compile and CUDA-graph the per-step path.** Static KV cache, fixed-shape buckets, `torch.compile` of the AR step and the LocDiT step. Note vLLM-Omni had to reject `reduce-overhead` for VoxCPM2 because automatic graph capture clashed with paged KV slot mapping; with a plain static cache this is less of an issue. On Windows, `torch.compile` needs `triton-windows`.
6. **Text-side streaming.** For LLM-driven speech, stream LLM tokens into a clause segmenter (split on punctuation, minimum ~25-40 characters, maximum ~200), queue clauses, and **chain prosody** by passing the tail (last 2-4 s) of the previous generated audio plus its text as the prompt continuation for the next clause. True dual-stream models (CosyVoice2/3 bi-stream, Kyutai DSM, VibeVoice-Realtime, MOSS-TTS-Realtime, Dia2) take incremental text natively; VoxCPM2 needs the clause approach.
7. **Pipelining on one GPU.** While clause N plays, generate N+1; give the streaming request priority in the worker pool and pause batch jobs (FireVoice's pool already arbitrates one GPU).
8. **Transport and playback.** WebSocket binary frames of PCM16 at 48 kHz (or Opus via WebCodecs for remote clients), a header announcing the sample rate, and an AudioWorklet ring buffer with a 100-200 ms jitter buffer in the browser. Send a "final" frame so the client can flush.
9. **Loudness stability.** Do not normalise each chunk on its own (it pumps). Use a running integrated-loudness estimate with a slow limiter, or normalise from the voice's stored target LUFS.
10. **Streaming QA.** Keep a one-chunk pre-roll so a failed chunk (alignment confidence collapse, silence, runaway length) can be regenerated before it is played. Log TTFA, chunk RTF and underruns per request.
11. **Throughput mode (optional, high effort).** Run Nano-vLLM-VoxCPM or vLLM-Omni in a WSL2 worker for long-form batch renders (about 2x faster RTF), and keep the native Windows worker for interactive streaming.

### 9c. Reference numbers

| Stack | Model | TTFA | RTF | Source |
|---|---|---|---|---|
| HF / native | VoxCPM2 on RTX 4090 | not published | ~0.30 | model card `[vendor]` |
| Nano-vLLM | VoxCPM2 on RTX 4090 | not published | ~0.13 | model card `[vendor]` |
| vLLM-Omni, H20, c=64 | VoxCPM2 | not reported | ~0.13 | vLLM blog |
| vLLM-Omni, H20, c=1 | Qwen3-TTS | 70.6 ms | - | vLLM blog |
| vLLM-Omni, H20, c=64 | Fish S2 Pro | 900 ms mean | - | vLLM blog |
| native | VibeVoice-Realtime-0.5B | ~300 ms | - | `[vendor]` |
| native | MOSS-TTS-Realtime | 180 ms TTFB | - | `[vendor]` |

---

## 10. Ranked shortlist (23 additions)

Effort: S = under 1 day, M = 1-3 days, L = 1 week or more. Risk covers Windows/Blackwell friction, licence and maturity.

| # | Addition | Expected user benefit | Effort | Risk | License |
|---|---|---|---|---|---|
| 1 | **Reference cleanup pipeline**: DNSMOS gate, DeepFilterNet3 pre-pass, Sidon (fallback ClearerVoice MossFormer2_SE_48K) with A/B against the raw clip | Better clones from every engine, because noise and reverb stop being cloned; works for Urdu references too | M | Low (Sidon licence: verify) | MIT / Apache |
| 2 | **VoxCPM2 streaming hardening**: prompt cache, 1-2-step first chunk, left-context decode with crossfade, compiled step, AudioWorklet player, pre-roll QA | Sub-second first audio on the main engine; smooth, click-free playback | M | Low-Med (`torch.compile` on Windows) | - |
| 3 | **Metrics upgrade**: WavLM-ECAPA or ERes2NetV2 SIM in place of resemblyzer, Audiobox Aesthetics, DNSMOS, long-form drift and artefact checks | Judging that matches published SIM numbers and catches long-form drift and seams | S-M | Low | MIT / Apache / CC-BY |
| 4 | **Alignment-based TTS QA and word timestamps**: WhisperX alignment (Urdu and Hindi models included) plus ctc-forced-aligner for Roman Urdu | Catches skipped, repeated or hallucinated words automatically; enables SRT export and karaoke-style UI | S-M | Low (MMS aligner weights are NC) | BSD; NC weights |
| 5 | **Chatterbox VC** exposed as speech-to-speech (performance transfer and timbre repair) | Users can act a line themselves and get it in the cloned voice: exact emotion and timing | S | Low | MIT |
| 6 | **Ming-3.0-tts-0.5B engine** | Best permissive model on the open arena; 14 non-verbal tags, director mode and voice design | M | Med (`pynini` on Windows; native streaming unclear; new) | MIT |
| 7 | **IndexTTS-2.5 upgrade** of the existing adapter | 2.28x faster, rate control, more languages, same dubbing-friendly duration control | S | Low (check licence parity) | Bilibili licence |
| 8 | **Urdu validation upgrade**: Whisper large-v3 plus Urdu fine-tuned turbo, CER in romanised space via `uroman` | Reliable automatic checks for Roman Urdu output; fewer false failures | S | Low | MIT |
| 9 | **MOSS-TTSD v1.0 and MOSS-TTS v1.5** (long-form, dialogue, pause and duration control) | Podcast and dialogue production; precise pauses; Hindi coverage | M | Med (TRC; 8B needs 8-bit or the llama.cpp path) | Apache-2.0 |
| 10 | **Step-Audio-EditX** as a post-edit tool ("make this take sadder, add a laugh here") | Fix the emotion or style of any good take without re-rolling | M | Med-High (VRAM; use the Int8 checkpoint) | Apache-2.0 |
| 11 | **Seed-VC worker** (GPL-isolated) | Zero-shot conversion that keeps emotion and accent, plus singing conversion | M | Med (GPL; old torch pins on sm_120) | GPL-3.0 |
| 12 | **Audio8-TTS-Realistic 0.6B** in the bake-off harness | Small, fast, permissive multilingual cloner; might beat Qwen3-TTS on cloning stability | S-M | Med (three weeks old; claims are the vendor's own) | Apache-2.0 |
| 13 | **ACE-Step 1.5 music beds** | Royalty-free background music and stings under 4 GB VRAM | S-M | Low | MIT |
| 14 | **Stable Audio 3 Small SFX** (or MOSS-SoundEffect v2.0 for a pure-Apache option) | Ambience and SFX layers without leaving the studio | S-M | Low (SA3 community licence revenue cap) | Stability Community / Apache |
| 15 | **Watermark and provenance**: AudioSeal on every export (voice ID in the payload), C2PA manifest, metadata tags; detector in the UI | Traceability, readiness for the EU Article 50 code, and "was this made here?" checks | S-M | Low | MIT |
| 16 | **Consent flow**: consent statement, challenge phrase, ASR plus speaker-verification match, ledger, protected-voice list | Responsible cloning, a defensible record and misuse prevention | M | Low | Apache |
| 17 | **Dubbing pipeline v1**: separation, pyannote, WhisperX, LLM translation with duration budget (Qwen3.5 or Gemma 4 via llama.cpp), duration-aware TTS, remix | End-to-end local dubbing, including EN to Roman Urdu or Hindustani | L | Med | mostly permissive |
| 18 | **48 kHz upsampling** for 24 kHz engines (LavaSR or MossFormer2_SR_48K) | Consistent 48 kHz output across engines in mixed projects | S | Low-Med (can add artefacts; keep optional) | Apache |
| 19 | **SAM Audio and audio-separator in voice harvest** | Harvest clean voices from noisy videos by text prompt ("the man speaking") | M | Med (custom gated licence) | SAM licence / MIT |
| 20 | **Qwen3-ASR-1.7B plus ForcedAligner** as a validator for its 30 languages | Faster, more accurate ASR checks and timestamps for zh, en, ja, ko and European outputs | S-M | Low | Apache-2.0 |
| 21 | **Low-latency conversational engine**: VibeVoice-Realtime-0.5B or Dia2 (English) | Voice-agent and "talk to it" demos with ~300 ms first audio | M | Low-Med | MIT / Apache |
| 22 | **WSL2 throughput worker**: Nano-vLLM-VoxCPM or vLLM-Omni for long-form batch | Roughly 2x faster audiobook-length renders | L | High (WSL2 plumbing, flash-attn, two OSes) | Apache |
| 23 | **Omnilingual ASR (WSL2)** as an Urdu and low-resource second opinion and CTC aligner | Better coverage for languages Whisper handles poorly | M-L | Med (fairseq2 Linux-only) | Apache-2.0 |

**Deliberately not shortlisted:** Fish Drama 3 (does not fit 16 GB; licence conditions); Fish S2 Pro, Higgs Audio v3 and Voxtral TTS (non-commercial; fine as private bake-off references only); Nemotron 3.5 Transcribe 30B (VRAM); HunyuanVideo-Foley (licence geofence); MMAudio, ThinkSound and Woosh (non-commercial weights); RVC/Applio (needs per-voice training; consider later for a "hero voice" feature); Magpie (no cloning).

---

## Sources

TTS
- Artificial Analysis open-weights Speech Arena: https://artificialanalysis.ai/text-to-speech/leaderboard/open-weights
- MOSS-TTS family: https://github.com/OpenMOSS/MOSS-TTS
- Ming-3.0: https://alphasignal.ai/news/ant-group-s-ming-3-0-tops-open-source-voice-charts-with-five-speech-models , https://aireiter.com/blog/ming-3-0-tts-review-local-deployment , https://kie.ai/blog/what-is-ming-3-0
- Audio8-TTS-Realistic: https://www.marktechpost.com/2026/10/29/edge0-audio8-tts-realistic-0-6b-voice-cloning/
- Fish Audio Drama 3: https://www.marktechpost.com/2026/10/14/fish-audio-drama-3-open-weight-tts-model/ , https://huggingface.co/fishaudio/Drama-3 , https://www.madebyagents.com/models/fish-audio-drama-3
- Fish Audio S2 Pro: https://huggingface.co/fishaudio/s2-pro , https://fish.audio/blog/fish-audio-open-sources-s2/
- Higgs Audio v3: https://huggingface.co/bosonai/higgs-audio-v3-tts-4b
- Voxtral TTS: https://mistral.ai/en/news/voxtral-tts , https://slator.com/mistral-text-to-speech-model/
- Step-Audio-EditX: https://huggingface.co/stepfun-ai/Step-Audio-EditX , https://arxiv.org/abs/2511.03601
- IndexTTS-2.5: https://arxiv.org/abs/2601.03888 , https://huggingface.co/indexteam/indextts-2.5
- VibeVoice-Realtime: https://huggingface.co/microsoft/VibeVoice-Realtime-0.5B
- Pocket TTS: https://kyutai.org/tts/ ; Phonon: https://huggingface.co/gradium/phonon-31m-en , https://www.marktechpost.com/2026/10/22/gradium-phonon-31m-on-device-tts/
- Magpie TTS Multilingual: https://huggingface.co/nvidia/magpie_tts_multilingual_357m
- Dia2: https://jimmysong.io/ai/dia2
- Breeze TTS 2 licence: https://www.mindstudio.ai/blog/breeze-tts-2-license-commercial-use
- VoxCPM2: https://huggingface.co/openbmb/VoxCPM2 , https://arxiv.org/pdf/2606.06928
- Urdu TTS options: https://huggingface.co/suhaibrashid17/XTTS-v2-Urdu-FT , https://huggingface.co/AhsanTalal/urdu-matcha-tts

Voice conversion
- Seed-VC: https://huggingface.co/Plachta/Seed-VC ; MeanVC2: https://huggingface.co/ASLP-lab/MeanVC2 , https://arxiv.org/html/2606.09050v1
- R2-SVC (Seed-VC baseline): https://arxiv.org/pdf/2510.20677 ; Applio: https://sourceforge.net/projects/applio.mirror/ ; w-okada voice-changer: https://github.com/w-okada/voice-changer

Enhancement and separation
- Sidon: https://arxiv.org/abs/2509.17052v2 , https://huggingface.co/KevinAHM/Sidon-GGUF
- ClearerVoice: https://github.com/modelscope/ClearerVoice-Studio , https://huggingface.co/alibabasglab/MossFormer2_SR_48K
- LavaSR: https://github.com/ysharma3501/LavaSR ; Resemble Enhance: https://github.com/resemble-ai/resemble-enhance
- SAM Audio: https://github.com/facebookresearch/sam-audio , https://pypi.org/project/sam-audio-infer/

SFX and music
- Stable Audio 3: https://stability.ai/news-updates/meet-stable-audio-3-the-model-family-built-for-artistic-experimentation-with-open-weight-models , https://the-decoder.com/stability-ai-launches-stable-audio-3-0-with-up-to-six-minute-tracks-and-open-weights/
- ACE-Step 1.5: https://arxiv.org/abs/2602.00744 , https://huggingface.co/ACE-Step/Ace-Step1.5
- HunyuanVideo-Foley: https://huggingface.co/tencent/HunyuanVideo-Foley ; ThinkSound: https://huggingface.co/FunAudioLLM/ThinkSound ; Woosh: https://arxiv.org/abs/2604.01929

ASR, alignment, diarization
- Qwen3-ASR: https://huggingface.co/Qwen/Qwen3-ASR-1.7B , https://arxiv.org/abs/2601.21337
- Open ASR snapshots: https://benchmarklist.com/benchmarks/open_asr_leaderboard/ , https://www.codesota.com/speech/stt-leaderboard
- Cohere Transcribe: https://the-decoder.com/cohere-releases-open-source-model-that-tops-speech-recognition-benchmarks/
- Nemotron 3.5 ASR: https://huggingface.co/nvidia/nemotron-3.5-asr-streaming-0.6b ; Transcribe: https://thenextweb.com/news/nvidia-nemotron-3-5-transcribe-granary-v2-open-speech
- Omnilingual ASR: https://ai.meta.com/blog/omnilingual-asr-advancing-automatic-speech-recognition/ ; fairseq2 install: https://facebookresearch.github.io/fairseq2/stable/getting_started/installation/index.html
- Urdu ASR benchmark: https://arxiv.org/abs/2409.11252 ; Urdu turbo fine-tune: https://huggingface.co/kingabzpro/wav2vec2-urdu
- WhisperX alignment models: https://github.com/m-bain/whisperX/blob/main/whisperx/alignment.py
- torchaudio forced-align deprecation: https://docs.pytorch.org/audio/2.9.0/generated/torchaudio.functional.forced_align.html
- MFA Urdu dictionary: https://mfa-models.readthedocs.io/en/latest/dictionary/Urdu/index.html ; MFA 2026 paper: https://arxiv.org/pdf/2606.18466
- Diarization benchmarks: https://arxiv.org/abs/2509.26177 , https://soniqo.audio/benchmarks/diarization

Translation and dubbing
- MiLMMT-46 (comparison with TranslateGemma, HY-MT1.5, Seed-X): https://arxiv.org/abs/2602.11961
- Gemma 4 licence: https://venturebeat.com/technology/google-releases-gemma-4-under-apache-2-0-and-that-license-change-may-matter
- OmniVoice Studio: https://themenonlab.blog/blog/omnivoice-studio-open-source-local-dubbing-646-languages

Watermarking, detection, regulation
- XAttnMark: https://arxiv.org/abs/2502.04230 ; Watermark SoK: https://arxiv.org/html/2503.19176v2 ; AudioMarkBench: https://arxiv.org/pdf/2406.06979
- Speech DF Arena: https://arxiv.org/pdf/2509.02859
- EU Code of Practice on marking AI content: https://www.jonesday.com/en/insights/2026/06/european-commission-publishes-final-code-of-practice-on-marking-and-labelling-aigenerated-content

Metrics
- Beyond Naturalness: https://arxiv.org/html/2608.09930 ; Conversational naturalness predictor: https://arxiv.org/html/2603.01467v1
- TTSDS2: https://arxiv.org/abs/2506.19441 ; UrgentMOS: https://arxiv.org/abs/2601.18438 ; ProxyMOS: https://huggingface.co/lab260/ProxyMos

Streaming
- vLLM-Omni TTS engineering: https://vllm.ai/blog/2026-06-23-vllm-omni-tts
- Nano-vLLM-VoxCPM deployment docs: https://voxcpm.readthedocs.io/en/latest/deployment/nanovllm_voxcpm.html
