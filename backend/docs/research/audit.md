# FireVoice product audit: API, CLI, playground and desktop app

Date: 2026-11-09. Scope: `firevoice` 1.1.0 (backend, CLI, web playground) and `firevoice-desktop` 1.1.0 (Tauri 2 + React 19).
Method: a read-only review of the source. Nothing was run against a GPU. Each finding gives a `file:line` reference. Paths
are relative to `firevoice/src/firevoice/` for the backend and to `firevoice-desktop/` for the app, unless a path says
otherwise.

Reading guide

- Section 1 is the capability matrix.
- Section 2 lists parity gaps between the surfaces.
- Section 3 covers robustness and UX.
- Section 4 lists likely bugs and code risks, each with a `file:line` reference.
- Section 5 covers desktop packaging, with the backend shipped as a sidecar.
- Section 6 is a ranked list of 28 recommendations.

---

## 0. Executive summary

The backend design is solid. One service layer serves the CLI, the HTTP API and both UIs. Each engine runs in its own venv
as a worker process with crash and OOM recovery. Requests are validated in one place. Jobs have an on-disk history and
SSE progress. The desktop app is the most polished client. It has typed hooks, optimistic updates, a live chunk player,
empty and loading states, and decent ARIA coverage.

The biggest problems are below. Each is covered in detail in sections 3 to 5.

1. **Cancellation does not stop the GPU.** A request fans out every sentence to the engine queue at once
   (`synth.py:497-511`), and nothing ever cancels a queued pool job. The only check, `future.cancelled()` at
   `core/pool.py:312`, is dead code. Stop in either UI, a job cancel, or a closed stream only stops the gathering loop.
   The GPU keeps rendering the rest of the script. A whole-file `/api/v1/tts` render cannot be cancelled at all
   (`server.py:398-404`).
2. **There is no fairness between requests.** Each engine has a single FIFO queue (`core/pool.py:199,288-294`). A long
   job queues hundreds of chunks, and an interactive Speak render waits behind all of them.
3. **The backend can only run from the git checkout.** Engine venvs and weights are found relative to the source tree
   (`core/registry.py:17-18`). Workers get `PYTHONPATH=<repo>/src` (`core/pool.py:98,192`), and ffmpeg must be on PATH
   (`audio.py:12-16`). This must change before a sidecar build can ship.
4. **The job event stream cannot resume reliably.** SSE messages carry no `id:` (`server.py:248`), and the sequence
   counter restarts at 0 on every server start (`jobs.py:67`). After a server restart, the desktop app sends a stale
   `since` and misses events (`src/lib/api/client.ts:195-209`). The playground replays the whole event log on each
   reconnect and pops a toast for every old done or failed job (`web/app.js:617-619`).
5. **Errors break the documented JSON contract in several paths.** There is no catch-all handler, and job payloads skip
   pydantic validation. The `voice_not_found` code does not exist in the status map. Section 4 covers each case.
6. **There is no engine install story anywhere.** Engines are "not installed" until someone runs uv and hf by hand. The
   measured footprint is about 5 GB per venv (torch is duplicated in each) plus 3 to 7 GB of weights per engine.

---

## 1. Capability inventory

Legend: **Y** = supported, **P** = partial (see note), **-** = missing. "PG" = web playground, "Desk" = desktop app.

| Capability | API | CLI | PG | Desk | Notes |
|---|---|---|---|---|---|
| TTS whole file | Y `/api/v1/tts` | Y `say` | Y | Y | Desktop uses `response=json` (base64) for word times |
| TTS options: engine, voice, style, pace, seed, language, instruct, params | Y | Y | Y | Y | |
| TTS options: style_overrides | Y | Y `--set` | Y (JSON box) | - | No overrides editor in `components/speak/SettingsPanel.tsx` |
| TTS options: candidates, accept, validate | Y | Y | P | Y | PG has no `accept` and caps candidates at 4 |
| TTS options: lufs, lead_ms, tail_ms, sample_rate, format | Y | Y | P | Y | PG has no lead/tail; PG pace range is 0.5-2, the API allows 0.25-4 |
| Word timestamps | Y | Y `.words.json` | Y | Y (read-along) | |
| SSE streaming | Y `/tts/stream` | - | Y | Y | `client.py` has `tts_stream`, but no CLI command uses it |
| Raw PCM stream | Y `/tts/stream.pcm` | - | - | - | |
| Cancel a live render | P | Y (Ctrl+C) | P | P | Client-side only; see issue B1 |
| Background TTS job | Y | - | Y | Y | |
| Job list, events, cancel, delete, download | Y | - | Y | Y | Desktop adds a detail panel and output file links |
| Batch (many lines) | Y job `batch` + legacy `/v1/batch` | Y `batch` (local only) | - | P | Desktop shows batch jobs but cannot create one |
| Voice list and filters | Y | Y | Y | Y | |
| Voice add (upload) | Y | Y | Y | Y | Desktop can also record in-app; PG "Add from recording" is a file upload |
| Voice update | Y (11 fields) | P (no favorite, notes, traits) | P (no favorite, notes) | Y | |
| Reference transcript edit | Y | Y | Y | Y | |
| Voice delete, set default | Y | Y | Y | Y | |
| Voice design, saved | Y (sync + job) | Y | Y (sync) | Y (job) | |
| Ad-hoc `design:` voice in TTS | Y | Y `--design` | Y | Y | |
| Kokoro presets (`design:<preset>`) | Y | Y | P (free text) | - | Desktop has no preset picker |
| Per-style reference clips | Y | Y `style-ref` | Y | P | Desktop plays style clips but cannot upload them (`addStyleClip` is never called) |
| Voice previews: play | Y | - | Y | Y | |
| Voice previews: render | Y (one, or `previews` job) | Y `voices previews` | - | - | `api.renderVoicePreview` exists in the desktop client but is unused |
| Collections (shelves) | Y | - | Y | Y | |
| Branding (names, taglines, tiers) | Y `/voices/brand` | Y `voices brand` | - | - | |
| Styles CRUD | Y | Y | Y | Y | |
| Engines: list and info | Y | Y | Y | Y | |
| Engines: load and unload | Y | P (`serve --preload` only) | Y | Y (with worker count) | |
| Engine install, verify, remove | - | - | - | - | Manual uv/hf commands in the README only |
| STT | Y | Y `transcribe` | Y (record + upload) | Y (+ copy SRT, save text) | |
| Render history | P (jobs only) | - | P (in-memory session list) | P (jobs + current player track) | Direct `/tts` renders are never stored |
| GPU and system status | Y `/system` | Y `doctor` | Y | Y | |
| Doctor (toolchain check) | - | Y | - | - | |
| Settings | n/a | flags and env | token only | URL, token, theme, format, stream default, autoplay | |
| Auth | Y (bearer, x-api-key, xi-api-key, `?token=`) | Y `--token` (remote) | Y | Y | No 401 UI state in the desktop app |
| ElevenLabs-compatible routes | Y | - | - | - | |
| Pronunciation lexicon | - | P (`build_synth --lexicon`) | - | - | The service accepts a `lexicon`, but no route exposes it |
| Take cache | env only | Y `--cache` | - | - | |

---

## 2. Parity gaps

### 2.1 In the API but missing from the desktop app

- **Batch creation.** There is no UI to paste lines, import CSV or JSON, or set per-line overrides. Batch jobs only
  appear in the job list (`src/components/jobs/jobUtils.ts:41`).
- **Per-style clip upload.** `api.addStyleClip` (`src/lib/api/client.ts:100`) is never used. VoiceDetail can only play
  style clips.
- **Rendering voice previews.** `api.renderVoicePreview` (`client.ts:90`) is unused. There is no way to start a
  `previews` job.
- **Branding.** There is no UI for `/api/v1/voices/brand`.
- **Style overrides.** The desktop sends `style_overrides` from the studio store (`src/views/SpeakView.tsx`), but no UI
  edits them.
- **Kokoro presets.** The voice picker has no preset list.
- **Engine and voice compatibility check before render.** The playground blocks clone-only voices on non-clone engines
  (`web/app.js:233-239`). The desktop sends the request and shows the server error.
- **Real languages for "many languages" engines.** For `*` engines, the desktop offers a hard-coded list of 9 languages
  (`src/components/speak/SettingsPanel.tsx:40`).
- **Raw PCM streaming.** This is low value for the UI. It is listed for completeness.

### 2.2 In the API but missing from the playground

- Batch, previews rendering, branding.
- Favorite and notes editing.
- `accept`, `lead_ms` and `tail_ms`.
- Worker count on engine load.
- Recording a voice in the browser. The STT page records, but the add-voice drawer only takes a file.

### 2.3 In the API but missing from the CLI

- `--remote` support. It works for `say`, `voices list`, `engines` and `transcribe` only. `batch`, `styles`, and
  `voices add`, `design` and `update` always run locally. Running locally boots a second copy of the models next to a
  running server.
- Job commands: submit, list, watch, cancel and download.
- `engines load` and `engines unload`.
- Collections, and a streaming playback command.

### 2.4 The reverse: in a UI but not in the API

- **Read-along word highlighting and the live chunk player.** These are client-side, which is fine.
- **SRT export.** The desktop builds SRT on the client (`src/components/transcribe/srt.ts`). The CLI and API have no
  SRT or VTT output for STT or TTS words. Add `?format=srt|vtt` to STT and to the job `words` output so every surface
  gets it.
- **Speak render history.** The desktop and playground keep direct renders only in memory. The backend stores only job
  outputs, so a closed app loses every Speak render. Section 6 has the fix.
- **Draft persistence.** Both UIs persist the script locally, and there is no server-side "project" concept. That is
  fine for now. Consider it if multi-device use matters.

### 2.5 Inconsistencies between surfaces

| Topic | Inconsistency | Reference |
|---|---|---|
| Pace range | API 0.25-4, PG slider 0.5-2 | `service.py:286`, `web/app.js:257` |
| Recording length guidance | Desktop says 7-14 s, the backend asks for 6-20 s with a 3 s minimum | `src/components/voices/RecordPanel.tsx:85`, `voices.py:188` |
| Voice design | Desktop always runs it as a job; PG runs it synchronously with no timeout | `src/lib/api/hooks.ts:192`, `web/app.js` (design drawer) |
| Warnings header | The server sends a count; the desktop parses it as `;`-separated text | `server.py:221`, `src/lib/api/client.ts:130` |
| Job kinds in the docs | `previews` is missing from docs/API.md | `jobs.py:29`, `docs/API.md` |
| PATCH fields in the docs | API.md omits `tagline`, `traits`, `use_cases` | `server.py:188-200` |
| Undocumented routes | `GET/POST /voices/{id}/preview`, `/voices/collections` and `/voices/brand` are missing from API.md and the server docstring | `server.py:4-37,322-341` |
| App version | The desktop About card hard-codes "1.1.0" | `src/components/settings/DataAboutSections.tsx:100` |

---

## 3. Robustness and UX

### 3.1 Error handling

- **Errors that are not JSON.** There is no `@app.exception_handler(Exception)` (`server.py:135-142`). A `RuntimeError`
  from a missing ffmpeg (`audio.py:15`), a `TypeError` or `ValueError` from a job payload, or an encoder failure
  outside the `ValueError` catch (`service.py:399-402`) returns Starlette's plain-text 500. That breaks the documented
  `{"error": {...}}` contract, and both clients then show "Internal Server Error".
- **Job payloads skip validation.** `TTSRequest.from_dict` checks field names but not types (`service.py:71-76`). A job
  with `"pace": "fast"` raises `ValueError` from `float()` (`service.py:286`) or `TypeError` from comparing a string to
  an int (`service.py:288`). Neither is wrapped, so the result is a raw 500. The HTTP `/tts` path is safe because
  pydantic runs first.
- **Unknown error code.** `voice_brand` raises the code `voice_not_found` (`service.py:583`). It is not in `STATUS`, so
  the client gets HTTP 500 instead of 404.
- **CLI remote failures.** A remote error or a connection failure prints a Python traceback (`cli.py:203,317,397`).
  `cmd_say` is the only remote command that catches `ClientError`.
- **Desktop network errors.** All network errors become "Cannot reach the FireVoice server", because any `TypeError`
  is treated as offline (`src/lib/api/hooks.ts:22`). A genuine code bug that throws `TypeError` is mislabelled too.
- **Silent PCM truncation.** `/tts/stream.pcm` stops quietly on an error (`server.py:442-443`). A client cannot tell a
  failure from a short render. Abort the connection, or send an error trailer.
- **Hidden failures.** Several paths swallow exceptions with no trace:
  - the voice transcription fallback (`voices.py:246-247`);
  - the take cache (`synth.py:543`);
  - `_stop` (`service.py:193-202`);
  - corrupt `meta.json` or `job.json`, which are skipped silently (`voices.py:56-57`, `jobs.py:215-216`). A voice or
    job can vanish from the list with no warning.

### 3.2 Loading and empty states

- **Desktop.** Coverage is good: skeletons, an `EmptyState` on jobs and voices, a render status line, and a
  "loading the engine first" hint (`src/views/SpeakView.tsx:198-205`). Gaps:
  - There is no progress for an engine load. VoxCPM2 compiles for about 2 minutes, and loading shows only a button
    spinner.
  - Whole-file renders have no progress (the "rendering" phase) and no ETA.
  - The voice grid renders every voice with no virtualisation (102 voices today; harvesting can add hundreds).
- **Playground.** Coverage is reasonable. One bug: if `init()` fails (for example `/options` errors), the server shows
  as offline (`web/app.js:105-106`).

### 3.3 Cancellation

This is the weakest area. See issues B1-B3 in section 4.

- **Stop button.** In both UIs, Stop aborts only the fetch (`web/app.js:313`, `src/components/speak/useRender.ts:66-78`).
  - **Whole-file render:** the server keeps going until the end.
  - **Stream:** disconnect detection in Starlette 0.52 combined with a sync generator is not deterministic.
    `svc.stream` sets `cancel` only when its generator closes (`service.py:390-391`). That happens no earlier than the
    next chunk boundary. Even then, the queued chunks keep running on the GPU.
- **Job cancel.** The job stops at the next chunk boundary, but already-queued takes still render.
- **Batch jobs.** A batch checks `cancel` between lines (`jobs.py:293`), which is fine. The current line still renders
  to the end.

### 3.4 Long scripts

- **Fan-out at once.** The whole script is planned and fanned out at once (`synth.py:497-511`). A 200,000-character
  limit (`service.py:125`) means thousands of futures and every take held in RAM until stitching. The studio chain then
  runs ffmpeg over the full float32 buffer, about 0.7 GB for an hour at 48 kHz, plus encode copies.
- **No progress for synchronous renders.** `/tts` gives no progress. The desktop "Whole file" mode returns base64 JSON:
  a 30-minute render is about 40 MB of mp3, or 55 MB of base64 in one JSON string (`useRender.ts:89`).
- **No guidance towards jobs.** Neither UI warns when a script is long enough that it should be a job. The desktop
  shows words, characters and an estimated duration (`src/components/speak/ScriptEditor.tsx:43-44,116`) but no
  threshold.
- **Draft persistence cost.** The desktop persists the whole studio draft, including the text, to localStorage on every
  keystroke through zustand `persist` (`src/stores/studio.ts:32`). Large scripts will cause typing lag and can hit the
  5 MB quota.
- **No document import.** There is no .txt, .md or .docx import and no chapter splitting. These are natural for
  audiobook use.

### 3.5 Accessibility

- **Desktop: good basics.**
  - `aria-label` on icon buttons.
  - `role="radiogroup"` on the style chips.
  - Keyboard-operable job rows (`src/components/jobs/JobRow.tsx:42-46`).
  - `role="alert"` banners.
  - Radix dialogs with focus traps.

  Gaps:
  - Render progress and streaming state have no `aria-live` region.
  - The waveform and player position need a slider role with a value text.
  - Check that `motion` animations respect `prefers-reduced-motion`.
- **Playground: weak.**
  - `index.html` has zero `aria-` attributes.
  - `<label class="f">` elements are not tied to inputs with `for`.
  - Voice rows are clickable `div`s that cannot be reached by keyboard (`web/app.js:195-199`).
  - The drawer has no focus trap and no `role="dialog"`.
  - Icon buttons rely on `title` alone.
  - `confirm()` dialogs are used for deletes. They work, but are inconsistent.

### 3.6 Keyboard shortcuts

- **Desktop.** Ctrl+Enter renders. Esc stops (`src/views/SpeakView.tsx:72-83`). Space plays or pauses
  (`src/components/shell/PlayerBar.tsx:41`). Problems:
  - The Esc handler is global and also fires while a dialog is open. It stops a render when the user only meant to
    close a dialog.
  - There is no shortcut cheat sheet and no shortcuts for inserting a pause, toggling stream or file, or navigating
    views.
  - The listener is registered again on every render, because the effect has no dependency array.
- **Playground.** It has Ctrl+Enter, Esc, `/` and 1-6, and documents them in Settings. That is good.

### 3.7 Offline and backend-down handling

- **Desktop.** The health poll and offline banner are good (`src/components/shell/OfflineBanner.tsx`). Gaps:
  - `/health` needs no auth. With a wrong or missing token the app looks online, while every query fails with 401 and
    shows a generic toast. There is no "token required" state.
  - React Query keys are not scoped by server URL (`src/lib/api/hooks.ts:8-18`). After switching servers, cached voices,
    styles and jobs from the old server stay until refetch.
  - The job feed reconnects with a stale `since` after a server restart (issue B5).
- **Playground.** With a wrong token, `poll()` shows the same toast every 8 seconds (`web/app.js:106`).
- **Polling cost.** Both UIs poll `/api/v1/system` every 8 seconds (`src/lib/api/hooks.ts:39`, `web/app.js:114`). Each
  poll spawns `nvidia-smi` (`core/gpu.py:31`). `/options` calls `svc.system()` too (`server.py:278`), and with it a
  second `nvidia-smi` and three full scans of the voice library (`server.py:277-279`).

---

## 4. Code-quality risks and likely bugs

The severity is H, M or L. "Likely" means the issue follows from reading the code and was not reproduced.

### Backend: concurrency, cancellation and lifecycle

| # | Sev | Where | Issue |
|---|---|---|---|
| B1 | H | `core/pool.py:312`, `synth.py:497-527` | No code ever calls `Future.cancel()` on pool jobs, so the `job.future.cancelled()` check is dead code. On cancel, `speak()` raises at the next chunk boundary, but every queued take still runs on the GPU. For a long script that wastes minutes of GPU time and blocks other users. Also, `ch.done.result()` blocks with no timeout and no cancel check. |
| B2 | H | `core/pool.py:199,288-294` | Each engine has one FIFO queue shared by all requests. A job's hundreds of chunks starve interactive renders. Add per-request queues with round-robin, or a priority for interactive work. |
| B3 | H | `server.py:398-404` | A whole-file `/tts` render runs in the threadpool with no cancel event. A client abort cannot stop it. |
| B4 | M | `service.py:333-336` with `service.py:237-251` | Race: `_pool()` returns the loaded engine, then `active += 1` happens under a separate lock. In between, another request's `_make_room()` can see `active == 0` and stop the pool. The pending request then fails, or hangs (see B6). Increment `active` inside `_pool()` while holding the lock. |
| B5 | M | `jobs.py:66-67`, `server.py:245-249`, `src/lib/api/client.ts:195-209` | Event `seq` restarts at 0 on every server start, and events older than the 5,000-entry deque are dropped. SSE frames have no `id:`. The desktop resumes with a stale `since` after a restart and receives nothing until `seq` catches up. Add a server epoch or instance id to events and `/health`, and emit `id:`. |
| B6 | M | `core/pool.py:270-275` | `EnginePool.stop()` stops the workers but never fails the futures still queued. Any `speak()` waiting on them blocks forever (`synth.py:527`), together with its request thread or job thread. Two job threads blocked this way stall the whole job system (`jobs.py:56`, concurrency 2). |
| B7 | M | `core/pool.py:345-356`, `core/pool.py:318` | If a worker fails all 3 restart attempts it stays in the pool as a dead worker. Its loop keeps taking jobs and failing them ("worker dead"), which burns other jobs' retries. The engine still reports `loaded: true`, with no health flag. |
| B8 | L | `core/pool.py:138-153,165` | When a worker dies, EOF returns `None`, which is reported as "timeout after Ns" with kind `hang`. The error text misleads anyone triaging logs. |
| B9 | M | `service.py:221` | `_make_room(spec.vram_gb * 1 + reserve)` ignores the worker count. Loading 2 workers of a 5 GB engine frees room for only one. `fit_workers` then trims the count, so the engine runs with fewer workers than requested. |
| B10 | L | `jobs.py:128-137` | Deleting a job emits no event, so other clients keep showing it. The desktop listens for `deleted` and `created` events that the server never emits (`src/lib/api/client.ts:216`). |
| B11 | M | `jobs.py:292-309` | Batch jobs render lines one after another. CLI `batch` renders 2 at a time (`cli.py:187-188`). For many short lines the pool is underused, so the same batch is slower through the API than through the CLI. |
| B12 | L | `synth.py:263`, `core/pool.py:292` | Shared stat counters (`stats.asr_seconds`, `pool.stats["jobs"]`) are updated from several threads with no lock. Cosmetic. |

### Backend: correctness and contracts

| # | Sev | Where | Issue |
|---|---|---|---|
| C1 | M | `server.py:135-142` | There is no catch-all exception handler (see 3.1), so non-JSON 500s break the error contract. |
| C2 | M | `service.py:71-76,286-291`, `jobs.py:80-81,92` | Job payload `request` and `defaults` skip type validation, so the wrong type gives a raw 500. Validate jobs through the same pydantic model as `/tts`. |
| C3 | L | `service.py:583` | Error code `voice_not_found` is not in `STATUS`, so it returns 500. Use `not_found`. |
| C4 | M | `server.py:221` vs `src/lib/api/client.ts:130` | `X-Warnings` holds a count, and the desktop splits it as text. The result is the desktop shows a warning that just reads "2". This only hits the `api.tts` path. Speak uses `ttsJson`, so the bug is latent today but waits for any caller. |
| C5 | M | `audio.py:163` | `m4a` is written as raw ADTS AAC (`-f adts`) with a `.m4a` extension and media type `audio/aac`. Many players (Apple, some DAWs) reject ADTS in a `.m4a` file. Use `-f ipod` or `-f mp4` with `-movflags +faststart` (on a temp file, because MP4 cannot be piped), or rename the format to `aac`. |
| C6 | L | `server.py:516-518` | The ElevenLabs route returns a WAV container for `pcm_*` output formats, but those clients expect raw PCM. It also ignores the sample rate and bitrate in `output_format`. `/v1/voices` returns FireVoice's voice shape, with no `preview_url`, `labels` or `category` (`server.py:537-539`). |
| C7 | M | `server.py:551-575`, `batch.py:29,39` | Legacy `/v1/batch` writes to any `out_dir` the client names, so it is an arbitrary file write on the host. It uses the engine without `active` accounting, so eviction can stop the engine mid-batch (see B4 and B6). A line without `id` raises `KeyError`, which gives a raw 500. |
| C8 | M | `service.py:632-637` | `style_remove` builds `home()/styles/{name}.json` from the raw path parameter. On Windows a name like `..\..\voices\x\meta` is a single URL segment, so this can delete any `.json` file the process can reach. Apply the same regex `style_save` uses (`service.py:613`). |
| C9 | L | `voices.py:103-104` | `ref_path` joins an unsanitised `style` query parameter. `GET /voices/{id}/audio?style=..\..\x` can read any `.wav` file. |
| C10 | L | `core/catalog.py:145` | The IndexTTS-2 `emo_ref` parameter is a path on the server that any API client can set. It is read-only and audio-only, but it should be limited to uploaded files or the voice library. |
| C11 | L | `server.py:151-154` | The token comparison is not constant-time (`!=`). `?token=` puts the secret in URLs, which end up in logs, history and the clipboard (the playground's "copy curl" copies the header form, which is fine). |
| C12 | L | `server.py:223-226` | An upload is read fully into memory before the 60 MB size check. Stream it to disk with a running byte count. |
| C13 | M | `core/registry.py:89` | `user_engines()` calls `json.loads` with no try. A malformed `~/.firevoice/engines.json` breaks `all_engines()`, and with it every engine, TTS and options call. Bad style files are skipped with a warning (`styles.py`), so engines should behave the same way. |
| C14 | M | `core/catalog.py:86-95,117-124` | `status()` only checks that the venv folder and the weights folder exist. Engines with `venv=None` (chatterbox, chatterbox-turbo, and user engines) always report ready, even when `chatterbox-tts` is not installed. Engines with no `weights` (f5, kokoro) download from Hugging Face on first load, which fails offline. The check never confirms the venv's `python.exe` exists. `registry._venv_python` silently falls back to `sys.executable` (`core/registry.py:23`). The UIs show such an engine as "ready", and it then fails with "failed to start". |
| C15 | L | `core/gpu.py:18,25,47` | `nvidia-smi` values are divided by 1024 (GiB) while the torch fallback divides by 1e9 (GB). VRAM numbers shift by 7% depending on which path ran. |
| C16 | M | `voices.py:228`, `voices.py:179,201` | `meta.json` writes are not atomic. A crash or two concurrent PATCH calls can corrupt the file, and `list()` then silently drops the voice (`voices.py:56-57`). Write to a temp file and rename, as `jobs._save` does (`jobs.py:202-207`). The preview mp3 write (`service.py:571`) has the same problem. |
| C17 | M | `voices.py:241-243` | `VoiceLibrary._transcribe` loads its own `FasterWhisperAligner` instead of the service's shared one (`service.py:264-270`). Adding a voice through the API can put a second Whisper model on the GPU. |
| C18 | L | `voices.py:63-76`, `service.py:437-451` | `canonical()` reads every `meta.json` on a miss, and `voice_list()` reads all of them again. With hundreds of voices, `/options`, `/voices` and every TTS request that names a voice by display name do O(n) disk reads. |
| C19 | L | `cli.py:246-249` | `firevoice voices design --name X` removes the existing entry before calling `voice_design`. If the design fails (engine missing, OOM), the voice is gone. |
| C20 | L | `core/pool.py:193`, `core/pool.py:106` | Each pool creates a `mkdtemp` scratch folder that is never removed. Worker logs append forever with no rotation. |
| C21 | L | `service.py:500-504` | `voice_set_transcript` accepts an empty transcript. That silently switches cloning engines to clip-only mode. |
| C22 | L | `jobs.py:209-222` | Job history is loaded fully at startup and never pruned. `renders/` grows without bound. |

### Web playground

| # | Sev | Where | Issue |
|---|---|---|---|
| W1 | M | `web/app.js:617-619`, `server.py:248` | The job EventSource connects with no `since`, and SSE frames have no `id:`. Every (re)connect replays the event log, and a "Finished"/"Failed" toast fires for every replayed terminal event. |
| W2 | L | `web/app.js:106` | With a missing or wrong token, the "needs an API token" toast repeats every 8 seconds. |
| W3 | M | `web/app.js:313,329` | Stop aborts the fetch only. The server keeps rendering (see B1 and B3). |
| W4 | L | `web/app.js:30,211,630` | The token goes into `?token=` for audio sources and download links. It ends up in history and logs. |
| W5 | M | `web/index.html` | There are no ARIA attributes, labels are not tied to inputs, and voice rows cannot be reached by keyboard (see 3.5). |

### Desktop app

| # | Sev | Where | Issue |
|---|---|---|---|
| D1 | M | `src/lib/api/client.ts:195-209,216` | The job feed resumes with a stale `since` after a server restart (B5), and it subscribes to event types the server never sends. |
| D2 | M | `src/components/jobs/JobRow.tsx:107` | Download uses `window.open(url, "_blank")`. In a Tauri 2 webview this either does nothing or hands a token-bearing URL to the system browser. `src/lib/audio.ts:164` already has a proper `saveBlob` through the dialog and fs plugins, so use it here too. |
| D3 | M | `src/lib/api/hooks.ts:8-18` | Query keys do not include `serverUrl` (only `health` does), so data from different servers mixes after a switch. |
| D4 | M | `src/stores/studio.ts:32` | The whole draft, including long scripts, is written to localStorage on each keystroke. Debounce the writes, or keep the text in IndexedDB or the Tauri store. |
| D5 | L | `src/components/settings/DataAboutSections.tsx:100` | The version is hard-coded. Use `getVersion()` from `@tauri-apps/api/app`, and show the backend version next to it. |
| D6 | L | `src/components/speak/SettingsPanel.tsx:40` | For `*` engines the language list is hard-coded, even though OmniVoice supports 600+ languages. |
| D7 | M | `src-tauri/tauri.conf.json` (`"csp": null`), `src-tauri/capabilities/default.json` (`fs:scope` allows writes under `$HOME/**`) | There is no CSP, and the webview can write anywhere in the home folder. Tighten both before release. Writes only need the path the user picked in the save dialog. |
| D8 | L | `src/views/SpeakView.tsx:72-83` | The global Esc handler stops a render even when it was pressed to close a dialog. The effect re-subscribes on every render. |
| D9 | L | `src/stores/settings.ts:27-44` | The token is stored in plain localStorage. Prefer the Tauri store, or, once there is a sidecar, a token the Rust side passes in at startup and never persists. |
| D10 | M | `src-tauri/src/lib.rs` | There is no backend lifecycle at all yet. The shell plugin is initialised but unused. See section 5. |
| D11 | L | no tests | The desktop repo has no tests. The SSE parser, error parsing and audio stitching are untested. |

---

## 5. Desktop packaging: the Python backend as a sidecar

Goal: a desktop release installs one thing, and the backend stays a standalone API (`firevoice serve`, CLI and
playground) that never depends on the desktop app. Rule of thumb: every change below lands in the backend as a generic
flag, environment variable or route. The desktop only *uses* those, so the CLI and playground benefit too.

### 5.1 What blocks a relocatable backend today

1. **Repo-relative paths.**
   - `core/registry.py:17-18` sets `PKG_ROOT = parents[3]` and `ENVS = PKG_ROOT/.envs`. Inside an installed wheel or a
     frozen app this points at nonsense.
   - `core/pool.py:192,98` sets the workers' `PYTHONPATH` to `<repo>/src`.
   - `service.voice_brand` reads `samples/voxcpm2/judge/report.json` next to the code (`service.py:580`).
   - `cli.py:17` `ROOT` has the same problem.

   Fix: add `FIREVOICE_ENVS` (venvs), `FIREVOICE_WEIGHTS` (weights, so they can live on another drive) and
   `FIREVOICE_FFMPEG`. Default them to today's layout. Report the resolved paths in `/api/v1/system`.
2. **The workers need the `firevoice` package inside each engine venv.** Today they borrow it through `PYTHONPATH`.
   - **Option A.** Ship the backend as plain source (or a wheel) next to an embedded CPython, and keep the `PYTHONPATH`
     trick, pointed at the installed package folder.
   - **Option B.** Install a slim `firevoice-worker` wheel (protocol, worker and adapters; numpy only) into each venv
     when the engine is installed.
   - Option A is simpler, and B is cleaner for updates. A PyInstaller-frozen supervisor does *not* solve this, because
     the venv interpreters cannot import from inside a frozen bundle.
3. **ffmpeg on PATH.** `audio.py:12-16` and `server.py:240` require it. Bundle an LGPL ffmpeg build as a resource and
   point `FIREVOICE_FFMPEG` at it.
4. **`nvidia-smi` on PATH.** The NVIDIA driver installs it, so it is fine on NVIDIA machines. Without it, the GPU card
   shows nothing useful (see 5.6).
5. **Whisper (faster-whisper / CTranslate2).** On first use it downloads the model from Hugging Face and needs the
   cuBLAS and cuDNN DLLs (`asr.py:45-57` already hunts for them). It must be part of the base install or an explicit
   "speech recognition" pack, and it must work offline afterwards.

### 5.2 Recommended sidecar shape

- **Runtime.** Use an embedded CPython 3.12 (python-build-standalone) plus a pre-built base venv. That venv holds
  numpy, soundfile, num2words, fastapi, uvicorn, python-multipart and httpx, with no torch. Ship the backend package
  in it. The base install comes to about 150-250 MB including ffmpeg.
- **`externalBin`.** Tauri wants an executable. Use a tiny launcher, written in Rust in the app itself or as a small
  `firevoice-server.exe` stub, that runs `<runtime>/python.exe -X utf8 -m firevoice serve ...`. Avoid PyInstaller for
  the supervisor. It adds antivirus false positives and 10-30 s cold starts, and it does not solve item 2 above.
- **Backend flags to add.** All of these are generic and useful outside the desktop:
  - `--port 0`, which binds to a free port.
  - `--ready-file PATH` or `--print-ready`, which emits `{"url","token","pid","version","api"}` once listening.
  - `--parent-pid PID`, a watchdog that exits when the parent dies. The worker already has one in
    `core/worker.py:_watch_parent`.
  - `--home DIR`, which sets `FIREVOICE_HOME`.
  - `--envs DIR`.
  - `--token-file PATH`.
- **Rust lifecycle.** The shell should:
  1. Use single-instance (`tauri-plugin-single-instance`), so two copies never fight over the GPU.
  2. If the user has set an external server, attach to it and skip spawning.
  3. Otherwise spawn the sidecar with a random token, `--port 0` and the app-data home. Wait for the ready line or
     `/health`, with a 60 s timeout and a "Starting engine host..." splash.
  4. Pass URL and token to the UI through a Tauri command (not localStorage).
  5. Put the process in a Windows Job Object (kill-on-close), so the server and all its venv workers die with the app.
     This complements the workers' parent watchdog.
  6. Restart with backoff on a crash, and show a banner with a "View logs" link.
  7. On quit, call a graceful shutdown endpoint, then kill the process tree.
- **Data location.** Use `FIREVOICE_HOME=%APPDATA%/FireVoice` (or the platform equivalent) for voices, styles, renders
  and logs. Use a user-choosable `FIREVOICE_ENVS` (default `%LOCALAPPDATA%/FireVoice/engines`) for venvs and weights,
  because they are huge and users will want them on a big drive. Migrate or adopt an existing `~/.firevoice` on first
  run.

### 5.3 Engine venvs and the weights size problem

These sizes were measured on this machine:

| Item | Size |
|---|---|
| `.envs/voxcpm` (venv) | 5.3 GB |
| `.envs/kokoro` (venv) | 4.5 GB |
| `weights/voxcpm2` | 4.6 GB |
| `weights/qwen3-tts-1.7b-base` | 4.2 GB |
| `weights/maya1` | 6.2 GB |
| `weights/breeze-tts-2` | 7.2 GB |
| `weights/omnivoice` | 3.0 GB |
| Voice library (`~/.firevoice/voices`, 102 voices) | 89 MB |

Each venv carries its own CUDA torch, about 4 GB of the 5 GB. Twelve engines come to roughly 60 GB of venvs plus about
50 GB of weights, so bundling any engine in the installer is out of the question.

Plan:

1. **Engine manifests in the backend.** Each engine gets a versioned manifest, for example `engines/<name>.json` in the
   package. It lists:
   - the Python version;
   - a uv lockfile or a requirements list with hashes and the torch index URL;
   - optional repo checkouts (indextts, breeze) pinned to a commit;
   - the Hugging Face repo, a pinned revision, a file list with sha256 and the total bytes;
   - the licence text and a commercial flag;
   - VRAM and disk needs.

   `catalog.EngineInfo` already holds the `venv` and `weights` names, so extend it rather than duplicate it.
2. **Install as a backend job.** Add `POST /api/v1/engines/{name}/install` (job kind `install`, with progress events
   per stage: venv, packages, weights, verify, smoke test). Also add `DELETE /api/v1/engines/{name}` and
   `POST .../verify`, plus the CLI `firevoice engines install|remove|verify NAME`. The desktop Engines screen and the
   playground both get it for free.
3. **De-duplicate torch.** Run uv with a shared cache and `UV_LINK_MODE=hardlink` on the same volume, so identical
   torch wheels are stored once. Group engines by torch pin (qwen uses 2.9.1 and voxcpm uses 2.11, per the README) and
   cut the number of distinct pins where the models allow. Where pins match, one venv can serve several engines.
   `qwen3-tts` and `qwen3-tts-design` already share `qwen`.
4. **Downloads.** Weights must be resumable, with a check for `.incomplete` files (`catalog.py:89` already looks for
   them), a sha256 check, and a disk-space check before starting. Mirror support (`HF_ENDPOINT`) and an offline import
   (point at a folder) help users behind firewalls.
5. **Licence gate.** Non-commercial engines (indextts2, breeze, omnivoice, f5) need an explicit acceptance step in the
   UI before download. Store the acceptance in `FIREVOICE_HOME`.
6. **Starter voices.** The 102-voice library (89 MB) comes from harvested datasets. Ship a small curated pack or
   download it on first run, and document each dataset's licence (LibriTTS-R, GLOBE, Expresso, FLEURS and
   Common Voice) in the voice metadata, which already has a `license` field.

### 5.4 First-run setup

A wizard, driven entirely by backend routes:

1. **System check.** Add a new `GET /api/v1/doctor`, the API form of `firevoice doctor` (`cli.py:495-540`). It should
   report:
   - GPU vendor, model, VRAM, driver version and CUDA driver capability;
   - free disk space on the engines volume;
   - ffmpeg;
   - Whisper status.
2. **Engine recommendation by VRAM.**
   - Under 4 GB, or no NVIDIA GPU: Kokoro (1 GB, presets only).
   - 4 to 8 GB: Chatterbox Turbo or OmniVoice.
   - 8 GB or more: VoxCPM2 (the default engine; `service.py:127` defaults to `voxcpm2`, so a fresh install with nothing
     installed fails every request until the default engine changes).
3. **Install the chosen engine and Whisper**, with live progress, then a 5-second smoke render. The smoke render
   already exists in `doctor --engine-test`.
4. **Pick a default voice, or design one.** `prepare()` rejects `default` when there is no default voice and the
   engine needs a reference (`service.py:304-305`).

### 5.5 Update story

- **The app and the sidecar update together.** Use `tauri-plugin-updater` with signed releases. The sidecar version
  equals the app version.
- **API version handshake.** `/health` should return `api: "1.x"` and a server epoch, and the desktop checks it.
  Remote-server mode needs this: the desktop warns when the server's API major version differs.
- **Engine packs update on their own schedule.** A manifest change, such as a new pin or a new weight revision, marks
  the engine "update available". Updating builds the new venv next to the old one and switches over only after the
  smoke test passes, so a broken update never bricks a working engine.
- **Data migrations.** Add a `FIREVOICE_HOME/schema.json` version and migrate voices, styles and renders at startup.
  The take cache already has `CACHE_REV` (`synth.py:44`).
- **Do not touch venvs on an app update** unless their manifest changed.

### 5.6 GPU checks

- **Today the code assumes NVIDIA.** It uses `nvidia-smi` or torch CUDA (`core/gpu.py`), and the README pins cu128 for
  Blackwell. The app should detect and explain:
  - **No NVIDIA GPU.** Only Kokoro and CPU Whisper are practical. Say so plainly, and hide or grey out GPU engines.
  - **A driver too old for the venvs' CUDA build.** cu128 wheels need a recent driver. Report the minimum, with a link.
  - **Not enough VRAM for an engine.** `vram_gb` per engine already exists, and `fit_workers` trims the worker count.
    Surface "this engine needs 9 GB, you have 8 GB" before the user loads it.
  - **WDDM paging.** The code notes that oversubscription runs 10-30x slower (`service.py:174-175`). Show a warning
    when free VRAM is low.
  - **Laptops with switchable graphics**, where the webview runs on the iGPU. That is fine, because only the Python
    workers need CUDA, but the doctor should report the GPU the workers will actually use.
- **Add `driver_version`, `cuda_version` and `compute_capability` to `gpu_info`.** Cache it for about 2 s, so 8-second
  polling from several clients does not spawn a process each time.
- **AMD, Intel and Apple** are out of scope for now. Say so in the doctor output, rather than failing at engine start.

---

## 6. Ranked recommendations

Effort: S = under a day, M = 1-3 days, L = a week or more. "BE" = backend, "PG" = playground, "Desk" = desktop.

| # | Recommendation | Surfaces | Effort | Why it matters |
|---|---|---|---|---|
| 1 | **End-to-end cancellation.** Give each render a request id. Cancel its queued pool futures, and skip them in `_loop`, when its cancel event fires. Wire a cancel event into `/tts` that fires on client disconnect. Add `POST /api/v1/tts/{request_id}/cancel` for clients that keep the connection open. Fixes B1, B3. | BE, PG, Desk | M | Today Stop does not stop the GPU. A cancelled long render keeps the card busy for minutes and blocks everyone else. |
| 2 | **Fair scheduling in `EnginePool`.** Use per-request queues served round-robin, with a priority class for interactive work (`/tts`, stream) over jobs. Fixes B2. | BE | M | An interactive render should not wait behind a 2-hour audiobook job. |
| 3 | **Make the backend relocatable.** Add `FIREVOICE_ENVS`, `FIREVOICE_WEIGHTS` and `FIREVOICE_FFMPEG`, make the worker importable without the repo, and add `--port 0`, `--print-ready`, `--parent-pid` and `--home`. | BE | M | This is the precondition for any sidecar build, and it helps plain `pip install` users too. |
| 4 | **Engine install, verify and remove as backend jobs** driven by pinned manifests (lockfile, HF revision, sha256, sizes, licence), plus CLI commands and an Engines screen in both UIs. Use a shared uv cache with hardlinks to de-duplicate torch. | BE, CLI, PG, Desk | L | Without it the desktop app is unusable for anyone who is not a developer. It also cuts tens of GB of duplicated torch. |
| 5 | **Sidecar lifecycle in Tauri.** Single instance, spawn on a free port with a random token, health wait and splash screen, a Windows Job Object, crash restart with a log viewer, and an "attach to existing server" option. | Desk | M | This is what turns the app into one-click software. Today the user must start `firevoice serve` in a terminal. |
| 6 | **Reliable job events.** Emit SSE `id:`, add a server epoch to events and `/health` so clients reset `since`, honour `Last-Event-ID`, send a "resync" when `since` has fallen out of the deque, and emit a `deleted` event. Stop the replay toast storm in the playground. | BE, PG, Desk | S | Fixes B5, B10, W1 and D1: missed progress after restarts and toast floods. |
| 7 | **Keep the error contract.** Add a catch-all JSON exception handler, validate job payloads with the `/tts` pydantic model, and fix the `voice_not_found` code. Wrap `ffmpeg missing` as `unavailable`. | BE | S | Every client relies on `{"error": {...}}`, and today raw 500s leak through. |
| 8 | **Lifecycle races.** Increment `active` inside `_pool()` under the lock. Fail queued futures on `EnginePool.stop()`. Mark the pool unhealthy (and reload it) when a worker cannot be restarted. Size `_make_room` by the worker count. | BE | S | Prevents hung requests and jobs (B4, B6, B7, B9) during eviction and unload. |
| 9 | **Truthful engine readiness and a `/api/v1/doctor` route.** Check that the venv python exists. Import-check engines that live in the main venv. Flag weights that would download on first load. Tolerate a bad `engines.json`. | BE, PG, Desk | S | Today "ready" engines can fail with "failed to start". The doctor route feeds the first-run wizard. |
| 10 | **First-run wizard.** System check, an engine recommended for the available VRAM, Whisper install, a smoke render, and a default voice. Change the default engine to an installed one. | Desk (BE routes) | M | A fresh install currently fails every render, because the default engine `voxcpm2` and the default voice may not exist. |
| 11 | **Long scripts.** Warn above a threshold, for example 2,000 words, and offer to run the script as a job. Make the desktop's whole-file mode use a job with progress instead of base64 JSON. Import .txt and .md files, split by chapter, and debounce draft persistence (D4). | Desk, PG | M | This is the core audiobook and narration use case. Today it means a blind wait, high memory use and typing lag. |
| 12 | **Persist direct renders.** Add an optional `save: true` (or always keep the last N) on `/tts` and stream, with a renders listing so Recent Renders covers Speak output too. | BE, Desk, PG | M | Users lose renders when they close the app. Jobs are the only history today. |
| 13 | **Desktop parity.** Batch creation (paste lines or CSV/JSON, per-line overrides, zip download), per-style clip upload, a "render intro preview" button and a previews job, a Kokoro preset picker, a style overrides editor, and a client-side engine and voice compatibility check. | Desk | M | These API features are invisible to the main client. |
| 14 | **Auth UX and token handling.** Read `auth` from `/health` and show a "token required or wrong" state on the first 401. Stop the playground toast loop. Pass the sidecar token through a Tauri command, not localStorage. Replace `?token=` with short-lived signed URLs or a cookie for media. | BE, PG, Desk | S | Today a wrong token looks like a broken app, and tokens leak into URLs and logs. |
| 15 | **Security hardening.** Sanitise style names on delete (C8) and the style query on audio (C9). Remove or confine legacy `/v1/batch` `out_dir` (C7). Restrict `emo_ref` (C10). Add a Tauri CSP and narrow the fs scope (D7). Use a constant-time token compare. Stream uploads to disk (C12). | BE, Desk | S | These are cheap fixes for path traversal and arbitrary file write. They matter once tokens and remote mode are in use. |
| 16 | **Atomic writes and one Whisper.** Write voice metadata and previews through a temp file and rename (C16). Reuse the service aligner when adding voices (C17). Log skipped corrupt files. | BE | S | Prevents voices that silently vanish, and a second copy of Whisper on the GPU. |
| 17 | **Cheap status endpoints.** Cache `gpu_info` for about 2 s and the voice index by directory mtime. Make `/options` stop calling `system()`. | BE | S | Two UIs polling every 8 s spawn `nvidia-smi` and rescan every `meta.json` each time. |
| 18 | **Disk and retention management.** Report render, cache, log and engine sizes. Add a retention policy and "clear history", clean up scratch folders, and rotate logs. | BE, Desk | S | `renders/`, the take cache, logs and `%TEMP%` scratch folders grow without bound. |
| 19 | **Batch jobs.** Render lines in parallel (as the CLI does) or plan them as one script. Add per-line retry and a zip download. Make `failed > 0` visible in the job status. | BE, Desk | M | The API batch is slower than the CLI batch, and partial failures look like success. |
| 20 | **CLI parity.** Add `--remote` to every command, `firevoice jobs submit|list|watch|cancel|download` and `engines load|unload`. Catch `ClientError` and connection errors cleanly. Fix `voices design`, which deletes before success (C19). | CLI | M | The CLI is the scripting surface. Without `--remote`, a second copy of the models boots next to a running server. |
| 21 | **Accessibility pass.** In the playground: labels with `for`, `role="dialog"` with a focus trap, keyboard-reachable voice rows, ARIA on icon buttons. In the desktop: an `aria-live` render status, slider semantics for the waveform, and reduced motion. | PG, Desk | M | Both UIs are hard to use with a screen reader or keyboard (W5, 3.5). |
| 22 | **Keyboard shortcuts.** Scope Esc so a dialog wins over Stop. Add a shortcut sheet (`?`), shortcuts for pause insertion, stream or file mode and view switching, and stable listeners. | Desk | S | Small but frequent friction in a production tool. |
| 23 | **Audio formats.** Write real MP4 for `m4a` (C5). Make the ElevenLabs `pcm_*` formats raw and honour `output_format` rates (C6). Signal errors on `stream.pcm`. | BE | S | Files that some players reject, and compatibility routes that are not compatible. |
| 24 | **Stream loudness parity.** Apply a running loudness estimate to streamed chunks, or document and label "streamed preview" against the "mastered file" (the desktop already re-wraps streamed audio as the saved track). | BE, Desk | M | The saved streamed render is quieter and unmastered compared with the same script rendered as a file. |
| 25 | **Desktop fixes.** Parse warnings correctly (C4). Save job downloads through `saveBlob` instead of `window.open` (D2). Scope query keys by server (D3). Read the app version at runtime (D5). Use the real language lists (D6). | Desk | S | Each one is a small, visible bug. |
| 26 | **A GPU and driver report.** Add driver and CUDA capability fields. Explain non-NVIDIA, old-driver and low-VRAM machines up front, and warn about WDDM paging. | BE, Desk | S | Avoids opaque "failed to start" errors on machines that cannot run an engine. |
| 27 | **Tests.** Backend: cancellation, eviction race, SSE resume, path traversal and job payload validation, all with the `null` engine. Desktop: vitest for the SSE parser, error parsing and `chunksToWav`, plus a Playwright smoke test against `firevoice serve` with the null engine. | BE, Desk | M | Most of the bugs above are in code paths no test exercises. The desktop has no tests at all. |
| 28 | **Documentation and contract.** Document the collections, brand and preview routes, the `previews` job kind and all PATCH fields in API.md. Snapshot the OpenAPI schema in a test, and generate the desktop's `types.ts` from it. | BE, Desk | S | API.md has already drifted from the server, and hand-written TypeScript types will drift next (C4 is one example). |

---

## Appendix: what was not verified

- No code was run. Starlette's disconnect behaviour for sync generators (3.3) and the Tauri `window.open` behaviour
  (D2) are inferred from the library versions in use (Starlette 0.52.1, FastAPI 0.162, Tauri 2) and should be
  confirmed with a quick manual test.
- Adapter internals (`core/adapters/*.py`), `frontend/` (text normalisation), `harvest.py`, `showcase.py` and the
  judge and bench tooling were only skimmed or not reviewed.
- Venv sizes were measured for two venvs and five weight folders. The totals for the rest are extrapolated.
