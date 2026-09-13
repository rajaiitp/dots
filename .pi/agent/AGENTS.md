# Pi Agent — Global Instructions

Do not push to git unless explicitly requested by the user.

## Git commits

NEVER push git commits unless requested by the user

## Interactive / sudo / password commands

NEVER run `sudo` or other interactive commands through the `bash` tool — pi's `bash` subprocess has no TTY, so `sudo` fails with `sudo: a terminal is required to read the password` (or hangs).

## Screenshots

NEVER take screenshots unless the user explicitly requests one.

## Communication and authored text

These rules apply everywhere: chat, plans, tool arguments, delegated prompts, findings, handoffs, progress updates, documentation, code comments, docstrings, TODOs, configuration comments, and commit or PR text.

- Keep text minimal, precise, and task-specific.
- State each fact once. Do not restate the request, narrate routine work, repeat evidence, add generic background, or list speculative alternatives.
- Prefer short bullets or direct sentences. Include only decisions, material findings, actions, verification, and unresolved risks.
- Edit documentation only when the user requests it or when necessary to keep a changed public contract accurate. Make the smallest sufficient documentation patch.
- Add code comments, docstrings, or TODOs only when needed to explain a non-obvious invariant, constraint, or reason the code cannot express. Never describe obvious behavior, restate code, narrate an edit, or leave commentary that naming or structure can replace.
- Before finishing, remove redundant prose, comments, docstrings, TODOs, and documentation.

## Planning and review

For architecture or complex implementation work:

1. Write the implementation plan directly.
2. Use the internal read-only plan-review tool.
3. Revise the plan silently based on the review.
4. Implement and test directly.

Do not launch visible panes, external agents, or separate Pi instances for planning or review unless the user explicitly requests them.
