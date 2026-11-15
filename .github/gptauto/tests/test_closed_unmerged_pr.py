from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from gptauto.model import State, Task
from gptauto.observer import capture


HEAD = "a" * 40
MERGE = "b" * 40
REPO = "example/GPTWork"
PR = "530"


def observe(root: str, event: str, *, pr_state: str = "", pr_merged: str = "false",
            workflow_conclusion: str = "", merge_sha: str = "") -> dict:
    return capture(
        REPO,
        event,
        default_branch="main",
        branch="feature/diagnostics",
        head_sha=HEAD,
        current_pr_head_sha=HEAD,
        pr_number=PR,
        pr_title="fix: standalone diagnostics",
        pr_state=pr_state,
        pr_merged=pr_merged,
        merge_sha=merge_sha,
        workflow_name="Private Core Boundary",
        workflow_conclusion=workflow_conclusion,
        log_root=root,
    )


def read_task(result: dict) -> Task:
    return Task.from_dict(json.loads(Path(result["paths"]["state"]).read_text(encoding="utf-8")))


class ClosedUnmergedPullRequestTests(unittest.TestCase):
    def test_closed_unmerged_pr_becomes_user_action_required_not_repair_required(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            result = observe(root, "pull_request", pr_state="closed")

            task = read_task(result)
            self.assertEqual(result["phase"], "USER_ACTION_REQUIRED")
            self.assertEqual(result["completion_lease"], "BLOCKED")
            self.assertTrue(result["allow_foreground_exit"])
            self.assertEqual(task.state, State.BLOCKED)
            self.assertEqual(task.metadata["pr_state"], "closed")
            self.assertFalse(task.metadata["pr_merged"])
            self.assertEqual(task.metadata["blocked_reason"], "pull_request_closed_without_merge")
            self.assertFalse(task.metadata["continuation_required"])

    def test_stale_failed_workflow_after_close_cannot_reopen_repair_lease(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            observe(root, "pull_request", pr_state="closed")
            result = observe(root, "workflow_run", workflow_conclusion="failure")

            task = read_task(result)
            self.assertEqual(result["phase"], "USER_ACTION_REQUIRED")
            self.assertEqual(result["completion_lease"], "BLOCKED")
            self.assertEqual(task.state, State.BLOCKED)
            self.assertEqual(task.metadata["pr_state"], "closed")
            self.assertFalse(task.metadata["pr_merged"])
            self.assertEqual(task.metadata["blocked_reason"], "pull_request_closed_without_merge")
            self.assertFalse(task.metadata["continuation_required"])

    def test_reopened_pr_clears_closed_reason_and_returns_to_active_gate(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            observe(root, "pull_request", pr_state="closed")
            result = observe(root, "pull_request", pr_state="open")

            task = read_task(result)
            self.assertNotEqual(result["phase"], "USER_ACTION_REQUIRED")
            self.assertEqual(result["completion_lease"], "ACTIVE")
            self.assertEqual(task.state, State.EXECUTE)
            self.assertEqual(task.metadata["pr_state"], "open")
            self.assertEqual(task.metadata["blocked_reason"], "")

    def test_closed_merged_pr_is_not_misclassified_as_abandoned(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            result = observe(root, "pull_request", pr_state="closed",
                             pr_merged="true", merge_sha=MERGE)

            task = read_task(result)
            self.assertNotEqual(result["phase"], "USER_ACTION_REQUIRED")
            self.assertNotEqual(result["completion_lease"], "BLOCKED")
            self.assertEqual(task.metadata["pr_state"], "closed")
            self.assertTrue(task.metadata["pr_merged"])
            self.assertEqual(task.metadata["merge_sha"], MERGE)


if __name__ == "__main__":
    unittest.main()
