# Contributing to FireVoice

Thanks for helping. Bug reports, ideas, documentation fixes and code are all welcome.

## Before you start

- **Bugs:** search the [issues](https://github.com/fabwaseem/firevoice/issues) first. If it's new, open one with the
  **Bug report** form. Include the version (Settings > About), your system and graphics card, and the steps that cause
  it. The engine log helps most: Settings > About > **View engine log**.
- **Ideas:** open a **Feature request** describing what you are trying to do. A short discussion first saves you from
  building something that doesn't fit.
- **Security problems:** please don't open a public issue. See [SECURITY.md](SECURITY.md).

## Setting up

See [Build from source](README.md#build-from-source) for the quick version and the
[developer guide](docs/DEVELOPMENT.md) for everything else.

```bash
pnpm install
node scripts/dev-setup.mjs   # the engine's Python environment (backend/.venv)
pnpm tauri dev               # the app, with the engine
```

## Making a change

1. Fork the repo and create a branch from `main`.
2. Keep the change focused: one fix or feature per pull request.
3. Check it before you open the pull request:

   ```bash
   pnpm typecheck                                    # the interface
   cd backend && .venv/Scripts/python -m pytest -q   # the engine (on Linux or macOS: .venv/bin/python)
   ```

4. Add or update a test when you change the engine's behaviour, and update the docs when you change how something is
   used.
5. Open a pull request that says what changed and why, and how you tested it. Screenshots help for interface changes.

## Style

- Match the code around you: names, structure and comments.
- Interface text is plain and short. Say what happened and what to do next, without jargon.
- The engine is a standalone HTTP API. It never imports from the app, and the app only talks to it over HTTP.
- Nothing a user writes or says leaves their computer. A change that sends data anywhere needs a very good reason and
  must say so in the interface.

## License

By contributing, you agree that your contributions are released under the [MIT License](LICENSE).
