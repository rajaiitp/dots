# Deterministic `/workflow`

A thin implementation wrapper for Pi:

```text
Sol xhigh design → Sol low plan/implementation → verify → Sol reviews (up to 2 rounds)
```

Every run begins with one mandatory fresh-context Sol xhigh architecture consultation. The parent session then runs Sol low as the sole implementer in the active checkout. Verification commands are executed by the extension with real exit-code receipts. Review round 1 uses fresh-context Sol high; review round 2, when required, uses a separate fresh-context Sol medium call through the pinned `pi-subagents` structured-delegation event API.

## Commands

- `/workflow <task>` — start the fixed flow with automatic Sol design.
- `/workflow status` — show the persisted stage, plan revision, checks, review, and exact next action.
- `/workflow continue` — resume the current stage after an interruption or early model stop.
- `/workflow cancel` — cancel active work and leave checkout changes intact.

A second task is rejected while a run is active. Terminal runs are replaced when the next task starts.

## Flow

1. The Sol-low implementer immediately calls `workflow_design`; planning is blocked until the mandatory Sol-xhigh result is persisted.
2. The implementer calls `workflow_plan` with Sol-informed acceptance criteria, bounded steps, and exact final checks.
3. The implementer works normally with the active Pi tools.
4. `workflow_verify` runs the stored checks sequentially. A nonzero exit, timeout, cancellation, or repository mutation invalidates the pass.
5. `workflow_review` persists review dispatch, constructs an authoritative packet from the goal, Sol design, plan, prior review results, receipts, and run-start diff, then asks a fresh read-only Sol reviewer for structured findings. Dispatch consumes that round even if interrupted before a result returns.
6. Round 1 approval completes immediately. Round 1 changes require implementer remediation and a full verification rerun before round 2.
7. Round 2 approval completes normally. Round 2 changes permit one final remediation and full verification rerun, then complete as `completed_after_fixes` without a third review. A malformed `CHANGES_REQUESTED` response with no P0/P1 finding is normalized to approval because P2 findings are informational.

The workflow does not infer completion from prose and has no separate finish tool.

## Deliberate limits

The replacement has no:

- risk classifier or conditional Sol routing;
- a skip-design route or separate test-planning agent;
- command-equivalence parser;
- shell command restrictions on ordinary implementation work;
- artifact-path inference;
- automatic lifecycle nudges or retry loops;
- delta review, sharding, or unbounded review/fix loops;
- migration of legacy workflow state.

The only model-facing delegation tool hidden during a run is `subagent`, preventing extra specialists from bypassing the fixed role and review-round policy. Normal editing, shell, research, and bookkeeping tools remain available.

## Verification

Plan commands are stored with stable IDs (`V1.1`, `V1.2`, …). `workflow_verify` runs exactly those strings through `/bin/bash -lc` in the project directory and records:

- exit code and duration;
- timeout/cancellation state;
- bounded output tail and full log path;
- repository fingerprints before and after;
- paths changed while the command ran.

A command that modifies a task or source path cannot count as final verification. Inspect or accept the generated change, then rerun the complete suite. The only runtime exception is the narrowly documented pi-subagents bookkeeping exclusion below.

## Review boundary

At run start the extension records HEAD, Git status, and durable copies of intake-dirty paths under `$XDG_STATE_HOME/pi-workflow-lite/`. At review it compares the current checkout with that exact starting state. Unrelated pre-existing changes are excluded; changes made during the run are included even if they were committed.

The comparison narrowly ignores only pi-subagents runtime bookkeeping written by the reviewer itself: `.pi/agent/run-history.jsonl` and `.pi/agent/missions/**`. Those paths cannot stale a review, count as verification mutation, or satisfy remediation. Every other path, including all other `.pi` configuration and source files, remains covered.

Binary, symlink, special-file, corrupt-baseline, and oversized-diff cases fail clearly instead of truncating or claiming complete review.

External side effects are outside this Git review envelope.

## Dependency

`pi-subagents@0.66.0` is pinned in `~/.pi/agent/npm/package.json` and enabled as an extension in `~/.pi/agent/settings.json`. Its bundled skills and prompts remain disabled. Because separately installed Pi packages have independent module roots, the workflow uses the package's documented structured-delegation event names directly rather than importing internal runner code.

Run `/subagents-doctor` if delegation is unavailable after `/reload`.

## Configuration

Global file: `~/.pi/agent/workflow.json`

The schema is version 2 and intentionally does not accept earlier role fields. It configures separate design, implementation, review-1, and review-2 model/thinking assignments plus check count, command/specialist timeouts, review-size limit, and bounded command output.

## Recovery

State version 4 is persisted as `workflow-lite-state` custom session entries. Earlier workflow state and legacy `workflow-state` entries are ignored. A reload during verification requires the suite to run again. A reload after either reviewer dispatch fails that run rather than duplicating the consumed round; a reload while merely waiting to invoke review remains review-ready. No stage advances automatically on `agent_settled`.
