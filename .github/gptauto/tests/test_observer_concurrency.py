from __future__ import annotations

import unittest
from pathlib import Path


class ObserverConcurrencyTests(unittest.TestCase):
    def test_push_and_workflow_run_for_same_commit_share_concurrency_group(self) -> None:
        workflow = (
            Path(__file__).resolve().parents[2]
            / "workflows"
            / "gptauto-observer.yml"
        ).read_text(encoding="utf-8")
        expected = (
            "group: gptauto-observer-${{ github.event.pull_request.number "
            "|| github.event.workflow_run.pull_requests[0].number "
            "|| inputs.pr_number || github.event.workflow_run.head_sha "
            "|| inputs.merge_sha || inputs.head_sha || github.sha || github.ref }}"
        )
        self.assertIn(expected, workflow)

    def test_pr_number_remains_the_primary_observer_concurrency_key(self) -> None:
        workflow = (
            Path(__file__).resolve().parents[2]
            / "workflows"
            / "gptauto-observer.yml"
        ).read_text(encoding="utf-8")
        group = next(line for line in workflow.splitlines() if line.strip().startswith("group:"))
        self.assertLess(group.index("github.event.pull_request.number"), group.index("github.sha"))


if __name__ == "__main__":
    unittest.main()
