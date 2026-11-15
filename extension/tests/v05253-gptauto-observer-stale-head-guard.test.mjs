import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('GPTAuto never cancels the live PR head from a stale synchronize event', async () => {
  const workflow = await readFile(
    new URL('../../.github/workflows/gptauto-observer.yml', import.meta.url),
    'utf8',
  );
  const start = workflow.indexOf('      - name: Cancel superseded pull-request workflow runs');
  const end = workflow.indexOf('      - uses: actions/checkout@v4', start);
  assert.ok(start >= 0 && end > start, 'observer cancellation step must exist');
  const step = workflow.slice(start, end);

  assert.match(step, /EVENT_HEAD: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/);
  assert.match(step, /current_head="\$\(gh api "repos\/\$REPOSITORY\/pulls\/\$PR_NUMBER" --jq '\.head\.sha'\)"/);
  assert.match(step, /if \[\[ "\$current_head" != "\$EVENT_HEAD" \]\]/);
  assert.match(step, /Skipping stale synchronize event/);
  assert.match(step, /live_head="\$\(gh api "repos\/\$REPOSITORY\/pulls\/\$PR_NUMBER" --jq '\.head\.sha'\)"/);
  assert.match(step, /if \[\[ "\$live_head" != "\$current_head" \]\]/);
  assert.match(step, /select\(\.head_sha != \$head\)/);
});
