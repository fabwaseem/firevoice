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

## Packaging the backend (planned)

Release builds will ship the backend inside the app so users install one thing:

1. The Python service is frozen into a single `firevoice-server` executable and added to `bundle.externalBin`
   as a Tauri **sidecar**.
2. On launch the Rust shell starts the sidecar on a free local port with a random token, waits for `/health`,
   passes the URL and token to the UI, and kills it on exit.
3. Engine venvs and model weights are too large to bundle. They are installed on demand into the app data folder
   from an **Engines** screen (download, verify, remove), the same layout `firevoice` uses under `.envs/`.

In development none of that runs; the UI just points at your `firevoice serve`.

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
