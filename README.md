# FireVoice

Local, expressive text-to-speech and speech-to-text on your own GPU: the desktop app and its voice engine in one repo.

Built with **Tauri 2** (Rust shell, system WebView2), **React 19 + Vite 8 + Tailwind CSS 4**, and a Python backend
(a FastAPI HTTP API) that the app bundles and runs.

```
firevoice/                 this repo (private: github.com/fabwaseem/firevoice)
  backend/                 the voice engine: Python package, HTTP API, tests (a standalone project)
  src/                     the app's UI
  src-tauri/               the native shell: runs the backend, required updates
  scripts/                 dev setup, bundling, versions, releases
  release/                 built releases (not in git)
```

Installers and the update feed are published to the public **github.com/fabwaseem/firevoice-releases**.

## Where things live

Development runs exactly like an installed app; only the Python environment differs in where it sits.

| what                                   | installed app                                         | development                    |
|----------------------------------------|-------------------------------------------------------|--------------------------------|
| backend code                           | wheel inside the installer                            | `backend/` (editable install)  |
| backend Python environment             | `%LOCALAPPDATA%\app.fabwaseem.firevoice\backend\venv` | `backend/.venv`                |
| engines, model weights                 | `~/.firevoice/engines`                                | the same folder                |
| voices, styles, history, renders, logs | `~/.firevoice`                                        | the same folder                |

Both environments are built from one recipe (`scripts/backend-recipe.mjs`: Python 3.12, CUDA 12.8 torch, the
`desktop` extra), and both read the same data folder, so an engine installed in one is ready in the other and nothing
is downloaded twice. Settings > Engines and storage can point engines or weights elsewhere (it writes
`~/.firevoice/settings.json`, which every build reads).

## Develop

```bash
pnpm install
node scripts/dev-setup.mjs   # once, and after changing backend dependencies: builds backend/.venv from the recipe
pnpm tauri dev               # the desktop window; it starts the backend from backend/.venv by itself
```

Faster loops:

```bash
pnpm dev                                        # the UI in a browser at http://localhost:1420
backend/.venv/Scripts/python -m firevoice.server      # the backend alone (the API, with Swagger docs at /docs)
cd backend && .venv/Scripts/python -m pytest -q       # backend tests
pnpm typecheck                                  # UI type check
```

`pnpm tauri dev` starts the UI through `scripts/dev-ui.mjs`; if `pnpm dev` already serves this app on port 1420 it
reuses that server. Dev builds skip the update check (set `FIREVOICE_UPDATE_URL` to test against a feed).

The backend stays a standalone API: it never imports anything from the app, and runs on its own with
`python -m firevoice.server`. There is no command-line tool and no web page: the app and the API are the two ways in.
The app is a client of the API that also bundles it.

## Versions

One version for the app and the backend, kept in six files:

```bash
node scripts/version.mjs            # show them (fails if they differ)
node scripts/version.mjs 1.5.0      # set them (or patch / minor / major)
```

The release workflow sets it for you. The bundled backend runtime is rebuilt on a user's computer when the version
changes, so a backend change always needs a new version.

## Release

Releases are built and published by GitHub Actions, for Windows, macOS (Apple Silicon) and Linux in one run. The
workflow (`.github/workflows/release.yml`, steps in `scripts/ci-release.mjs`) only runs when started by hand:
**Actions > Release > Run workflow** on `main`, or

```bash
gh workflow run release.yml --ref main -f version=patch -f notes="One line of notes"
```

`version` is `patch`, `minor`, `major` or an exact `X.Y.Z`. For longer notes, leave `notes` empty and commit
`release-notes.md` to `main` first; the release commit moves its text into `CHANGELOG.md` and deletes it.

1. **Plan and test** (Linux): works out the version, checks the tag is free, runs the type check and backend tests.
2. **Build** (Windows, macOS and Linux side by side): sets the version, builds the signed installers, refuses a build
   that would ship source, and runs the backend tests against the compiled wheel on each OS.
   * Windows: `FireVoice_X.Y.Z_x64-setup.exe` (updates) and `.msi`
   * macOS: `FireVoice_X.Y.Z_aarch64.dmg` and `FireVoice_X.Y.Z_aarch64.app.tar.gz` (updates)
   * Linux: `FireVoice_X.Y.Z_amd64.AppImage` (updates), `.deb` and `.rpm`
3. **Publish**, only once every build passed: writes `latest.json` (all platforms) and `SHA256SUMS.txt`, commits
   `Release vX.Y.Z` with the `CHANGELOG.md` entry, tags it, pushes `main` and the tag here, publishes every file as a
   release of `fabwaseem/firevoice-releases`, and confirms the update feed announces the new version.

Nothing is committed or tagged until all three builds pass. If **Publish** fails, fix the cause and use **Re-run
failed jobs**: it keeps the builds, keeps a tag it already pushed, and replaces files already on the release. If
`main` moved while the builds ran, the push is refused; start the release again.

**Dry run** builds everything and publishes nothing; the installers are on the run's page as artifacts. **Skip tests**
does what it says.

The macOS app is ad-hoc signed, not signed with an Apple Developer ID, so the first open needs right-click > Open (or
`xattr -cr /Applications/FireVoice.app`). There is no Intel Mac build: torch no longer publishes Intel Mac wheels.

Repository secrets (Settings > Secrets and variables > Actions):

| Secret | What |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | the contents of `updater.key` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | the contents of `updater.password` |
| `RELEASES_TOKEN` | a fine-grained token with Contents: read and write on `fabwaseem/firevoice-releases` only |

### What ships: no source code

An installed copy holds no readable source of the app:

* **Backend (Python).** `scripts/bundle-backend.mjs` compiles every module of the package to a native extension
  module (`scripts/protect-backend.py`: Cython, then the C compiler) and builds a wheel with those and no `.py` file.
  It compiles once per Python version that imports the package: the app's runtime and the engine venvs (3.11 and
  3.12 today; the list comes from the recipe and `installer.py`). Docstrings are left out, except the route
  descriptions shown at `/docs`. An update replaces the installed
  package, and the copy that engine workers import, so source left by older versions goes away.
* **UI.** Minified, no source maps, files named by hash, and packed inside the app binary.
* **App binary (Rust).** Optimised, stripped of symbols, and built with this computer's folder names removed.

The build fails rather than fall back to shipping source: if the compiler is missing, if a module does not compile,
or if a source file is left in the wheel. A release also refuses a plain wheel or a UI build with source maps, and
runs the backend tests against the compiled wheel that goes into the installer
(`node scripts/test-bundled-backend.mjs` does that on its own). Building needs a C compiler; on Windows the Visual
Studio Build Tools that Rust uses are enough.

What this does not hide: compiled code can still be studied with a disassembler by someone determined, and the names
of modules, classes and functions and the text the code contains (messages, URLs) stay visible in the binaries.
Nothing that must stay secret (keys, tokens) belongs in the code.

Two rules the compiled backend puts on the code:

* Start a module as a process with `paths.entry("firevoice.some.module")`, not `python -m`: Python cannot run a
  compiled module as a script.
* In `server.py`, a type used in a route's signature and created inside `create_app` must be passed to `_expose()`
  (request models do this themselves). The server checks this at startup and names the route if one is missing.

`node scripts/bundle-backend.mjs --plain` stages the plain source wheel for debugging a build; a release refuses it.

### Signing key

Updates are signed; the app only installs an update whose signature matches the public key built into it
(`plugins.updater.pubkey` in `src-tauri/tauri.conf.json`). The private key and its password are kept outside the repo
in `%USERPROFILE%\.firevoice-release\` (`updater.key`, `updater.key.pub`, `updater.password`; or set
`FIREVOICE_RELEASE_KEYS`), and their contents are the release workflow's two signing secrets. **Back that folder up
somewhere safe.** Without it no installed copy can ever update again:
a new key means everyone reinstalls by hand.

## Updates

Updates are required. At start the app asks the feed
(`https://github.com/fabwaseem/firevoice-releases/releases/latest/download/latest.json`) for the newest version:

* **Newer version, online:** the app shows only the update screen. It downloads the installer, checks its signature,
  stops the voice engine, installs, and opens the new version. If the download fails it stays on that screen with
  **Try again** (and a link to download it by hand). Voices, history and settings are untouched.
* **Offline, or GitHub unreachable:** the app opens normally and asks again next time.
* **While running:** it checks every four hours; a new version shows a bar with **Update now**, so work in progress can
  finish. The next start requires it.

After an update the app updates its private backend runtime once (only the FireVoice package is reinstalled; torch and
the rest stay), with progress on screen.

## Dictation

Dictation types what you say into any program (Settings are on the Dictation page). The pieces:

* **Hotkey and typing, in the desktop shell** (`src-tauri/src/dictation.rs`): a global hotkey (press to start and stop,
  or hold), the microphone read natively (so it works with the window hidden), keystrokes or paste into the focused
  program, a tray icon that keeps the hotkey alive when the window is closed, and the small overlay window
  (`overlay.html`, `src/overlay/`) that never takes keyboard focus.
* **Live transcription, in the backend** (`backend/src/firevoice/dictation.py`, `WS /api/v1/dictate`): the audio
  streams in; every 0.3 s the unsettled part is transcribed again with the loaded Whisper model, and a word is released
  once two passes agree on it, so text that has been given out is never taken back. The window is cut as words settle,
  so a pass costs the same at the first second and the fifth minute.
* **The app side** (`src/views/DictationView.tsx`, `src/stores/dictation.ts`, `src/components/dictation/`): settings,
  history and totals, saved on this computer; the settings are sent to the shell whenever they change.

Two modes: "as you speak" types each word as it becomes certain; "when you stop" transcribes the whole dictation once
more (beam search, with your names as hints) and inserts it in one go. While Ctrl or Alt is held down nothing is typed
(it would trigger shortcuts), so in hold-to-talk mode the words wait for the key to come up.

## Security

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
  views/          Home, Speak, Voices, Transcribe, Dictation, Jobs, Engines, Styles, Settings
  overlay/        the dictation overlay window (its own page: overlay.html)
src-tauri/        Rust shell, capabilities, icons
```

## License

Proprietary: all rights reserved (see `LICENSE`). The code may not be copied, changed, shared or sold without written
permission. The speech models a user installs keep their own licences.
