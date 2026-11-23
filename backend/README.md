# FireVoice 1.1

Local, expressive text-to-speech and speech-to-text engine for one GPU, and the backend of the FireVoice desktop app.
Many open models behind one service and one HTTP API. No per-character fees, no rate limits, every take validated.

```
text ─► markup/normalise/chunk ─► EnginePool (N model copies, any engine, own venv each)
                                   │  every sentence x candidate take in flight at once
                                   ▼
                       GPU Whisper scores each take as it lands (agreement, rate, stalls, clipping)
                                   │  bad takes are re-rolled while the rest keep flowing
                                   ▼
             level-match ─► pace ─► humanised pauses ─► studio chain (-16 LUFS, true-peak) ─► wav/mp3 + word times
```

## What changed in 1.0

| | 0.2 | 1.0 |
|---|---|---|
| Engines | Chatterbox only, in-process | 12 adapters (Chatterbox Turbo/base, Qwen3-TTS base+VoiceDesign, VoxCPM2, dots.tts, IndexTTS-2, Breeze TTS 2, OmniVoice, F5, Kokoro, Maya1), each in its **own venv** so conflicting torch/transformers pins never fight |
| Parallelism | one sentence at a time under a lock | **worker pool**: N model copies per GPU, all sentences and candidate takes fan out at once, ASR scoring overlaps generation; VRAM-aware worker count |
| Robustness | retry once on OOM | workers are separate processes: a CUDA crash or hang restarts one worker and the job moves on; OOM backoff; parent watchdog so no orphaned GPU memory; hung-kernel timeouts |
| ASR | base.en on CPU | large-v3-turbo on CUDA (0.1 s per take), CPU fallback; speech to text with word times (`POST /api/v1/stt`) |
| Styles | 11 dicts of Chatterbox knobs | 21 JSON **delivery styles** with instruction text, emotion vectors, pacing and a showcase paragraph; user styles in `~/.firevoice/styles/` |
| Voices | ref.wav | ref.wav + transcript (auto), gender, description, licence/provenance, **per-style reference clips**, designed voices (description only) |

## Install

```bash
uv venv --python 3.12 .venv && .venv\Scripts\activate
uv pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu128   # RTX 50-series needs cu128
uv pip install chatterbox-tts
uv pip install --reinstall-package torch --reinstall-package torchaudio torch torchaudio --index-url https://download.pytorch.org/whl/cu128
uv pip install -e ".[asr,server,dev]"
python -m firevoice.server             # the HTTP API on http://127.0.0.1:8787, docs at /docs
curl -s localhost:8787/api/v1/system/setup   # the GPU, a recommended engine, which engines are ready, anything missing
```

`ffmpeg` must be on PATH. Windows note: PyPI's `torch` wheel is CPU-only, always install from the cu128 index first.

### Other engines

Each heavy engine has its own venv and its own weights. FireVoice builds both from a pinned manifest. Install from the
desktop app's Engines page, or through the API:

```bash
curl -s localhost:8787/api/v1/engines/voxcpm2/install             # the plan: what it would install and download, and what is already there
curl -s -X POST localhost:8787/api/v1/engines/voxcpm2/install     # a background job: venv + CUDA torch + pinned packages + weights
curl -s -X DELETE "localhost:8787/api/v1/engines/f5/install?weights=true"   # remove the venv and the weights
```

Every venv hardlinks from uv's shared cache, so a torch build is stored once, not once
per engine. IndexTTS-2, IndexTTS-2.5 and Ming run code from their GitHub repositories, and MOSS runs model code that
ships with its weights (`trust_remote_code`). All of them are pinned to fixed commits and revisions, and the install
plan and the app say so before installing. Breeze stays manual (research-only weights).

### Where things live

FireVoice runs from a checkout, a pip install or the desktop app's bundle. Each location is an environment variable,
then a setting in `~/.firevoice/settings.json` (also editable from the API and the desktop app), then
the checkout's `.envs/` when running from source, then the data folder:

| what | env var | default |
|---|---|---|
| voices, renders, projects | `FIREVOICE_HOME` | `~/.firevoice` |
| engine venvs | `FIREVOICE_ENGINES_DIR` | `<checkout>/.envs`, else `<home>/engines` |
| model weights | `FIREVOICE_WEIGHTS_DIR` | `<engines>/weights` |
| ffmpeg | `FIREVOICE_FFMPEG` | `<home>/bin/ffmpeg`, then PATH |

`GET /api/v1/system/paths` shows what was found and where it came from. Manual recipe, if you prefer:

```bash
uv venv --python 3.12 .envs/qwen && uv pip install --python .envs/qwen/Scripts/python.exe torch==2.9.1 torchaudio==2.9.1 --index-url https://download.pytorch.org/whl/cu128 && uv pip install --python .envs/qwen/Scripts/python.exe qwen-tts
hf download Qwen/Qwen3-TTS-12Hz-1.7B-Base --local-dir .envs/weights/qwen3-tts-1.7b-base
```

| engine | model | licence (weights) | commercial | notes |
|---|---|---|---|---|
| `chatterbox-turbo` | Resemble Chatterbox Turbo 350M | MIT | yes | fastest clone, `[laugh] [sigh]` tags, PerTh watermark kept |
| `chatterbox` | Chatterbox 500M | MIT | yes | built-in voice, exaggeration/CFG |
| `qwen3-tts` / `qwen3-tts-design` | Qwen3-TTS 12Hz 1.7B Base / VoiceDesign | Apache-2.0 | yes | 3 s clone with transcript; voice from a text description |
| `voxcpm2` | VoxCPM2 2B | Apache-2.0 | yes | 48 kHz, clone + ultimate clone + design + style instructions, 30 languages; RTF 0.36 compiled |
| `dots` | dots.tts SOAR 2B | Apache-2.0 | yes | 48 kHz, highest speaker similarity on Seed-TTS |
| `maya1` | Maya1 3B | Apache-2.0 | yes | description-designed voices, 20 emotion tags, ~9 GB |
| `kokoro` | Kokoro 82M | Apache-2.0 | yes | preset voices, RTF 0.01, no cloning |
| `indextts2` | IndexTTS-2 | bilibili licence | no | emotion vector / emotion text independent of timbre |
| `indextts25` | IndexTTS-2.5 | bilibili licence | no | 2.3x faster IndexTTS, native speech rate, zh/en/ja/es/ar; shares the indextts venv |
| `ming` | Ming-3.0-tts 0.5B | MIT | yes | clone or design a voice, paralinguistic tags, 7 languages, 44.1 kHz |
| `moss` | MOSS-TTS Local-Transformer v1.5 (5B) | Apache-2.0 | yes | 48 kHz cloning, 31 languages incl. Hindi, long passages; ~14 GB VRAM, wants the GPU to itself |
| `breeze` | Breeze TTS 2 3B | BreezeBlue research | no | top open model on the Speech Arena; voice direction |
| `omnivoice` | OmniVoice 0.6B | CC-BY-NC | no | very fast clone + design |
| `f5` | F5-TTS v1 | CC-BY-NC | no | flow-matching clone |

VoxCPM2 speed: install `triton-windows` matching your torch (3.7.x for torch 2.11) into `.envs/voxcpm` and the adapter
compiles the model with `torch.compile` (RTF 1.05 -> 0.36 on an RTX 5080, one ~2 min warm-up per worker).

Not runnable natively on Windows (vLLM-Omni / SGLang only): Fish S2 Pro, Fish Drama 3 (35B), Higgs Audio v3, Voxtral TTS.

## Use

FireVoice is used through the desktop app or the HTTP API. Both run through `firevoice.service.FireVoice`, so every
option means the same thing in both. The desktop app starts the server by itself. To run it yourself:

```bash
python -m firevoice.server                                    # http://127.0.0.1:8787, docs at /docs
python -m firevoice.server --preload voxcpm2 --token SECRET   # load an engine at startup, require a token
```

| option | meaning |
|---|---|
| `--host`, `--port` | where to listen (default `127.0.0.1`, `8787`) |
| `--engine` | default engine (default `voxcpm2` or `$FIREVOICE_ENGINE`) |
| `--preload`, `--workers` | comma-separated engines to load at startup, and model copies per preloaded engine |
| `--token`, `--no-token` | require an API token (also `FIREVOICE_API_KEY`); `--no-token` allows a network address without one, only on a network you trust |
| `--cors` | comma-separated allowed origins (default: localhost and the desktop app) |
| `--asr-model`, `--asr-device` | the Whisper model and device (default `auto`) |
| `--log-level` | `critical`, `error`, `warning` (default), `info` or `debug` |

The model stays loaded between requests, so repeated requests are fast.

```bash
curl -s localhost:8787/api/v1/tts -H "Content-Type: application/json" -o hello.mp3 \
  -d '{"text": "Hello there. [pause 400ms] Welcome back.", "voice": "lib-f-4992", "style": "storyteller"}'

curl -s localhost:8787/api/v1/tts -H "Content-Type: application/json" -o narration.wav \
  -d '{"text": "A longer script...", "engine": "voxcpm2", "voice": "glb-m-sco-s01863", "style": "documentary",
       "params": {"inference_timesteps": 16, "cfg_value": 2.5}, "style_overrides": {"pause": 1.2},
       "candidates": 2, "format": "wav", "sample_rate": 44100}'

curl -s localhost:8787/api/v1/tts -H "Content-Type: application/json" -o robot.mp3 \
  -d '{"text": "Beep. I was designed from a sentence.", "voice": "design:a flat robotic AI assistant"}'

curl -s localhost:8787/api/v1/tts -H "Content-Type: application/json" -o urdu.mp3 \
  -d '{"text": "Aaj mausam bohat acha hai. Chalo chai peetay hain.", "voice": "Ayesha", "language": "ur"}'

curl -s localhost:8787/api/v1/stt -F file=@talk.mp3 -F language=auto      # speech to text with word times
```

`format` picks the encoding (wav, mp3, flac, ogg, opus, m4a, pcm16). With `"response": "json"` the audio comes back
as base64 together with word times and stats. Several lines at once go through a `batch` job (`POST /api/v1/jobs`),
where each line may override any request field. The main request fields (all of them are in [docs/API.md](docs/API.md)):

| field | meaning |
|---|---|
| `engine` | model (default `voxcpm2` or `$FIREVOICE_ENGINE`); `GET /api/v1/engines` lists them |
| `voice` | a library voice, or `"design:<description>"` for a voice invented from a description |
| `style` | delivery style (`GET /api/v1/styles`); `instruct` overrides its instruction, `style_overrides` any of its fields |
| `pace`, `seed`, `language` | tempo, reproducibility, language (default: detected from the script) |
| `params` | engine settings, validated against the schema in `GET /api/v1/engines/{name}` (e.g. VoxCPM2 `cfg_value`, `inference_timesteps`, `ultimate`) |
| `candidates`, `accept`, `validate` | takes per sentence, ASR agreement needed, `false` skips validation |
| `lufs` (`null` = raw), `lead_ms`, `tail_ms` | mastering and padding |
| `format`, `sample_rate` | output encoding |

**One speaker for the whole script.** VoxCPM2 clones from the voice's clip *and* its transcript by default (`ultimate`), so every
sentence continues from the same recording and the voice does not drift between sentences or across a `[pause]`. A delivery
instruction (`instruct`) needs clip-only cloning, so passing one turns `ultimate` off for that render unless you set
`"params": {"ultimate": true}`. Style presets still shape pace, pauses and per-style reference clips. Voices added without a
transcript are transcribed automatically.

VoxCPM2 also renders whole passages (up to about 360 characters) in one generation instead of one sentence at a time, so
there is no seam where the delivery could change. A `[pause]` inside a passage is generated through and the exact silence is
cut in at the word boundary afterwards (English text, using the speech-recognition word timings). Style or pace changes, long
pauses and non-English text still start a new generation.

Everything else is managed the same way:

```bash
curl -s localhost:8787/api/v1/engines                 # capabilities, licence, install status, speed
curl -s localhost:8787/api/v1/engines/voxcpm2         # every setting with type, default and range
curl -s "localhost:8787/api/v1/voices?language=ur&gender=female"        # filters: language, gender, kind, tag, q
curl -s localhost:8787/api/v1/voices -F file=@clip.wav -F name=me -F consent=true -F language=en -F accent=Lahore
curl -s localhost:8787/api/v1/voices/design -H "Content-Type: application/json" \
  -d '{"name": "narrator", "description": "a warm, deep documentary narrator"}'           # designed + locked
curl -s -X PATCH localhost:8787/api/v1/voices/me -H "Content-Type: application/json" \
  -d '{"description": "my studio voice", "tags": ["mine", "studio"]}'
curl -s -X POST localhost:8787/api/v1/voices/me/default
curl -s -X PUT localhost:8787/api/v1/styles/mystyle -H "Content-Type: application/json" \
  -d '{"pace": 0.95, "instruct": "speak softly, like a late-night radio host"}'
```

## HTTP API

`python -m firevoice.server` exposes the full engine to the desktop app and to any other program: engines (with
settings schemas), voices (upload, design, edit, per-style clips, previews), styles, TTS (whole file, in-order
streaming over SSE, raw PCM), STT, and background jobs with progress events and an on-disk history.
ElevenLabs-shaped routes stay available for existing clients.
The full contract, with examples, is in [docs/API.md](docs/API.md).

One page ships with the server for testing by hand: `http://127.0.0.1:8787/docs` is Swagger (`/` redirects there, and
the schema is at `/openapi.json`). Every route has **Try it out** with ready-made examples in the Examples dropdown,
and an **Authorize** button for the token. TTS responses play inline. Sample recordings for trying the audio tools
are at `/api/v1/samples`.

```bash
curl -s localhost:8787/api/v1/tts -H "Content-Type: application/json" -o hello.mp3   -d '{"text": "Hello there.", "voice": "lib-f-4992", "style": "storyteller", "params": {"inference_timesteps": 12}}'
```

### Drop-in for other clients

- **OpenAI SDK:** set `base_url="http://127.0.0.1:8787/v1"` and any API key. `audio.speech.create` and
  `audio.transcriptions.create` work unchanged; OpenAI voice names (`nova`, `onyx`...) map to library voices.
- **ElevenLabs clients:** the `/v1/text-to-speech/{voice_id}` routes.
- **Live agents:** `ws://127.0.0.1:8787/api/v1/tts/ws` takes text as an LLM writes it and returns audio sentence by
  sentence (about 0.5 s to first audio on a warm GPU).

Speech to text takes key terms (`keyterms=FireVoice, Ayesha`) and labels speakers (`diarize=true`).
Long work runs as background jobs:

```
POST /api/v1/jobs                    {"kind": "tts" | "batch" | "dialogue" | ..., "payload": {...}}
GET  /api/v1/jobs                    the list
GET  /api/v1/jobs/{id}/events        progress as Server-Sent Events, until the job finishes
GET  /api/v1/jobs/{id}/audio         the result
```

## Takes, QA, subtitles and the dictionary

```
POST /api/v1/tts  {"text": "...", "keep_takes": true}        keep every take; the X-Render-Id header names the kept render
GET  /api/v1/renders                                         kept renders, with flagged passages
GET  /api/v1/renders/{id}                                    every passage and take: score, words missed or misheard
POST /api/v1/renders/{id}/chunks/{i}/takes                   a new take of passage i (it becomes the one used)
POST /api/v1/renders/{id}/chunks/{i}/choose  {"take": 1}     use take 1 of passage i
POST /api/v1/renders/{id}/chunks/{i}/lock    {"locked": true}    and keep it
POST /api/v1/renders/{id}/chunks/{i}/edit    {"text": "...ships on Friday..."}   change words; only the edit is re-recorded
POST /api/v1/renders/{id}/regenerate                         new takes for every unlocked passage
GET  /api/v1/renders/{id}/audio?format=wav                   the chosen takes, stitched and mastered
GET  /api/v1/renders/{id}/subtitles?format=srt               subtitles (srt or vtt)
POST /api/v1/dictionary       {"match": "Ayesha", "say": "Aa-ye-sha"}
POST /api/v1/dictionary/test  {"text": "Ayesha is here"}     what the engine will actually read
GET  /api/v1/dictionary                                      your rules and the built-in list
```

The desktop app shows the same thing after a render: each passage with the words the speech check
missed or misheard underlined, its takes to compare, a new-take button and a lock, plus SRT and VTT downloads. The
Dictionary page edits your pronunciation rules and plays them back.

## Projects (audiobooks and other long form)

```
POST /api/v1/projects  {"title": "The Lighthouse", "text": "...", "defaults": {"voice": "Ember", "style": "audiobook"}}
                                                             "# Heading" lines in the text start chapters
POST /api/v1/projects/{id}/render  {"scope": "stale"}        drafts and changed paragraphs only ("all": every unlocked one)
GET  /api/v1/projects/{id}                                   every paragraph with its status: draft, rendered, stale, locked
GET  /api/v1/projects/{id}/export?format=m4b&master=audiobook    also mp3, wav, srt, vtt; chapter= for one chapter
GET  /api/v1/projects/{id}/check?master=audiobook            loudness, peaks, noise floor, head and tail quiet
GET  /api/v1/projects/{id}/bundle                            the project and every take as one zip
POST /api/v1/projects/import                                 multipart file: a bundle, back as a new project
GET  /api/v1/voices/{id}/pack                                a voice as a portable pack
POST /api/v1/voices/import                                   multipart file, consent=true: a pack, back as a voice
```

The Projects page in the desktop app edits chapters and paragraphs (each with its own voice and
style if you like), saves as you type, renders only what changed in the background, and opens each paragraph's takes.

## Dialogue

```
POST /api/v1/dialogue        {"script": "...", "response": "zip", "stems": true}     "Name: line" per turn; the zip holds
                                                             the mix, one track per speaker and subtitles
POST /api/v1/dialogue/parse  {"script": "...", "cast": {"Ayesha": "urd-f-cv01", "Bilal": "Bilal"}}   see the turns and who speaks
```

Sound cues sit on their own line: `[sfx: a door creaks open, 2s]` puts an effect between turns, and one
`[music: calm lo-fi piano]` lays a bed under the whole dialogue (a stem each). They need the sound engines installed.

Delivery tags work in any script: `[whisper]`, `[excited]`, `[calm]`, `[sad]`, `[angry]`, `[serious]`, `[dramatic]`
switch the style until `[normal]`.

## Voice tools

```
POST /api/v1/voice-changer                    multipart file, voice: your timing and delivery, another voice
POST /api/v1/audio/analyze                    multipart file: how good a recording is to clone from
POST /api/v1/audio/clean                      multipart file, strength (light, medium, strong)
POST /api/v1/voices/{id}/clean                clean a voice's clip in place; /restore-original puts the original back
POST /api/v1/voices/{id}/styles/{style}/build     the voice's own clip for a style
POST /api/v1/voices/{id}/avatar               multipart file: the voice's avatar image
```

## Audio tools: separation, Urdu, exact timing

```
POST /api/v1/engines/separator/install        UVR RoFormer models, ~1.5 GB once
POST /api/v1/audio/separate                   multipart file, mode (vocals, denoise, dereverb), stem (voice, rest, zip)
POST /api/v1/audio/clean                      strength=neural: neural denoise, then level and trim
POST /api/v1/dub                              keep_music=true: the original music under the dub
```

- **Urdu takes are checked.** Scripts in Roman Urdu are compared with what Whisper hears in Urdu by consonant
  skeleton, so spelling variants ("hain", "hein") do not count against a take but a wrong word does. Urdu transcripts
  also come in English letters (`text_roman`). With VoxCPM2 and large-v3-turbo the check passed 94% of takes (mean
  0.963); the one failure was a genuinely wrong take.
- **Exact word times.** English word times are refined by CTC forced alignment (wav2vec 2.0, about 8 ms per take
  on the GPU), so subtitles, splices and pause cuts land on the real word edges. `FIREVOICE_ALIGN=off` turns it off.
- **Stopping is immediate.** A cancelled render stops the passage already generating on step-by-step engines (VoxCPM2
  and others that stream), instead of letting it finish.

## Sound effects and music

Install `audioldm2` and `musicgen` from the desktop app's Engines page or with `POST /api/v1/engines/{name}/install`
(one shared venv, ~3 GB of models).

```bash
curl -s localhost:8787/api/v1/sound -H "Content-Type: application/json" -o rain.wav \
  -d '{"prompt": "rain on a tin roof, distant thunder", "kind": "sfx", "duration": 8, "format": "wav"}'
curl -s localhost:8787/api/v1/sound -H "Content-Type: application/json" -o bed.mp3 \
  -d '{"prompt": "calm lo-fi piano bed, warm and slow", "kind": "music", "duration": 20, "format": "mp3"}'
```

AudioLDM 2 and MusicGen weights are licensed for non-commercial use only.

## Dubbing

```bash
pip install "firevoice[dub]"                                # sentencepiece for the local translator
curl -s localhost:8787/api/v1/dub -F file=@interview.mp4 -F target_language=es -F voice=Ember
curl -s localhost:8787/api/v1/dub -F file=@talk.mp3 -F target_language=de -F keep_voices=true -F consent=true -F translator=better
                                                            # the speakers' own voices, the larger translator
```

Each call starts a `dub` job; its files (the dubbed audio, subtitles and, for a video, the video with the new
soundtrack) are under `/api/v1/jobs/{id}/files/`.
Speech to text, translation (M2M100, 100 languages) and the voices all run locally. Each line keeps its original slot:
it is sped up by at most 1.3x, and anything longer flows into the next pause. Subtitles of the dub come with it.

## Watermark and consent

Everything FireVoice makes carries an inaudible AudioSeal watermark that says so, the machine-readable marking EU AI
Act Article 50 asks of synthetic audio from 2026-08-02. It survives MP3, edits and level changes. Every cloned voice
keeps a consent record: who consented, when, through what, and fingerprints of the clip it covers.

```bash
pip install "firevoice[watermark]"                          # the marker and detector (small, CPU)
curl -s localhost:8787/api/v1/audio/detect -F file=@clip.mp3                  # whether it carries the FireVoice mark
curl -s localhost:8787/api/v1/audio/quality -F file=@take.mp3 -F voice=Ember  # WavLM similarity, DNSMOS, drift over the take
curl -s localhost:8787/api/v1/renders/ID/quality                              # the same for a kept render
curl -s localhost:8787/api/v1/voices -F file=@sara.wav -F name=Sara -F consent=true -F "consent_by=Sara Khan"
curl -s localhost:8787/api/v1/voices/Sara/consent                             # the record, and whether the clip changed since
```

Turn marking off with `FIREVOICE_WATERMARK=off`, the `watermark` setting, or `"watermark": false` on one request.

## Markup, styles and voices

### Markup

`[pause 600ms]` `[style horror]` `[pace 0.95]`, blank line = paragraph pause, and for engines that support them the
paralinguistic tags `[laugh] [chuckle] [sigh] [gasp] [cough] [clear throat] [sniff] [groan]`.

### Styles

`explainer storyteller horror excited calm conversational dramatic serious curious reflective deadpan documentary
newscaster trailer bedtime asmr sports podcast audiobook angry sad neutral`. A style is a JSON file with pacing, pause
scale, sampling temperature, a delivery instruction (used by instruction-following engines), an IndexTTS-2 emotion
vector and a showcase paragraph. Drop your own into `~/.firevoice/styles/<name>.json`.

### Voices

```
POST /api/v1/voices                         multipart file, name, consent=true, gender, description...: a cloned voice
POST /api/v1/voices/{id}/styles/{style}     multipart file: a per-style reference clip, such as a whispered take for horror
POST /api/v1/voices/design                  {"name": "ghost", "description": "a hushed, menacing male horror narrator",
                                             "engine": "qwen3-tts-design"}: a designed voice, locked so every engine can clone it
GET  /api/v1/voices/{id}                    the voice with its transcript and per-style clips
```

A voice keeps `ref.wav`, its transcript (transcribed on add; cloning engines that use in-context prompting need
it), gender, description, provenance and licence. Voices record `language` and
`accent`. Adding a voice requires `consent=true`; only clone voices you own or have permission to use.

`"voice": "design:<description>"` speaks from a description with no library entry (design-capable engines).
Non-English text is detected by script (or pass a language): it is read as written, without English number
expansion or English ASR validation, and Urdu / Devanagari / CJK sentence marks split chunks.

## Architecture

```
desktop app, other programs ─► HTTP (server.py) ─► FireVoice service ───┬─ engine pools: one worker process per model copy, each engine in its own venv
                                                   (service.py, jobs.py) ├─ synthesizer: chunk ─► fan out ─► Whisper-validate ─► stitch ─► master
                                                                         ├─ voices / styles / jobs on disk in ~/.firevoice
                                                                         └─ shared GPU Whisper (validation + STT)

src/firevoice/
  service.py         FireVoice: engines (lazy load, VRAM-aware eviction), TTSRequest validation, tts / stream / stt,
                     voices, styles, system info
  jobs.py            background tts / batch / design jobs, progress events, history in ~/.firevoice/renders
  server.py          FastAPI app (/api/v1 + ElevenLabs-compatible routes); `python -m firevoice.server` starts it
  core/catalog.py    per-engine capabilities, languages, venv/weights status and typed parameter schemas
  core/registry.py   EngineSpec per engine: venv python, licence, VRAM, default workers (+ ~/.firevoice/engines.json)
  core/pool.py       EnginePool: N workers, VRAM-aware count, restart on death/hang, retry, OOM backoff
  core/worker.py     runs inside an engine venv: loads one adapter, serves load/voice/synth/stats
  core/protocol.py   JSON-lines supervisor <-> worker protocol      core/gpu.py  device-wide VRAM (nvidia-smi)
  core/adapters/     one file per model family
  synth.py           orchestrator with in-order chunk callbacks (streaming, progress) and cancellation
  asr.py             GPU faster-whisper (validation, word times, STT, language detection)
  styles.py + styles/*.json   delivery styles        voices.py  voice library
  frontend/          normalize (numbers, symbols, lexicon; non-English kept as written), markup, chunker
  audio.py           trim / fades / tempo / studio chain / encoders (wav mp3 flac ogg opus m4a pcm16)
docs/API.md          the HTTP API contract
```

Data lives in `~/.firevoice` (or `$FIREVOICE_HOME`): `voices/`, `styles/` (user styles), `renders/` (job history),
`logs/`. Engine venvs and weights live in `.envs/` next to the code; both are git-ignored.

Develop: `pytest` (CPU only, null engine, about 2 minutes; covers the service and every API route group).

## License

MIT (see `LICENSE` at the repo root). Model weights
carry their own licences (table above); non-commercial engines are for personal use.
