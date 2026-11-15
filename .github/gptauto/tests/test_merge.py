from __future__ import annotations

import unittest

from gptauto.merge import confirmed_merge_sha, is_merge_in_progress_error


HEAD = "a" * 40
MERGE = "b" * 40


def pr(*, merged_at: str | None = "2026-11-15T12:00:00Z", head: str = HEAD, merge_sha: str = MERGE) -> dict:
    return {
        "merged_at": merged_at,
        "head": {"sha": head},
        "merge_commit_sha": merge_sha,
    }


class MergeConflictClassificationTests(unittest.TestCase):
    def test_recognizes_github_merge_already_in_progress(self) -> None:
        self.assertTrue(is_merge_in_progress_error("gh: Merge already in progress (HTTP 405)"))

    def test_does_not_treat_unrelated_http_405_as_a_merge_race(self) -> None:
        self.assertFalse(is_merge_in_progress_error("HTTP 405 Method Not Allowed"))


class ConfirmedMergeEvidenceTests(unittest.TestCase):
    def test_accepts_only_merged_pr_with_exact_expected_head_and_full_merge_sha(self) -> None:
        self.assertEqual(confirmed_merge_sha(pr(), HEAD), MERGE)

    def test_rejects_pr_that_is_not_yet_merged(self) -> None:
        self.assertEqual(confirmed_merge_sha(pr(merged_at=None), HEAD), "")

    def test_rejects_pr_whose_head_moved(self) -> None:
        self.assertEqual(confirmed_merge_sha(pr(head="c" * 40), HEAD), "")

    def test_rejects_missing_or_malformed_merge_sha(self) -> None:
        self.assertEqual(confirmed_merge_sha(pr(merge_sha=""), HEAD), "")
        self.assertEqual(confirmed_merge_sha(pr(merge_sha="short-sha"), HEAD), "")

    def test_rejects_malformed_expected_head(self) -> None:
        self.assertEqual(confirmed_merge_sha(pr(), "short-sha"), "")


if __name__ == "__main__":
    unittest.main()
