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

## Supported computers

| | Windows 10/11 (64-bit) | Linux (64-bit, glibc 2.35+, such as Ubuntu 22.04 or newer) |
|---|---|---|
| NVIDIA card with its driver | CUDA build of torch; every engine its memory allows | the same |
| AMD or Intel card, or none | the small CPU build of torch (about 200 MB, without the CUDA libraries); engines that can run on a processor | the same |

The setup detects which row applies (`src-tauri/src/backend.rs` for the torch build, `backend/src/firevoice/hardware.py` for the
engines) and says so on the setup screen. Every engine has recorded needs in `hardware.REQUIREMENTS` (graphics card or not,
graphics memory, system memory, a rough speed on a processor). The Engines page marks each one **Ready**, **Slow here** (it works,
slower than real time: fine for short lines) or **Can't run here** with the reason in plain words; an engine that cannot run is
never downloaded, and loading it is refused with the same words. Measured on a 16-thread desktop processor with the card hidden:
Spark keeps up easily (0.25 s per second of speech), Flash and Torch run 2 to 3.5 times slower than real time (fine for short
lines), while Flicker (17 times slower) and Flare (never finished a line) are not offered there; the large engines need an
NVIDIA card with enough memory. AMD graphics cards are not used by the
engines yet (AMD's PyTorch for Windows covers only some cards and is not published on the usual package index); they are named
in the message so it is clear why the processor is used. `FIREVOICE_ACCELERATOR=cpu` forces the processor (a broken driver,
or a test).

### macOS

Built by the release workflow on Apple Silicon (macOS 11 or newer; no Intel build, torch no longer publishes Intel Mac
wheels). The engines run on the processor there (no CUDA). Differences from Windows, all in the code:

* the window uses the system's own traffic-light buttons (`src-tauri/tauri.macos.conf.json`, the title bar hides its
  drawn buttons), and the transparent dictation pill needs `macOSPrivateApi` (the Tauri CLI adds the Cargo feature on
  a macOS build only);
* typing into other apps needs **Accessibility** (System Settings > Privacy & Security > Accessibility): on the first
  dictation macOS asks, and FireVoice says where to turn it on; the microphone prompt uses `src-tauri/Info.plist`;
* paste and copy use Cmd, the focused app is read with `lsappinfo`, and starting at login is a LaunchAgent in
  `~/Library/LaunchAgents/com.firevoice.autostart.plist`.

### Linux builds

`node scripts/build-linux.mjs <folder>` builds the Linux packages in Docker on any computer that runs it (the image is
`docker/linux/Dockerfile`, Ubuntu 22.04 so the app runs on it and on newer systems): an **AppImage** (what the updater uses; it
updates itself), a `.deb` and an `.rpm`. It is for trying a Linux build locally: releases build Linux natively in
the release workflow, with the same libraries as the image. Dictation's global hotkey and typing
into other programs work on X11; on Wayland the desktop decides what is allowed.

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

**Before starting a release, run the whole backend test suite on your computer** (CI only runs a quick check, which
saves Actions minutes and cannot stall a build):

```
cd backend && .venv/Scripts/python -m pytest -q                       # Windows, on the source
node scripts/bundle-backend.mjs && node scripts/test-bundled-backend.mjs --full   # Windows, on the compiled backend
```

and on Linux, in Docker, on the same system as GitHub's runner (Ubuntu 22.04 with its own ffmpeg):

```
docker run --rm -v firevoice-uv-cache:/root/.cache/uv -v "$PWD:/src:ro" ubuntu:22.04 sh /src/scripts/test-linux.sh
```

(add `-e COMPILED=1` after `--rm` to test the compiled Linux backend, as the Linux installer ships it).

1. **Plan and type check** (Linux): works out the version, checks the tag is free, runs the type check.
2. **Build** (Windows, macOS and Linux side by side): sets the version, builds the signed installers, refuses a build
   that would ship source, and gives the compiled backend a quick check on each OS (a few seconds: it loads, its server
   starts and answers, and it resamples audio with the ffmpeg the app ships).
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

Optional, for a macOS build Apple trusts without the right-click (an Apple Developer account): `APPLE_CERTIFICATE`
(the Developer ID Application certificate, `.p12` as base64), `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`
("Developer ID Application: Name (TEAMID)"), and for notarization `APPLE_ID`, `APPLE_PASSWORD` (an app-specific
password) and `APPLE_TEAM_ID`. Without them the build is ad-hoc signed, as described above.

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
gives the compiled wheel that goes into the installer a quick check (`node scripts/test-bundled-backend.mjs`; add
`--full` for the whole test suite against it). Building needs a C compiler; on Windows the Visual
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

Two modes: **Live** types each word as it becomes certain; **Polished** ("when you stop") transcribes the whole
dictation once more (beam search, with your words as hints), applies the final touches and inserts it in one go. While
Ctrl or Alt is held down nothing is typed (it would trigger shortcuts), so in hold-to-talk mode the words wait for the
key to come up; a double tap of the keys keeps listening hands-free until the next tap.

What the words become (`backend/src/firevoice/dictation_text.py`, both modes): spoken commands and punctuation ("new
line", "comma", "question mark", "open quote"...), and your own **words** (expected by the speech model, any casing
fixed), **replacements** ("fire voice" -> "FireVoice") and **snippets** ("my email" types the address), kept in
`FIREVOICE_HOME/dictation.json` (`backend/src/firevoice/dictation_store.py`, `/api/v1/dictation/*`). A phrase's first
words are held back while live until the next word decides. Polished mode also applies corrections said out loud
("scratch that", "no wait", "sorry, I meant": the correction replaces from the word it repeats, else the last word).
Every dictation lands in a searchable history (`FIREVOICE_HOME/dictation/history.jsonl`) with the app it went to.

**Languages.** One fixed language, or Automatic among the languages you speak (any of Whisper's 100 when the list is
empty). In Automatic mode every pass is made in the likeliest of your languages (`asr.detect_language`, silence cut out
first), the language is settled once the detector is 75% sure among yours or after 4 s, and in Polished mode the whole
dictation is checked once more at the end, so a wrong early guess is put right before anything is typed. One language
in the list needs no detection at all. Spoken Urdu and Hindi are close to identical, so keep only the one you write in.
Without an NVIDIA card the shared speech model is the English-only `base.en`; a dictation that may be in another
language uses a multilingual `small` model instead (loaded on first use). The writing assistant keeps the text in its
language and never translates it, and it uses the graphics card only when 4.5 GB of it is free (else the processor).

**The writing assistant** (`backend/src/firevoice/dictation_ai.py`, optional, installed from the Dictation page):
llama.cpp's server (pinned release, Vulkan build: NVIDIA, AMD and Intel graphics, or the processor) with
Qwen3-4B-Instruct-2507 (Apache-2.0, 4-bit, 2.5 GB), both SHA-256 checked, in `<engines>/writer/`. It runs as its own
process tied to the backend's lifetime (a job object on Windows, a parent-death signal on Linux). In Polished mode it
rewrites the dictation as meant (punctuation, false starts, corrections, numbered lists) in the style chosen for the
kind of app the text goes to (`app_kind`: messages, work chat, email, documents, code, other; the shell reports the
focused program), adding about 0.1 s on a graphics card. A reply that does not look like the dictation (an answer, a
poem it was asked for) is discarded and the rule-based text used. **Command mode** (its own hotkey): the shell copies the
selection when you finish speaking, and the spoken instruction is carried out on it ("make this shorter", "translate to
Spanish"); the result is pasted over it. With nothing selected it writes what was asked for.

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
