# FireVoice HTTP API

The API the desktop app (and anything else) uses. Start it with:

```bash
firevoice serve                              # http://127.0.0.1:8787, default engine voxcpm2, interactive docs at /docs
firevoice serve --preload voxcpm2 --token SECRET --port 8787
```

Try it in a browser: **`/docs`** is Swagger with ready-made examples on every route and an Authorize button.
**`/playground`** is a page for listening: render, stream, record speech to text, manage voices and styles, and watch jobs live.

The CLI and the API share one service (`firevoice.service.FireVoice`), so every option below has the same meaning
as the matching `firevoice say` flag. The OpenAPI schema is at `/openapi.json`.

## Conventions

- **Base URL:** `http://127.0.0.1:8787`. The app routes live under `/api/v1`.
- **Auth:** off by default on localhost. With `--token` or `FIREVOICE_API_KEY` set, send any one of:
  - `Authorization: Bearer <token>`
  - `x-api-key: <token>`
  - `xi-api-key: <token>`
  - `?token=<token>`, which works for `<audio src>` and `EventSource`.

  `/health` never needs a token. The server refuses a non-local `--host` unless a token is set.
- **Errors:** every failure is JSON in this shape: `{"error": {"code": "...", "message": "..."}}`.

  | code | HTTP |
  |---|---|
  | `bad_request` | 400 |
  | `unauthorized` | 401 |
  | `not_found` | 404 |
  | `conflict` | 409 |
  | `too_large` | 413 |
  | `internal` | 500 |
  | `unavailable` | 503, when an engine is not installed or failed to start |

- **CORS:** `localhost`, `127.0.0.1` and `tauri://localhost` origins are allowed by default. Use `--cors` to replace the list.
- **Engine loading:** an engine loads on its first request, or explicitly with `POST /api/v1/engines/{name}/load`.
  - First loads are slow; VoxCPM2 compiles for about 2 minutes on its first load.
  - When the GPU is short of memory, idle engines are unloaded first. The least recently used goes first.

## The TTS request

Every TTS route takes the same body. Only `text` is required.

| field | default | meaning |
|---|---|---|
| `text` | required | What to say. Markup: `[pause 500ms]`, `[style horror]`, `[pace 0.9]`. Engines with tag support also read `[laugh]` and `[sigh]`. |
| `engine` | server default | Engine name or alias. See `GET /api/v1/engines`. |
| `voice` | `"default"` | A voice id, `"default"`, or `"design:<description>"` for a voice invented on the fly. For Kokoro, use `"design:af_heart"` to pick a preset. |
| `style` | `"conversational"` | A delivery style. See `GET /api/v1/styles`. |
| `pace` | `1.0` | Tempo multiplier, from 0.25 to 4. |
| `instruct` | `null` | Delivery instruction for instruction-following engines. `null` uses the style's own instruction; `""` sends none. |
| `language` | `null` | ISO code. `null` detects it from the script. |
| `params` | `{}` | Engine-specific settings, validated against that engine's `params` schema. Example: `{"cfg_value": 2.5, "inference_timesteps": 16}`. VoxCPM2 `ultimate` (default `true`) clones from the clip and its transcript so the voice stays the same across sentences; an explicit `instruct` turns it off unless you also send `"ultimate": true`. |
| `style_overrides` | `{}` | Override any style field: `temperature`, `top_p`, `cfg`, `pause`, `exaggeration`, `cfg_weight`, `emo_vector`, and so on. |
| `seed` | `1234` | Same seed and inputs give the same take. |
| `candidates` | `1` | Takes per sentence; the best validated one is kept. Range 1 to 8. |
| `accept` | `0.9` | How closely Whisper's transcript must match a take for it to count as validated. |
| `validate` | `true` | Whisper-check English takes and re-roll bad ones. |
| `lufs` | `-16` | Loudness target of the studio chain. `null` returns raw audio. |
| `lead_ms`, `tail_ms` | `120`, `280` | Silence before and after. |
| `format` | `"mp3"` | `wav`, `mp3`, `flac`, `ogg`, `opus`, `m4a` or `pcm16`. |
| `sample_rate` | `null` | Resample the output. `null` keeps the engine's native rate: 48 kHz for VoxCPM2 and dots, 24 kHz for most others. |
| `response` | `"audio"` | `"audio"` returns the bytes; `"json"` returns base64 audio plus word times and stats. |
| `dictionary` | `null` | Extra pronunciation rules for this request only: `[{"match": "SQL", "say": "sequel"}]` or `{"SQL": "sequel"}`. They win over your saved dictionary. |
| `keep_takes` | `false` | Keep every take of every passage. The response names the kept render (`X-Render-Id` header, `render_id` in JSON and in the stream's `done` event); see Takes below. |

A request is fully validated before rendering starts: unknown fields, styles, voices or engine settings, out-of-range values, and an engine that can't do what you asked for. Each fails with `400` or `404` and a readable message.

## Routes

### System

| | |
|---|---|
| `GET /health` | `{"ok", "version", "auth"}` |
| `GET /api/v1/system` | version, uptime, GPU name and free/total VRAM, default engine, loaded engines, job counts |
| `GET /api/v1/options` | Everything a UI needs in one call: engines with capabilities and settings schemas, styles, formats, request defaults, the languages present in the voice library. |

### Engines

| | |
|---|---|
| `GET /api/v1/engines` | Every engine. See the field list below. |
| `GET /api/v1/engines/{name}` | One engine. Aliases work: `voxcpm`, `qwen`, `turbo`, `indextts`. |
| `POST /api/v1/engines/{name}/load` | Body `{"workers": 2}` (optional). Blocks until the engine is ready. |
| `POST /api/v1/engines/{name}/unload` | Returns `409` while the engine is busy. |

Fields on each engine:

- **Identity:** `name`, `title`, `license`, `commercial`.
- **Capabilities:** `clone`, `needs_reference`, `needs_transcript`, `design`, `instruct`, `tags`, `presets`, `languages`.
- **Performance:** `sample_rate`, `vram_gb`, `speed_rtf`.
- **Install status:** `ready`, `problems`.
- **Runtime:** `loaded`, plus `workers` and `active_requests` while loaded.
- **`params`:** the settings schema. Each entry is `{name, type, default, min, max, step, choices, length, labels, label, help}`, with `type` one of `float`, `int`, `bool`, `str`, `enum` or `vector`.

Installing engines:

| | |
|---|---|
| `GET /api/v1/engines/{name}/install` | The plan: `{auto, manual, venv_state, installed, steps: [{step, what, done, gb}], estimated_gb, uv}`. `?sizes=false` skips asking the Hub for sizes. |
| `POST /api/v1/engines/{name}/install` | Starts an `install` job (`202`). `?force=true` rebuilds. Install jobs run beside renders, not behind them. The job's `install.log` is under `/api/v1/jobs/{id}/files/`. |
| `DELETE /api/v1/engines/{name}/install` | Removes the venv; `?weights=true` deletes the weights too. `also_affects` lists engines sharing that venv. |

### Voices

| | |
|---|---|
| `GET /api/v1/voices` | Filters: `?language=ur&gender=female&kind=cloned\|designed&tag=globe_v2&q=scottish` |
| `GET /api/v1/voices/{id}` | The voice plus its transcript and per-style clips. |
| `GET /api/v1/voices/{id}/audio` | The original reference clip as WAV. `?style=horror` returns that style's clip. |
| `POST /api/v1/voices` | Multipart. Required: `file`, `name`, `consent=true`. Optional: `description`, `gender`, `language`, `accent`, `tags` (comma-separated), `transcript`. Any format ffmpeg reads works, including browser recordings. Returns `201`. |
| `POST /api/v1/voices/design` | Body `{"name", "description", "engine"?, "text"?, "gender"?, "language"?, "seed"?}`. Invents the voice and locks the take as its reference. `?wait=false` returns a job instead. |
| `PATCH /api/v1/voices/{id}` | Any of `name`, `description`, `gender`, `language`, `accent`, `tags`, `favorite`, `notes`. |
| `PUT /api/v1/voices/{id}/transcript` | Body `{"transcript": "..."}` |
| `POST /api/v1/voices/{id}/default` | Make this the default voice. |
| `POST /api/v1/voices/{id}/styles/{style}` | Multipart `file` plus optional `transcript`: a reference clip used only with that style, such as a whispered take for `horror`. |
| `DELETE /api/v1/voices/{id}` | |

### Styles

| | |
|---|---|
| `GET /api/v1/styles` | The built-in and user styles, each with `builtin`. |
| `GET /api/v1/styles/{name}` | |
| `PUT /api/v1/styles/{name}` | Body: any style fields. Creates or replaces a user style; a user style with a built-in name overrides it. |
| `DELETE /api/v1/styles/{name}` | User styles only. |

The style fields:

| field | meaning |
|---|---|
| `title`, `description` | display text |
| `pace`, `pause` | tempo multiplier and pause scale |
| `temperature`, `top_p`, `repetition_penalty` | sampling |
| `cfg` | guidance |
| `exaggeration`, `cfg_weight` | Chatterbox |
| `instruct` | delivery instruction |
| `desc` | appended to a designed voice's description |
| `emo_vector`, `emo_alpha` | IndexTTS-2 emotion: 8 values for happy, angry, sad, afraid, disgusted, melancholic, surprised, calm |
| `tags` | suggested inline tags |
| `sample` | showcase paragraph |
| `extra` | raw engine settings |

### Sound effects and music

`POST /api/v1/sound` `{prompt, kind: "sfx" | "music", duration (1-30 s), seed?, engine?, params?, format}` returns the audio,
with headers `X-Seed`, `X-Engine`, `X-Duration` and `X-License`. Effects and ambience come from AudioLDM 2 (`audioldm2`),
music beds from MusicGen small (`musicgen`). Both run in the `sfx` venv and are installed from Engines. Their weights
are non-commercial. `GET /api/v1/engines?task=sfx` lists them; speech engine lists leave them out (`task=all` shows
everything).

### Dubbing

A recording or video in another language, on the original timeline. Every step runs locally: Whisper turns the speech
into text (with speakers when they matter), M2M100 translates each line (MIT; `fast` is the 418M model, `better` the
1.2B one), a voice says it, and each line is fitted to the time the original took. Speed-ups are capped at 1.3x, and a
line that still runs long pushes the next one until the next pause.

| | |
|---|---|
| `GET /api/v1/dub/languages` | `{languages: [ISO codes], model, sizes}` |
| `POST /api/v1/dub` | Multipart `file` (audio or video), `target_language`, `source_language` (`auto`), `voice`, `cast` (JSON `{"Speaker 1": "Ember"}`), `keep_voices` (clone each original speaker for the dub, needs `consent`; the clones are deleted afterwards), `speakers`, `engine`, `style`, `background` (0-1, original audio underneath), `translator` (`fast` or `better`), `format`, `video` (also the video with the new soundtrack). Returns a `dub` job (`202`). Its files are `dub.<format>`, `dub.srt`, `dub.vtt`, `lines.json` (`{lines: [{start, end, text, translation, speaker, voice, speed, at, duration}]}`) and, for a video, `dub.mp4`. |

Dub jobs read only their own upload. The jobs API cannot point one at another file. The output is watermarked once,
after mixing, because time-stretching a line would erase a per-line mark.

### Watermark and consent

Every output is marked as AI speech with an inaudible AudioSeal watermark (16 bits: "FireVoice", then `render` or
`convert`). It survives MP3, cuts and level changes. This covers renders, streamed chunks, kept renders, projects and the
voice changer. Policy: `FIREVOICE_WATERMARK` or the `watermark` setting (`all`, the default, or `off`). A request
can pass `watermark: false`. `/tts` responses carry `X-Watermarked: 1|0`, and render info has `watermarked`. Without the
optional `audioseal` package (`pip install firevoice[watermark]`) nothing is marked.

| | |
|---|---|
| `POST /api/v1/audio/quality` | Multipart `file`, `voice?` -> `{duration, mos: {overall, signal, background, p808}, similarity: {value, backend, same_speaker}, drift: {windows: [{start, end, similarity, f0, level_db}], flags: [{start, end, why}], min_similarity, spread, pitch_hz, compared_with}, verdict, notes}`. Similarity uses WavLM (microsoft/wavlm-base-plus-sv; same speaker from about 0.86) and DNSMOS predicts listener scores 1-5. Drift compares 8 s windows with the voice's clip (or the take's own median voice). |
| `GET /api/v1/renders/{id}/quality` | The same report for a kept render's stitched audio against its voice. |
| `POST /api/v1/audio/detect` | Multipart `file` -> `{watermarked, probability, firevoice, kind, bits, seconds}`. |
| `GET /api/v1/voices/{id}/consent` | The voice's consent record `{basis: "consent", given, by, via, statement, time, upload_sha256, ref_sha256, clip_unchanged, clip_note}`, or for voices without one what their use rests on (`basis`: a dataset licence, a synthetic design). |

Adding a voice (`POST /api/v1/voices`) takes `consent_by` (the speaker's name) for the record. Importing a voice pack
keeps the pack's record under `original`.

### System paths and settings

- `GET /health` adds `api_version` (the HTTP contract, now 2) and `min_client_api`, so clients can check compatibility.
- `GET /api/v1/system/paths`: the data folder, engine venvs, weights and ffmpeg, each with where it came from.
- `PUT /api/v1/system/settings`: `{"engines_dir", "weights_dir", "ffmpeg", "watermark"}` stored in `settings.json`. An empty string
  removes a key. Folders must exist. `restart_required` is true when engine folders changed.

### Text to speech

| | |
|---|---|
| `POST /api/v1/tts` | Returns audio bytes with headers `X-Duration`, `X-Sample-Rate`, `X-Engine`, `X-RTF`, `X-Warnings`. With `"response": "json"` it returns `{audio_base64, format, engine, voice, style, duration, sample_rate, seconds, rtf, chunks, takes, retries, warnings, words: [{text, start, end}]}`. |
| `POST /api/v1/tts/stream` | Server-Sent Events. Every sentence renders in parallel; each `chunk` event is sent in order as soon as it and everything before it is ready. Ends with `done` or `error`. |
| `POST /api/v1/tts/stream.pcm` | Raw little-endian 16-bit mono PCM, streamed. The `X-Sample-Rate` header carries the rate. |

The `chunk` event:

```json
{"type": "chunk", "index": 0, "total": 7, "start": 0.0, "sample_rate": 48000, "format": "wav", "audio_base64": "...",
 "words": [{"text": "Hello", "start": 0.12, "end": 0.41}], "text": "Hello there."}
```

`start` is the chunk's position in the final timeline; word times are absolute. Streamed chunks are loudness-matched, but the final studio chain (loudness normalisation and limiter) applies only to `/tts` and to jobs. Closing the connection cancels the render at the next sentence.

In stream mode, VoxCPM2 hands out the first passage piece by piece while it renders (first audio in about half a
second). Such pieces arrive as `chunk` events with `"partial": true` and no words; the event that closes the passage
carries its words. A streamed passage is heard as it renders, so it is never re-taken; a weak one is reported in
`warnings`.

`POST /api/v1/subtitles` turns word timings (`{"words": [...], "format": "srt" | "vtt"}`) into SRT or WebVTT.

### Pronunciation dictionary

Your rules for how words are said, stored in `FIREVOICE_HOME/dictionary.json`. They run before the built-in text pass
(numbers, money, dates, tech terms), win over it, and apply to every language.

| | |
|---|---|
| `GET /api/v1/dictionary` | `{rules: [{id, match, say, case, whole_word, note}], builtin: [{match, say}]}` |
| `POST /api/v1/dictionary` | Add a rule `{match, say, case?: false, whole_word?: true, note?}`. The same match again replaces the old rule. |
| `PATCH /api/v1/dictionary/{id}` | Change a rule. |
| `DELETE /api/v1/dictionary/{id}` | Remove a rule. |
| `PUT /api/v1/dictionary` | Replace every rule (import): `{rules: [...]}`. |
| `POST /api/v1/dictionary/test` | `{text, engine?}` -> `{spoken}`: what the engine will actually read. |

### Takes (kept renders)

A render made with `keep_takes` keeps every take of every passage in `FIREVOICE_HOME/takes/<id>/`, each with what the
speech check heard. Swap or re-take one passage and the stitched audio is rebuilt from the chosen takes; nothing else
is re-rendered.

| | |
|---|---|
| `GET /api/v1/renders` | Kept renders, newest first, with how many passages are flagged. |
| `GET /api/v1/renders/{id}` | The timeline and every passage: `text`, `takes: [{n, seed, score, duration, said, words, qa}]`, `chosen`, `locked`, `flagged`. `qa.words` marks each word `ok`, `missed` or `changed` (with what was heard). |
| `GET /api/v1/renders/{id}/audio?format=` | The chosen takes, stitched and mastered like the original. |
| `GET /api/v1/renders/{id}/words` | Word times of the stitched audio. |
| `GET /api/v1/renders/{id}/subtitles?format=srt\|vtt` | Subtitles of the stitched audio. |
| `GET /api/v1/renders/{id}/chunks/{i}/takes/{n}/audio` | One take of one passage. |
| `POST /api/v1/renders/{id}/chunks/{i}/takes` | A new take `{seed?, choose?: true}` (same voice, style and checks). |
| `POST /api/v1/renders/{id}/chunks/{i}/edit` | Change the passage's words: `{text, mode?: "splice" \| "passage", seed?}`. The passage is re-recorded with the new text; `splice` (default) keeps the original audio around the change and swaps in only the changed words, cut at quiet points and crossfaded. A big change uses the whole re-recording. The new take is chosen and records `edit: {mode, from_take, old_text, changed_words, cuts_s, note?}`; older takes keep their own `text`. Locked passages refuse. |
| `POST /api/v1/renders/{id}/chunks/{i}/choose` | Use take `{take: n}`. |
| `POST /api/v1/renders/{id}/chunks/{i}/lock` | `{locked: true}` keeps that passage when the rest are re-taken. |
| `POST /api/v1/renders/{id}/regenerate` | New takes for `{chunks: [i, ...]}`, or every unlocked passage. |
| `DELETE /api/v1/renders/{id}` | Delete a kept render. The newest 200 are kept (and any with a locked passage). |

### Dialogue and tags

A dialogue script has one turn per line: `Name: text` or `[Name] text`. A line without a label continues the turn;
`(laughs)`, `(sighs)` and similar become sound tags.

| | |
|---|---|
| `POST /api/v1/dialogue/parse` | `{script, cast?}` -> `{turns, speakers, cast}`. Speakers without a cast entry get a library voice with their name, else distinct voices. |
| `POST /api/v1/dialogue` | `{script, cast?, defaults?, gap_ms, format, response: audio\|json\|zip, stems}`. `json` returns the mix, `turns` with times, `words` with speakers (and stems with `stems: true`); `zip` holds the mix, one track per speaker, SRT/VTT labelled with speakers, and `turns.json`. Long scripts: job kind `dialogue`. |
| `GET /api/v1/tags` | Sound tags (`[laugh]`, `[sigh]`...: performed by engines with tag support, dropped by the rest), delivery tags (`[whisper]`, `[excited]`, `[calm]`... switch the style until `[normal]`), and the markup directives. |

### Voice tools

| | |
|---|---|
| `POST /api/v1/voice-changer` | Speech to speech (Chatterbox VC): multipart `file`, `voice`, `format`, `lufs`. Keeps the words, timing and delivery; swaps the voice. |
| `POST /api/v1/audio/analyze` | How good a recording is to clone from: `snr_db`, `clipped_pct`, `duration`, `silence_pct`, `verdict` (good, fair, poor), `notes`. |
| `POST /api/v1/audio/clean` | `file`, `strength` (light, medium, strong): RNNoise denoise (FFT fallback), rumble cut, trimmed ends, -20 dBFS level. Headers `X-Quality-Before/After`. |
| `POST /api/v1/voices` with `clean` | Clean the clip before adding; the response carries `quality_check`. |
| `POST /api/v1/voices/{id}/clean` / `restore-original` | Clean a voice's clip in place (the original is kept), or put the original back. |
| `POST /api/v1/voices/{id}/styles/{style}/build` | The voice's own clip for a style, rendered in that style. Three tries, kept only if mostly voiced and still clearly the speaker; renders in that style then keep voice and delivery. Job kind `style_refs` builds several. |
| `DELETE /api/v1/voices/{id}/styles/{style}` | Remove a style clip. |
| `POST /api/v1/voices/design/candidates` | `{description, n}`: several takes to compare; `GET .../candidates/{batch}/{n}/audio`; keep one with `POST .../candidates/{batch}/{n}/keep {name}`. |
| `GET/POST/DELETE /api/v1/voices/{id}/avatar` | The voice's mascot avatar (512x512 PNG); voices list `avatar` as a version for `?v=`. |

### Projects (long form)

Audiobooks, courses and series: chapters of paragraphs in `FIREVOICE_HOME/projects/<id>/project.json` (plain JSON).
Every paragraph renders as a kept render (all takes, speech check), so its status follows from its text and settings:
`draft`, `rendered`, `stale` (changed since its render) or `locked`.

| | |
|---|---|
| `GET /api/v1/projects` | Projects with counts per status, words and rendered duration. |
| `POST /api/v1/projects` | `{title, text?, defaults?}`. `text` is split into chapters at `# Heading` or `Chapter 1` lines and into paragraphs at blank lines. `defaults` takes any TTS request field plus `paragraph_gap_ms`, `chapter_gap_ms`, `chapter_lead_ms`. |
| `GET /api/v1/projects/{id}` | Chapters and paragraphs with `status` and `render` (`id` is a kept render: its takes are under `/api/v1/renders/{id}`). |
| `PATCH /api/v1/projects/{id}` | `{title?, defaults?, chapters?}`. `chapters` replaces the structure; a paragraph that keeps its `id` keeps its render. Paragraphs may set their own `voice`, `style`, `pace`, `engine`, `instruct`, `language`. |
| `POST /api/v1/projects/{id}/paragraphs/{p}/render` | Render one paragraph now. |
| `POST /api/v1/projects/{id}/paragraphs/{p}/lock` | `{locked}`: a locked paragraph is skipped by project renders. |
| `GET /api/v1/projects/{id}/paragraphs/{p}/audio` | One paragraph (chosen takes). |
| `POST /api/v1/projects/{id}/render` | A background job (`kind: project`) for `{scope: "stale" \| "all", chapter?}`. |
| `GET /api/v1/projects/{id}/export?format=&chapter=&master=audiobook` | The book or one chapter: any audio format, `m4b` with chapter marks, `srt` or `vtt`. `master=audiobook` brings it inside the usual audiobook limits. |
| `GET /api/v1/projects/{id}/check?master=` | Per chapter: RMS -23 to -18 dBFS, peak at most -3 dBFS, noise floor at most -60 dBFS, 0.5-1 s quiet at the start, 1-5 s at the end. |
| `GET /api/v1/projects/{id}/bundle` / `POST /api/v1/projects/import` | The project and every take as one zip, and back (a new id each import). |
| `GET /api/v1/voices/{id}/pack` / `POST /api/v1/voices/import` | A voice as a portable pack (clip, transcript, per-style clips, metadata, preview, avatar), and back (`consent=true` required). |

### Speech to text

`POST /api/v1/stt` takes multipart `file`, `language` (default `auto`) and `beam_size` (default 5). Optional fields:

- `keyterms`: comma-separated names and jargon to spell right (`FireVoice, Ayesha, VoxCPM`). They become Whisper hotwords.
- `prompt`: free text that sets the vocabulary and tone, as with Whisper's initial prompt.
- `diarize=true`: label who speaks. Every word and segment gains `speaker` (`Speaker 1`, `Speaker 2`...). Pass
  `speakers=N` when you know the count; otherwise it is estimated (up to 6).
- `format`: `json` (default), `srt` or `vtt`. Subtitles carry the speaker label when diarizing.

It returns:

```json
{"text", "language", "language_probability", "duration", "seconds", "model", "device",
 "words": [{"text", "start", "end", "speaker"?}], "segments": [{"start", "end", "text", "speaker"?}]}
```

### WebSocket streaming (text in as it arrives)

`WS /api/v1/tts/ws` is for LLM output and live agents: send text in pieces, get audio back sentence by sentence while
more text is still arriving. Authenticate with the `Authorization` header, `X-API-Key`, or `?token=`.

Client messages (JSON):

| | |
|---|---|
| `{"type": "config", ...}` | Optional, first. Any TTS request field except `text` (`voice`, `style`, `engine`, `params`...), plus `format` (`wav`, `pcm16`, `mp3`, `ogg`, `opus`, `flac`). |
| `{"type": "text", "text": "..."}` | Appended to the buffer. Each finished sentence is spoken as soon as it is complete. |
| `{"type": "flush"}` | Speak what is buffered now, even without a full stop. |
| `{"type": "end"}` | Flush, finish speaking, then send `done`. |
| `{"type": "cancel"}` | Drop the buffer and stop the sentence being spoken. |

Server messages: `{"type": "audio", "segment", "index", "audio_base64", "format", "sample_rate", "words", "text", "partial"?}`,
`{"type": "segment_done", "segment", "text"}`, `{"type": "done"}` and `{"type": "error", "segment"?, "code", "message"}`.
With a warm VoxCPM2 the first audio arrives about 0.5 s after the first sentence ends.

### Jobs

Use jobs for long scripts, batches and voice design: anything the app should track, cancel and keep in a history.

| | |
|---|---|
| `POST /api/v1/jobs` | Body `{"kind": "tts" \| "batch" \| "design" \| "previews" \| "project" \| "style_refs" \| "dialogue", "payload": {...}, "title": ""}`. Returns `202` and the job. |
| `GET /api/v1/jobs` | Filters `?status=&kind=&limit=`. Returns `{jobs, counts}`. |
| `GET /api/v1/jobs/{id}` | `{id, kind, title, status, progress (0-1), step, steps, message, error, result, created, started, finished, elapsed}` |
| `GET /api/v1/jobs/{id}/events` | SSE for one job. Ends with that job's terminal event. |
| `GET /api/v1/jobs/events` | SSE for every job. Pass `?since=<seq>` to resume after a reconnect. A `ping` arrives every 15 s of silence. |
| `POST /api/v1/jobs/{id}/cancel` | |
| `DELETE /api/v1/jobs/{id}` | Only once the job has finished. |
| `GET /api/v1/jobs/{id}/audio` | The main audio file. Add `?download=true` for an attachment. |
| `GET /api/v1/jobs/{id}/files/{name}` | Any output, such as `words.json`, `manifest.json` or `<line>.wav`. |

Payloads:

- **`tts`:** `{"request": <TTS request>, "format": "mp3", "sample_rate": null}`
- **`batch`:** `{"lines": [{"id": "s01", "text": "...", <any request field>}], "defaults": <TTS request fields>, "format": "wav"}`
- **`design`:** `{"name", "description", "engine", "text", "gender", "language"}`

Status moves through `queued`, then `running`, then one of `done`, `failed` or `cancelled`. Events carry `{seq, type, time, job}`. Each job lives in `~/.firevoice/renders/<id>/` and survives restarts. A job that was running when the server stopped is marked `failed` with the code `interrupted`.

### OpenAI-compatible

Point the official OpenAI SDK (or anything built on it) at `http://127.0.0.1:8787/v1` with any API key:

- `POST /v1/audio/speech`: `{"model", "input", "voice", "response_format", "speed", "instructions"}`. `voice` may be an
  OpenAI name (`alloy`, `nova`, `onyx`...), which maps to a fixed pick among the best English library voices, or any
  library voice name or id. Map names yourself in `~/.firevoice/openai_voices.json` (`{"nova": "Isla"}`). `model` may
  name an engine; OpenAI model names use the default engine. `pcm` is 24 kHz 16-bit mono, like OpenAI's.
- `POST /v1/audio/transcriptions`: multipart `file`, `model`, `language`, `prompt`, `response_format` (`json`, `text`,
  `srt`, `vtt`, `verbose_json` with words and segments).

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key="local")
client.audio.speech.create(model="tts-1", voice="nova", input="Hello from FireVoice.").write_to_file("hello.mp3")
```

### ElevenLabs-compatible

These routes let existing clients work unchanged:

- `POST /v1/text-to-speech/{voice_id}`. `model_id` may name an engine. `voice_settings.stability` and `voice_settings.style` map to temperature, and `voice_settings.speed` maps to pace.
- `POST /v1/text-to-speech/{voice_id}/with-timestamps`
- `GET /v1/voices`
- `POST /v1/voices/add`
- `GET /v1/models`
- `POST /v1/batch`: the legacy folder-output batch.

## Examples

```bash
curl -s localhost:8787/api/v1/tts -H "Content-Type: application/json" -o hello.mp3 \
  -d '{"text": "Hello there.", "engine": "voxcpm2", "voice": "lib-f-4992", "style": "storyteller", "params": {"inference_timesteps": 12}}'

curl -s localhost:8787/api/v1/tts -H "Content-Type: application/json" -o robot.wav \
  -d '{"text": "Beep. I am a designed voice.", "voice": "design:a flat robotic AI assistant", "format": "wav", "sample_rate": 24000}'

curl -s localhost:8787/api/v1/stt -F file=@talk.mp3 -F language=auto
```

```js
// stream in a browser or Tauri webview: start playback before the whole script is rendered
const res = await fetch("http://127.0.0.1:8787/api/v1/tts/stream", {method: "POST", headers: {"Content-Type": "application/json"},
  body: JSON.stringify({text, voice: "lib-f-4992", style: "storyteller", format: "wav"})});
const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
let buf = "";
for (;;) {
  const {value, done} = await reader.read(); if (done) break;
  buf += value;
  let i;
  while ((i = buf.indexOf("\n\n")) >= 0) {
    const block = buf.slice(0, i); buf = buf.slice(i + 2);
    const data = block.split("\n").filter(l => l.startsWith("data:")).map(l => l.slice(5)).join("\n");
    const ev = JSON.parse(data);
    if (ev.type === "chunk") queueForPlayback(ev);   // decode ev.audio_base64, schedule at ev.start
  }
}
```

```python
from firevoice.client import Client
c = Client("http://127.0.0.1:8787")
audio, info = c.tts("Hello there.", voice="lib-f-4992", style="storyteller", format="mp3")
for ev in c.tts_stream("A longer paragraph. With several sentences.", voice="lib-f-4992"):
    print(ev["type"], ev.get("index"))
```
