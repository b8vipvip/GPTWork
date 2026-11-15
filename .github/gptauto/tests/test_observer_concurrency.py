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
            "group: gptauto-observer-${{ (github.event.pull_request.merged "
            "&& github.event.pull_request.merge_commit_sha) || "
            "(github.event.workflow_run.head_branch == github.event.repository.default_branch "
            "&& github.event.workflow_run.head_sha) || github.event.pull_request.number "
            "|| github.event.workflow_run.pull_requests[0].number || inputs.merge_sha "
            "|| inputs.pr_number || inputs.head_sha || github.event.workflow_run.head_sha "
            "|| github.sha || github.ref }}"
        )
        self.assertIn(expected, workflow)

    def test_merged_pr_and_default_branch_workflow_run_use_the_merge_sha(self) -> None:
        workflow = (
            Path(__file__).resolve().parents[2]
            / "workflows"
            / "gptauto-observer.yml"
        ).read_text(encoding="utf-8")
        group = next(line for line in workflow.splitlines() if line.strip().startswith("group:"))
        self.assertLess(group.index("github.event.pull_request.merge_commit_sha"), group.index("github.event.pull_request.number"))
        self.assertLess(group.index("github.event.workflow_run.head_branch"), group.index("github.event.workflow_run.pull_requests[0].number"))

    def test_unmerged_pr_events_remain_serialized_by_pr_number(self) -> None:
        workflow = (
            Path(__file__).resolve().parents[2]
            / "workflows"
            / "gptauto-observer.yml"
        ).read_text(encoding="utf-8")
        group = next(line for line in workflow.splitlines() if line.strip().startswith("group:"))
        self.assertLess(group.index("github.event.pull_request.number"), group.index("github.sha"))


if __name__ == "__main__":
    unittest.main()
