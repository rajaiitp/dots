# Pi-Herdr completion-gated run overlay

Version 2 replaces pi-herdr's eager-read/follow-up completion patch.

- `run` submits one wrapped Bash/Zsh command, waits once with `herdr pane wait-output`, and returns its final output and exit code.
- `detached: true` is for persistent processes.
- `read` remains an immediate snapshot.
- Captured output may use `hypa compress --kind shell-output`; raw output is the safe fallback.

`../install.sh` supports pi-herdr `0.1.0`, validates the Herdr `pane wait-output` capability, migrates the recognized legacy patch, and executes `run-protocol.test.cjs` after installation.
