import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const releaseWorkflow = new URL('../../.github/workflows/release.yml', import.meta.url);
const housekeepingWorkflow = new URL('../../.github/workflows/repository-housekeeping.yml', import.meta.url);
const governanceScript = new URL('../../.github/scripts/verify-pr-only-main.sh', import.meta.url);

test('release builds the private engine from the same private monorepo commit', async () => {
  const text = await readFile(releaseWorkflow, 'utf8');

  assert.doesNotMatch(text, /GPTLOCK_PRIVATE_CORE_REPOSITORY/);
  assert.doesNotMatch(text, /GPTLOCK_PRIVATE_CORE_TOKEN/);
  assert.doesNotMatch(text, /Stage private engine when configured/);
  assert.doesNotMatch(text, /gh release download/);
  assert.doesNotMatch(text, /compatibility package/i);

  assert.equal(
    (text.match(/cargo build --release --manifest-path private-engine\/Cargo\.toml/g) || []).length,
    2,
  );
  assert.equal((text.match(/GPTLOCK_REQUIRE_PRIVATE_ENGINE=1/g) || []).length, 2);
  assert.match(text, /Build private engine from this commit/);
  assert.match(text, /Enforce Linux release distribution boundary/);
  assert.match(text, /Enforce Windows release distribution boundary/);
  assert.match(text, /gptwork-engine/);
});

test('release jobs cache both native runtime crates', async () => {
  const text = await readFile(releaseWorkflow, 'utf8');
  const blocks = text.match(/workspaces: \|\n\s+native-core\n\s+private-engine/g) || [];
  assert.equal(blocks.length, 2);
});


test('release gates support GPTAuto-dispatched main CI and share one PR-only governance authority', async () => {
  const release = await readFile(releaseWorkflow, 'utf8');
  const housekeeping = await readFile(housekeepingWorkflow, 'utf8');
  const governance = await readFile(governanceScript, 'utf8');

  assert.doesNotMatch(release, /head_sha=\$GITHUB_SHA&event=push&per_page=1/);
  assert.match(release, /select\(\.event == "push" or \.event == "workflow_dispatch"\)/);
  assert.equal(
    (release.match(/bash \.github\/scripts\/verify-pr-only-main\.sh/g) || []).length,
    1,
  );
  assert.equal(
    (housekeeping.match(/bash \.github\/scripts\/verify-pr-only-main\.sh/g) || []).length,
    1,
  );
  assert.match(governance, /commits\/\$GITHUB_SHA\/pulls/);
  assert.match(governance, /Repository policy requires changes to enter main through a merged pull request/);
});
