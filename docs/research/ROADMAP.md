# FireVoice roadmap

Built from three research reports, written 2026-11-09:

- `market.md`: what ElevenLabs, Cartesia, Hume, Murf, WellSaid, Descript, Resemble and OpenAI ship, and what their users praise and complain about.
- `open-source.md`: models and tools we could run locally on one RTX 5080 under Windows, with licences and evidence quality.
- `audit.md`: our own API, CLI, playground and desktop app, with issues cited by `file:line`.

**Rule for every feature:** it lands in the API first, then the CLI, the playground and the desktop app. The API stays standalone and never depends on the desktop app. The desktop release bundles the whole backend.

Effort uses these codes:

| Code | Meaning          |
| ---- | ---------------- |
| S    | a few days       |
| M    | one to two weeks |
| L    | several weeks    |

Surfaces use these codes:

| Code | Surface     |
| ---- | ----------- |
| A    | API         |
| C    | CLI         |
| P    | playground  |
| D    | desktop app |

## Status, 2026-11-09

Phases 0 to 6 are built in the API, the CLI, the playground and the desktop app. So are most of the Later items:

| Item | State |
|---|---|
| Phases 0-5 | Done. Cancellation and priority, takes and QA, subtitles, dictionary, projects and M4B export, clip cleaning, voice changer, per-style clips, design previews, avatars, dialogue and tags, OpenAI routes, WebSocket streaming, diarization and key terms. |
| 6.1 Configurable paths | Done (`paths.py`, `GET /system/paths`, `PUT /system/settings`). |
| 6.2 Engine installer | Done. Pinned manifests, install jobs, a shared uv cache, and install markers. |
| 6.3 Sidecar | Done. The desktop builds a private backend runtime from the bundled wheel, starts and stops it, and keeps its logs. Release CSP and a narrower file-system scope. |
| 6.4 First run | Done. A GPU check (`GET /system/setup`), a recommended engine installed in place, and a test line. |
| 6.5 Updates | The API version handshake and the backend runtime update are done. The app's own auto-updater needs a signing key and a release feed (your call). |
| Edit a word inside a take | Done. The passage is re-recorded and only the changed words are spliced in. |
| Watermark and consent | Done. AudioSeal marks every output, there is a detector, and consent records are kept. C2PA manifests need a signing certificate (not done). |
| Better metrics | Done. WavLM speaker similarity, DNSMOS, and a drift check, for files and kept renders. |
| Dubbing | Done. Local Whisper, M2M100 (418M fast, 1.2B better), the original timeline, video re-mux, and an option to keep the original voices (with consent). |
| Sound effects and music | Done. AudioLDM 2 and MusicGen engines (non-commercial weights), installable, with `/sound`. Not yet: `[sfx: ...]` cues inside scripts and dialogue. |
| New engines (Ming-3.0, IndexTTS-2.5, MOSS-TTS, MOSS-TTSD, Step-Audio-EditX) | Waiting on a decision. They run code from their own repositories (`trust_remote_code` or a cloned repo), which this setup does not do without your go-ahead. |
| Deferred | Aborting a generation already on the GPU; a CTC forced aligner; a neural denoiser (DeepFilterNet clashes with torch 2.11) and music/voice separation (3.3); Urdu ASR validation (5.3); `--remote` on every CLI command. |

## Where we stand

**Where FireVoice already leads:**

- Takes are checked by speech recognition and retried automatically.
- Several candidates per sentence, seeds, and many engines.
- One voice holds across a whole passage, and pauses are cut in at real silence.
- Everything runs locally, so regenerating costs nothing.

That last point answers the top complaint about ElevenLabs: regenerations burn credits, and voices drift between paragraphs.

**What we lack:**

- **A workflow layer:** projects, kept takes, a QA view, pronunciation dictionaries and dialogue.
- **Real cancellation and request priority.**
- **A way to ship the backend:** today it only runs from the repo checkout.

PlayHT shut down on 2025-12-31 and deleted every user's voices and projects. That makes local files, portable voice packs and open project formats a real selling point for us.

## Phase 0: foundations (do first)

These are bugs and limits that every later feature would hit. All of them were found in the audit. I checked the first three in the code.

| #   | Item                                                                                                                                                                                                                                 | Surfaces | Effort |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | ------ |
| 0.1 | **Real cancellation.** Stop or cancel must drop queued engine requests. Today no queued request is ever cancelled, and a whole-file `/tts` render cannot be stopped at all. Also cancel when a streaming client disconnects. | A C P D  | S      |
| 0.2 | **Request priority.** Interactive renders go ahead of background jobs, with one queue per priority on each engine.                                                                                                             | A        | S      |
| 0.3 | **Safety.** Validate style and voice names on every route (style delete accepts `..\` paths). Restrict legacy `/v1/batch` output folders. Write voice metadata atomically.                                                 | A        | S      |
| 0.4 | **Error contract.** Add a catch-all handler. Make every error `{"error": {"code", "message"}}` with the right status. Type-check job payloads.                                                                               | A        | S      |
| 0.5 | **Job events that survive restarts.** Give each event an `id:` and a counter that persists, and resume with `Last-Event-ID`. Stop the playground re-toasting old jobs.                                                     | A P D    | S      |
| 0.6 | **True engine status.** "Ready" only when the venv imports and the weights exist. Fix the race where an engine is unloaded mid-request, and fail queued requests when an engine stops.                                         | A P D    | S      |
| 0.7 | **Small bugs from the audit:** the desktop warnings header, job download through `window.open`, the `.m4a` container, a second Whisper load on voice add, and `voices design` deleting the old voice first.              | A C D    | S      |

## Phase 1: takes, QA and timing

This is the groundwork the long-form editor builds on.

| #   | Item                                                                                                                                                                                                                                                        | Surfaces | Effort |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ |
| 1.1 | **Keep every take.** Store all candidates per chunk with their scores. Add A/B compare, restore, and lock a take so it survives re-renders.                                                                                                           | A C P D  | S-M    |
| 1.2 | **QA panel.** Show what we already measure: the words heard against the words asked, the score, retries and warnings, highlighted in the script.                                                                                                      | P D      | S      |
| 1.3 | **Forced alignment and subtitles.** Get exact word times from a CTC or WhisperX aligner, and use them to catch skipped or repeated words. Export SRT and VTT, and use the same timings for pause cuts.                                                | A C P D  | S-M    |
| 1.4 | **Pronunciation dictionaries.** Make the lexicon user-editable, with global and per-project rules, case and whole-word options, a test-speak button, and import and export.                                                                           | A C P D  | S-M    |
| 1.5 | **VoxCPM2 real streaming.** Use `generate_streaming` inside one passage, so first audio stays around 1-2 s while the voice stays consistent. Also cache the voice prompt and smooth chunk joins. This undoes the latency cost of passage rendering. | A P D    | M      |

## Phase 2: Projects, the long-form editor

| #   | Item                                                                                                                                                                                                                                       | Surfaces | Effort |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | ------ |
| 2.1 | **Projects.** Chapters, then paragraphs, each with a status: draft, rendered, stale or locked. Regenerate one paragraph and keep the rest. Voice and style per paragraph. Autosave to disk, not to local storage on every keystroke. | A C D    | L      |
| 2.2 | **Long-script handling everywhere.** Suggest a background job above a length threshold, and stream progress per paragraph.                                                                                                           | A P D    | S      |
| 2.3 | **Export.** WAV, MP3, M4B with chapter marks, one file per chapter, an ACX/audiobook loudness and peak check, and subtitles.                                                                                                         | A C D    | S-M    |
| 2.4 | **Open project format.** A plain JSON project folder that is portable and versionable, plus "export voice pack".                                                                                                                     | A C D    | S      |

## Phase 3: voice tools

| #   | Item                                                                                                                                                                                                                                                                                                                         | Surfaces | Effort |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ |
| 3.1 | **Clean reference clips before cloning.** Run a DNSMOS check and DeepFilterNet3, then Sidon, and warn about noisy clips. This improves every cloned voice.                                                                                                                                                             | A C P D  | S-M    |
| 3.2 | **Voice changer (speech to speech).** Chatterbox VC is already installed. Seed-VC is optional, as a separate worker because it is GPL. Adds actor mode: record yourself, keep your timing, change the voice.                                                                                                           | A C P D  | M      |
| 3.3 | **Voice isolator.** Strip noise and music from uploads.                                                                                                                                                                                                                                                                | A C P D  | S      |
| 3.4 | **Per-style reference clips, built automatically.** For a chosen voice and style, render a styled read in clip-only mode, then store it as that style's reference clip with its transcript. Styles then shape delivery again while the voice stays consistent. This fixes Ember sounding playful in the serious style. | A C P D  | S-M    |
| 3.5 | **Voice design with several previews.** Generate 3-4 previews per prompt, then remix and save the best.                                                                                                                                                                                                                | A C P D  | S-M    |
| 3.6 | **Voice avatars.** Show the mascot avatars in progress elsewhere through `/voices/{id}/avatar` and in the cards.                                                                                                                                                                                                     | A P D    | S      |

## Phase 4: dialogue and expressive tags

| #   | Item                                                                                                                                                                                                                         | Surfaces | Effort |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ |
| 4.1 | **Multi-speaker dialogue.** A cast table that maps speakers to voices, with script lines like `Ayesha: ...`. Each speaker keeps their own voice across all their lines, and the output can be stems or a single mix. | A C P D  | M      |
| 4.2 | **One set of audio tags.** `[laugh]`, `[sigh]`, `[whisper]` and so on, translated for each engine or dropped where unsupported. A tag palette in the editor.                                                     | A P D    | M      |
| 4.3 | **MOSS-TTSD for real dialogue.** Apache-2.0, built for conversations with overlapping turns.                                                                                                                           | A        | M      |

## Phase 5: API reach

| #   | Item                                                                                                                               | Surfaces | Effort |
| --- | ---------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ |
| 5.1 | **OpenAI-compatible routes.** `/v1/audio/speech` and `/v1/audio/transcriptions`, so any OpenAI client works.             | A        | S      |
| 5.2 | **WebSocket streaming.** Text arrives in pieces (for example from an LLM), with flush, cancel and alignment events.          | A        | M      |
| 5.3 | **STT upgrade.** Diarization, key terms, subtitles, and Urdu validation through Whisper large-v3 with Roman Urdu comparison. | A C P D  | M      |
| 5.4 | **CLI parity.** `--remote` for all commands, and `jobs` commands.                                                        | C        | S      |

## Phase 6: ship it, desktop packaging

| #   | Item                                                                                                                                                                                  | Surfaces | Effort |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ |
| 6.1 | **Configurable paths.** Make the backend runnable from anywhere: engine venvs, weights and ffmpeg are found through `FIREVOICE_HOME` and settings, not the source tree.       | A        | S-M    |
| 6.2 | **Engine installer.** On-demand installs as backend jobs from pinned manifests. A shared uv cache keeps torch from being stored once per engine; each venv is 4.5-5.3 GB today. | A C D    | L      |
| 6.3 | **Sidecar launcher.** Embedded Python running `firevoice serve`, started and stopped by the desktop app, with a health check and logs, a CSP, and tighter file-system scope.  | D        | M      |
| 6.4 | **First run.** Detect the GPU and VRAM, recommend an engine, install it, do a test render.                                                                                      | A D      | M      |
| 6.5 | **Updates.** App and backend update together, with an API version check.                                                                                                        | A D      | M      |

## Later

These are worth it, but only after the workflow exists.

- **New engines:**
  - Ming-3.0-tts-0.5B (MIT, strongest permissive model; Windows install needs work).
  - IndexTTS-2.5, which is 2.3x faster and adds rate control.
  - MOSS-TTS v1.5 for long-form.
- **Edit a word inside a finished take**, and Step-Audio-EditX to restyle finished takes.
- **Sound effects and ambience** (Stable Audio 3 Small), and music beds (ACE-Step 1.5).
- **Watermarking and provenance:** AudioSeal plus C2PA, with a consent record for every cloned voice. EU AI Act Article 50 duties apply from 2026-08-02.
- **Dubbing** with local translation.
- **Better metrics:** speaker similarity with WavLM-ECAPA instead of resemblyzer, Audiobox Aesthetics, DNSMOS, and a drift check on long takes.

## Not planned

Telephony and voice agents, video and lip-sync, a hosted voice marketplace, and Linux-only stacks without a WSL2 worker (vLLM, NeMo).

## Suggested order

1. **Phase 0, all of it,** plus 1.5 (VoxCPM2 streaming). This gives us stability and fixes first-audio latency.
2. **1.1-1.4,** takes, QA, timing and dictionaries, plus 3.4 (per-style clips) and 3.6 (avatars).
3. **2.1-2.4,** Projects.
4. **3.1-3.3 and 4.1-4.2,** voice tools and dialogue.
5. **Phase 5,** API reach.
6. **Phase 6,** desktop packaging. Do 6.1 early, because it is cheap and unblocks everything else in that phase.
