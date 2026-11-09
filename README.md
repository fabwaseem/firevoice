# FireVoice 1.1

Local, expressive text-to-speech and speech-to-text engine for one GPU, and the backend of the FireVoice desktop app.
Many open models behind one service, one CLI and one HTTP API. No per-character fees, no rate limits, every take validated.

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
| ASR | base.en on CPU | large-v3-turbo on CUDA (0.1 s per take), CPU fallback; `firevoice transcribe` STT with word times |
| Styles | 11 dicts of Chatterbox knobs | 21 JSON **delivery styles** with instruction text, emotion vectors, pacing and a showcase paragraph; user styles in `~/.firevoice/styles/` |
| Voices | ref.wav | ref.wav + transcript (auto), gender, description, licence/provenance, **per-style reference clips**, designed voices (description only), `voices harvest` from open datasets |
| Tooling | `say`, `batch`, `audition`, `serve` | + `samples` (voice x style grid with HTML player), `engines`, `doctor`, `styles`, `transcribe`, `bench` (engine bake-off with WER / speaker-similarity / MOS report) |

## Install

```bash
uv venv --python 3.12 .venv && .venv\Scripts\activate
uv pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu128   # RTX 50-series needs cu128
uv pip install chatterbox-tts
uv pip install --reinstall-package torch --reinstall-package torchaudio torch torchaudio --index-url https://download.pytorch.org/whl/cu128
uv pip install -e ".[asr,server,harvest,bench,dev]"
firevoice doctor                       # GPU, ffmpeg, CUDA Whisper, engine venvs, voices
firevoice doctor --engine-test chatterbox-turbo --workers 2   # timed smoke synthesis
```

`ffmpeg` must be on PATH. Windows note: PyPI's `torch` wheel is CPU-only, always install from the cu128 index first.

### Other engines

Each heavy engine has its own venv and its own weights. FireVoice builds both from a pinned manifest:

```bash
firevoice engines plan voxcpm2        # what it would install and download, and what is already there
firevoice engines install voxcpm2     # venv + CUDA torch + pinned packages + weights + an import check
firevoice engines uninstall f5 --weights
```

The same install runs as a background job from the API (`POST /api/v1/engines/{name}/install`), the playground's
Engines page and the desktop app. Every venv hardlinks from uv's shared cache, so a torch build is stored once, not once
per engine. IndexTTS-2 and Breeze run from cloned repositories and stay manual (`engines plan` prints the steps).

### Where things live

FireVoice runs from a checkout, a pip install or the desktop app's bundle. Each location is an environment variable,
then a setting in `~/.firevoice/settings.json` (also editable from the API, the playground and the desktop app), then
the checkout's `.envs/` when running from source, then the data folder:

| what | env var | default |
|---|---|---|
| voices, renders, projects | `FIREVOICE_HOME` | `~/.firevoice` |
| engine venvs | `FIREVOICE_ENGINES_DIR` | `<checkout>/.envs`, else `<home>/engines` |
| model weights | `FIREVOICE_WEIGHTS_DIR` | `<engines>/weights` |
| ffmpeg | `FIREVOICE_FFMPEG` | `<home>/bin/ffmpeg`, then PATH |

`firevoice doctor` prints what was found and why. Manual recipe, if you prefer:

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
| `breeze` | Breeze TTS 2 3B | BreezeBlue research | no | top open model on the Speech Arena; voice direction |
| `omnivoice` | OmniVoice 0.6B | CC-BY-NC | no | very fast clone + design |
| `f5` | F5-TTS v1 | CC-BY-NC | no | flow-matching clone |

VoxCPM2 speed: install `triton-windows` matching your torch (3.7.x for torch 2.11) into `.envs/voxcpm` and the adapter
compiles the model with `torch.compile` (RTF 1.05 -> 0.36 on an RTX 5080, one ~2 min warm-up per worker; `--kw optimize=0` skips it).

Not runnable natively on Windows (vLLM-Omni / SGLang only): Fish S2 Pro, Fish Drama 3 (35B), Higgs Audio v3, Voxtral TTS.

## Use

One backend, two front doors: the CLI and the HTTP API both run through `firevoice.service.FireVoice`, so every option
means the same thing in both. Add `--remote` to any everyday command to send it to a running `firevoice serve`
(the model stays loaded, so repeated commands are fast).

```bash
firevoice say "Hello there. [pause 400ms] Welcome back." -o hello.mp3 --voice lib-f-4992 --style storyteller
firevoice say @script.txt -o narration.wav --engine voxcpm2 --voice glb-m-sco-s01863 --style documentary     --param inference_timesteps=16 --param cfg_value=2.5 --set pause=1.2 --candidates 2 --sample-rate 44100
firevoice say "Beep. I was designed from a sentence." -o robot.mp3 --design "a flat robotic AI assistant"
firevoice say "Aaj mausam bohat acha hai. Chalo chai peetay hain." -o urdu.mp3 --voice Ayesha --language ur
echo "Text from a pipe." | firevoice say - -o piped.wav --json
firevoice batch lines.json -o voice_out/ --format mp3 --parallel 3   # [{"id": "s01", "text": "...", <any option>}, ...]
firevoice transcribe talk.mp3 --language auto --print               # STT with word times
firevoice serve --preload voxcpm2                                    # API for the desktop app, docs at http://127.0.0.1:8787/docs
firevoice say "Fast, the model is already warm." -o warm.mp3 --remote
```

`say` writes the audio (format from the extension: wav, mp3, flac, ogg, opus, m4a) plus `<out>.words.json` with word
times. Every option:

| option | meaning |
|---|---|
| `--engine` | model (default `voxcpm2` or `$FIREVOICE_ENGINE`); `firevoice engines` lists them |
| `--voice` / `--design` | a library voice, or a voice invented from a description |
| `--style` | delivery style (`firevoice styles`); `--instruct` overrides its instruction, `--set FIELD=VALUE` any of its fields |
| `--pace`, `--seed`, `--language` | tempo, reproducibility, language (default: detected from the script) |
| `--param KEY=VALUE` | engine settings, validated against `firevoice engines info NAME` (e.g. VoxCPM2 `cfg_value`, `inference_timesteps`, `ultimate`) |

**One speaker for the whole script.** VoxCPM2 clones from the voice's clip *and* its transcript by default (`ultimate`), so every
sentence continues from the same recording and the voice does not drift between sentences or across a `[pause]`. A delivery
instruction (`--instruct`) needs clip-only cloning, so passing one turns `ultimate` off for that render unless you set
`--param ultimate=true`. Style presets still shape pace, pauses and per-style reference clips. Voices added without a
transcript are transcribed automatically.

VoxCPM2 also renders whole passages (up to about 360 characters) in one generation instead of one sentence at a time, so
there is no seam where the delivery could change. A `[pause]` inside a passage is generated through and the exact silence is
cut in at the word boundary afterwards (English text, using the speech-recognition word timings). Style or pace changes, long
pauses and non-English text still start a new generation.
| `--candidates`, `--accept`, `--no-asr` | takes per sentence, ASR agreement needed, skip validation |
| `--lufs` (0 = raw), `--lead-ms`, `--tail-ms` | mastering and padding |
| `--format`, `--sample-rate` | output encoding |
| `--remote [URL]`, `--token` | use a running server |

Manage everything else the same way:

```bash
firevoice engines                     # capabilities, licence, install status, speed
firevoice engines info voxcpm2        # every --param with type, default and range
firevoice voices list --language ur --gender female        # filters: --language --gender --kind --tag -q
firevoice voices add --name me --ref clip.wav --consent --language en --accent "Lahore"
firevoice voices add --name narrator --description "a warm, deep documentary narrator"   # designed + locked
firevoice voices update --name me --description "my studio voice" --tags mine,studio
firevoice voices default --name me
firevoice styles add mystyle --base calm --set pace=0.95 --instruct "speak softly, like a late-night radio host"
```

## HTTP API

`firevoice serve` exposes the full engine to the desktop app: engines (with settings schemas), voices (upload, design,
edit, per-style clips, previews), styles, TTS (whole file, in-order streaming over SSE, raw PCM), STT, and background
jobs with progress events and an on-disk history. ElevenLabs-shaped routes stay available for existing clients.
The full contract, with examples, is in [docs/API.md](docs/API.md).

Two pages ship with the server for testing by hand:

- `http://127.0.0.1:8787/docs` is Swagger. Every route has **Try it out** with ready-made examples in the Examples dropdown, and an **Authorize** button for the token. TTS responses play inline.
- `http://127.0.0.1:8787/playground` (also `/`) has six tabs:
  - **Speak:** every option plus auto-generated engine settings; render with word highlighting, stream with live playback, send to a job, or copy as curl.
  - **Voices:** browse, filter, preview, upload, design and delete.
  - **Speech to text:** a file or your microphone.
  - **Jobs:** live progress and playback.
  - **Styles:** create and edit your own.
  - **Engines:** load and unload, plus GPU info.

```bash
curl -s localhost:8787/api/v1/tts -H "Content-Type: application/json" -o hello.mp3   -d '{"text": "Hello there.", "voice": "lib-f-4992", "style": "storyteller", "params": {"inference_timesteps": 12}}'
```

### Drop-in for other clients

- **OpenAI SDK:** set `base_url="http://127.0.0.1:8787/v1"` and any API key. `audio.speech.create` and
  `audio.transcriptions.create` work unchanged; OpenAI voice names (`nova`, `onyx`...) map to library voices.
- **ElevenLabs clients:** the `/v1/text-to-speech/{voice_id}` routes.
- **Live agents:** `ws://127.0.0.1:8787/api/v1/tts/ws` takes text as an LLM writes it and returns audio sentence by
  sentence (about 0.5 s to first audio on a warm GPU).

Speech to text takes key terms (`--keyterms "FireVoice, Ayesha"`) and labels speakers (`diarize=true`).
Background jobs can be driven from the shell too:

```bash
firevoice jobs list ; firevoice jobs wait <id> ; firevoice jobs download <id> -o out.mp3
firevoice jobs submit dialogue --payload @show.json
```

## Takes, QA, subtitles and the dictionary

```bash
firevoice say "Script..." -o out.wav --keep-takes --srt out.srt   # keep every take, write subtitles
firevoice renders list                                             # kept renders, with flagged passages
firevoice renders show ID                                          # every passage and take: score, words missed or misheard
firevoice renders take ID 2                                        # a new take of passage 2 (it becomes the one used)
firevoice renders choose ID 2 1 ; firevoice renders lock ID 2      # use take 1 of passage 2 and keep it
firevoice renders edit ID 2 --text "...ships on Friday..."        # change words; only the edit is re-recorded
firevoice renders regenerate ID ; firevoice renders export ID -o final.wav
firevoice dict add Ayesha "Aa-ye-sha" ; firevoice dict test "Ayesha is here" ; firevoice dict list
```

The playground and the desktop app show the same thing after a render: each passage with the words the speech check
missed or misheard underlined, its takes to compare, a new-take button and a lock, plus SRT and VTT downloads. The
Dictionary page edits your pronunciation rules and plays them back.

## Projects (audiobooks and other long form)

```bash
firevoice project new "The Lighthouse" --text @book.txt --voice Ember --style audiobook   # "# Heading" lines start chapters
firevoice project render ID              # drafts and changed paragraphs only (--all: every unlocked one)
firevoice project show ID                # every paragraph with its status: draft, rendered, stale, locked
firevoice project export ID -o book.m4b --master audiobook   # also .mp3 .wav .srt .vtt, --chapter ID
firevoice project check ID --master audiobook                # loudness, peaks, noise floor, head and tail quiet
firevoice project bundle ID -o book.zip ; firevoice project import book.zip
firevoice voices pack Ember --pack ember.zip ; firevoice voices import --pack ember.zip --consent
```

The Projects page in the playground and the desktop app edits chapters and paragraphs (each with its own voice and
style if you like), saves as you type, renders only what changed in the background, and opens each paragraph's takes.

## Dialogue

```bash
firevoice dialogue script.txt -o show.mp3 --stems stems/ --srt show.srt   # "Name: line" per turn
firevoice dialogue script.txt --cast "Ayesha=urd-f-cv01,Bilal=Bilal" --dry-run   # see the turns and who speaks
```

Delivery tags work in any script: `[whisper]`, `[excited]`, `[calm]`, `[sad]`, `[angry]`, `[serious]`, `[dramatic]`
switch the style until `[normal]`.

## Voice tools

```bash
firevoice convert performance.wav --voice Ember -o ember.wav     # voice changer: your timing and delivery, another voice
firevoice audio analyze clip.wav ; firevoice audio clean clip.wav -o clip.clean.wav --strength medium
firevoice voices clean --name Isla ; firevoice voices restore --name Isla
firevoice voices build-styles --name Ember --styles calm,serious   # the voice's own clip per style
firevoice voices avatar --name Ember --image face.png
```

## Watermark and consent

Everything FireVoice makes carries an inaudible AudioSeal watermark that says so, the machine-readable marking EU AI
Act Article 50 asks of synthetic audio from 2026-08-02. It survives MP3, edits and level changes. Every cloned voice
keeps a consent record: who consented, when, through what, and fingerprints of the clip it covers.

```bash
pip install "firevoice[watermark]"                          # the marker and detector (small, CPU)
firevoice audio detect clip.mp3                             # made by FireVoice (render); marked share 100%
firevoice audio quality take.mp3 --voice Ember               # WavLM similarity, DNSMOS, drift over the take
firevoice renders quality ID                                # the same for a kept render
firevoice voices add --name Sara --ref sara.wav --consent --consent-by "Sara Khan"
firevoice voices consent --name Sara                        # the record, and whether the clip changed since
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

```bash
firevoice voices add --name narrator --ref clip.wav --consent --gender male --description "warm, mid-forties, slight gravel"
firevoice voices style-ref --name narrator --style-name horror --ref whispered_take.wav   # per-style reference clip
firevoice voices add --name ghost --description "a hushed, menacing male horror narrator"  # designed voice (no clip)
firevoice voices design --name ghost --engine qwen3-tts-design      # renders a reference so every engine can clone it
firevoice voices harvest --dataset libritts_r --shards ".downloads/libritts_r/data/test.clean/*.parquet" --max 14 --per-gender 7 --prefix lib
firevoice voices harvest --dataset globe_v2 --shards ".downloads/globe_v2/data/*.parquet" --max 42 --per-accent 3 --prefix glb
firevoice voices harvest --dataset fleurs --shards .downloads/fleurs_r_ur/data/ur_pk --lang ur --lang-name Urdu --prefix urd
firevoice voices harvest --dataset commonvoice --shards .downloads/cv_urdu --repo azeem-ahmed/Common_Voice_Corpus_22_0_Urdu --cv-split other --lang ur --lang-name Urdu --prefix urd
firevoice voices list -v
```

A voice keeps `ref.wav`, its transcript (transcribed on add; cloning engines that use in-context prompting need
it), gender, description, provenance and licence. `harvest` scans open datasets (LibriTTS-R and Hi-Fi TTS, CC-BY-4.0;
Expresso, CC-BY-NC) for 7-14 s clips with a clean noise floor, labels gender by pitch and, for expressive datasets,
attaches per-style reference clips (a whispered take becomes the `asmr`/`horror`/`bedtime` reference, a laughing
take the `excited` one). GLOBE V2 (CC0, accent-labelled Common Voice English, enhanced) is harvested round-robin over
accents with both genders per accent; FLEURS / FLEURS-R (CC-BY-4.0) has no speaker ids, so distinct speakers are found
by voice embedding; Common Voice (CC0) fetches only the clips of the speakers it picks. Voices record `language` and
`accent`. Adding a voice requires `--consent`; only clone voices you own or have permission to use.

`--voice "design:<description>"` speaks from a description with no library entry (design-capable engines).
Non-English text is detected by script (or pass a language): it is read as written, without English number
expansion or English ASR validation, and Urdu / Devanagari / CJK sentence marks split chunks.

### Showcase

```bash
firevoice showcase showcases/voxcpm2.json -o samples/voxcpm2            # resumes; --sections urdu,knobs to redo parts
```

A plan crosses voices (ids or selectors such as `@cloned`, `@lang:ur`, `@tag:globe_v2`, `design:...`) with styles,
texts and variants (any style field or engine parameter, e.g. `cfg`, `instruct`, `ultimate`, `inference_timesteps`).
Design sections can lock each take as a reusable `dsg-*` voice. The page puts each voice's original reference clip
next to its renders and filters rows by gender, language and text.

## Automated listening test

```bash
firevoice judge samples/voxcpm2          # manifest, metrics, listen, judge, utmos, report -> samples/voxcpm2/judge/report.html
```

Runs in `.envs/judge` (torch cu128, transformers 4.52.3, bitsandbytes, funasr) plus the main venv. Per clip:
SpeechJudge-GRM naturalness (Qwen2.5-Omni trained on 99K human votes, 4-bit, single-clip prompt, probability-weighted
1-9), Whisper intelligibility, resemblyzer similarity to the original, prosody, emotion2vec+ and arousal/valence/dominance
for style fit, and optionally UTMOSv2 (`--stages utmos`, runs the model's own code from Hugging Face). Voices are ranked
only against clips that said the same words. The pairwise SpeechJudge tournament (`--stages tournament`) is opt-in:
on near-equal clips it mostly prefers whichever clip played second. The report includes a reliability check (does each
metric order the same voices the same way across sections).

## Bake-off

```bash
firevoice bench                 # every engine with a venv: bench/texts.json -> bench/out/<engine>/ -> bench/report.{md,html}
firevoice bench --engines qwen3-tts,voxcpm2 --ref bench/refs/libri_f.wav
```

Each runner (`bench/runners/run_<engine>.py`) runs in that engine's venv and times load, per-clip latency and
VRAM. `bench/score.py` transcribes every clip with Whisper large-v3-turbo (WER after spoken-form canonicalisation),
measures speaker similarity to the reference (resemblyzer) and predicts quality (DNSMOS P.835), then writes a Markdown
table and an HTML page with every clip playable side by side.

## Architecture

```
CLI (cli.py) ─┐                          ┌─ engine pools: one worker process per model copy, each engine in its own venv
HTTP (server.py) ─► FireVoice service ───┼─ synthesizer: chunk ─► fan out ─► Whisper-validate ─► stitch ─► master
client.py ────┘    (service.py, jobs.py) ├─ voices / styles / jobs on disk in ~/.firevoice
                                         └─ shared GPU Whisper (validation + STT)

src/firevoice/
  service.py         FireVoice: engines (lazy load, VRAM-aware eviction), TTSRequest validation, tts / stream / stt,
                     voices, styles, system info
  jobs.py            background tts / batch / design jobs, progress events, history in ~/.firevoice/renders
  server.py          FastAPI app (/api/v1 + ElevenLabs-compatible routes)      client.py  Python client
  core/catalog.py    per-engine capabilities, languages, venv/weights status and typed parameter schemas
  core/registry.py   EngineSpec per engine: venv python, licence, VRAM, default workers (+ ~/.firevoice/engines.json)
  core/pool.py       EnginePool: N workers, VRAM-aware count, restart on death/hang, retry, OOM backoff
  core/worker.py     runs inside an engine venv: loads one adapter, serves load/voice/synth/stats
  core/protocol.py   JSON-lines supervisor <-> worker protocol      core/gpu.py  device-wide VRAM (nvidia-smi)
  core/adapters/     one file per model family
  synth.py           orchestrator with in-order chunk callbacks (streaming, progress) and cancellation
  asr.py             GPU faster-whisper (validation, word times, STT, language detection)
  styles.py + styles/*.json   delivery styles        voices.py  voice library     harvest.py  dataset harvesting
  frontend/          normalize (numbers, symbols, lexicon; non-English kept as written), markup, chunker
  audio.py           trim / fades / tempo / studio chain / encoders (wav mp3 flac ogg opus m4a pcm16)
  showcase.py        render a plan of voices x styles x settings     judge/  automated listening test
bench/               bake-off texts, reference clips, per-engine runners, scorer
docs/API.md          the HTTP API contract for the desktop app
```

Data lives in `~/.firevoice` (or `$FIREVOICE_HOME`): `voices/`, `styles/` (user styles), `renders/` (job history),
`logs/`. Engine venvs and weights live in `.envs/` next to the code; both are git-ignored.

Develop: `pytest` (CPU only, null engine, about 2 minutes; covers the service, every API route group and the CLI).

## License

MIT for this code. Model weights carry their own licences (table above); non-commercial engines are for personal use.
