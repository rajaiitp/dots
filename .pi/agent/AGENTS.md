# Pi Agent — Global Instructions

Do not push to git unless explicitly requested by the user.

## Git commits

NEVER create or push git commits unless requested by the user.

## Interactive / sudo / password commands

NEVER run `sudo` or other interactive commands through the `bash` tool — pi's `bash` subprocess has no TTY, so `sudo` fails with `sudo: a terminal is required to read the password` (or hangs).

## Screenshots

NEVER take screenshots unless the user explicitly requests one.
