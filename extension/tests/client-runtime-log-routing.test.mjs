import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const runtimeLog = new URL('../runtime-log.js', import.meta.url);
const server = new URL('../../license-server/server.mjs', import.meta.url);
const adminHtml = new URL('../../license-server/public/admin.html', import.meta.url);
const adminClientLogsHtml = new URL('../../license-server/public/admin-client-logs.html', import.meta.url);
const adminJs = new URL('../../license-server/public/client-runtime-admin.js', import.meta.url);

test('client runtime logs are uploaded in authenticated batches', async () => {
  const source = await readFile(runtimeLog, 'utf8');
  assert.match(source, /RUNTIME_LOG_UPLOAD_BATCH_SIZE\s*=\s*50/);
  assert.match(source, /\/api\/v1\/account\/runtime-logs/);
  assert.match(source, /authorization:\s*`Bearer \$\{token\}`/);
  assert.match(source, /periodInMinutes:\s*1/);
  assert.match(source, /acknowledgedIds/);
  assert.match(source, /RUNTIME_LOG_SYNC_KEY\s*=\s*'gptworkRuntimeLogSyncEnabled'/);
  assert.match(source, /skipped:\s*'sync_disabled'/);
  assert.match(source, /LOG_WRITE_COALESCE_MS\s*=\s*250/);
  assert.match(source, /pendingLogEntries\.length\s*>=\s*LOG_WRITE_MAX_BATCH/);
});

test('server routes client runtime logs and exposes a dedicated admin page', async () => {
  const [serverSource, overviewHtml, clientLogsHtml, adminSource] = await Promise.all([
    readFile(server, 'utf8'),
    readFile(adminHtml, 'utf8'),
    readFile(adminClientLogsHtml, 'utf8'),
    readFile(adminJs, 'utf8'),
  ]);
  assert.match(serverSource, /createClientRuntimeLogManager/);
  assert.match(serverSource, /clientRuntimeLogs\.handleApi/);
  assert.match(serverSource, /clientRuntimeLogs\.handleAdmin/);
  assert.match(overviewHtml, /href="\/admin\/client-logs"[^>]*>客户端运行日志/);
  assert.doesNotMatch(overviewHtml, /id="clientLogs"/);
  assert.match(clientLogsHtml, /data-admin-page="client-logs"/);
  assert.match(clientLogsHtml, /id="clientLogs"/);
  assert.match(clientLogsHtml, /src="\/client-runtime-admin\.js"/);
  assert.match(clientLogsHtml, /id="clientLogSyncEnabled"/);
  assert.match(clientLogsHtml, /同步日志/);
  assert.match(adminSource, /\/admin\/api\/client-runtime-logs/);
  assert.match(adminSource, /清空当前筛选/);
  assert.match(adminSource, /runtimeLogSyncEnabled/);
  assert.match(adminSource, /\/admin\/api\/client-feature-settings/);
});
