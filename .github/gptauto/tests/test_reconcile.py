from __future__ import annotations

import unittest

from gptauto.reconcile import select_validation_run


WORKFLOW = "CI"
SHA = "a" * 40
BRANCH = "main"


def run(
    run_id: int,
    *,
    status: str = "completed",
    conclusion: str | None = "success",
    event: str = "push",
    workflow: str = WORKFLOW,
    sha: str = SHA,
    branch: str = BRANCH,
    created_at: str = "2026-11-15T10:00:00Z",
) -> dict:
    return {
        "id": run_id,
        "name": workflow,
        "head_sha": sha,
        "head_branch": branch,
        "event": event,
        "status": status,
        "conclusion": conclusion,
        "created_at": created_at,
    }


class SelectValidationRunTests(unittest.TestCase):
    def select(self, runs: list[dict]) -> dict:
        return select_validation_run(
            runs,
            workflow_name=WORKFLOW,
            merge_sha=SHA,
            default_branch=BRANCH,
        )

    def test_reuses_latest_successful_exact_sha_main_run(self) -> None:
        result = self.select([
            run(10, created_at="2026-11-15T09:00:00Z"),
            run(11, created_at="2026-11-15T10:00:00Z"),
        ])
        self.assertEqual(result["action"], "reuse")
        self.assertEqual(result["run_id"], 11)
        self.assertEqual(result["reason"], "completed_success")

    def test_waits_for_in_progress_push_run_instead_of_dispatching_duplicate(self) -> None:
        result = self.select([
            run(21, status="in_progress", conclusion=None),
        ])
        self.assertEqual(result["action"], "wait")
        self.assertEqual(result["run_id"], 21)
        self.assertEqual(result["event"], "push")

    def test_waits_for_newest_active_run(self) -> None:
        result = self.select([
            run(31, status="queued", conclusion=None, created_at="2026-11-15T09:00:00Z"),
            run(32, status="in_progress", conclusion=None, created_at="2026-11-15T10:00:00Z"),
        ])
        self.assertEqual(result["action"], "wait")
        self.assertEqual(result["run_id"], 32)

    def test_recognizes_all_github_active_statuses(self) -> None:
        for status in ("queued", "in_progress", "waiting", "requested", "pending"):
            with self.subTest(status=status):
                result = self.select([run(40, status=status, conclusion=None)])
                self.assertEqual(result["action"], "wait")
                self.assertEqual(result["run_id"], 40)

    def test_dispatches_after_failure_or_cancellation(self) -> None:
        for conclusion in ("failure", "cancelled", "timed_out", "startup_failure", "skipped"):
            with self.subTest(conclusion=conclusion):
                result = self.select([run(50, conclusion=conclusion)])
                self.assertEqual(result["action"], "dispatch")
                self.assertIsNone(result["run_id"])

    def test_does_not_reuse_pull_request_ci(self) -> None:
        result = self.select([run(60, event="pull_request")])
        self.assertEqual(result["action"], "dispatch")

    def test_does_not_reuse_other_sha_or_branch(self) -> None:
        result = self.select([
            run(70, sha="b" * 40),
            run(71, branch="feature/branch"),
        ])
        self.assertEqual(result["action"], "dispatch")

    def test_does_not_reuse_another_workflow_or_event(self) -> None:
        result = self.select([
            run(80, workflow="Release"),
            run(81, event="schedule"),
        ])
        self.assertEqual(result["action"], "dispatch")

    def test_successful_evidence_takes_precedence_over_an_active_retry(self) -> None:
        result = self.select([
            run(90, status="completed", conclusion="success"),
            run(91, status="in_progress", conclusion=None),
        ])
        self.assertEqual(result["action"], "reuse")
        self.assertEqual(result["run_id"], 90)


if __name__ == "__main__":
    unittest.main()
