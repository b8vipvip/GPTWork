import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const ciWorkflow = new URL('../../.github/workflows/ci.yml', import.meta.url);
const releaseWorkflow = new URL('../../.github/workflows/release.yml', import.meta.url);
const housekeepingWorkflow = new URL('../../.github/workflows/repository-housekeeping.yml', import.meta.url);
const governanceScript = new URL('../../.github/scripts/verify-pr-only-main.sh', import.meta.url);

test('release reuses exact-SHA CI artifacts instead of rebuilding native runtimes', async () => {
  const [ci, release] = await Promise.all([
    readFile(ciWorkflow, 'utf8'),
    readFile(releaseWorkflow, 'utf8'),
  ]);

  assert.doesNotMatch(release, /GPTLOCK_PRIVATE_CORE_REPOSITORY/);
  assert.doesNotMatch(release, /GPTLOCK_PRIVATE_CORE_TOKEN/);
  assert.doesNotMatch(release, /Stage private engine when configured/);
  assert.doesNotMatch(release, /gh release download/);
  assert.doesNotMatch(release, /compatibility package/i);
  assert.doesNotMatch(release, /cargo build --(?:locked )?--release --manifest-path (?:native-core|private-engine)\/Cargo\.toml/);
  assert.doesNotMatch(release, /dtolnay\/rust-toolchain|Swatinem\/rust-cache/);

  assert.match(release, /ci_run_id=/);
  assert.match(release, /gptwork-linux-release/);
  assert.match(release, /gptwork-windows-setup/);
  assert.match(release, /gptwork\.ci-release-provenance\/v1/);
  assert.match(release, /\.sha == \$sha/);
  assert.match(release, /\.version == \$version/);
  assert.match(release, /Assemble and verify release surface without rebuilding/);

  assert.match(ci, /cargo build --release --manifest-path private-engine\/Cargo\.toml/);
  assert.match(ci, /cargo build --locked --release --manifest-path native-core\/Cargo\.toml/);
  assert.match(ci, /schema='gptwork\.ci-release-provenance\/v1'/);
  assert.match(ci, /name: gptwork-linux-release/);
  assert.match(ci, /name: gptwork-windows-setup/);
  assert.match(ci, /Enforce extension distribution boundary/);
  assert.match(ci, /Install and verify Setup registration/);
});

test('CI release-producing jobs cache both native runtime crates', async () => {
  const ci = await readFile(ciWorkflow, 'utf8');
  const blocks = ci.match(/workspaces: \|\n\s+native-core\n\s+private-engine/g) || [];
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
