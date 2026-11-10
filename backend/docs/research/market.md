# Voice-AI market research for FireVoice (November 2026)

Purpose: decide what FireVoice builds next. FireVoice is a local, GPU-only TTS/STT studio (FastAPI backend plus CLI,
a web playground at `/playground`, and the Tauri desktop app `firevoice-desktop`) that aims to be an ElevenLabs-class
product on one RTX 5080 (16 GB VRAM).

Method: official docs and changelogs first (ElevenLabs, Cartesia, Hume, Murf, OpenAI), then press and review sites,
then user forums. Research date: 2026-11-09. Where sources conflict or are thin, this report says so. Claims from
affiliate-style review sites are marked "(reported)". A full source list is at the end.

---

## 0. Executive summary

- **ElevenLabs is still the reference product and has widened its lead in breadth.** In 2026 it shipped Eleven v4 and
  v4 Turbo (Sep 28), audio effects on TTS (Oct 12), SFX v3 (Nov 2), PVC fine-tuning with a clone-strength control,
  transcript editing in Scribe, Text to Dialogue continuity, and Video to Music. Its moat is a complete workflow:
  Studio (long-form editor), Voice Library, dubbing, SFX, music and agents in one account.
- **The rest of the field has split.** Cartesia, Hume, OpenAI and Murf's Falcon chase real-time voice agents
  (sub-200 ms, websockets, turn detection). Murf, WellSaid, Speechify and Descript chase creators and businesses with
  editors. Resemble chases safety (watermark, deepfake detection) and open weights (Chatterbox, which FireVoice
  already runs). PlayHT is gone: Meta hired the team in July 2025 and the service shut down on 2025-12-31 with no
  export of voices or projects.
- **The most common user complaints are things a local product fixes by design:** credits burnt on regenerations,
  credits that expire, voice drift between paragraphs, licensing confusion, billing friction, and losing everything
  when a vendor shuts down.
- **FireVoice already beats the market on several axes:** many engines behind one API, Whisper-validated takes with
  automatic re-rolls, multiple candidates per sentence, deterministic seeds, per-style reference clips, and an
  ElevenLabs-compatible route set. **It is missing the workflow layer:** a long-form project editor with takes and
  history, pronunciation dictionaries, multi-speaker dialogue, speech-to-speech, voice isolation, SFX and a mixer.
- **Recommendation:** build the long-form project editor (with takes, history, locks and QA flags) and the
  pronunciation dictionary first, then dialogue, voice changer and isolator, then API parity (OpenAI-compatible
  routes, websocket text-in streaming, forced alignment), then audio post (effects, SFX, mixer, audiobook export).
  Leave telephony agents, video generation and live translation for later or never.

---

## 1. FireVoice today (baseline)

From `docs/API.md`, `README.md` and the desktop app views:

| Area | What exists |
|---|---|
| Engines | 12 adapters in their own venvs: Chatterbox Turbo and base, Qwen3-TTS base and VoiceDesign, VoxCPM2, dots.tts, IndexTTS-2, Breeze TTS 2, OmniVoice, F5, Kokoro, Maya1. Worker pool with VRAM-aware LRU unloading. |
| TTS request | markup `[pause 500ms]`, `[style x]`, `[pace x]`, engine tags `[laugh]` `[sigh]`; styles; pace; `instruct`; language; engine params; seed; `candidates` 1-8; Whisper `validate` and `accept`; LUFS studio chain; lead and tail silence; 7 formats; resample; JSON response with word times. |
| Streaming | SSE per-sentence chunks with word times; raw PCM stream. No websocket, no text-in streaming. |
| Voices | upload clone with consent flag, transcript, per-style reference clips, design from description, favourites, notes, default voice, filters, harvest from open datasets. |
| STT | faster-whisper large-v3-turbo on CUDA, word times, language detection. No diarization, no realtime stream, no subtitles. |
| Jobs | tts, batch, design jobs; SSE events; history on disk; cancel; per-line outputs. |
| Compatibility | ElevenLabs `/v1/text-to-speech`, `with-timestamps`, `/v1/voices`, `/v1/voices/add`, `/v1/models`. No OpenAI-compatible routes. |
| Desktop app | Home, Speak (script editor, read-along), Voices (record, add, design, quality badge), Styles, Engines, Jobs, Transcribe, Settings, player bar. |
| Tooling | samples grid, bench bake-off (WER, speaker similarity, MOS), doctor, showcase. |

Not present: project or chapter editor, takes browser, pronunciation dictionaries, multi-speaker dialogue,
speech-to-speech, voice isolation or enhancement, SFX, music, mixer or timeline, audio effects, dubbing, diarization,
forced alignment endpoint, subtitles export, audiobook export, websocket API, OpenAI-compatible API, watermark checks,
MCP server.

---

## 2. Product-by-product findings

### 2.1 ElevenLabs

The broadest product. Split here by sub-product.

**TTS models (as listed in the docs in November 2026)**

| Model | Notes |
|---|---|
| Eleven v4 (Sep 2026) | Most expressive; better cloning; 90+ languages; 10,000 characters per request. Used via TTS and Text to Dialogue. |
| Eleven v4 Turbo (Sep 2026) | Same family for real time, about 100 ms median latency, supports audio tags, used via Dialogue websocket for agents. |
| Eleven v3 | GA in early 2026 (was alpha in 2025). Dramatic delivery, 70+ languages, 5,000 characters. No SSML; uses audio tags and punctuation. |
| Eleven v3 Conversational | Realtime, about 165 ms, audio tags. |
| Multilingual v2 | Still recommended as "most stable for long-form", 29 languages, Studio default. |
| Flash v2.5 / v2 | About 75-100 ms, 32 languages, 40,000 characters; only model family with phoneme rules in dictionaries. |

**Audio tags (v3, v4, v4 Turbo).** Inline bracketed directions such as `[whispers]`, `[laughs]`, `[sighs]`,
`[sarcastic]`, `[curious]`, `[excited]`, `[shouting]`, plus sound-like tags (`[applause]`, `[gunshot]`) and accent
tags (`[strong French accent]`). The official prompting guide says the stability slider matters most: Creative and
Natural respond strongly to tags but can hallucinate; Robust is consistent but ignores tags. Community guides advise
at most two compatible tags per line and punctuation before tags. Tags are guidance, not commands; the guide tells
users to generate several times and pick the best.

**API features developers use**
- Voice settings: `stability`, `similarity_boost`, `style` (exaggeration), `use_speaker_boost`, `speed` (0.7-1.2).
- Request stitching: `previous_text`, `next_text`, `previous_request_ids`, `next_request_ids` to keep prosody
  continuous across chunks.
- `seed` (best-effort determinism), `language_code` enforcement, `apply_text_normalization` (auto, on, off).
- Pronunciation dictionaries: alias rules and phoneme rules (IPA or CMU), PLS file upload, up to several
  dictionaries per request, rules matched top to bottom.
- Output formats: MP3 22-44.1 kHz at 32-192 kbps, PCM 8-48 kHz, mu-law and A-law 8 kHz for telephony, Opus 48 kHz.
- Timestamps: `with-timestamps` routes return character-level alignment (start and end per character, plus a
  normalized alignment).
- Streaming: HTTP chunked streaming; websocket `stream-input` that accepts text as it arrives from an LLM (with
  `chunk_length_schedule`, `flush`, `auto_mode`), returns audio plus alignment; multi-context websocket for agents
  (several independent contexts on one socket, used for interruptions).
- **Audio effects (Oct 2026):** `audio_effects` object on TTS and Dialogue with `filter_preset_id`, `distance` (0-1),
  `environment_id` (reverb) and `send_level`, `background_noise_id` (looped bed), `pan` (-1 to 1). A catalog endpoint
  lists presets. Reverb or pan make output stereo. No extra cost.
- `use_pvc_as_ivc` to use the instant version of a professional clone for lower latency.

**Studio (long-form projects).** The strongest editor pattern in the market:
- Projects created from a prompt, a template card, an upload (EPUB best, also PDF, DOCX, TXT, HTML, URL) or blank.
  EPUB headings become chapters automatically.
- Chapters sidebar; paragraphs as the unit of generation. A grey status bar beside each paragraph shows
  converted vs unconverted. Play renders ahead to the end of the chapter or one clip at a time.
- Per-paragraph regenerate; up to two free regenerations when text and voice are unchanged; regenerate a word
  selection (full sentences recommended).
- **Generation history per paragraph:** listen, download, restore any earlier take.
- **Lock paragraph** freezes the chosen take and blocks accidental regeneration.
- Per-paragraph or per-selection voice and setting overrides; "replace voice across project"; project-only aliases
  for character names.
- Insert break (1 to 3 s); timeline recommended for exact pauses on newer models.
- **Actor Mode:** record or upload your own reading of a line and the model copies its delivery (timing, emphasis,
  even accent) in the target voice.
- Timeline with narration, music and SFX tracks; trim, split, duplicate, nudge timing between paragraphs; waveforms.
- AI tools in the sidebar: enhance text, remove background audio (Voice Isolator), voice changer, Actor Mode.
- Pronunciation editor with alias and phoneme rules.
- Export per chapter or project, MP3 or WAV, ZIP, metadata (title, author, ISBN), volume normalization, export
  history, publishing to Spotify and an audiobook store.
- **Auto-regenerate on export:** checks for mispronunciation, volume distortion, missing or extra words, and
  regenerates up to two times at no extra cost.
- Collaboration: read-only share links, timestamped comments with threads and mentions, anonymous comments.
- Studio 3.0 added video projects: Studio Agent (chat co-editor that drafts a timeline), captions with styles,
  aspect ratios, generated B-roll, lip-sync avatars.
- Limits: 500 chapters, 400 paragraphs per chapter, 5,000 characters per paragraph.

**Voice Changer (speech-to-speech).** Upload or record audio, output the same performance in another voice.
Settings: stability, similarity, style, remove background noise. Used for Actor Mode and for performers who want to
keep their own timing.

**Dubbing.** Automatic dubbing API (source to target language, keeps speakers, separates background) and a Dubbing
Studio editor with speaker tracks, editable transcript and translation per segment, split and merge clips, reassign
speakers, clip history, "stale audio" marking when text changes, regenerate per clip. **The docs now say Dubbing Studio
is in maintenance mode** (bug fixes only). Lip sync is not part of dubbing. Oct 2026 added subtitle URLs for dubbed
outputs.

**Voice Design.** Voice Design v3 creates a voice from a text prompt and returns several previews (each with a
generated voice id) to choose from. Parameters include guidance scale, loudness, seed, and (on `eleven_ttv_v3`) an
optional reference audio with a prompt-vs-reference balance. **Voice Remix** edits an existing voice by prompt
("make it older", "more breathy") in iterative sessions.

**Voice Library.** Community marketplace of shared voices with filters (language, accent, gender, age, use case),
previews, usage counts and rewards for creators. Oct 2026 added **voice collections** with permissions (admin,
editor, commenter, viewer).

**Cloning.** Instant Voice Clone (seconds to minutes of audio) and Professional Voice Clone (30 minutes or more,
fine-tuned, with a spoken verification step). Nov 2026: PVC fine-tuning on v4 for everyone; Oct 2026: clone strength
control for PVCs on v4.

**Sound Effects.** Text to SFX, now SFX v3 (Nov 2026). Duration control, looping, prompt influence, WAV output
(Oct 2026), a browsable SFX library in Studio.

**Voice Isolator.** Removes background noise, music and reverb from speech. API and in-Studio button.

**Text to Dialogue.** One request with a list of `{text, voice_id}` inputs renders a natural multi-speaker
conversation (interruptions, timing, emotion via tags). Sep 2026: continuity across requests, PVC-as-IVC, a
`similarity` setting; v4 Turbo exposes dialogue over websocket.

**Music.** Eleven Music v2.5 (Sep 2026): prompt or composition plan with sections, lyrics, styles; streaming;
waveform visual data option (Aug 2026); Video to Music (Oct 2026).

**Agents.** ElevenAgents (formerly Conversational AI): LLM choice, knowledge base with crawling, tools, MCP tools,
workflows and procedures, telephony (Twilio, SIP), DTMF, call queues, guardrails, evaluations, alerts. Eleven
Realtime (v1 Mini and Max) for agents (Oct to Nov 2026). Realtime translation websocket (enterprise).

**Speech to Text (Scribe).** Scribe v2 (90+ languages), Scribe v2 Realtime (about 150 ms) and Scribe v2 Medical.
Diarization up to 32 speakers, audio event tags (laughter, applause), keyterm prompting (1,000 terms batch),
65 entity types with timestamps, realtime entity redaction (Nov 2026), word timestamps, no-verbatim mode, multichannel
(up to 5), webhooks, natural-language transcript editing (Sep 2026), commit strategies `manual`, `vad` and
`turn_prediction` with `turn_probability` (Oct 2026).

**Forced Alignment API.** `POST /v1/forced-alignment` with audio plus text returns word and character timings.
Up to 10 hours of audio and 675,000 characters; priced like STT.

**Other.** CLI v1.0 (Aug 2026) exposes every API operation; hosted MCP server with OAuth; ElevenReader app; AI
speech classifier.

**What users praise.** Best-in-class realism and emotional range (v3, v4); huge voice library; fast cloning; Studio
for audiobooks; breadth of one account.

**What users complain about** (r/ElevenLabs snapshots Jan-May 2026, review blogs):
- Credits: regenerations eat credits; one user spent a month of credits on a two-hour, four-voice novella and found
  it "almost unusable"; credits expire and are lost on cancellation; one blog estimates the effective cost at 2.8x the
  list price once regenerations are counted (reported).
- Free regenerations vary a lot between takes and cannot be turned off.
- Long-form consistency: v3 voices sound like a different person from one paragraph to the next; accent drift
  (British to Australian) between regenerations with identical text and settings; v3 clone quality worse for some
  legacy voices.
- Tags are non-deterministic; multiple conflicting tags confuse the model.
- Price and plan limits; quality tiers locked by plan (Studio exports at 128 kbps on lower plans).

### 2.2 Cartesia

**Models.** Sonic 3 (stable, dated snapshots such as `sonic-3-2026-01-12`), Sonic 3.5 (GA May 2026), Sonic 3.6
(GA 2026-08-27: more natural pacing without SSML, 44 languages including Urdu and Odia, better Hindi and Hinglish,
disfluency handling). Aliases track the latest snapshot; dated snapshots never change. Older Sonic 2 and Turbo retired
after 2026-10-20.

**API features.**
- Websocket with **contexts**: send text incrementally under one `context_id` so prosody continues across pieces;
  `flush_id` in responses; cancel per context. HTTP bytes and SSE endpoints.
- **Word and phoneme timestamps** (beginning-of-word timing changed slightly in 3.5).
- **SSML-like tags:** `<speed ratio="0.6-1.5"/>`, `<volume ratio="0.5-2.0"/>`, `<emotion value="angry"/>` (beta,
  "highly experimental"), `<break time="1s"/>`, `<spell>ABC123</spell>`; laughter supported in Sonic 3. Docs warn that
  many breaks can cause hallucination and to use punctuation first.
- `generation_config` with speed and volume; new `locale`, `accent` and `normalization` fields (Aug 2026).
- **Pronunciation dictionaries** with custom IPA (Jan 2026), case-insensitive by default on 3.6 (Sep 2026), access
  control and public sharing (Jul 2026).
- Output: raw PCM (f32 or s16), WAV, MP3, mu-law, A-law; sample rates 8 to 48 kHz.
- **Infill** (generate audio that fits between two existing clips) and **voice changer** endpoints (present in the
  JS SDK v3.0 notes, Mar 2026). Voice localization (change a voice's accent or language) existed in 2025.
- Cloning: Instant clones (up to 60 s recommended on 3.6, multilingual) and Professional clones that auto-train on
  all eligible models (Sep 2026). Embedding-based TTS and voice mixing endpoints were retired in June 2026.
- **Ink-2 STT** (May 2026): streaming STT with built-in turn detection, thresholds for turn start, end and eager end;
  keyterm prompting (Jul 2026); multilingual (Sep 2026).
- Line and Managed Agents for voice agents; regional routing (US, EU, APAC); self-hosted deployment.

**Playground UX.** TTS playground with a "Report issue" button, mini voice picker, click-to-seek transcripts,
pronunciation dictionary views, sample-rate testing, noise removal toggle for clone uploads.

**Praise.** Lowest latency in the market, stable streaming, good for agents, versioned model snapshots (predictable
upgrades). **Complaints.** Less expressive and less control for creative long-form than ElevenLabs; controls removed
then restored between 3.5 preview and GA; breaking changes (PVCs needing dated model ids, retired endpoints); no
studio editor.

### 2.3 Hume (Octave)

**Models.** Octave 1 and Octave 2 (Oct 2025; under 200 ms, about 100 ms in instant mode, 11 languages, half the price
of Octave 1). EVI 3 and EVI 4 mini for speech-to-speech conversation. In March 2026 Hume released TADA, an open-source
speech generation architecture (1B and 3B, Llama-based) (reported).

**Distinctive features.**
- **An LLM-based TTS that "understands what it is saying":** infers emotion from the text.
- **Voice design from a prompt** ("a weary old sailor, gravelly"), then save.
- **Acting instructions:** a natural-language `description` per utterance ("whispering, scared") separate from the
  voice. Docs conflict on whether this works on Octave 2 or only Octave 1.
- `speed` (0.5-2.0) and `trailing_silence` per utterance.
- `context`: earlier utterances or a generation id as reference-only context for continuity.
- **`num_generations` 1-5** in one request for take selection, with prosody continuity across them.
- `split_utterances` toggle (natural segmenting vs strict one-to-one mapping).
- `instant_mode` streaming (about 10 percent more expensive, predefined voices only).
- Websocket stream-input; timestamps on Octave 2 only.
- Instant cloning from about 15 s; accent preserved when a clone speaks another language.
- Announced as "coming soon": voice conversion and **phoneme editing** (change the timing and pronunciation of a word
  inside generated speech).
- Hosted MCP server; Expressive TTS Arena on Hugging Face.

**Praise.** Emotional intelligence, prompt-designed voices, acting instructions. **Complaints.** Fewer languages,
features announced before shipped, docs out of sync, less of a production editor.

### 2.4 PlayHT (defunct)

Historical features: PlayHT 2.0 and Play 3.0 mini, **PlayDialog** (multi-speaker dialogue model), voice cloning,
websocket streaming, emotion and style guidance, a Studio editor with per-paragraph voices and a pronunciation library,
WordPress plugin. Meta hired the team in July 2025; sign-ups closed in August 2025; the service shut down on
2025-12-31 and deleted accounts, projects, clones and keys with no export tool.

**Lesson for FireVoice:** "your voices and projects live on your disk and export in open formats" is a real selling
point. Voice packs and project export should be first-class.

### 2.5 Resemble AI

- **Chatterbox** open-weights family (MIT): Chatterbox, Turbo, Multilingual v3 (Jun 2026, 25 languages), Nano and Flash
  (edge and high throughput). **PerTh watermark on by default** in new releases. FireVoice already runs Chatterbox and
  Turbo and keeps the watermark.
- Platform: rapid and professional cloning, speech-to-speech, localize (translation into other languages in the same
  voice), audio enhancement (Resemble Enhance is open source), Resemble Detect (deepfake detection, vendor claims
  very high accuracy), Identity (speaker verification), on-prem and air-gapped deployment, DramaBox model (May 2026,
  reported).
- Markets watermarking as compliance for EU AI Act Article 50 (transparency for AI-generated content), applying from
  2026-08-01.

**Praise.** Open weights, safety story, enterprise deployment. **Complaints.** Hosted quality trails ElevenLabs on
expressive nuance (reported); editor less polished.

### 2.6 Murf

- **Studio:** block-based script editor (each block has a voice), per-word **pitch, speed, volume, emphasis**, pauses,
  pronunciation library (enterprise library with folders, permissions and "re-render when an entry changes"),
  **Say It My Way** (record your reading and the AI voice copies the delivery), multi-native voices that switch
  language mid-script, voice changer (upload a recording, get a Murf voice), video and music sync, AI translation,
  PowerPoint, Canva and Google Slides plugins, bulk actions, Murf Reader embeddable player.
- **MurfDub:** dubbing with QA-enabled languages, burn-in subtitles and original or dubbed downloads (Jun 2026).
- **API:** Falcon real-time model (Nov 2025, about 130 ms time to first audio, 10+ data residency regions, about
  $0.01 per 1,000 characters), Gen2 for studio quality, websocket streaming (Jun 2025), voice changer API, text
  translation API, dubbing automation API, voice cloning via API from one 30 s recording (enterprise, Sep 2026).

**Praise.** Easy for non-experts, fine per-word control, slide-deck integrations. **Complaints.** Voices less
expressive than ElevenLabs; cloning locked to enterprise; occasional pronunciation checks needed for jargon.

### 2.7 WellSaid

- **Caruso** model (Jan 2025): faster rendering, better first takes. Voices from licensed, consenting voice actors
  (a brand-safety pitch).
- Studio with projects and clips, **AI Director** (word-level pace, loudness and pitch control), pronunciation
  library with respellings, team phrase libraries, API, Adobe and LMS integrations.

**Praise.** Clean, safe enterprise voices; consistent narration for e-learning. **Complaints.** Monotone unless you
spend a long time tweaking words; price; no customer self-cloning.

### 2.8 Speechify Studio

- Voice-over studio with 200+ voices in 60+ languages, voice cloning, emotion controls, pronunciation library,
  pauses, dubbing, voice changer, AI avatars; the Speechify reader app is the bigger brand.

**Praise.** Ease of use, pronunciation of hard words. **Complaints.** Voice nuance, thin non-English voices, commercial
rights not in all plans, billing and cancellation friction (reported via competitor blogs and review sites).

### 2.9 Descript

- **Text-based audio and video editing:** delete words in the transcript to cut media; remove filler words; multitrack.
- **AI Speech (formerly Overdub):** clone your voice, then type to insert or replace words in a recording.
- **Regenerate:** select a flawed or missing segment and the AI re-speaks it, matching the surrounding tone; also
  used to fill gaps after cuts.
- **Studio Sound:** one-click noise removal and voice enhancement, widely praised.
- **Underlord:** agentic co-editor (filler removal, clips, show notes).
- Translation and dubbing, captions, eye contact, green screen.

**Praise.** Editing speech like a document; Studio Sound. **Complaints.** Credit burn (Studio Sound about 10 credits
per use, no rollover), clone sounds "professional" but not expressive, app performance on long projects.

### 2.10 OpenAI

- **gpt-4o-mini-tts** (snapshot 2025-12-15): an `instructions` field steers delivery ("speak like a calm nurse"),
  11 built-in voices, formats mp3, opus, aac, flac, wav, pcm, HTTP streaming. No SSML, no timestamps, no
  pronunciation dictionaries. Custom voices only for eligible customers via sales.
- **Realtime:** gpt-realtime-2 (May 2026: reasoning in the audio loop, preambles while tools run, 128K context),
  gpt-realtime-translate (70+ input, 13 output languages), gpt-realtime-whisper (streaming STT).
- **Transcription:** gpt-4o-transcribe and mini, a diarizing variant, Whisper.
- One report says OpenAI deprecated the standalone TTS models on 2026-10-01 with shutdown on 2027-01-06 and pointed
  users to a realtime model that does not support `/v1/audio/speech`; OpenAI's TTS guide did not show this.
  **Unconfirmed.**

**Why it matters for FireVoice:** the `/v1/audio/speech` and `/v1/audio/transcriptions` request shapes are the most
widely supported "custom TTS/STT endpoint" in third-party apps (chat front-ends, agent frameworks, home automation).
If OpenAI retires its TTS endpoint, local OpenAI-compatible servers become the obvious replacement.

---

## 3. Cross-cutting patterns worth copying

1. **Paragraph is the unit of work.** Every serious editor (ElevenLabs Studio, Murf blocks, WellSaid clips, Dubbing
   Studio segments) renders, regenerates, versions and locks per paragraph or block, and marks blocks stale when text
   changes.
2. **Takes are first-class.** ElevenLabs keeps per-paragraph generation history with restore; Hume returns up to 5
   generations per request; ElevenLabs Voice Design returns several previews. Users expect to compare and pick.
3. **Direct by example.** ElevenLabs Actor Mode, Murf Say It My Way and voice changers all let users perform a line and
   transfer the delivery. This is the escape hatch when text prompts fail.
4. **Pronunciation is managed data**, not inline hacks: dictionaries with alias and IPA rules, scopes (project,
   workspace), import (PLS), and "re-render affected blocks when an entry changes" (Murf).
5. **Inline direction is converging on bracket tags plus a free-text instruction.** ElevenLabs uses `[whispers]`;
   Hume and OpenAI use a natural-language instruction; Cartesia keeps a small SSML-like set (speed, volume, emotion,
   break, spell). FireVoice already has both mechanisms but per engine.
6. **Streaming for agents means websockets with text-in.** ElevenLabs stream-input and multi-context, Cartesia
   contexts, Hume stream-input. Each returns audio plus alignment and supports flush and cancel per context.
7. **Timing data everywhere.** Word or character timestamps on TTS, a forced-alignment endpoint, subtitle export,
   read-along players.
8. **Automatic QA.** ElevenLabs auto-regenerates on export when it detects missing words or distortion. FireVoice
   already does this on every take; it should be visible in the UI.
9. **Post-production built in.** Isolation, enhancement, reverb and environment presets, background beds, SFX, music,
   ducking, loudness targets.
10. **Safety and provenance:** consent and verification for clones, watermarking by default (Resemble, EU AI Act
    Article 50 from August 2026), classifiers.
11. **Model versioning:** Cartesia pins dated snapshots; users hate silent model changes. FireVoice can record exact
    engine, weights hash, seed and params for every take so any take can be reproduced.

---

## 4. Feature matrix

Legend: **Y** = has it; **P** = partial, limited or enterprise-only; **-** = not found; **?** = unclear or unverified;
**L** = legacy (PlayHT had it before shutting down). "FV" is FireVoice today.

| Feature | ElevenLabs | Cartesia | Hume | PlayHT (dead) | Resemble | Murf | WellSaid | Speechify | Descript | OpenAI | FV |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Premade voice library | Y | Y | Y | L | Y | Y | Y | Y | Y | Y (11) | Y (harvest) |
| Community voice marketplace | Y | P (public voices) | P | L | - | - | - | - | - | - | - |
| Voice collections or folders | Y | - | - | L | ? | Y | Y | ? | - | - | P (tags) |
| Instant voice clone | Y | Y | Y | L | Y | P (enterprise) | - | Y | Y | P (sales) | Y |
| Professional (fine-tuned) clone | Y | Y | - | L | Y | P | P (custom) | ? | - | P | - |
| Clone verification / consent check | Y | ? | ? | L | Y | ? | Y (licensed actors) | ? | Y | Y | P (consent flag) |
| Voice design from text prompt | Y | - | Y | - | ? | - | - | - | - | - | Y |
| Multiple previews per design | Y | - | Y | - | - | - | - | - | - | - | - |
| Voice remix (edit a voice by prompt) | Y | - | - | - | - | - | - | - | - | - | - |
| Inline audio or emotion tags | Y | P (emotion beta, laughter) | - | L | Y | P | - | Y | - | - | P (per engine) |
| Natural-language delivery instruction | P (via tags) | - | Y | - | - | - | - | - | - | Y | Y (instruct engines) |
| SSML or tag subset (break, speed, volume, spell) | P | Y | P (speed, silence) | L | Y | P | P | P | - | - | P (pause, pace) |
| Per-word pitch, speed, emphasis UI | - | - | - | - | ? | Y | Y | P | - | - | - |
| Pronunciation dictionary (alias) | Y | Y | - | L | ? | Y | Y | Y | - | - | - |
| Pronunciation dictionary (IPA or phoneme) | P (Flash only) | Y | P (coming) | L | ? | ? | Y (respelling) | ? | - | - | - |
| Text normalization control | Y | Y | ? | ? | ? | ? | ? | ? | - | - | P (always on) |
| Seed / reproducible takes | Y | - | - | - | ? | - | - | - | - | - | Y |
| Multiple takes per request | P (Studio history) | - | Y (1-5) | - | - | P (variability) | - | - | - | - | Y (candidates 1-8) |
| Automatic QA and re-roll | Y (Studio export) | - | - | - | - | - | P (better first take) | - | - | - | Y (every take) |
| Context stitching (prev/next text) | Y | Y (contexts) | Y | ? | ? | ? | ? | ? | - | - | P (ultimate clone) |
| Word or char timestamps on TTS | Y | Y (word, phoneme) | P (Octave 2) | L | ? | ? | ? | ? | - | - | Y (word) |
| HTTP chunked streaming | Y | Y | Y | L | Y | Y | Y | ? | - | Y | Y (SSE, PCM) |
| Websocket text-in streaming | Y | Y | Y | L | ? | Y | - | - | - | P (realtime) | - |
| Telephony formats (mu-law, A-law 8 kHz) | Y | Y | - | L | Y | Y | - | - | - | - | - |
| Audio effects (reverb, filter, pan, noise beds) | Y (Oct 2026) | - | - | - | - | - | - | - | P | - | - |
| Long-form project editor | Y | - | - | L | P | Y | Y | Y | Y | - | - |
| Chapters and document import (EPUB, DOCX, PDF, URL) | Y | - | - | L | ? | P | P | Y | P | - | - |
| Per-paragraph regenerate and history | Y | - | - | L | ? | Y | Y | Y | P | - | - |
| Lock paragraph / stale marking | Y | - | - | - | - | ? | ? | ? | - | - | - |
| Perform-to-direct (Actor Mode, Say It My Way) | Y | - | - | - | - | Y | - | - | - | - | - |
| Word-level speech inpainting (fix a word in audio) | P (selection regen) | Y (infill) | P (coming) | - | ? | - | - | - | Y | - | - |
| Multi-speaker dialogue generation | Y | - | - | L (PlayDialog) | ? | P (blocks) | P | P | - | - | P (batch lines) |
| Speech-to-speech voice changer | Y | Y | P (coming) | - | Y | Y | - | Y | - | P (realtime) | - |
| Voice isolator / speech enhancement | Y | P (clone upload) | - | - | Y (Enhance) | - | - | ? | Y (Studio Sound) | - | - |
| Dubbing / translation | Y | - | - | L | Y (localize) | Y | - | Y | Y | P (realtime translate) | - |
| Sound effects generation | Y | - | - | - | - | - | - | - | - | - | - |
| Music generation | Y | - | - | - | - | P (stock music) | - | ? | P (stock) | - | - |
| Timeline / multitrack mixer | Y | - | - | - | - | Y | ? | Y | Y | - | - |
| Captions / subtitle export | Y | - | - | ? | - | Y | ? | Y | Y | - | - |
| Audiobook publishing export | Y | - | - | L | - | - | - | - | - | - | - |
| STT batch | Y | Y | - | - | ? | - | - | - | Y | Y | Y |
| STT realtime streaming + turn detection | Y | Y | P (EVI) | - | - | - | - | - | - | Y | - |
| STT diarization | Y | ? | - | - | - | - | - | - | Y | Y | - |
| STT audio events, keyterms, entities | Y | P (keyterms) | - | - | - | - | - | - | - | - | - |
| Forced alignment endpoint | Y | - | - | - | - | - | - | - | P (internal) | - | P (Whisper words) |
| Voice agents platform | Y | Y | Y | L | Y | P | - | - | - | Y | - |
| Watermark / provenance | P (classifier) | - | - | - | Y | - | - | - | - | - | P (Chatterbox PerTh) |
| Deepfake detection | P | - | - | - | Y | - | - | - | - | - | - |
| MCP server | Y | ? | Y | - | ? | ? | - | - | - | - | - |
| CLI | Y (v1.0 Aug 2026) | ? | - | - | ? | - | - | - | - | - | Y |
| Collaboration (comments, share links) | Y | - | - | L | ? | Y | Y | ? | Y | - | - |
| Self-host / on-prem | P (enterprise) | Y | P (dedicated) | - | Y | - | - | - | - | - | Y (only mode) |
| Open-format export of voices and projects | P | - | - | - (lost on shutdown) | Y (open weights) | - | - | - | P | - | P (files on disk) |
| Many models behind one API | P (own models) | - | - | - | P | - | - | - | - | - | Y (12 engines) |

---

## 5. Ranked candidate features for FireVoice

Scoring: user value (how often the feature is the reason people pick a product, or the top complaint it fixes),
fit with "ElevenLabs-class local studio", and cost on one RTX 5080 (16 GB). Difficulty: **S** = days, **M** = one to
two weeks, **L** = several weeks, **XL** = a quarter or more. "Where": API, Playground (web `/playground`), Desktop
(Tauri app). "All" means all three.

Note on VRAM: the 5080 has 16 GB. New models (SFX, music, isolation, diarization, VC) must load into the existing
LRU pool as engines or tools and accept being unloaded; a project render should plan model swaps (render all
narration, then all SFX) rather than thrash.

### Tier 1: build next (core studio workflow)

**1. Long-form Projects editor (chapters, paragraphs, render status, per-paragraph regenerate)**
- What: a project document with chapters and paragraphs (or blocks); each paragraph has voice, style, engine,
  overrides and render state (unrendered, rendered, stale, locked); play renders ahead; export per chapter or whole.
- Who: ElevenLabs Studio, Murf Studio, WellSaid, Speechify Studio, PlayHT (legacy).
- Why: long-form narration (audiobooks, courses, YouTube scripts) is where users spend the most and complain the most
  (credits burnt, drift, regenerations). Locally, regeneration is free, which turns the main complaint into a strength.
- Difficulty: **L.** Backend: a `projects` resource on top of the existing jobs and batch machinery (project JSON on
  disk, paragraph hashes for stale detection, incremental render). Most work is the desktop editor.
- Where: API (projects CRUD and render), Desktop (main editor). Playground: read-only preview at most.

**2. Takes and generation history per paragraph, with A/B compare, restore and lock**
- What: keep every take (engine, seed, params, Whisper score, speaker similarity) per paragraph; compare side by
  side; pick one; lock it so re-renders skip it.
- Who: ElevenLabs Studio history and lock; Hume `num_generations`; ElevenLabs Voice Design previews.
- Why: TTS is stochastic; users want to choose rather than gamble. FireVoice already generates `candidates` and scores
  them, but throws the losers away.
- Difficulty: **S-M.** Store losing candidates instead of discarding; add take metadata and a picker.
- Where: All (API returns takes; Playground shows candidates; Desktop picker in the editor).

**3. Pronunciation dictionaries (alias and IPA rules, global and per-project, PLS import)**
- What: named dictionaries of rules (word or regex to alias text, or to IPA), case options, ordered matching, scope
  global, voice or project; mark affected paragraphs stale when an entry changes.
- Who: ElevenLabs, Cartesia, Murf (enterprise library with re-render prompts), WellSaid (respellings), Speechify.
- Why: names, brands, jargon and Roman Urdu terms are the most common reason to re-render. Every pro tool has it.
- Difficulty: **S** for alias rules (text frontend, works on every engine). **M** for IPA: only engines that accept
  phonemes (Kokoro via misaki IPA; others via respelling generated from IPA, or by cloning a short spoken sample).
  Show per-engine support.
- Where: All (API `pronunciation_dictionaries` field and CRUD, ElevenLabs-compatible shape; editors in both UIs).

**4. Multi-speaker dialogue (Text to Dialogue)**
- What: a script with speaker labels (`ALICE: ...`), a cast table mapping speakers to voices and styles, natural turn
  gaps, optional overlaps and interruptions, per-line regenerate, stems per speaker.
- Who: ElevenLabs Text to Dialogue (v3, v4), PlayDialog (legacy), Murf and Speechify via per-block voices.
- Why: podcasts, audio dramas, explainers, game lines; one of the most demoed features of v3. Also the base for a
  podcast-from-document feature.
- Difficulty: **M** using per-line rendering with any engine plus a turn-timing model (gaps from punctuation and
  speaker change, small overlaps for interruptions). **L** if adding a native dialogue model (open options: Dia,
  MOSS-TTSD, Higgs Audio, VibeVoice-style models; check licences and Windows support).
- Where: All (API `/api/v1/dialogue` plus ElevenLabs-compatible `/v1/text-to-dialogue`; Playground script box;
  Desktop cast editor inside Projects).

**5. Universal audio-tag layer with a tag palette**
- What: one documented tag set (`[whispers]`, `[laughs]`, `[sighs]`, `[excited]`, `[sad]`, `[shouting]`, `[pause]`,
  `[spell]...`) that FireVoice translates per engine: native tokens where supported (Chatterbox Turbo, Maya1), an
  instruction sentence for instruct engines (VoxCPM2, Qwen3, Breeze), emotion vectors for IndexTTS-2, a per-style
  reference clip swap, or a warning when an engine cannot honour it. Autocomplete and colour highlighting in editors.
- Who: ElevenLabs v3 and v4 audio tags; Cartesia emotion and spell tags; Hume acting instructions.
- Why: the "v3 audio tags" experience is the headline feature of modern TTS; FireVoice has the pieces but the user has
  to know each engine.
- Difficulty: **M.** Mostly mapping tables and markup parser work in `frontend/markup.py`, plus tests per engine.
- Where: All.

**6. Voice changer (speech-to-speech) and Actor Mode**
- What: input a recording (upload or mic), output the same words, timing and emotion in a target voice. Actor Mode
  in the editor: record yourself reading a paragraph, convert it into the paragraph's voice, and use it as that
  paragraph's take.
- Who: ElevenLabs Voice Changer and Actor Mode, Murf Say It My Way and voice changer, Cartesia, Resemble, Speechify.
- Why: the escape hatch when text direction fails; performers keep exact timing; great for character voices.
- Difficulty: **M.** Open options: Chatterbox VC (already in the Chatterbox package, MIT), Seed-VC, RVC (needs per-voice
  training), OpenVoice tone-colour converter. Real-time VC is harder (**L**).
- Where: All (API `/api/v1/sts` plus ElevenLabs-compatible `/v1/speech-to-speech`; Playground record-and-convert;
  Desktop in Projects and a standalone tool).

**7. Voice isolator and speech enhancer (and auto-clean of clone references)**
- What: remove music, noise and reverb from speech; optional enhancement (bandwidth extension, de-click); apply
  automatically to new clone references with a before/after toggle.
- Who: ElevenLabs Voice Isolator, Descript Studio Sound, Resemble Enhance, Cartesia noise removal toggle on clones.
- Why: bad references make bad clones; creators clean their own recordings; dubbing needs vocal and background
  separation.
- Difficulty: **S-M.** Open models: Demucs or BS-RoFormer / Mel-RoFormer (vocal separation), DeepFilterNet 3
  (denoise, light), Resemble Enhance (MIT). All fit easily alongside TTS.
- Where: All (API `/api/v1/isolate` plus ElevenLabs-compatible `/v1/audio-isolation`).

**8. OpenAI-compatible endpoints**
- What: `/v1/audio/speech` (`model`, `input`, `voice`, `instructions`, `response_format`, `speed`, streaming) and
  `/v1/audio/transcriptions` and `/translations` (multipart, `response_format` json, text, srt, vtt, verbose_json with
  word timestamps).
- Who: OpenAI defines the shape; most chat UIs, agent frameworks and home-automation tools accept a custom
  OpenAI-compatible base URL.
- Why: the cheapest way to make FireVoice usable from dozens of existing apps. If OpenAI retires standalone TTS
  (reported, unconfirmed), demand for local drop-ins rises.
- Difficulty: **S.** Thin mapping onto the existing service, like the ElevenLabs routes.
- Where: API.

**9. Visible QA review panel (surface the Whisper validation that already runs)**
- What: per paragraph, show transcript agreement, missing or extra words, stalls, clipping, pace outliers and speaker
  similarity; flag weak paragraphs in the editor; "fix all flagged" re-renders only those; QA summary on export.
- Who: ElevenLabs auto-regenerate on export (hidden); nobody else exposes per-take QA.
- Why: turns FireVoice's existing strength into a visible differentiator and saves listening time on long projects.
- Difficulty: **S-M.** Data exists in the pipeline; needs storage per take and UI.
- Where: All (API returns QA in take metadata; Desktop and Playground show flags).

**10. Websocket streaming with text-in (LLM tokens in, audio and alignment out)**
- What: a websocket that accepts text fragments, buffers to sentence or clause boundaries, streams PCM or Opus back
  with word alignment, supports `flush`, per-context ids and cancel (interruptions).
- Who: ElevenLabs stream-input and multi-context, Cartesia contexts, Hume stream-input, Murf websocket.
- Why: required for any voice-agent or live-reading use; ElevenLabs-compatible clients (Pipecat, LiveKit plugins)
  speak this protocol.
- Difficulty: **M.** Existing chunker and pool do the work; latency depends on engine (Kokoro and Chatterbox Turbo
  are fast enough; VoxCPM2 compiled at RTF 0.36 is fine for streaming but first-chunk latency must be measured).
- Where: API (plus a Playground "type and hear" demo).

### Tier 2: high value, build after the core

**11. Forced alignment endpoint and subtitle export**
- What: `POST /api/v1/align` (audio plus text to word and character times); SRT, VTT and JSON export for any render;
  ElevenLabs-compatible `/v1/forced-alignment`.
- Who: ElevenLabs Forced Alignment; captions in Studio, Murf, Speechify, Descript.
- Why: captions for video, read-along, karaoke, lip-sync pipelines, and aligning user recordings to scripts.
- Difficulty: **S.** CTC alignment with wav2vec2 or MMS (torchaudio forced aligner) or WhisperX-style alignment;
  word times already exist for renders.
- Where: All.

**12. Audiobook export (M4B with chapters, ACX check, metadata)**
- What: export a project as M4B or per-chapter MP3 with chapter markers, cover art, title, author, ISBN; an ACX/
  Audible-style check (RMS between -23 and -18 dB, peaks at or below -3 dB, noise floor at or below -60 dB, room tone
  at head and tail) with a pass/fail report and an auto-fix option.
- Who: ElevenLabs Studio export and publishing; no one else does the technical check well.
- Why: audiobooks are the biggest long-form use case; the check saves rejected uploads.
- Difficulty: **S-M.** ffmpeg plus the existing studio chain.
- Where: API and Desktop.

**13. STT upgrade: diarization, subtitles, keyterms, no-verbatim, audio events**
- What: speaker labels, SRT and VTT output, initial-prompt keyterms (hotwords), filler-word removal option, tags for
  laughter and music, multichannel.
- Who: ElevenLabs Scribe v2, Cartesia Ink-2 (keyterms), OpenAI diarize model, Descript.
- Why: transcription is half of "TTS/STT studio"; diarization is required for dubbing and for turning recordings into
  dialogue scripts.
- Difficulty: **M.** pyannote community diarization (gated weights, check licence) or NeMo Sortformer; Whisper
  `initial_prompt` and hotwords for keyterms; audio events from a classifier such as BEATs or PANNs.
- Where: All.

**14. Speech inpainting: fix a word or phrase inside a take**
- What: select words in a rendered paragraph, retype them, and regenerate only that span, matched in voice and
  prosody, with crossfades at word boundaries found by alignment.
- Who: Descript Regenerate and AI Speech, Cartesia infill, ElevenLabs selection regenerate, Hume phoneme editing
  (coming).
- Why: avoids re-rendering a good paragraph to fix one name.
- Difficulty: **M** for "re-render the sentence, splice the changed words at aligned boundaries"; **L** for true
  infilling (F5-TTS speech editing, MaskGCT-style models; check licences, F5 is CC-BY-NC).
- Where: API and Desktop.

**15. Voice design upgrades: multiple previews, remix, guidance and prompt helpers**
- What: return three to five candidate voices per description (different seeds or engines) for side-by-side choice;
  "remix" an existing voice ("older", "warmer", "more breathy") by redesigning with the old reference plus a new
  prompt where the engine allows; prompt templates by age, accent, timbre, pace; Kokoro voice-vector blending.
- Who: ElevenLabs Voice Design v3 and Remix, Hume voice design.
- Why: design is a FireVoice strength (Qwen3 VoiceDesign, VoxCPM2, Maya1, OmniVoice); one-shot design wastes it.
- Difficulty: **S** for multiple previews; **M** for remix and blending.
- Where: All.

**16. Context continuity across paragraphs (prosody stitching)**
- What: pass previous and next text (and optionally the previous take's audio tail) so each paragraph starts in the
  right register; keep one reference clip and seed per voice per project; "consistency mode" that prefers the
  candidate closest in speaker embedding and loudness to the previous paragraph.
- Who: ElevenLabs request stitching, Cartesia contexts, Hume context.
- Why: voice drift between paragraphs is the most common long-form complaint about ElevenLabs v3.
- Difficulty: **M.** Speaker-similarity selection is easy with the existing judge; audio-prompt continuation depends on
  engine (VoxCPM2 ultimate clone already helps).
- Where: API (request fields) and Desktop (on by default in Projects).

**17. Audio effects and environments**
- What: post-render effects per paragraph or line: room and hall reverb (convolution with bundled impulse responses),
  distance, telephone, radio, megaphone and walkie-talkie filters, pan, looped background beds (cafe, rain, office).
  Mirror the ElevenLabs `audio_effects` object and catalog endpoint.
- Who: ElevenLabs (Oct 2026); Descript and DAWs.
- Why: audio drama, games and explainers need it; cheap to do.
- Difficulty: **S.** ffmpeg filters or scipy convolution; ship a small CC0 IR and noise library. Avoid GPL-3
  dependencies if the app may be distributed under other terms.
- Where: All.

**18. Timeline mixer with music and SFX tracks, ducking and gaps**
- What: narration track plus music and SFX tracks per chapter; drag to nudge, trim, fade; automatic ducking of music
  under speech; set gap after each paragraph; render a mixdown and stems.
- Who: ElevenLabs Studio timeline, Murf, Speechify, Descript.
- Why: finished deliverables instead of raw narration; the gap control fixes "pauses ignored by the model".
- Difficulty: **L** (mostly desktop UI; mixing itself is ffmpeg).
- Where: Desktop (API renders the mix from a timeline JSON).

**19. Sound effects generation**
- What: prompt to SFX with duration, variations, loop option; a local SFX library browser; drop into the timeline.
- Who: ElevenLabs SFX v3 only (among these products).
- Why: completes the "all audio in one place" story; demanded by video creators and game devs.
- Difficulty: **M.** Stable Audio Open (1.0 or Small; Stability community licence, revenue cap) or AudioLDM2; MMAudio
  for video-to-audio (check weights licence). About 4-8 GB VRAM; plan swaps with TTS engines.
- Where: All.

**20. Import: EPUB, DOCX, PDF, Markdown, URL, SSML**
- What: import documents into a project with chapter detection from headings; clean-up rules (footnotes, page
  numbers); an SSML subset importer (`break`, `prosody rate`, `say-as`, `phoneme`, `sub`, `voice`) mapped to FireVoice
  markup.
- Who: ElevenLabs Studio import; Speechify; Murf.
- Why: nobody wants to paste a book paragraph by paragraph; SSML import eases migration from Azure, Google and Polly.
- Difficulty: **S-M.**
- Where: API and Desktop.

**21. Per-word controls (emphasis, pause, pitch, speed, volume)**
- What: select words, set emphasis or pause; pitch and volume implemented as DSP on aligned word spans; emphasis as an
  instruction for instruct engines or an inline tag.
- Who: Murf, WellSaid AI Director, Speechify.
- Why: e-learning and corporate users want deterministic fixes without regenerating.
- Difficulty: **M.** DSP on aligned spans is reliable; model-side emphasis varies by engine.
- Where: Desktop (API accepts span markup).

**22. Expanded ElevenLabs-compatible surface**
- What: add `/v1/text-to-speech/{id}/stream`, `/stream/with-timestamps`, websocket `stream-input`,
  `/v1/text-to-dialogue`, `/v1/speech-to-speech`, `/v1/audio-isolation`, `/v1/speech-to-text`, `/v1/forced-alignment`,
  `/v1/sound-generation`, `/v1/pronunciation-dictionaries`, `/v1/text-to-voice/design`, `/v1/history`.
- Who: ElevenLabs defines it; many tools and SDKs target it.
- Why: existing scripts and integrations switch to FireVoice by changing the base URL.
- Difficulty: **S** each once the native feature exists.
- Where: API.

### Tier 3: valuable, larger or narrower

**23. Dubbing pipeline (video or audio in, translated dub out)**
- What: separate vocals and background, transcribe and diarize, translate (local LLM or user-supplied API key), clone
  each speaker, render with duration control to fit segment timing, mix back over the background, export audio,
  video and subtitles; a segment editor with stale marking and per-segment regenerate.
- Who: ElevenLabs Dubbing (editor in maintenance mode), Murf MurfDub, Speechify, Descript, Resemble localize.
- Why: large market; a local version avoids per-minute dubbing fees.
- Difficulty: **XL.** Needs items 7, 13 and 6 first; translation needs an LLM (local 7-14B model in 16 GB VRAM
  competes with TTS); duration-controlled TTS is engine-dependent (IndexTTS-2 has explicit duration control but a
  non-commercial licence).
- Where: API (job kind `dub`) and Desktop (segment editor).

**24. Podcast or explainer from a document (GenFM-style)**
- What: document or URL in, two-host script out (LLM), rendered with the dialogue feature, with intro music.
- Who: ElevenLabs GenFM in Studio; NotebookLM popularised it.
- Why: popular demo; shows off dialogue and voices.
- Difficulty: **M** given item 4, if the user supplies an LLM endpoint (local llama.cpp or any OpenAI-compatible URL).
- Where: Desktop and API.

**25. Voice library management: collections, voice packs, import and export**
- What: collections or folders; a portable `.fvvoice` pack (reference clips, per-style clips, transcript, metadata,
  licence and consent record, preview); import packs; project export bundles.
- Who: ElevenLabs collections (Oct 2026) and Voice Library sharing; PlayHT's lost-data shutdown is the counter-example.
- Why: ownership and portability are the core reason to choose local; makes sharing voices between machines easy.
- Difficulty: **S.**
- Where: All.

**26. Provenance: watermarking and AI-content metadata**
- What: optional inaudible watermark on every render (AudioSeal, MIT; or keep PerTh for Chatterbox), a "check
  watermark" tool, and metadata tags (and optionally C2PA manifests) stating the audio is AI-generated, which engine
  and which voice.
- Who: Resemble (default watermark, Detect), ElevenLabs classifier.
- Why: EU AI Act Article 50 transparency duties apply from August 2026 for generated audio published in the EU;
  responsible cloning story.
- Difficulty: **S-M.**
- Where: API (flag and check endpoint), Desktop setting.

**27. Clone consent and verification flow**
- What: when cloning, optionally record a spoken consent sentence that is checked by STT and speaker similarity against
  the reference; store the consent record with the voice; label voices as "self", "licensed", "dataset", "unknown".
- Who: ElevenLabs PVC verification; WellSaid licensed actors.
- Why: safety and provenance for shared packs; cheap with existing ASR and speaker similarity.
- Difficulty: **S.**
- Where: All.

**28. Realtime STT with VAD and turn detection**
- What: websocket STT streaming partial and final transcripts with VAD and an end-of-turn model, keyterms.
- Who: ElevenLabs Scribe v2 Realtime, Cartesia Ink-2, OpenAI gpt-realtime-whisper.
- Why: dictation, live captions and the base for local agents.
- Difficulty: **M.** faster-whisper streaming with Silero VAD and an open turn-detection model (for example Pipecat
  smart-turn).
- Where: API and Playground (live captions demo).

**29. Local voice conversation demo (STT plus LLM plus TTS)**
- What: push-to-talk or VAD conversation with a user-chosen LLM endpoint, barge-in, streaming TTS.
- Who: ElevenAgents, Cartesia Line, Hume EVI, OpenAI Realtime.
- Why: showcases latency and voices; a frequent ask. A full agent platform (telephony, workflows) is out of scope.
- Difficulty: **M-L** (needs items 10 and 28).
- Where: Playground and Desktop.

**30. Text normalization preview and locale control**
- What: show the normalized text that will be spoken (numbers, dates, currency, units, phone numbers, abbreviations,
  Roman Urdu terms) before rendering; per-request `normalization` on or off and `locale`; per-project overrides.
- Who: ElevenLabs `apply_text_normalization`, Cartesia `normalization` and `locale` (Aug 2026).
- Why: wrong number readings are a top cause of re-renders; seeing it first saves time.
- Difficulty: **S** (normalizer exists in `frontend/normalize.py`).
- Where: All.

**31. Reproducible takes and model pinning**
- What: store engine, weights hash, adapter version, seed, params and markup with every take; "reproduce this take";
  warn when an engine update changes output.
- Who: Cartesia dated snapshots; ElevenLabs seed.
- Why: users hate silent model changes; local can guarantee reproducibility.
- Difficulty: **S.**
- Where: API and Desktop.

**32. MCP server**
- What: expose speak, list voices, design voice, transcribe and render project as MCP tools so Claude and other agents
  can drive FireVoice.
- Who: ElevenLabs hosted MCP, Hume MCP.
- Why: agent workflows (script writing plus narration) without glue code.
- Difficulty: **S.**
- Where: API (separate small server or route).

**33. Webhooks and job callbacks, CSV batch**
- What: per-job webhook on completion or failure; CSV and JSONL batch import with columns for any request field.
- Who: ElevenLabs (STT webhooks, Flows), Murf dubbing API.
- Why: automation pipelines (n8n, scripts) without polling.
- Difficulty: **S.**
- Where: API.

**34. Music generation**
- What: prompt or lyrics to music with sections and duration, for beds and intros.
- Who: ElevenLabs Music v2.5, Video to Music.
- Why: rounds out the studio, but quality gap vs cloud services is large.
- Difficulty: **M-L.** ACE-Step (Apache-2.0) or YuE (Apache-2.0); heavy VRAM and long renders on 16 GB.
- Where: API and Desktop (timeline).

**35. Review links and comments**
- What: export a self-contained review page (HTML with audio and per-paragraph comment fields) or serve a LAN
  read-only link; import comments back as paragraph notes.
- Who: ElevenLabs Studio share links and timestamped comments, Murf, WellSaid, Descript.
- Why: clients and collaborators review narration; local-first makes this harder, so a file-based review page fits.
- Difficulty: **M.**
- Where: Desktop.

**36. Video voice-over sync and burned-in captions**
- What: import a video, place narration and captions against it, export MP4 with burned or soft subtitles.
- Who: ElevenLabs Studio 3.0 video projects, Murf, Descript, Speechify.
- Why: many TTS users are video creators; but FireVoice is not a video editor.
- Difficulty: **L.**
- Where: Desktop.

**37. Live speech-to-speech translation**
- What: speak in one language, hear yourself in another in near real time.
- Who: ElevenLabs Realtime Translation (enterprise), OpenAI gpt-realtime-translate.
- Why: impressive, niche for a local studio.
- Difficulty: **XL** (STT plus translation LLM plus streaming TTS plus cloning under latency on one GPU).
- Where: Playground (demo) only.

### Not recommended (for now)

- Telephony agents (SIP, Twilio, call queues, DTMF): far from the studio mission.
- Image and video generation (ElevenLabs Flows): different product.
- Lip-sync avatars: heavy, legally sensitive, low fit.
- Deepfake detection classifier: hard to do well; watermark checks (item 26) cover FireVoice's own output.
- Community marketplace with payouts: needs a hosted service.

---

## 6. Suggested sequence

1. **Foundation for long-form (items 2, 9, 31, 30):** keep and score all takes, record reproducibility data, normalized
   preview. Small, mostly backend, unblocks the editor.
2. **Projects editor (items 1, 3, 5, 16, 20):** projects API and desktop editor with chapters, render state, takes,
   locks, pronunciation dictionaries, tag palette, continuity, document import.
3. **Voices and voice tools (items 6, 7, 15, 25, 27):** voice changer and Actor Mode, isolator and auto-clean, design
   previews and remix, voice packs, consent.
4. **Dialogue and API parity (items 4, 8, 10, 11, 22, 33):** dialogue, OpenAI-compatible routes, websocket text-in,
   alignment and subtitles, extended ElevenLabs routes, webhooks.
5. **Post-production (items 17, 18, 19, 12, 21, 14):** effects, mixer, SFX, audiobook export, per-word controls,
   inpainting.
6. **STT and realtime (items 13, 28, 29):** diarization and subtitles, realtime STT, local conversation demo.
7. **Big bets (items 23, 24, 34, 26):** dubbing, document-to-podcast, music, provenance.

---

## 7. Sources

ElevenLabs (official)
- Changelog index and entries: https://elevenlabs.io/docs/changelog/2026/9/28 , https://elevenlabs.io/docs/changelog/2026/10/12 ,
  https://elevenlabs.io/docs/changelog/2026/8/17 , https://elevenlabs.io/docs/changelog/2026/8/24 , https://elevenlabs.io/docs/changelog/2026/8/31
- Release digest (third-party aggregator of the official changelog, Aug-Nov 2026): https://releasebot.io/updates/eleven-labs
- TTS capabilities: https://elevenlabs.io/docs/overview/capabilities/text-to-speech
- v3 prompting and audio tags: https://elevenlabs.io/docs/best-practices/prompting/eleven-v3
- Studio guide: https://elevenlabs.io/docs/eleven-creative/products/studio
- Speech to Text capabilities: https://elevenlabs.io/docs/overview/capabilities/speech-to-text
- Forced alignment: https://elevenlabs.io/docs/overview/capabilities/forced-alignment
- Voice design and remix API: https://elevenlabs.io/docs/api-reference/text-to-voice/design , https://elevenlabs.io/docs/api-reference/text-to-voice/remix ,
  https://elevenlabs.io/blog/voice-design-v3
- Dubbing Studio: https://elevenlabs.io/docs/eleven-creative/products/dubbing/dubbing-studio , https://elevenlabs.io/blog/introducing-dubbing-studio

ElevenLabs user feedback
- r/ElevenLabs snapshots (Jan-May 2026): https://reddit.sentinel-team.org/subreddits/ElevenLabs/snapshots/2026-03-20T14%3A26%3A09.794287Z ,
  https://reddit.sentinel-team.org/subreddits/ElevenLabs/snapshots/2026-05-16T01%3A45%3A46.711269Z
- Review blogs: https://www.eesel.ai/blog/elevenlabs-reviews , https://vantaige.io/ai-tool/elevenlabs , https://www.roborhythms.com/elevenlabs-v3-whats-new/

Cartesia
- Changelog 2026: https://docs.cartesia.ai/changelog/2026
- Latest models: https://docs.cartesia.ai/build-with-cartesia/tts-models/latest , older models: https://docs.cartesia.ai/build-with-cartesia/tts-models/older-models.md
- SSML tags: https://docs.cartesia.ai/build-with-cartesia/sonic-3/ssml-tags
- Review: https://www.eesel.ai/blog/cartesia-sonic-3-api

Hume
- Octave 2 launch: https://hume.ai/blog/octave-2-launch
- TTS docs: https://dev.hume.ai/docs/text-to-speech-tts/overview , https://dev.hume.ai/docs/text-to-speech-tts/acting-instructions ,
  https://dev.hume.ai/docs/text-to-speech-tts/continuation , https://dev.hume.ai/docs/text-to-speech-tts/faq
- Coverage: https://www.testingcatalog.com/hume-ai-launches-octave-2-and-evi-4-mini-voice-models , https://docs.pipecat.ai/server/services/tts/hume

PlayHT
- Shutdown coverage: https://elevenlabs.io/blog/playht-alternatives-2026 , https://anyspeech.io/playht-alternatives ,
  https://texttolab.com/blog/play-ht-shutdown-alternatives , https://trillet.ai/blogs/playai-alternatives-2026

Resemble AI
- https://resemble.ai/products , https://www.resemble.ai/learn/models/chatterbox-multilingual ,
  https://www.resemble.ai/resources/the-watermark-cant-be-optional-anymore-so-we-made-it-the-default ,
  https://www.resemble.ai/resources/chatterbox-multilingual-v3-tts-with-embedded-watermarking-for-25-languages ,
  https://neuronfeed.com/reviews/resemble-ai-review

Murf
- Product updates: https://murf.ai/product-updates/all , API: https://murf.ai/api
- Reviews: https://hackceleration.com/labs/review/murf , https://www.g2.com/products/murf-ai/features

WellSaid
- https://wellsaid.io/resources/blog/coming-soon--wellsaids-most-performant-and-fastest-ai-voice-model-caruso-and-new-features-like-ai-director ,
  https://www.speechtechmag.com/Articles/News/Speech-Technology-News/WellSaid-Announces-the-Caruso-AI-Voice-Model-167580.aspx ,
  https://www.trustpilot.com/review/wellsaid.io , https://www.capterra.com/p/238211/Wellsaid/reviews

Speechify Studio
- https://www.g2.com/products/speechify-voice-over-studio/reviews , https://www.capterra.com/p/10011535/Voice-Over-Studio/ ,
  https://www.heygen.com/blog/speechify-alternatives (competitor blog)

Descript
- https://www.descript.com/studio-sound , https://skillscouter.com/descript-review/ , https://dupple.com/reviews/descript ,
  https://sonix.ai/resources/descript-review-pricing/amp/

OpenAI
- Audio model updates (Dec 2025): https://developers.openai.com/blog/updates-audio-models
- gpt-realtime-2 coverage (May 2026): https://thenextweb.com/news/openai-gpt-realtime-2-voice-models
- Reported TTS deprecation (unconfirmed): https://mixed-news.com/en/openai-tts-replacement-gpt-realtime-2-1-mini-audio-speech-not-supported/ ,
  https://www.creativeainews.com/articles/openai-tts-1-shutdown-migration-tested-2026/

Caveats
- Several ElevenLabs details (v4 and v4 Turbo, audio effects, SFX v3, collections) come from the official changelog;
  the Aug-Nov 2026 list came through an aggregator and was spot-checked against two official entries.
- Hume docs contradict themselves on acting instructions for Octave 2 and on the instant mode default.
- Review-site claims about Murf latency, WellSaid audio specs and Speechify billing are low-confidence and marked
  "(reported)" where used.
- Open-model licences named in section 5 (Stable Audio Open, pyannote, F5, IndexTTS-2, MMAudio, ACE-Step) must be
  re-checked before shipping; several are non-commercial or gated.
