# Changelog

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
