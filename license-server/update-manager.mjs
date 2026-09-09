import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const ACTIVE = new Set(['queued', 'running', 'restarting', 'rolling_back']);
const UPDATE_PATH_UNIT = 'gptlock-license-update.path';
const UPDATE_PATH_FILES = [
  '/etc/systemd/system/gptlock-license-update.path',
  '/usr/lib/systemd/system/gptlock-license-update.path',
];

function readJson(path, fallback = null) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}

function atomicJson(path, value) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}

function tail(path, lines = 80) {
  try { return readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).slice(-lines); } catch { return []; }
}

function gitCommit(repoDir) {
  try {
    return execFileSync('git', ['-C', repoDir, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 2000 }).trim();
  } catch {
    return '';
  }
}

function commandOk(command, args) {
  try {
    execFileSync(command, args, { stdio: 'ignore', timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\"'\"'")}'`;
}

export function createUpdateManager({ serverRoot, dbPath, env = process.env }) {
  // dbPath may come from a legacy relative GPTLOCK_LICENSE_DB. Resolve it in the
  // running server process before deriving updater files so the web process and
  // root updater always point at the same persistent data directory.
  const absoluteDbPath = resolve(dbPath);
  const dataDir = resolve(env.GPTLOCK_UPDATE_DATA_DIR || dirname(absoluteDbPath));
  const repoDir = resolve(env.GPTLOCK_UPDATE_REPO_DIR || join(serverRoot, '..'));
  const ref = env.GPTLOCK_UPDATE_REF || 'main';
  const requestFile = join(dataDir, 'update-request.json');
  const statusFile = join(dataDir, 'update-status.json');
  const logFile = join(dataDir, 'update.log');
  const deploymentFile = join(dataDir, 'deployment.json');
  const packagePath = join(serverRoot, 'package.json');
  const productManifestPath = join(serverRoot, '..', 'extension', 'manifest.json');
  const bootstrapCommand = `cd ${shellQuote(serverRoot)} && sudo bash scripts/install-updater-systemd.sh`;

  function packageVersion() {
    return String(readJson(packagePath, {})?.version || 'unknown');
  }

  function productVersion() {
    return String(readJson(productManifestPath, {})?.version || readJson(deploymentFile, {})?.version || packageVersion());
  }

  function updaterState() {
    const installedPath = UPDATE_PATH_FILES.find((path) => existsSync(path)) || null;
    const allowWithoutSystemd = env.GPTLOCK_UPDATE_ALLOW_WITHOUT_SYSTEMD === '1';
    const active = installedPath ? commandOk('systemctl', ['is-active', '--quiet', UPDATE_PATH_UNIT]) : false;
    const enabled = installedPath ? commandOk('systemctl', ['is-enabled', '--quiet', UPDATE_PATH_UNIT]) : false;
    return {
      installed: Boolean(installedPath),
      active,
      enabled,
      ready: allowWithoutSystemd || (Boolean(installedPath) && active),
      unit: UPDATE_PATH_UNIT,
      testBypass: allowWithoutSystemd,
    };
  }

  function info() {
    const status = readJson(statusFile, { status: 'idle', stage: 'idle', percent: 0, message: '尚未执行版本更新' });
    const deployment = readJson(deploymentFile, {});
    const commit = gitCommit(repoDir) || deployment.commit || '';
    const updater = updaterState();
    return {
      ok: true,
      updaterReady: updater.ready,
      updater,
      bootstrapCommand,
      productVersion: productVersion(),
      serverVersion: packageVersion(),
      currentCommit: commit || null,
      targetRef: ref,
      status,
      log: tail(logFile),
    };
  }

  function request() {
    const updater = updaterState();
    if (!updater.ready && env.GPTLOCK_UPDATE_ALLOW_WITHOUT_SYSTEMD !== '1') {
      const error = new Error(updater.installed
        ? '系统更新器已安装但监听单元未运行，请在服务器执行安装/修复命令后重试'
        : '系统更新器尚未安装，请先在服务器执行一次安装命令');
      error.status = 503;
      throw error;
    }
    const current = readJson(statusFile, null);
    if (current && ACTIVE.has(current.status)) {
      const error = new Error('已有版本更新任务正在执行');
      error.status = 409;
      throw error;
    }
    const requestId = `upd-${Date.now()}-${randomBytes(4).toString('hex')}`;
    const now = new Date().toISOString();
    atomicJson(statusFile, {
      status: 'queued', stage: 'queued', percent: 1,
      message: '更新任务已提交，等待系统更新器接管', requestId, ref,
      startedAt: now, updatedAt: now,
    });
    atomicJson(requestFile, { requestId, ref, requestedAt: now });
    return { ok: true, requestId, status: readJson(statusFile) };
  }

  return { info, request };
}
