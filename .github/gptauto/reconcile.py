"""Select reusable exact-SHA post-merge validation evidence."""

from __future__ import annotations

import argparse
import json
import sys
from typing import Any

_ACTIVE_STATUSES = frozenset({"queued", "in_progress", "waiting", "requested", "pending"})
_REUSABLE_EVENTS = frozenset({"push", "workflow_dispatch"})


def _sort_key(run: dict[str, Any]) -> tuple[str, int]:
    try:
        run_id = int(run.get("id") or 0)
    except (TypeError, ValueError):
        run_id = 0
    return str(run.get("created_at") or ""), run_id


def select_validation_run(
    runs: list[dict[str, Any]],
    *,
    workflow_name: str,
    merge_sha: str,
    default_branch: str,
) -> dict[str, Any]:
    """Prefer a successful run, otherwise wait for an active main-branch run.

    The Actions API query is already scoped by head_sha, but the identity checks
    are repeated here so callers and tests cannot accidentally reuse PR CI or
    evidence for a different commit/branch.
    """
    matching = [
        run
        for run in runs
        if isinstance(run, dict)
        and run.get("name") == workflow_name
        and run.get("head_sha") == merge_sha
        and run.get("head_branch") == default_branch
        and run.get("event") in _REUSABLE_EVENTS
        and run.get("id") is not None
    ]

    successful = [
        run
        for run in matching
        if run.get("status") == "completed" and run.get("conclusion") == "success"
    ]
    if successful:
        selected = max(successful, key=_sort_key)
        return {
            "action": "reuse",
            "reason": "completed_success",
            "run_id": selected["id"],
            "status": selected.get("status"),
            "conclusion": selected.get("conclusion"),
            "event": selected.get("event"),
        }

    active = [run for run in matching if run.get("status") in _ACTIVE_STATUSES]
    if active:
        selected = max(active, key=_sort_key)
        return {
            "action": "wait",
            "reason": "active_run",
            "run_id": selected["id"],
            "status": selected.get("status"),
            "conclusion": selected.get("conclusion"),
            "event": selected.get("event"),
        }

    return {
        "action": "dispatch",
        "reason": "no_reusable_run",
        "run_id": None,
        "status": None,
        "conclusion": None,
        "event": None,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Select exact-SHA post-merge CI evidence")
    subparsers = parser.add_subparsers(dest="command", required=True)
    select = subparsers.add_parser("select-run")
    select.add_argument("--workflow", required=True)
    select.add_argument("--merge-sha", required=True)
    select.add_argument("--default-branch", required=True)
    args = parser.parse_args(argv)

    payload = json.load(sys.stdin)
    runs = payload.get("workflow_runs", []) if isinstance(payload, dict) else []
    if not isinstance(runs, list):
        raise ValueError("workflow_runs must be a list")
    result = select_validation_run(
        runs,
        workflow_name=args.workflow,
        merge_sha=args.merge_sha,
        default_branch=args.default_branch,
    )
    print(json.dumps(result, separators=(",", ":"), sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
