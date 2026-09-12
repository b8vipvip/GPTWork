import fs from 'node:fs';

function read(path) { return fs.readFileSync(path, 'utf8'); }
function write(path, content) { fs.writeFileSync(path, content); }
function replaceOnce(path, from, to) {
  const source = read(path);
  const count = source.split(from).length - 1;
  if (count !== 1) throw new Error(`${path}: expected exactly one match, got ${count}`);
  write(path, source.replace(from, to));
}
function replaceCount(path, from, to, expected) {
  const source = read(path);
  const count = source.split(from).length - 1;
  if (count !== expected) throw new Error(`${path}: expected ${expected} matches, got ${count}`);
  write(path, source.split(from).join(to));
}

replaceOnce(
  'extension/background-update.js',
  "import { appendRuntimeLog } from './runtime-log.js';\n",
  "import { appendRuntimeLog } from './runtime-log.js';\nimport { ACCOUNT_REFRESH_ALARM, scheduleAccountRefresh } from './account-refresh-scheduler.js';\n",
);
replaceOnce(
  'extension/background-update.js',
  "export const ACCOUNT_REFRESH_ALARM = 'gptlock-account-refresh';\n",
  '',
);
replaceOnce(
  'extension/background-update.js',
  "const ACCOUNT_REFRESH_SOON_MS = 250;\n",
  '',
);
replaceOnce(
  'extension/background-update.js',
  `export async function scheduleAccountRefresh(chromeApi = globalThis.chrome) {\n  if (!chromeApi?.alarms?.create) throw new Error('Account refresh alarm is unavailable');\n  // background-update.js runs in the same MV3 service-worker frame as background.js.\n  // runtime.sendMessage() does not deliver back into the sender's own frame, so using\n  // it here can produce \"Receiving end does not exist\" even while the worker is alive.\n  // Re-arm the existing heartbeat alarm to fire promptly and keep its 1-minute cadence.\n  await chromeApi.alarms.create(ACCOUNT_REFRESH_ALARM, {\n    when: Date.now() + ACCOUNT_REFRESH_SOON_MS,\n    periodInMinutes: AUTO_UPDATE_ALARM_MINUTES,\n  });\n}\n\n`,
  '',
);

replaceOnce(
  'extension/background.js',
  "} from './tab-feature-runtime.js';\n",
  "} from './tab-feature-runtime.js';\nimport { ACCOUNT_REFRESH_ALARM } from './account-refresh-scheduler.js';\n",
);
replaceOnce(
  'extension/background.js',
  "const ACCOUNT_REFRESH_ALARM = 'gptlock-account-refresh';\n",
  '',
);

replaceOnce(
  'extension/tab-feature-runtime.js',
  "import { appendRuntimeLog } from './runtime-log.js';\n",
  "import { appendRuntimeLog } from './runtime-log.js';\nimport { scheduleAccountRefresh } from './account-refresh-scheduler.js';\n",
);
replaceOnce(
  'extension/tab-feature-runtime.js',
  "async function refreshBackgroundRuntime() {\n  try { await runtimeMessage({ type: 'GPTLOCK_ACCOUNT_REFRESH' }); } catch {}\n}\n\n",
  '',
);
replaceCount(
  'extension/tab-feature-runtime.js',
  '    await refreshBackgroundRuntime();',
  '    await scheduleAccountRefresh();',
  2,
);

replaceOnce(
  'extension/package.json',
  'node --check tab-feature-runtime.js && ',
  'node --check tab-feature-runtime.js && node --check account-refresh-scheduler.js && ',
);

const test = `import assert from 'node:assert/strict';\nimport fs from 'node:fs';\nimport test from 'node:test';\n\nconst scheduler = fs.readFileSync(new URL('../account-refresh-scheduler.js', import.meta.url), 'utf8');\nconst featureRuntime = fs.readFileSync(new URL('../tab-feature-runtime.js', import.meta.url), 'utf8');\nconst background = fs.readFileSync(new URL('../background.js', import.meta.url), 'utf8');\nconst backgroundUpdate = fs.readFileSync(new URL('../background-update.js', import.meta.url), 'utf8');\n\ntest('account refresh has one alarm scheduler and no service-worker self message', () => {\n  assert.match(scheduler, /export const ACCOUNT_REFRESH_ALARM = 'gptlock-account-refresh'/);\n  assert.match(scheduler, /export async function scheduleAccountRefresh/);\n  assert.match(featureRuntime, /import \\{ scheduleAccountRefresh \\} from '\\.\\/account-refresh-scheduler\\.js'/);\n  assert.doesNotMatch(featureRuntime, /runtimeMessage\\(\\{ type: 'GPTLOCK_ACCOUNT_REFRESH'/);\n  assert.doesNotMatch(featureRuntime, /refreshBackgroundRuntime/);\n  assert.match(background, /import \\{ ACCOUNT_REFRESH_ALARM \\} from '\\.\\/account-refresh-scheduler\\.js'/);\n  assert.doesNotMatch(background, /const ACCOUNT_REFRESH_ALARM = 'gptlock-account-refresh'/);\n  assert.match(backgroundUpdate, /import \\{ ACCOUNT_REFRESH_ALARM, scheduleAccountRefresh \\} from '\\.\\/account-refresh-scheduler\\.js'/);\n  assert.doesNotMatch(backgroundUpdate, /export async function scheduleAccountRefresh/);\n  const literalCount = [scheduler, featureRuntime, background, backgroundUpdate]\n    .reduce((count, source) => count + (source.match(/gptlock-account-refresh/g) || []).length, 0);\n  assert.equal(literalCount, 1);\n});\n`;
write('extension/tests/account-refresh-authority.test.mjs', test);

console.log('single-authority refresh refactor applied');
