# Pi Agent — Global Instructions

Do not push to git unless explicitly requested by the user.

## Git commits and pushes

NEVER create, amend, fix up, rebase, or otherwise rewrite a commit unless the user explicitly requests it for the current change.

NEVER push or force-push unless the user explicitly requests it for the current change.

Prior authorization to commit or push does not carry over to later refinements. An implementation request is not authorization to commit or push. Leave completed changes uncommitted until the user explicitly asks.

## Separation of concerns

Promote separation of concerns. Keep transport handling, static validation, stateful domain logic, persistence, and external integrations in their appropriate layers rather than combining them in one function or component.

## Code hygiene

Use typed internal enums and named constants instead of magic state strings, operation strings, retry counts, limits, or timeouts. Keep external wire values at transport boundaries and map them to internal types rather than reusing serialized constants for internal control flow.

Make enum switches exhaustive. Reserve an invalid zero value where practical, and never use a default branch that silently interprets an unknown value as a valid operation.

Centralize repeated transport error responses behind typed identifiers and a consistent response schema. Keep transport errors, domain validation errors, persistence errors, and external-integration errors distinct.

Preserve source compatibility for exported APIs unless the user explicitly approves a breaking change.

Do not convert durability or persistence failures into successful outcomes. Propagate or retry them so externally reported success reflects durable state.

## Markdown documents

NEVER add or modify Markdown documents in a repository unless explicitly requested by the user.

## Interactive / sudo / password commands

NEVER run `sudo` or other interactive commands through the `bash` tool — pi's `bash` subprocess has no TTY, so `sudo` fails with `sudo: a terminal is required to read the password` (or hangs).

## Screenshots

NEVER take screenshots unless the user explicitly requests one.
