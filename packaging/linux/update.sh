#!/usr/bin/env bash
set -euo pipefail

feed_url="https://gptlock.mv3.cn/site/api/releases"
temp_dir="$(mktemp -d)"
trap 'rm -rf -- "$temp_dir"' EXIT

curl_official() {
  curl -fsSL --proto '=https' --tlsv1.2 \
    --retry 6 --retry-all-errors --retry-delay 2 --retry-max-time 180 \
    --connect-timeout 15 --max-time 300 \
    --speed-time 30 --speed-limit 1024 \
    "$@"
}

echo "正在从 GPTWork 官网检查更新 / Checking the GPTWork official update service…"
feed_json="$temp_dir/releases.json"
curl_official -H 'Accept: application/json' "$feed_url" -o "$feed_json"

readarray -t release_data < <(python3 - "$feed_json" <<'PY'
import json
import re
import sys
from urllib.parse import urlparse

with open(sys.argv[1], encoding="utf-8") as handle:
    feed = json.load(handle)
releases = feed.get("releases") or []
if not releases:
    raise SystemExit("official GPTWork server does not currently expose a mirrored release")
release = releases[0]
tag = str(release.get("tag") or "")
if not re.fullmatch(r"v\d+(?:\.\d+){1,3}", tag):
    raise SystemExit("official release tag is invalid")
version = tag[1:]
assets = {str(item.get("name") or ""): item for item in release.get("assets") or []}
preferred = f"GPTWork_{version}_amd64.deb"
if preferred not in assets:
    raise SystemExit("official mirrored release does not contain the GPTWork Linux amd64 package")
name = preferred

def trusted_url(item):
    value = str(item.get("url") or "")
    parsed = urlparse(value)
    prefix = f"/downloads/releases/{tag}/"
    if parsed.scheme != "https" or parsed.hostname != "gptlock.mv3.cn" or not parsed.path.startswith(prefix):
        raise SystemExit(f"untrusted mirrored release URL for {item.get('name')}")
    return value

def digest(item):
    value = str(item.get("digest") or "")
    match = re.fullmatch(r"sha256:([0-9a-fA-F]{64})", value)
    if not match:
        raise SystemExit(f"missing SHA-256 digest for {item.get('name')}")
    return match.group(1).lower()

print(tag)
print(name)
print(trusted_url(assets[name]))
print(digest(assets[name]))
PY
)

tag="${release_data[0]}"
asset="${release_data[1]}"
asset_url="${release_data[2]}"
feed_digest="${release_data[3]}"

echo "正在从 GPTWork 服务端镜像下载 $asset / Downloading $asset from the GPTWork server mirror…"
curl_official "$asset_url" -o "$temp_dir/$asset"

actual="$(sha256sum "$temp_dir/$asset" | awk '{print tolower($1)}')"
if [[ "$actual" != "$feed_digest" ]]; then
  echo "服务端镜像 SHA-256 校验失败，已停止更新 / Server mirror SHA-256 verification failed; update aborted." >&2
  exit 1
fi

echo "校验通过，正在安装 $tag / Verification passed; installing $tag…"
sudo dpkg -i "$temp_dir/$asset"
systemctl --user daemon-reload 2>/dev/null || true
systemctl --user try-restart gptwork-core.service 2>/dev/null || systemctl --user try-restart gptlock-core.service 2>/dev/null || true
echo "更新完成；请完全重启浏览器 / Update complete; fully restart the browser."
