#!/usr/bin/env bash
set -Eeuo pipefail
# Git checkout files must remain readable by the low-privilege runtime user after
# root deploys a new commit. Sensitive updater artifacts are chmod 0600 below.
umask 022

SERVER_DIR="${GPTLOCK_UPDATE_SERVER_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
REPO_DIR="${GPTLOCK_UPDATE_REPO_DIR:-$(git -C "$SERVER_DIR" rev-parse --show-toplevel 2>/dev/null || true)}"
REF="${GPTLOCK_UPDATE_REF:-main}"
SERVICE="${GPTLOCK_UPDATE_SERVICE:-gptlock-license.service}"
ENV_FILE="${GPTLOCK_UPDATE_ENV_FILE:-$SERVER_DIR/.env}"
NODE_BIN="${GPTLOCK_UPDATE_NODE_BIN:-/usr/local/bin/node22}"
RUNTIME_USER="${GPTLOCK_UPDATE_RUNTIME_USER:-gptlock}"
RUNTIME_GROUP="${GPTLOCK_UPDATE_RUNTIME_GROUP:-$RUNTIME_USER}"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi
NODE_BIN="${GPTLOCK_UPDATE_NODE_BIN:-$NODE_BIN}"

resolve_from() {
  local base="$1" value="$2"
  if [[ "$value" == /* ]]; then readlink -m -- "$value"; else readlink -m -- "$base/$value"; fi
}

# Resolve legacy relative paths against the cwd of the currently running service.
# That is the exact base Node used before the updater started. Every path is made
# absolute before any backup/deploy action so a restart cannot silently select a
# different empty SQLite database.
SERVICE_CWD=""
MAIN_PID="$(systemctl show -p MainPID --value "$SERVICE" 2>/dev/null || true)"
if [[ "$MAIN_PID" =~ ^[1-9][0-9]*$ && -e "/proc/$MAIN_PID/cwd" ]]; then
  SERVICE_CWD="$(readlink -f "/proc/$MAIN_PID/cwd" 2>/dev/null || true)"
fi
if [[ -z "$SERVICE_CWD" ]]; then
  SERVICE_CWD="$(systemctl show -p WorkingDirectory --value "$SERVICE" 2>/dev/null || true)"
fi
[[ "$SERVICE_CWD" == /* ]] || SERVICE_CWD="$SERVER_DIR"

DB_CONFIG="${GPTLOCK_UPDATE_DB_PATH:-${GPTLOCK_LICENSE_DB:-$SERVER_DIR/data/gptlock-license.sqlite3}}"
DB_PATH="$(resolve_from "$SERVICE_CWD" "$DB_CONFIG")"
DATA_CONFIG="${GPTLOCK_UPDATE_DATA_DIR:-$(dirname "$DB_PATH")}"
DATA_DIR="$(resolve_from "$SERVICE_CWD" "$DATA_CONFIG")"
RELEASE_CONFIG="${GPTLOCK_RELEASE_MIRROR_DIR:-$DATA_DIR/releases}"
RELEASE_MIRROR_DIR="$(resolve_from "$SERVICE_CWD" "$RELEASE_CONFIG")"

FETCH_HELPER="${GPTLOCK_UPDATE_FETCH_HELPER:-$SERVER_DIR/scripts/github-fetch.sh}"
REQUEST_FILE="$DATA_DIR/update-request.json"
STATUS_FILE="$DATA_DIR/update-status.json"
LOG_FILE="$DATA_DIR/update.log"
DEPLOYMENT_FILE="$DATA_DIR/deployment.json"
LOCK_FILE="$DATA_DIR/update.lock"
BACKUP_DIR="$DATA_DIR/update-backups"
PERSISTENCE_DROPIN_DIR="/etc/systemd/system/${SERVICE}.d"
PERSISTENCE_DROPIN="$PERSISTENCE_DROPIN_DIR/20-gptwork-persistent-data.conf"
mkdir -p "$DATA_DIR" "$BACKUP_DIR" "$RELEASE_MIRROR_DIR"
chown "$RUNTIME_USER:$RUNTIME_GROUP" "$RELEASE_MIRROR_DIR" 2>/dev/null || true
chmod 750 "$RELEASE_MIRROR_DIR" 2>/dev/null || true
touch "$LOG_FILE"
chmod 600 "$LOG_FILE" || true
chown "$RUNTIME_USER:$RUNTIME_GROUP" "$LOG_FILE" 2>/dev/null || true

REQUEST_ID="$($NODE_BIN -e "const fs=require('fs');try{const j=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));process.stdout.write(String(j.requestId||''))}catch{}" "$REQUEST_FILE" 2>/dev/null || true)"
[[ "$REQUEST_ID" =~ ^[A-Za-z0-9._:-]{8,160}$ ]] || REQUEST_ID="manual-$(date +%s)"
STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
FROM_COMMIT=""
TARGET_COMMIT=""
DEPLOYED_COMMIT=""
ROLLBACK_COMMIT=""
FETCH_ROUTE=""
STAGE_DIR=""
CURRENT_STAGE="idle"
CURRENT_PERCENT=0
DB_IDENTITY_BEFORE=""
SETTINGS_SNAPSHOT=""

log() {
  printf '%s  %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "$LOG_FILE"
}

write_status() {
  local status="$1" stage="$2" percent="$3" message="$4" error="${5:-}"
  CURRENT_STAGE="$stage"
  CURRENT_PERCENT="$percent"
  STATUS="$status" STAGE="$stage" PERCENT="$percent" MESSAGE="$message" ERROR_TEXT="$error" \
  REQUEST_ID="$REQUEST_ID" STARTED_AT="$STARTED_AT" FROM_COMMIT="$FROM_COMMIT" TARGET_COMMIT="$TARGET_COMMIT" \
  DEPLOYED_COMMIT="$DEPLOYED_COMMIT" ROLLBACK_COMMIT="$ROLLBACK_COMMIT" REF="$REF" FETCH_ROUTE="$FETCH_ROUTE" \
  "$NODE_BIN" -e '
    const fs=require("fs");
    const out=process.argv[1], tmp=`${out}.tmp`;
    const e=process.env;
    const body={status:e.STATUS,stage:e.STAGE,percent:Number(e.PERCENT),message:e.MESSAGE,requestId:e.REQUEST_ID,startedAt:e.STARTED_AT,updatedAt:new Date().toISOString(),ref:e.REF,fetchRoute:e.FETCH_ROUTE||null,fromCommit:e.FROM_COMMIT||null,targetCommit:e.TARGET_COMMIT||null,deployedCommit:e.DEPLOYED_COMMIT||null,rollbackCommit:e.ROLLBACK_COMMIT||null,error:e.ERROR_TEXT||null};
    fs.writeFileSync(tmp,JSON.stringify(body,null,2),{mode:0o600}); fs.renameSync(tmp,out);
  ' "$STATUS_FILE"
  chown "$RUNTIME_USER:$RUNTIME_GROUP" "$STATUS_FILE" 2>/dev/null || true
  chmod 600 "$STATUS_FILE" || true
}

cleanup() {
  [[ -n "$STAGE_DIR" && -d "$STAGE_DIR" ]] && git -C "$REPO_DIR" worktree remove --force "$STAGE_DIR" >/dev/null 2>&1 || true
  rm -f "$REQUEST_FILE"
}

fail() {
  trap - ERR
  local message="$1" failed_stage="${CURRENT_STAGE:-failed}" failed_percent="${CURRENT_PERCENT:-1}"
  if ! [[ "$failed_percent" =~ ^[0-9]+$ ]] || (( failed_percent < 1 || failed_percent >= 100 )); then
    failed_percent=1
  fi
  log "FAILED: $message"
  if [[ -n "$FROM_COMMIT" && -n "$TARGET_COMMIT" && "$FROM_COMMIT" != "$TARGET_COMMIT" ]]; then
    write_status rolling_back rollback 94 "更新失败，正在回滚到上一版本" "$message" || true
    log "Rolling back to $FROM_COMMIT"
    git -C "$REPO_DIR" reset --hard "$FROM_COMMIT" >>"$LOG_FILE" 2>&1 || true
    systemctl restart "$SERVICE" >>"$LOG_FILE" 2>&1 || true
    ROLLBACK_COMMIT="$FROM_COMMIT"
  fi
  write_status failed "$failed_stage" "$failed_percent" "更新失败（阶段：$failed_stage）" "$message" || true
  cleanup
  exit 1
}

pin_persistent_paths() {
  mkdir -p "$PERSISTENCE_DROPIN_DIR"
  cat > "$PERSISTENCE_DROPIN" <<EOF
[Service]
Environment="GPTLOCK_LICENSE_DB=$DB_PATH"
Environment="GPTLOCK_UPDATE_DATA_DIR=$DATA_DIR"
Environment="GPTLOCK_RELEASE_MIRROR_DIR=$RELEASE_MIRROR_DIR"
EOF
  chmod 644 "$PERSISTENCE_DROPIN"
  systemctl daemon-reload
  log "Pinned persistent runtime paths: db=$DB_PATH data=$DATA_DIR"
}

snapshot_app_settings() {
  SETTINGS_SNAPSHOT="$BACKUP_DIR/app-settings-$(date -u +%Y%m%dT%H%M%SZ)-${FROM_COMMIT:0:8}.json"
  DB_PATH_ENV="$DB_PATH" SNAPSHOT_ENV="$SETTINGS_SNAPSHOT" "$NODE_BIN" --input-type=module -e '
    import { DatabaseSync } from "node:sqlite";
    import { writeFileSync } from "node:fs";
    const db=new DatabaseSync(process.env.DB_PATH_ENV);
    let rows=[];
    try { rows=db.prepare("SELECT key,value,updated_at FROM app_settings ORDER BY key").all(); } catch {}
    db.close();
    writeFileSync(process.env.SNAPSHOT_ENV,JSON.stringify({createdAt:new Date().toISOString(),rows},null,2),{mode:0o600});
  ' >>"$LOG_FILE" 2>&1
  chmod 600 "$SETTINGS_SNAPSHOT" || true
  log "Runtime settings snapshot: $SETTINGS_SNAPSHOT"
}

verify_app_settings() {
  DB_PATH_ENV="$DB_PATH" SNAPSHOT_ENV="$SETTINGS_SNAPSHOT" "$NODE_BIN" --input-type=module -e '
    import { DatabaseSync } from "node:sqlite";
    import { readFileSync } from "node:fs";
    const before=JSON.parse(readFileSync(process.env.SNAPSHOT_ENV,"utf8")).rows||[];
    const db=new DatabaseSync(process.env.DB_PATH_ENV);
    let after=[];
    try { after=db.prepare("SELECT key,value,updated_at FROM app_settings ORDER BY key").all(); } catch {}
    db.close();
    const map=new Map(after.map((row)=>[row.key,row]));
    const changed=before.filter((row)=>{const current=map.get(row.key);return !current||current.value!==row.value||current.updated_at!==row.updated_at;});
    if(changed.length){console.error(`pre-existing app_settings changed: ${changed.map((row)=>row.key).join(",")}`);process.exit(42);}
  ' >>"$LOG_FILE" 2>&1
}

restore_app_settings() {
  DB_PATH_ENV="$DB_PATH" SNAPSHOT_ENV="$SETTINGS_SNAPSHOT" "$NODE_BIN" --input-type=module -e '
    import { DatabaseSync } from "node:sqlite";
    import { readFileSync } from "node:fs";
    const before=JSON.parse(readFileSync(process.env.SNAPSHOT_ENV,"utf8")).rows||[];
    const db=new DatabaseSync(process.env.DB_PATH_ENV);
    db.exec("BEGIN IMMEDIATE");
    try {
      const upsert=db.prepare("INSERT INTO app_settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at");
      for(const row of before) upsert.run(row.key,row.value,row.updated_at);
      db.exec("COMMIT");
    } catch(error) { try{db.exec("ROLLBACK");}catch{} db.close(); throw error; }
    db.close();
  ' >>"$LOG_FILE" 2>&1
}

trap 'fail "第 ${LINENO} 行执行失败"' ERR
trap cleanup EXIT

exec 9>"$LOCK_FILE"
chmod 600 "$LOCK_FILE" || true
if ! flock -n 9; then
  write_status failed busy 1 "已有更新任务正在执行" "UPDATE_BUSY"
  exit 0
fi

write_status running preflight 5 "正在检查更新环境与持久化数据"
log "Update request $REQUEST_ID started; ref=$REF transport=${GPTLOCK_UPDATE_TRANSPORT:-auto}"
[[ -n "$REPO_DIR" && -d "$REPO_DIR/.git" ]] || fail "未找到 Git 仓库"
[[ "$REF" =~ ^[A-Za-z0-9._/-]+$ && "$REF" != -* && "$REF" != *..* ]] || fail "更新分支配置无效"
command -v git >/dev/null || fail "git 不可用"
command -v systemctl >/dev/null || fail "systemctl 不可用"
command -v curl >/dev/null || fail "curl 不可用"
command -v timeout >/dev/null || fail "timeout 不可用"
command -v readlink >/dev/null || fail "readlink 不可用"
command -v stat >/dev/null || fail "stat 不可用"
[[ -x "$NODE_BIN" ]] || fail "Node 22 不可用: $NODE_BIN"
[[ -f "$FETCH_HELPER" ]] || fail "GitHub 传输助手不存在: $FETCH_HELPER"
[[ "$DB_PATH" == /* ]] || fail "持久化数据库路径必须为绝对路径"
[[ -f "$DB_PATH" ]] || fail "持久化数据库不存在，拒绝更新以避免初始化空数据库: $DB_PATH"
DB_IDENTITY_BEFORE="$(stat -Lc '%d:%i' "$DB_PATH")"
[[ -n "$DB_IDENTITY_BEFORE" ]] || fail "无法识别当前持久化数据库"
pin_persistent_paths
REMOTE_URL="$(git -C "$REPO_DIR" remote get-url origin)"
bash "$FETCH_HELPER" --validate-url "$REMOTE_URL" || fail "Git origin 不是受信任的 b8vipvip/GPTLock 仓库"
git -C "$REPO_DIR" diff --quiet || fail "生产仓库存在未提交的已跟踪文件修改"
git -C "$REPO_DIR" diff --cached --quiet || fail "生产仓库存在未提交的暂存修改"
FROM_COMMIT="$(git -C "$REPO_DIR" rev-parse HEAD)"

write_status running fetch 18 "正在通过 SSH/HTTPS 自适应链路获取最新代码"
log "Fetching $REF with resilient GitHub transport"
if ! FETCH_ROUTE="$(bash "$FETCH_HELPER" "$REPO_DIR" "$REF" "$LOG_FILE")"; then
  fail "所有 GitHub 拉取链路均失败；请检查服务器 SSH/HTTPS 网络和 update.log"
fi
TARGET_COMMIT="$(git -C "$REPO_DIR" rev-parse FETCH_HEAD)"
write_status running compare 30 "已通过 $FETCH_ROUTE 获取最新版本，正在比较提交"
log "Fetch route=$FETCH_ROUTE Current=$FROM_COMMIT Target=$TARGET_COMMIT"
if [[ "$FROM_COMMIT" == "$TARGET_COMMIT" ]]; then
  DEPLOYED_COMMIT="$FROM_COMMIT"
  write_status succeeded current 100 "当前已经是最新版本"
  log "Already up to date"
  exit 0
fi

write_status running stage 40 "正在创建隔离测试工作区"
STAGE_DIR="$(mktemp -d /tmp/gptlock-license-update.XXXXXX)"
rmdir "$STAGE_DIR"
git -C "$REPO_DIR" worktree add --detach "$STAGE_DIR" "$TARGET_COMMIT" >>"$LOG_FILE" 2>&1

write_status running test 52 "正在执行新版本语法检查"
"$NODE_BIN" --check "$STAGE_DIR/license-server/server.mjs" >>"$LOG_FILE" 2>&1
"$NODE_BIN" --check "$STAGE_DIR/license-server/update-manager.mjs" >>"$LOG_FILE" 2>&1
"$NODE_BIN" --check "$STAGE_DIR/license-server/public/admin.js" >>"$LOG_FILE" 2>&1
bash -n "$STAGE_DIR/license-server/scripts/update-server.sh"
bash -n "$STAGE_DIR/license-server/scripts/install-updater-systemd.sh"
bash -n "$STAGE_DIR/license-server/scripts/github-fetch.sh"
[[ -s "$STAGE_DIR/license-server/scripts/github-known-hosts" ]] || fail "新版本缺少 GitHub SSH host key 固定文件"
write_status running test 62 "正在执行新版本自动化测试"
(cd "$STAGE_DIR/license-server" && GPTLOCK_UPDATE_ALLOW_WITHOUT_SYSTEMD=1 "$NODE_BIN" --test test/*.test.mjs) >>"$LOG_FILE" 2>&1

write_status running backup 70 "测试通过，正在保护并备份运行数据"
snapshot_app_settings
BACKUP_PATH="$BACKUP_DIR/gptlock-license-$(date -u +%Y%m%dT%H%M%SZ)-${FROM_COMMIT:0:8}.sqlite3"
DB_PATH_ENV="$DB_PATH" BACKUP_PATH_ENV="$BACKUP_PATH" "$NODE_BIN" --input-type=module -e '
  import { DatabaseSync, backup } from "node:sqlite";
  const db=new DatabaseSync(process.env.DB_PATH_ENV);
  await backup(db, process.env.BACKUP_PATH_ENV);
  db.close();
' >>"$LOG_FILE" 2>&1
chmod 600 "$BACKUP_PATH" || true
log "Database backup: $BACKUP_PATH"

write_status running deploy 80 "正在部署已验证的最新代码"
log "Deploying $TARGET_COMMIT"
git -C "$REPO_DIR" reset --hard "$TARGET_COMMIT" >>"$LOG_FILE" 2>&1
DEPLOYED_COMMIT="$TARGET_COMMIT"

write_status restarting restart 90 "代码部署完成，正在使用固定持久化数据库重启服务"
systemctl restart "$SERVICE" >>"$LOG_FILE" 2>&1

write_status running verify 95 "服务已重启，正在校验健康状态与运行数据"
HEALTH_URL="http://${GPTLOCK_LICENSE_HOST:-127.0.0.1}:${GPTLOCK_LICENSE_PORT:-3188}/api/v1/health"
HEALTH_OK=0
for _ in $(seq 1 30); do
  if curl --fail --silent --show-error --max-time 2 "$HEALTH_URL" >/dev/null 2>&1; then HEALTH_OK=1; break; fi
  sleep 1
done
if [[ "$HEALTH_OK" != "1" ]]; then
  log "Health check failed for $HEALTH_URL; collecting service diagnostics before rollback"
  systemctl status "$SERVICE" --no-pager -l >>"$LOG_FILE" 2>&1 || true
  journalctl -u "$SERVICE" -n 100 --no-pager >>"$LOG_FILE" 2>&1 || true
  fail "新版本启动后健康检查失败"
fi

[[ -f "$DB_PATH" ]] || fail "服务重启后持久化数据库消失"
DB_IDENTITY_AFTER="$(stat -Lc '%d:%i' "$DB_PATH")"
[[ "$DB_IDENTITY_AFTER" == "$DB_IDENTITY_BEFORE" ]] || fail "服务重启后数据库文件身份发生变化，拒绝继续以避免使用新数据库"
SERVICE_PID="$(systemctl show -p MainPID --value "$SERVICE" 2>/dev/null || true)"
[[ "$SERVICE_PID" =~ ^[1-9][0-9]*$ ]] || fail "无法取得重启后的服务进程"
SERVICE_DB_OK=0
for fd in "/proc/$SERVICE_PID/fd/"*; do
  target="$(readlink -f "$fd" 2>/dev/null || true)"
  if [[ "$target" == "$DB_PATH" ]]; then SERVICE_DB_OK=1; break; fi
done
[[ "$SERVICE_DB_OK" == "1" ]] || fail "重启后的服务没有打开更新前的持久化数据库，已阻止错误初始化"

if ! verify_app_settings; then
  log "Pre-existing app_settings changed during update; restoring snapshot before rollback"
  restore_app_settings || true
  fail "更新过程中检测到已有配置被修改或重置；已恢复更新前配置并回滚代码"
fi

VERSION="$($NODE_BIN -e "const p=require(process.argv[1]);process.stdout.write(String(p.version||''))" "$REPO_DIR/license-server/package.json")"
VERSION="$VERSION" DEPLOYED_COMMIT="$DEPLOYED_COMMIT" REF="$REF" FETCH_ROUTE="$FETCH_ROUTE" "$NODE_BIN" -e '
  const fs=require("fs"), out=process.argv[1], tmp=`${out}.tmp`, e=process.env;
  fs.writeFileSync(tmp,JSON.stringify({version:e.VERSION,commit:e.DEPLOYED_COMMIT,ref:e.REF,fetchRoute:e.FETCH_ROUTE||null,deployedAt:new Date().toISOString()},null,2),{mode:0o600}); fs.renameSync(tmp,out);
' "$DEPLOYMENT_FILE"
chown "$RUNTIME_USER:$RUNTIME_GROUP" "$DEPLOYMENT_FILE" 2>/dev/null || true
chmod 600 "$DEPLOYMENT_FILE" || true
write_status succeeded complete 100 "更新完成，服务已运行最新版本且原有配置保持不变"
log "Update completed successfully: $DEPLOYED_COMMIT route=$FETCH_ROUTE db=$DB_PATH"
