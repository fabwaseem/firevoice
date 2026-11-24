# Changelog

## 2.0.2 (2026-11-24)

FireVoice is now open source, under the MIT license: the code is at github.com/fabwaseem/firevoice.

- **Downloads and updates move to github.com/fabwaseem/firevoice.** This version checks for updates there. If you have 2.0.1 or older, download this version once from the FireVoice website; after that it updates by itself again.
- **Dictation waits for setup.** Starting dictation while FireVoice is still setting it up now says so, instead of failing with a network error.

## 2.0.1 (2026-11-12)

A fix for 2.0.0, which could open to an empty dark window.

- **FireVoice opens again after updating.** In 2.0.0 the window stayed empty and dark while FireVoice started, set itself up or updated its voice engine (the sign-in button in the title bar was the cause). If you see an empty window, close FireVoice and open it again once 2.0.1 is installed; it updates by itself.
- If something ever goes wrong while the window is drawn, FireVoice now shows what happened and a Reload button instead of an empty window.

## 2.0.0 (2026-11-12)

FireVoice comes to the Mac, and dictation is quicker to start.

- **macOS.** FireVoice is available for Mac (Apple silicon): the Mac's own window buttons, Cmd for copy and paste, start at login, and a clear prompt for the Accessibility permission dictation needs.
- **Start with "Hey FireVoice".** Say it in any program and keep talking: the dictation starts with what follows and ends when you stop. Off by default; nothing leaves your computer while it listens.
- **Starts with your computer.** FireVoice starts quietly in the tray when you sign in, so dictation is ready (turn it off in Settings, Startup).
- **A new dictation pill.** A short guide for your first dictation, a glass pill with a glow that follows your voice, and a green tick when the text goes in.
- **One dictionary.** Every name and term in one place: how the voices say it, what dictation mishears, and the words to expect.
- **A calmer app.** Home shows your dictation stats (words, time saved, speaking speed, streak), History is grouped by day, icons move when you point at them, and the app uses a new typeface.
- **Sign in on the web.** The person button in the title bar opens the FireVoice website (email or Google); your account shows in the app once you are signed in. Signing in is optional.
- **Usage statistics, your choice.** FireVoice asks once whether to share usage statistics (features used, computer details, crash reports; never what you say), and you can turn it off or delete them in Settings, Privacy. Send feedback from the sidebar.
- Windows 11 rounded corners on the window, and the pill centred correctly on screens with different scaling.

## 1.9.0 (2026-11-11)

Dictation now writes what you meant, in any language.

- **Writing assistant.** A small writing model on your computer polishes every dictation: punctuation, grammar, no false starts, numbered lists, in the style of the app you are typing in (casual for chat, formal for email, exact for code). It downloads by itself after setup when your computer suits it, and adds about a tenth of a second on a graphics card.
- **Translate as you dictate.** Speak Urdu, Spanish or any language and have it written in the language you choose.
- **Edit by voice.** Select text in any app, press the command keys and say what to do: "make it shorter", "more polite", "translate to German".
- **Correct yourself out loud.** Say "no wait" or "scratch that" and only the correction goes in. Say "comma", "question mark", "new line" and more.
- **Your words and snippets.** Teach FireVoice the names and terms you use, fix words it keeps getting wrong, and type whole texts from a short phrase ("my email").
- **Better languages.** Pick the languages you speak and Automatic only chooses among them, checks again when you stop, and keeps Urdu in Urdu script. All 100 speech languages are available, and other languages work without an NVIDIA card too.
- **Hands-free and whisper mode.** Double-tap the keys to keep listening; whisper mode hears you when you speak softly.
- **Searchable history.** Every dictation is kept on your computer, with the app it went to, ready to copy again.
- **Polished by default.** Dictations now go in when you stop, cleaned up. Live typing as you speak is still one click away.
- Downloads show how much is left, the speed and the time remaining, and resume where they stopped.
- Engine cards are simpler, and only an engine your computer cannot run says so.

## 1.8.1 (2026-11-11)

FireVoice now runs on more computers, and on Linux.

- **Linux.** FireVoice is available for Linux (64-bit, Ubuntu 22.04 or newer and similar): an AppImage that updates itself, a .deb and an .rpm.
- **No NVIDIA card? It still works.** Computers with an AMD or Intel graphics card, or none, get a much smaller setup (about 200 MB instead of several GB) and run FireVoice on the processor.
- **Every engine says whether it runs on your computer.** The Engines page marks each one as ready, slower than real time here, or "Can't run here" with the reason in plain words (for example, not enough graphics memory, or an NVIDIA driver that isn't working). FireVoice never downloads an engine your computer can't run.
- **Setup fix.** The voice libraries step no longer fails on computers without developer tools installed.

## 1.8.0 (2026-11-11)

A first run that just works: one setup, then your first render is a click away.

- **One setup that can't be skipped.** A new computer gets a single "Setting up FireVoice for your computer" screen with real progress and time left: the environment, GPU support, the voice libraries, 100 ready-made voices, the best engine for your computer, and loading it. When it finishes, Speak is ready: press Render.
- **The right engine for your computer.** FireVoice reads your graphics card, memory and free disk and installs the engine that runs comfortably faster than real time and sounds best on it. A weak card or none gets the light one.
- **All 100 voices from the start.** The voice library downloads once during setup, and it never overwrites a voice you changed.
- **Clear errors.** A full disk names the drive and how much is needed; a network problem says so, with Try again. No more raw error codes.
- **Finish setup.** If an older version let you skip the setup, a "Finish setup" prompt in the app completes it.
- **More engines install in one click.** Flash and the other engines that share the GPU runtime now have an Install button with live progress.
- **Downloads show real progress.** Model downloads no longer sit at 0% and then jump.

## 1.7.2 (2026-11-11)

- **Clearer update notes.** "What's new" in the update card now shows proper formatting: lists, bold text and links, instead of raw symbols.
- **The update stays in sight.** If you close the update card, a pill in the sidebar ("Update available") remains. Click it to reopen the card. It shows the download progress and turns green with "Restart to update" when the update is ready.
- **Title bar matches the app.** The window's title bar now follows FireVoice's own theme (light, dark or system), so a light app no longer sits under a dark title bar.

## 1.7.1 (2026-11-11)

- **Updates are noticed while FireVoice runs.** It checks every 30 minutes, when you bring the window back (for example from the tray) and when your connection returns. If the window is hidden, a notification tells you a new version is ready. You still choose when to download and install.
- **Speak renders the whole script.** The Stream switch is gone: every render is the full script, checked and mastered, with a timer and an estimate while it works. The streaming API routes are still there for programs.
- **Styles come with Firebrand.** Delivery styles (excited, sad, whisper, newscaster…) now appear only when Firebrand is the engine, in Speak, the script editor, Home, Projects and Dialogue. With other engines the voice's own delivery is used, and a Styles section in the engine panel explains how to get them.
- **Smoother floating player.** The player bar has a frosted background, so the page no longer shows through it.

## 1.7.0 (2026-11-10)

- **Faster first start.** FireVoice is ready in about a minute. Graphics card support (the big download) now finishes in the background while you look around, with live progress, speed and time left in the corner. If you close the app part way, the download picks up where it stopped.
- **New welcome.** A cleaner, centred setup with calm music, a step to turn on dictation and try it, and a short guided tour of the app afterwards. You can take the tour again from Settings.
- **Updates on your terms.** New versions no longer interrupt you. A card in the corner offers the update, it downloads in the background with real progress, and it installs only when you click Restart and install. Settings has Check for updates.
- Engines reuse the graphics card download instead of fetching it again.

## 1.6.0 (2026-11-10)

Dictation: speak in any program and FireVoice types what you say.

- Press a hotkey (Ctrl+Alt+Space by default, changeable) in any app, speak, and press it again. Or choose hold-to-talk. Everything is turned into text on your own graphics card; nothing leaves your computer.
- Words appear as you speak. A word is typed only once FireVoice is sure of it, and it is never changed afterwards. Or choose "when you stop" and the whole text is checked once more and inserted in one go.
- A small floating window shows your voice and the words as they form, without taking the cursor away from the program you are typing in.
- Say "new line" or "new paragraph" to start one. Um and uh are left out. Names and terms from your Dictionary are spelled the way you wrote them.
- Pick your language (or let FireVoice detect it) and your microphone. Dictations are kept in a list you can copy from, with totals of the words you have dictated.
- With dictation on, closing the window keeps FireVoice running in the tray next to the clock, so the hotkey keeps working. Quit from the tray icon.
- The play button on voice cards is easier to see in dark mode.
- Developers: the same live speech-to-text is available to your own tools and AI agents at /api/v1/dictate, documented in Settings > API.

## 1.5.4 (2026-11-10)

An API for your own tools and AI agents, and a tidier app.

- Settings has a new API section: the address, a ready-made set of instructions to paste into your AI agent, examples for curl, Python and JavaScript, and a button that opens the full API docs.
- With the sidebar in compact mode, the FireVoice logo opens it: point at the logo and it becomes the open button.
- The engine log is easier to read: no more hundreds of progress lines per model load, and it no longer grows without limit.
- Dubbing and transcription with several speakers start faster: a helper model is now loaded once instead of once per segment.
- The voice engine is used through the app or its API only. The command-line tool and the playground web page are gone; the API docs at /docs remain.
- After this update FireVoice updates its voice engine once, with progress on screen.
- FireVoice is now under a proprietary license.

## 1.5.3 (2026-11-10)

A new first-run experience.

- Welcome: a tour of what FireVoice can do, from speech and your own voices to dubbing, transcription and music.
- Set up: the one-time setup now shows each step as it happens, with clear progress and an easy way to try again.
- Your engine: FireVoice checks your graphics card and suggests the engine that suits it, explained in plain words, and installs it in place.
- First words: pick a voice and hear FireVoice speak before you start.
- Starting, updating and setting up now have their own calm screens, with no flicker.

## 1.5.2 (2026-11-10)

Uninstalling can now remove everything.

- The uninstaller's checkbox now reads "Also delete all FireVoice data: voices, history, engines and models". Ticked, it removes FireVoice's data folder and any engine or model folders you moved in Settings, as well as the app's own settings. Left unticked, your voices, history, engines and models stay, ready for a reinstall.
- Updates never delete any data.

## 1.5.1 (2026-11-10)

A small housekeeping update.

- FireVoice now installs under its own app name (app.fabwaseem.firevoice, publisher fabwaseem).
- The app log keeps the lines that explain a problem (starts, updates, errors) for longer.

## 1.5.0 (2026-11-10)

FireVoice now keeps itself up to date, and audio tools have a home of their own.

New
- Automatic updates: when a new version is out, FireVoice downloads and installs it on start, then reopens. Every update is signed and checked before it installs.
- Tools: Separate voice, Quality report and AI speech check, each with a large drop zone and a clear result panel.
- A new audio player everywhere: a waveform you can click or drag to seek, playback speed, mute and save.
- The quality report now includes listener scores (sound quality, speech clarity, background).

Improved
- Settings are simpler: FireVoice always runs its own voice engine, with nothing to configure.
- Picked files in Transcribe and Add a voice can be played before you use them.
- Install steps for engines are described in plain words.

Fixed
- Dialogue could come out as a short burst of noise when Speak was set to the voice changer engine.
- Separating a voice ran twice and kept two copies in History.
