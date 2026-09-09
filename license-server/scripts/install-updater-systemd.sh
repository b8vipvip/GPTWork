#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  echo "Please run as root" >&2
  exit 1
fi

SERVER_DIR="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
SERVICE="${GPTLOCK_UPDATE_SERVICE:-gptlock-license.service}"

# Prefer the production service EnvironmentFile when the caller did not explicitly
# select one. This keeps the updater aligned with the database and secrets used by
# the running service instead of silently falling back to a checkout-local .env.
SYSTEMD_ENV_FILE=""
if [[ -z "${GPTLOCK_UPDATE_ENV_FILE:-}" ]]; then
  SYSTEMD_ENV_FILE="$(
    systemctl cat "$SERVICE" 2>/dev/null |
      awk '
        /^[[:space:]]*EnvironmentFile=/ {
          line=$0
          sub(/^[[:space:]]*EnvironmentFile=/, "", line)
          sub(/^-/, "", line)
          gsub(/^"|"$/, "", line)
          if (line ~ /^\//) last=line
        }
        END { if (last) print last }
      ' || true
  )"
fi
ENV_FILE="${GPTLOCK_UPDATE_ENV_FILE:-${SYSTEMD_ENV_FILE:-$SERVER_DIR/.env}}"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

# Resolve updater settings only after loading the production environment so values
# such as GPTLOCK_UPDATE_REPO_DIR and GPTLOCK_UPDATE_REF are actually honored.
SERVICE="${GPTLOCK_UPDATE_SERVICE:-$SERVICE}"
NODE_BIN="${GPTLOCK_UPDATE_NODE_BIN:-/usr/local/bin/node22}"
REF="${GPTLOCK_UPDATE_REF:-main}"
REPO_DIR="${GPTLOCK_UPDATE_REPO_DIR:-$(git -C "$SERVER_DIR" rev-parse --show-toplevel)}"
RUNTIME_USER="${GPTLOCK_UPDATE_RUNTIME_USER:-$(systemctl show -p User --value "$SERVICE" 2>/dev/null || true)}"
RUNTIME_GROUP="${GPTLOCK_UPDATE_RUNTIME_GROUP:-$(systemctl show -p Group --value "$SERVICE" 2>/dev/null || true)}"
RUNTIME_USER="${RUNTIME_USER:-gptlock}"
RUNTIME_GROUP="${RUNTIME_GROUP:-$RUNTIME_USER}"
UPDATE_SCRIPT="$SERVER_DIR/scripts/update-server.sh"
FETCH_HELPER="$SERVER_DIR/scripts/github-fetch.sh"
KNOWN_HOSTS="$SERVER_DIR/scripts/github-known-hosts"
TRANSPORT="${GPTLOCK_UPDATE_TRANSPORT:-auto}"

[[ -d "$REPO_DIR/.git" ]] || { echo "Git repository not found: $REPO_DIR" >&2; exit 1; }
[[ -f "$UPDATE_SCRIPT" ]] || { echo "Updater script not found: $UPDATE_SCRIPT" >&2; exit 1; }
[[ -f "$FETCH_HELPER" ]] || { echo "GitHub fetch helper not found: $FETCH_HELPER" >&2; exit 1; }
[[ -s "$KNOWN_HOSTS" ]] || { echo "Pinned GitHub known_hosts file not found: $KNOWN_HOSTS" >&2; exit 1; }
[[ -x "$NODE_BIN" ]] || { echo "Node 22 not found: $NODE_BIN" >&2; exit 1; }
command -v timeout >/dev/null || { echo "GNU timeout is required" >&2; exit 1; }
id "$RUNTIME_USER" >/dev/null 2>&1 || { echo "Runtime user not found: $RUNTIME_USER" >&2; exit 1; }

resolve_from() {
  "$NODE_BIN" -e 'const path=require("node:path");process.stdout.write(path.resolve(process.argv[1],process.argv[2]))' "$1" "$2"
}

# Legacy deployments allowed GPTLOCK_LICENSE_DB to be relative. Resolve that path
# against the *currently running service cwd*, which is the exact location Node used
# before this installer existed. Then pin the absolute path in a systemd drop-in so
# future code updates or WorkingDirectory changes can never switch to a fresh DB.
SERVICE_CWD=""
MAIN_PID="$(systemctl show -p MainPID --value "$SERVICE" 2>/dev/null || true)"
if [[ "$MAIN_PID" =~ ^[1-9][0-9]*$ && -e "/proc/$MAIN_PID/cwd" ]]; then
  SERVICE_CWD="$(readlink -f "/proc/$MAIN_PID/cwd" 2>/dev/null || true)"
fi
if [[ -z "$SERVICE_CWD" ]]; then
  SERVICE_CWD="$(systemctl show -p WorkingDirectory --value "$SERVICE" 2>/dev/null || true)"
fi
[[ "$SERVICE_CWD" == /* ]] || SERVICE_CWD="$SERVER_DIR"

DB_CONFIG="${GPTLOCK_LICENSE_DB:-$SERVER_DIR/data/gptlock-license.sqlite3}"
if [[ "$DB_CONFIG" == /* ]]; then
  DB_PATH="$(resolve_from / "$DB_CONFIG")"
else
  DB_PATH="$(resolve_from "$SERVICE_CWD" "$DB_CONFIG")"
fi
[[ -f "$DB_PATH" ]] || { echo "Persistent database not found: $DB_PATH" >&2; exit 1; }

DATA_CONFIG="${GPTLOCK_UPDATE_DATA_DIR:-$(dirname "$DB_PATH")}"
if [[ "$DATA_CONFIG" == /* ]]; then DATA_DIR="$(resolve_from / "$DATA_CONFIG")"; else DATA_DIR="$(resolve_from "$SERVICE_CWD" "$DATA_CONFIG")"; fi
RELEASE_CONFIG="${GPTLOCK_RELEASE_MIRROR_DIR:-$DATA_DIR/releases}"
if [[ "$RELEASE_CONFIG" == /* ]]; then RELEASE_MIRROR_DIR="$(resolve_from / "$RELEASE_CONFIG")"; else RELEASE_MIRROR_DIR="$(resolve_from "$SERVICE_CWD" "$RELEASE_CONFIG")"; fi
REQUEST_FILE="$DATA_DIR/update-request.json"

REMOTE_URL="$(git -C "$REPO_DIR" remote get-url origin)"
GPTLOCK_UPDATE_TRANSPORT="$TRANSPORT" bash "$FETCH_HELPER" --validate-url "$REMOTE_URL" || {
  echo "Untrusted Git origin: $REMOTE_URL" >&2
  exit 1
}

mkdir -p "$DATA_DIR" "$RELEASE_MIRROR_DIR"
chown "$RUNTIME_USER:$RUNTIME_GROUP" "$DATA_DIR" "$RELEASE_MIRROR_DIR" || true
chmod 750 "$RELEASE_MIRROR_DIR" || true
rm -f "$REQUEST_FILE"
chmod 750 "$SERVER_DIR/scripts" || true
# Keep tracked shell files non-executable so installing the updater does not dirty the Git checkout.
# Both files are invoked explicitly through /bin/bash.
chmod 640 "$UPDATE_SCRIPT" "$FETCH_HELPER" || true
chmod 640 "$KNOWN_HOSTS" || true

# Pin all persistent runtime locations for the application service itself. This is
# intentionally outside the Git checkout and survives git reset --hard updates.
PERSISTENCE_DROPIN_DIR="/etc/systemd/system/${SERVICE}.d"
PERSISTENCE_DROPIN="$PERSISTENCE_DROPIN_DIR/20-gptwork-persistent-data.conf"
mkdir -p "$PERSISTENCE_DROPIN_DIR"
cat > "$PERSISTENCE_DROPIN" <<EOF
[Service]
Environment="GPTLOCK_LICENSE_DB=$DB_PATH"
Environment="GPTLOCK_UPDATE_DATA_DIR=$DATA_DIR"
Environment="GPTLOCK_RELEASE_MIRROR_DIR=$RELEASE_MIRROR_DIR"
EOF
chmod 644 "$PERSISTENCE_DROPIN"

cat > /etc/systemd/system/gptlock-license-update.service <<EOF
[Unit]
Description=GPTWork License Server GitHub Update
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
Environment="GIT_TERMINAL_PROMPT=0"
Environment="GPTLOCK_UPDATE_SERVER_DIR=$SERVER_DIR"
Environment="GPTLOCK_UPDATE_REPO_DIR=$REPO_DIR"
Environment="GPTLOCK_UPDATE_ENV_FILE=$ENV_FILE"
Environment="GPTLOCK_UPDATE_DB_PATH=$DB_PATH"
Environment="GPTLOCK_UPDATE_DATA_DIR=$DATA_DIR"
Environment="GPTLOCK_UPDATE_NODE_BIN=$NODE_BIN"
Environment="GPTLOCK_UPDATE_REF=$REF"
Environment="GPTLOCK_UPDATE_SERVICE=$SERVICE"
Environment="GPTLOCK_UPDATE_RUNTIME_USER=$RUNTIME_USER"
Environment="GPTLOCK_UPDATE_RUNTIME_GROUP=$RUNTIME_GROUP"
ExecStart=/bin/bash $UPDATE_SCRIPT
TimeoutStartSec=15min
EOF

cat > /etc/systemd/system/gptlock-license-update.path <<EOF
[Unit]
Description=Watch GPTWork License Server update requests

[Path]
PathExists=$REQUEST_FILE
Unit=gptlock-license-update.service

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now gptlock-license-update.path

echo "GPTWork updater installed."
echo "  repository: $REPO_DIR"
echo "  server dir: $SERVER_DIR"
echo "  target ref: $REF"
echo "  transport: $TRANSPORT (SSH 22 -> SSH 443 -> HTTPS in auto mode)"
echo "  runtime user: $RUNTIME_USER:$RUNTIME_GROUP"
echo "  env file: $ENV_FILE"
echo "  persistent db: $DB_PATH"
echo "  data dir: $DATA_DIR"
echo "  release mirror: $RELEASE_MIRROR_DIR"
echo "  persistence drop-in: $PERSISTENCE_DROPIN"
echo "  request: $REQUEST_FILE"
echo "  watcher: gptlock-license-update.path"
echo "  trusted origin: $REMOTE_URL"
echo "  transport plan:"
GPTLOCK_UPDATE_TRANSPORT="$TRANSPORT" bash "$FETCH_HELPER" --plan "$REMOTE_URL" "$TRANSPORT" | sed 's/^/    /'
