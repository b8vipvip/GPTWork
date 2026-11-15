from __future__ import annotations

import argparse
import json
import re
import sys
from typing import Any

_SHA_RE = re.compile(r"^[0-9a-f]{40}$")


def is_merge_in_progress_error(message: str) -> bool:
    return "Merge already in progress" in str(message or "")


def confirmed_merge_sha(pr: dict[str, Any], expected_head: str) -> str:
    """Return merge SHA only after GitHub confirms this exact PR head was merged."""
    if not isinstance(pr, dict) or not pr.get("merged_at"):
        return ""
    expected = str(expected_head or "").strip().lower()
    actual_head = str((pr.get("head") or {}).get("sha") or "").strip().lower()
    merge_sha = str(pr.get("merge_commit_sha") or "").strip().lower()
    if not _SHA_RE.fullmatch(expected):
        return ""
    if actual_head != expected or not _SHA_RE.fullmatch(merge_sha):
        return ""
    return merge_sha


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Validate idempotent GPTAuto merge evidence")
    subparsers = parser.add_subparsers(dest="command", required=True)
    resolve = subparsers.add_parser("resolve-merged-sha")
    resolve.add_argument("--expected-head", required=True)
    args = parser.parse_args(argv)

    payload = json.load(sys.stdin)
    if not isinstance(payload, dict):
        raise ValueError("pull request response must be a JSON object")
    print(confirmed_merge_sha(payload, args.expected_head))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
