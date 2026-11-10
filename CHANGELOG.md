# Changelog

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
