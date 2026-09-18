# GPTAuto for GPTWork

GPTAuto is GPTWork's goal-bound GitHub work protocol. It supersedes turn-bound execution while retaining GitHub Agent as the deterministic Actions-governance subsystem.

## Completion contract

A GPTWork GitHub task is complete only when its requested final outcome satisfies its Definition of Done. A chat turn, tool call, commit, PR, queued/running Actions run, merge, tag, or started release is not completion.

Canonical lifecycle:

    GOAL -> INSPECT -> IMPLEMENT -> PR -> WAIT_CI -> MERGE -> MAIN_CI -> RELEASE -> VERIFY -> DONE
                                      |                    |          |          |
                                      +-> ANALYZE -> FIX <-+----------+----------+

Queued, requested, pending, waiting and in-progress Actions are WAITING. They never imply DONE.

## Responsibility split

GPTAuto owns durable goal state, completion semantics, retry budget and final acceptance. GPT/Work owns reasoning: repository inspection, code changes, root-cause analysis, fixes and product-aware verification. GitHub Agent owns deterministic Actions governance: Policy Check, Governor, Recovery and Housekeeping.

## Stop policy

The worker may return control before DONE only when state is BLOCKED because credentials/permissions are unavailable, a material product decision is ambiguous, a destructive/high-risk action lacks authorization, bounded repair attempts are exhausted, or an external platform condition cannot be repaired.

## Durable handoff

The embedded runtime lives in `.github/gptauto/`. Persist active task JSON outside the repository worktree when possible, or as an Actions artifact/state store in a host integration. The JSON is the handoff between invocations; WAITING state must be resumed rather than reported as task completion.

Example:

    python -m .github.gptauto.cli

For local execution set `PYTHONPATH=.github` and run:

    PYTHONPATH=.github python -m gptauto.cli init --goal "Ship fix" --repo b8vipvip/GPTWork --out /tmp/gptauto-task.json
    PYTHONPATH=.github python -m gptauto.cli step /tmp/gptauto-task.json accepted
    PYTHONPATH=.github python -m gptauto.cli status /tmp/gptauto-task.json

## Release Definition of Done

Release-required work reaches DONE only after PR CI succeeds, the PR is merged, CI for the exact merge SHA succeeds, the requested non-draft GitHub Release exists, and product-specific final verification is recorded as passed.
