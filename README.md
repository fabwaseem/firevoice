# FireVoice Desktop

The desktop studio for [FireVoice](../firevoice): local, expressive text-to-speech and speech-to-text on your own GPU.

Built with **Tauri 2** (Rust shell, system WebView2) and **React 19 + Vite 8 + Tailwind CSS 4**.

```
firestack/
  firevoice/           Python backend: engines, voices, styles, jobs, HTTP API (firevoice serve)
  firevoice-desktop/   this repo: the UI and the native shell
```

## Develop

The app talks to the backend over HTTP. In development you run the backend yourself from the sibling repo.

```bash
# terminal 1: backend (from ../firevoice, with its venv active)
firevoice serve

# terminal 2: UI in a browser, fastest loop
pnpm install
pnpm dev                 # http://localhost:1420

# or the real desktop window
pnpm tauri dev
```

`pnpm tauri dev` starts the UI through `scripts/dev-ui.mjs`. If `pnpm dev` is already serving this app on port 1420, it
reuses that server instead of failing. If some other program holds the port, it says so and exits.

FireVoice itself stays a standalone API with its own web playground at `/playground`. This app is only a client of it,
so nothing desktop-specific belongs in the backend repo.

The server address and token live in **Settings** (default `http://127.0.0.1:8787`).
The backend already allows `localhost`, `127.0.0.1` and `tauri://localhost` origins.

## Build

```bash
pnpm tauri build         # installer under src-tauri/target/release/bundle/
```

`tauri build` first runs `scripts/bundle-backend.mjs`, which copies the whole backend into the app: it builds the
backend's wheel from `../firevoice` (or `FIREVOICE_BACKEND_SRC`) and stages it with `uv` and a pinned recipe
(`backend.json`: Python 3.12, CUDA 12.8 torch, the `desktop` extra) in `src-tauri/resources/backend/`.
`node scripts/bundle-backend.mjs --check` shows what it would stage.

## The backend inside the app

The backend stays a standalone API: the app works against any FireVoice server and adds nothing the backend needs.
When the server URL is on this computer and **Settings > Backend > Start the backend with the app** is on (the default):

1. **First run.** The app builds a private runtime from the bundled pieces in its local data folder
   (`%LOCALAPPDATA%\dev.firestack.firevoice\backend`): uv fetches Python 3.12, CUDA torch and the backend wheel
   (about 4 GB, once). Torch is too large for an installer (NSIS and MSI stop near 2 GB), so it is fetched here.
2. **Every launch.** If nothing answers at the server URL, the app starts `firevoice serve` from that runtime, waits
   for `/health`, and stops it (with its engine workers) when the app closes. A server you started yourself is left alone.
3. **Updates.** A new app version ships a new wheel. The app notices the runtime is older and offers to update it;
   `/health` reports `api_version`, and the app warns when a server is too old or too new for it.
4. **Engines and weights** are installed on demand from the Engines page (`POST /api/v1/engines/{name}/install`),
   into the backend's engine folder (Settings > Engines and storage).
5. **First-run welcome.** Once a backend answers, the app checks the GPU (`GET /api/v1/system/setup`), recommends an
   engine, installs it if needed, and plays a test line.

In development the app uses the sibling checkout's `.venv` (`../firevoice/.venv`) when nothing is running, so
`pnpm tauri dev` starts the backend by itself. Set `FIREVOICE_BACKEND_PYTHON` to use another interpreter. The backend
log is in the app log folder (Settings > Backend > Log).

The release window has a strict content security policy (scripts only from the app; network and media to any
FireVoice server), and file access is limited to the user's Downloads, Documents, Desktop, Music, Videos and temp
folders, plus whatever the user picks in a file dialog.

## Layout

```
src/
  lib/api/        typed client (client.ts), React Query hooks (hooks.ts), API types (types.ts)
  lib/audio.ts    streamed-chunk player, WAV encoder, recorder, save dialog
  stores/         zustand: settings (persisted), studio draft (persisted), player
  components/ui/  design-system primitives (Radix + Tailwind tokens)
  components/shell/  sidebar, player bar, page header
  components/<view>/ view-specific pieces
  views/          Home, Speak, Voices, Transcribe, Jobs, Engines, Styles, Settings
src-tauri/        Rust shell, capabilities, icons
```
