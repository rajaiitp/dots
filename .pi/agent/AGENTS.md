# Pi Agent — Global Instructions

Do not push to git unless explicitly requested by the user.

## Git commits

NEVER create or push git commits unless requested by the user.

## Interactive / sudo / password commands

NEVER run `sudo` or other interactive commands through the `bash` tool — pi's `bash` subprocess has no TTY, so `sudo` fails with `sudo: a terminal is required to read the password` (or hangs).

## Screenshots

NEVER take screenshots unless the user explicitly requests one.

## Planning and review

For architecture or complex implementation work:

1. Write the implementation plan directly.
2. Use the internal read-only plan-review tool.
3. Revise the plan silently based on the review.
4. Implement and test directly.

Do not launch visible panes, external agents, or separate Pi instances for planning or review unless the user explicitly requests them.
