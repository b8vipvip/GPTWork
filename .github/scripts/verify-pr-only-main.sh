#!/usr/bin/env bash
set -Eeuo pipefail

: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
: "${GITHUB_SHA:?GITHUB_SHA is required}"
: "${GH_TOKEN:?GH_TOKEN is required}"

for attempt in $(seq 1 6); do
  count="$(gh api \
    -H 'Accept: application/vnd.github+json' \
    "/repos/$GITHUB_REPOSITORY/commits/$GITHUB_SHA/pulls" \
    --jq '[.[] | select(.merged_at != null and .base.ref == "main")] | length')"
  if [[ "$count" -ge 1 ]]; then
    echo "PR-only governance passed for $GITHUB_SHA."
    exit 0
  fi
  sleep 5
done

# Keep compatibility with merge commits while GitHub's commit->PR association is still converging.
message="$(gh api "/repos/$GITHUB_REPOSITORY/commits/$GITHUB_SHA" --jq '.commit.message // ""')"
if [[ "$message" =~ ^Merge\ pull\ request\ \#([0-9]+)\ from\  ]]; then
  pr_number="${BASH_REMATCH[1]}"
  pr_json="$(gh api "/repos/$GITHUB_REPOSITORY/pulls/$pr_number")"
  merged_at="$(jq -r '.merged_at // ""' <<<"$pr_json")"
  base_ref="$(jq -r '.base.ref // ""' <<<"$pr_json")"
  merge_sha="$(jq -r '.merge_commit_sha // ""' <<<"$pr_json")"
  if [[ -n "$merged_at" && "$base_ref" == "main" && "$merge_sha" == "$GITHUB_SHA" ]]; then
    echo "PR-only governance passed via merge-commit fallback for $GITHUB_SHA."
    exit 0
  fi
fi

echo "::error::Direct push to main detected at $GITHUB_SHA. Repository policy requires changes to enter main through a merged pull request."
exit 1
