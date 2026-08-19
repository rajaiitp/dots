# Pi Agent — Global Instructions

Do not push to git unless explicitly requested by the user.

## Git commits

NEVER create or push git commits unless requested by the user.

## Interactive / sudo / password commands

NEVER run `sudo` or other interactive commands through the `bash` tool — pi's `bash` subprocess has no TTY, so `sudo` fails with `sudo: a terminal is required to read the password` (or hangs).

Regardless of expected runtime, always use `terminal_run` for interactive or `sudo` commands and let the user type passwords or other secrets directly in the visible managed pane. Never send or type a password yourself with `terminal_input`. This applies to `sudo`, editors, REPLs, `psql`, `ssh`, and other interactive prompts.

## Managed terminal commands

- Use internal `bash` for quick, finite commands. Use `terminal_run` when a command is long-running, interactive, intentionally parallel, or needs to remain visible.
- Pass argv directly to `terminal_run`; use `["bash", "-lc", SCRIPT]` only when shell syntax is required.
- `terminal_run` is asynchronous and returns an opaque command ID. Never sleep or poll `terminal_read`/`terminal_command` for completion; wait for the automatic `command.finished` follow-up.
- Completion follow-ups contain status only. Call `terminal_read` with that command ID only when its output is relevant.
- `terminal_read` is command-scoped: completed output remains immutable even if the mux reuses the physical pane. Optional ranges are relative to that command's output.
- Use `terminal_input` only for a currently running command. End submitted lines with `\n`; use separate calls for iterative interaction.
- A long-lived SSH shell, REPL, or debugger keeps the same command ID and pane ownership until it exits. Reuse that ID for all input and incremental reads.
- Use `terminal_command` for one-shot inspection, cancellation, or explicit close. Old command IDs may read retained output but cannot control a pane after reuse.
- Pane creation, pooling, reuse, and pane/tab/window IDs are mux internals; do not request or reason about them.
- Use a subagent for a coherent independent objective, not for every shell command. A subagent may own an entire remote or interactive session and return a concise summary.

## Screenshots

NEVER take screenshots unless the user explicitly requests one.
