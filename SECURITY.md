# Security policy

## Supported versions

Only the latest release gets security fixes. FireVoice updates itself, so keeping it up to date is enough.

## Reporting a vulnerability

Please report security problems privately, not in a public issue:
[open a private vulnerability report](https://github.com/fabwaseem/firevoice/security/advisories/new) on GitHub.

Include what you found, the steps to reproduce it, the version, and your system. You will get an answer within a few
days. Once a fix is released, the report is published with credit to you, unless you'd rather stay anonymous.

## Scope

FireVoice runs on the user's own computer:

- The voice engine listens on `127.0.0.1` only, and the app's window has a strict content security policy.
- Updates are signed: the app checks every update's signature against the public key built into it before installing.
- Speech models are downloaded from their publishers and run on the user's computer. Problems in a model or in a
  third-party library are best reported to its own project, but tell us too if FireVoice exposes them.
