# Active-checkout workflow

`/workflow` is an orch-derived implementation workflow. The parent Pi session runs Luna xhigh as the only writer in the active checkout; isolated Terra xhigh and Sol xhigh children plan and review with read/search tools only.

## Usage

- `/workflow <goal>` — enable workflow mode and start the goal in one step.
- `/workflow` — open an editor for the goal.
- `/workflow on` — enable workflow mode; the next ordinary prompt starts a run.
- `/workflow status` — show the current persisted run state and recent activity.
- `/workflow continue` — resume an interrupted nonterminal run without replacing its task, plan, diff, or verification evidence.
- `/workflow abandon` — terminate the run while leaving active-checkout changes intact.
- `/workflow off` — restore the model, thinking level, and active tools that preceded workflow mode.

A compact widget shows only stage and review state. Normal Pi tool rows remain the authoritative detailed activity view; task and recent-activity diagnostics are available only through `/workflow status`. Widget/state entries do not enter model context.

## Execution model

For behavior-bearing changes:

1. Sol design is available only for architecture/high-risk task signals or an explicit Terra escalation; low-risk optional consultations are rejected. Its normal tool row reports elapsed time while the isolated child runs.
2. Terra writes acceptance criteria and exact verification commands before the first behavior-bearing mutation or shell command.
3. Luna edits and verifies in the active checkout.
4. Terra reviews the complete task-local diff, with bounded delta review for remediation and lossless sharding for large full reviews.
5. Exact approval completes the run atomically. No separate finish call is required.

Read-only answers and inert documentation edits complete without specialist calls.

## Checkout safeguards

The workflow captures intake-dirty files in a task-local baseline under `$XDG_STATE_HOME/pi-workflow/`, then captures clean files before mutation. Terra receives only the diff against that baseline, not the user's pre-existing work.

Allowed after Terra planning:

- `edit` and `write` for normal source changes;
- `workflow_file` for attributable single-file remove/move operations;
- foreground `bash` and `hypa_shell` commands, including tests, builds, package tools, and generators.

Still blocked:

- Git/JJ metadata writes;
- direct shell filesystem mutation (`rm`, `mv`, redirection, inline interpreters, and similar bypasses); use attributed file tools instead;
- unmanaged background jobs;
- privileged/process-control commands;
- repository escapes and remote-code piping;
- symlink or special-file mutation.

Foreground commands are compared against Git status and content manifests before and after execution. A change outside an observed Luna tool call stops further mutation rather than silently entering the task.

## Differences from final `/orch`

Kept from `/orch`:

- active-checkout Luna implementation;
- isolated Terra planning/review and risk-gated Sol design;
- task-local dirty-worktree baseline;
- exact artifact/verification binding, bounded review retries, delta review, and sharded full review;
- Git-write, background-process, and path-escape protections.

Changed for seamless use:

- `/workflow <goal>` starts directly instead of requiring a separate enable-and-prompt sequence;
- both normal `bash` and compressed `hypa_shell` are available after planning;
- `workflow_file` supports safely attributed remove/move operations;
- Terra approval finishes atomically, removing the brittle `orch_finish` handshake;
- a twice-settled agent pauses resumably instead of terminally blocking;
- read-only/docs-only runs finish automatically;
- normal Pi tool rows remain visible while task/recent-activity diagnostics stay out of the persistent widget;
- low-risk runs cannot launch unnecessary Sol consultations, and required Sol calls report elapsed progress;
- mutation preflight detects unobserved checkout changes and symlink escapes.

## Configuration

Global configuration: `~/.pi/agent/workflow.json`

A trusted repository may override supported fields in `.pi/workflow.json`. Invalid or unknown fields fall back to the global/default values.
