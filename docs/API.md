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

### Speech to text

`POST /api/v1/stt` takes multipart `file`, `language` (default `auto`) and `beam_size` (default 5). It returns:

```json
{"text", "language", "language_probability", "duration", "seconds", "model", "device", "words": [{"text", "start", "end"}]}
```

### Jobs

Use jobs for long scripts, batches and voice design: anything the app should track, cancel and keep in a history.

| | |
|---|---|
| `POST /api/v1/jobs` | Body `{"kind": "tts" \| "batch" \| "design", "payload": {...}, "title": ""}`. Returns `202` and the job. |
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
