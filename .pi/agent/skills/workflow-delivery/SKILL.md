---
name: workflow-delivery
description: Execute an active deterministic /workflow run. Use only when the /workflow command explicitly loads this skill.
disable-model-invocation: true
---

# Workflow delivery

You are the sole writer in the active checkout. Follow the active workflow state rather than inventing another orchestration process.

## Required sequence

1. If the prompt says `Workflow mode: design`, call `workflow_design` once and use its result as architectural guidance.
2. Inspect only enough repository context to make a concrete plan. Ask the user only when a material product or architecture decision cannot be resolved from the task and code.
3. Call `workflow_plan` before implementation. Use `expectedRevision: 0` for the first plan. Include concise acceptance criteria, bounded implementation steps, and 1–8 exact final verification commands.
4. Implement in the active checkout with normal Pi tools. Development shell commands are allowed; they do not count as final evidence.
5. If requirements or final checks materially change before review, call `workflow_plan` again with the current revision. Do not revise the plan after review starts.
6. Call `workflow_verify`. The controller runs the registered commands itself and trusts their actual exit codes. Do not rerun equivalent commands and claim that they satisfy the gate.
7. After successful verification, call `workflow_review` exactly once. Dispatch consumes the review even if it is interrupted before returning, so do not call it again. Do not call `subagent` or another specialist directly.
8. If review requests changes, apply the concrete P0/P1 findings, ensure the repository actually changes, and call `workflow_verify` again. No second independent review runs.
9. Report the exact terminal status. For `completed_after_fixes`, explicitly say that fixes passed verification but did not receive a second independent review.

## Plan quality

- Prefer the smallest coherent change.
- Derive acceptance criteria from user-visible behavior or explicit invariants.
- Use commands that are non-interactive, finite, and appropriate for the repository.
- Verification commands must not modify tracked or visible untracked project files. Run formatters or generators before the final gate. The controller narrowly ignores only pi-subagents runtime bookkeeping at `.pi/agent/run-history.jsonl` and `.pi/agent/missions/**`; never use those paths as task artifacts or remediation evidence.
- Do not add a check merely to create ceremony; every check must validate an acceptance criterion or regression risk.

## Failure handling

- A failed or timed-out check returns the run to implementation or remediation. Fix the cause, then call `workflow_verify` again.
- If verification changes repository files, inspect and accept or revert those changes, then rerun the complete suite.
- If Sol or a verification command is interrupted, do not infer success. Use `/workflow continue` when the user wants to resume. A dispatched independent review is intentionally not retried; report the failed terminal run instead.
- Never commit or push unless the user separately requests it.
