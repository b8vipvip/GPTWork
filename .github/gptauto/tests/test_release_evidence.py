from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock

from gptauto.github import GitHubClient, GitHubError
from gptauto.model import Criterion, Gate, GateStep, Task
from gptauto.observer import _release_event_published_for_merge, capture
from gptauto.orchestrator import Orchestrator


MERGE_SHA = "a" * 40
OTHER_SHA = "b" * 40
TAG = "v0.5.253"


class ReleaseEventEvidenceTests(unittest.TestCase):
    def test_release_event_requires_published_tag_targeting_exact_merge_sha(self) -> None:
        self.assertTrue(
            _release_event_published_for_merge(
                "release", "published", TAG, MERGE_SHA, MERGE_SHA
            )
        )

    def test_release_event_rejects_tag_targeting_another_commit(self) -> None:
        self.assertFalse(
            _release_event_published_for_merge(
                "release", "published", TAG, OTHER_SHA, MERGE_SHA
            )
        )

    def test_release_event_rejects_missing_tag_or_sha_evidence(self) -> None:
        cases = [
            ("release", "published", "", MERGE_SHA, MERGE_SHA),
            ("release", "published", TAG, "", MERGE_SHA),
            ("release", "published", TAG, MERGE_SHA, ""),
            ("release", "published", TAG, "not-a-sha", MERGE_SHA),
        ]
        for case in cases:
            with self.subTest(case=case):
                self.assertFalse(_release_event_published_for_merge(*case))

    def test_release_event_rejects_non_release_or_unpublished_events(self) -> None:
        self.assertFalse(
            _release_event_published_for_merge(
                "push", "published", TAG, MERGE_SHA, MERGE_SHA
            )
        )
        self.assertFalse(
            _release_event_published_for_merge(
                "release", "created", TAG, MERGE_SHA, MERGE_SHA
            )
        )


class ReleaseCaptureFailClosedTests(unittest.TestCase):
    def capture_state(self, *, resolved_tag_sha: str):
        with tempfile.TemporaryDirectory() as root:
            result = capture(
                "example/GPTWork",
                "release",
                default_branch="main",
                branch="main",
                head_sha=MERGE_SHA,
                pr_merged="true",
                merge_sha=MERGE_SHA,
                release_tag=TAG,
                release_state="published",
                release_tag_target_sha=resolved_tag_sha,
                release_required_override="true",
                main_ci_conclusion="success",
                main_ci_run_id="123",
                log_root=root,
            )
            state_path = Path(result["paths"]["state"])
            return json.loads(state_path.read_text(encoding="utf-8"))

    def test_default_branch_sha_cannot_substitute_for_unresolved_release_tag(self) -> None:
        state = self.capture_state(resolved_tag_sha="")
        release_gate = next(gate for gate in state["plan"] if gate["gate"] == Gate.RELEASE.value)
        self.assertEqual(release_gate["status"], "waiting")
        self.assertFalse(state["metadata"]["release_published"])

    def test_release_gate_passes_only_with_explicit_exact_tag_target(self) -> None:
        state = self.capture_state(resolved_tag_sha=MERGE_SHA)
        release_gate = next(gate for gate in state["plan"] if gate["gate"] == Gate.RELEASE.value)
        self.assertEqual(release_gate["status"], "passed")
        self.assertEqual(state["metadata"]["release_tag_target_sha"], MERGE_SHA)

    def test_release_gate_rejects_tag_targeting_different_commit(self) -> None:
        state = self.capture_state(resolved_tag_sha=OTHER_SHA)
        release_gate = next(gate for gate in state["plan"] if gate["gate"] == Gate.RELEASE.value)
        self.assertEqual(release_gate["status"], "waiting")
        self.assertFalse(state["metadata"]["release_published"])


class GitTagResolutionTests(unittest.TestCase):
    def test_resolves_lightweight_tag(self) -> None:
        client = GitHubClient("example/GPTWork")
        client._api = Mock(return_value={"object": {"type": "commit", "sha": MERGE_SHA}})

        self.assertEqual(client.tag_commit_sha(TAG), MERGE_SHA)
        client._api.assert_called_once_with(
            "repos/example/GPTWork/git/ref/tags/v0.5.253"
        )

    def test_dereferences_annotated_tag_to_commit(self) -> None:
        client = GitHubClient("example/GPTWork")
        client._api = Mock(side_effect=[
            {"object": {"type": "tag", "sha": OTHER_SHA}},
            {"object": {"type": "commit", "sha": MERGE_SHA}},
        ])

        self.assertEqual(client.tag_commit_sha(TAG), MERGE_SHA)
        self.assertEqual(client._api.call_count, 2)
        client._api.assert_any_call(
            f"repos/example/GPTWork/git/tags/{OTHER_SHA}"
        )

    def test_unresolvable_or_non_commit_tag_fails_closed(self) -> None:
        client = GitHubClient("example/GPTWork")
        client._api = Mock(return_value={"object": {"type": "tree", "sha": OTHER_SHA}})
        self.assertEqual(client.tag_commit_sha(TAG), "")

        client._api = Mock(side_effect=GitHubError("not found"))
        self.assertEqual(client.tag_commit_sha(TAG), "")


class FakeGitHub:
    def __init__(self, release: dict | None, tag_sha: str):
        self.release = release
        self.resolved_sha = tag_sha

    def release_by_tag(self, tag: str):
        return self.release

    def tag_commit_sha(self, tag: str):
        return self.resolved_sha


class OrchestratorReleaseGateTests(unittest.TestCase):
    def decide(self, *, release: dict | None, tag_sha: str, merge_sha: str = MERGE_SHA):
        task = Task(
            "GA-release-proof",
            "publish release",
            "example/GPTWork",
            [Criterion("release is verified")],
            plan=[GateStep(Gate.RELEASE)],
            metadata={"release_tag": TAG, "merge_sha": merge_sha},
        )
        return Orchestrator(FakeGitHub(release, tag_sha)).decide_gate(task, task.plan[0])

    def test_release_gate_passes_only_when_published_tag_targets_merge_sha(self) -> None:
        decision = self.decide(
            release={"draft": False, "published_at": "2026-11-15T10:00:00Z"},
            tag_sha=MERGE_SHA,
        )
        self.assertEqual(decision.action, "passed")

    def test_release_gate_waits_when_tag_points_to_another_commit(self) -> None:
        decision = self.decide(
            release={"draft": False, "published_at": "2026-11-15T10:00:00Z"},
            tag_sha=OTHER_SHA,
        )
        self.assertEqual(decision.action, "wait")
        self.assertIn("expected merge SHA", decision.reason)

    def test_release_gate_waits_for_published_release_and_resolvable_tag(self) -> None:
        draft = self.decide(release={"draft": True}, tag_sha=MERGE_SHA)
        unpublished = self.decide(release={"draft": False, "published_at": None}, tag_sha=MERGE_SHA)
        unresolved = self.decide(
            release={"draft": False, "published_at": "2026-11-15T10:00:00Z"},
            tag_sha="",
        )
        self.assertEqual(draft.action, "wait")
        self.assertEqual(unpublished.action, "wait")
        self.assertEqual(unresolved.action, "wait")

    def test_release_gate_requires_merge_sha(self) -> None:
        decision = self.decide(
            release={"draft": False, "published_at": "2026-11-15T10:00:00Z"},
            tag_sha=MERGE_SHA,
            merge_sha="",
        )
        self.assertEqual(decision.action, "blocked")


if __name__ == "__main__":
    unittest.main()
