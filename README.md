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

### First run: one setup, then it just works

A new computer gets one setup screen that cannot be skipped, so the first render in Speak works the moment it is done.
It runs six steps in order and reports each one honestly (`src/components/onboarding/useFirstRunSetup.ts`); every step
is safe to repeat, so a setup that was closed half way carries on where it stopped:

1. **Environment.** Python 3.12 and the backend's server (about 100 MB), built by the desktop shell
   (`src-tauri/src/backend.rs`); it starts while the welcome screen is still up.
2. **GPU support.** torch and torchaudio, downloaded by `src-tauri/src/fetch_wheels.py` with exact progress, resume and
   a checksum. It checks the free disk space first and stops with a plain message if there is not enough.
3. **Voice libraries.** Every other package of the runtime, pinned at build time in `constraints.txt`
   (`scripts/bundle-backend.mjs`), so installing them never replaces a file the running server has open.
4. **The voice library.** 100 ready-made voices, one zip downloaded from the releases repo (`backend/src/firevoice/voicepack.py`;
   a server job, running alongside steps 2 and 3). Voices a person has edited, renamed or deleted are never touched, and
   the default voice is set only when there is none.
5. **The engine for this computer.** `backend/src/firevoice/hardware.py` reads the graphics card (name and memory), the
   RAM and the free disk, and picks the engine that runs comfortably faster than real time on it and sounds best (an
   RTX 5080 gets Inferno, an RTX 4060 or 3060 gets Flare, a weak card or none gets Spark). It is installed with its
   weights, with progress.
6. **Getting it ready.** The engine is loaded into the graphics card and becomes Speak's engine.

Someone who skipped the setup in an older version sees a "Finish setup" prompt in the app until they have an engine and
the voice library; it opens the same screen. Failures are told in plain words (a full disk names the drive, a network
problem says so) with a **Try again** button.

**The voice library pack.** `backend/.venv/Scripts/python.exe scripts/build-voices-pack.py` builds
`release/voices/FireVoice-voices-N.zip` from your voices folder and rewrites `backend/src/firevoice/voicepack.json`
(version, URL, size, SHA-256, the ids, the default voice). Only the ids listed in that committed file ever ship. Publish
the zip once, before the release that needs it: `gh release create voices-N <zip> --repo fabwaseem/firevoice-releases`
(the script prints the command). Add voices with `--all` (every voice in the folder) and publish the new version.

`FIREVOICE_RUNTIME_DIR` builds the runtime in another folder, `FIREVOICE_VOICES_URL` points the voice pack download at
another file or address (a local `file:///` path works), and `FIREVOICE_HOME`, `FIREVOICE_ENGINES_DIR` and `HF_HOME` move
the data, the engines and the model cache: together they let you try a first run without touching the real one.

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

The release script sets it for you. The bundled backend runtime is rebuilt on a user's computer when the version
changes, so a backend change always needs a new version.

## Release

Releases are built and published from this computer; there is no CI.

```bash
node scripts/release.mjs patch --notes-file notes.md     # or minor / major / 1.5.0, or --notes "One line"
```

It checks the repo is clean and on `main`, runs the type check and backend tests, sets the version, adds the notes to
`CHANGELOG.md`, commits `Release vX.Y.Z` and tags it, builds the signed installers into `release/vX.Y.Z/`
(`FireVoice_X.Y.Z_x64-setup.exe` and its `.sig`, the `.msi`, `latest.json`, `SHA256SUMS.txt`), pushes `main` and the
tag here, publishes the files as a release of `fabwaseem/firevoice-releases`, and confirms the update feed announces
the new version. If any step fails, fix it and run the same command again: it resumes the same release.

`--dry-run` builds everything into `release/vX.Y.Z/` and changes nothing else. `--skip-tests` and `--rebuild` do what
they say.

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
`FIREVOICE_RELEASE_KEYS`). **Back that folder up somewhere safe.** Without it no installed copy can ever update again:
a new key means everyone reinstalls by hand.

## Updates

Updates never block the app (`src-tauri/src/updater.rs`, `src/components/shell/UpdateGate.tsx`). A few seconds after
start, every 30 minutes, and whenever its window comes back into view (from the tray) or the connection returns (at
most once every 5 minutes), the app asks the feed
(`https://github.com/fabwaseem/firevoice-releases/releases/latest/download/latest.json`) for the newest version.
Settings > Check for updates asks right away.

* **Newer version:** a card in the bottom-right corner says so, with what's new. If the window is hidden in the tray or
  behind other windows, a Windows notification says so too (once per version), and the tray icon's tooltip names it. **Download update** fetches it in the
  background with real progress (bytes, speed, time left) while the user keeps working; **Later** hides it until the
  next start. The card folds down to a pill.
* **Downloaded:** the installer's signature is checked against the public key built into the app, then the card offers
  **Restart and install**. Nothing installs until the user clicks it: then the app stops the voice engine, runs the
  installer and opens the new version. Voices, history and settings are untouched.
* **Offline, or GitHub unreachable:** nothing is shown; it asks again later. A failed download offers **Try again** and
  a link to download it by hand.

After an update the app updates its private backend runtime once, before the engine starts (the FireVoice package is
reinstalled and the other packages brought in step with the new pins; torch stays unless the pin changed), with
progress on screen.

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
