#!/usr/bin/env bash
set -euo pipefail

extract_apply() {
  local pr="$1"
  local path="$2"
  local out="/tmp/modelpro-pr${pr}.patch"
  local selected="/tmp/selected-${pr}.patch"
  curl -fsSL "https://github.com/b8vipvip/ModelPro/pull/${pr}.patch" -o "$out"
  python - "$out" "$path" "$selected" <<'PY'
import sys
src, path, dst = sys.argv[1:]
text = open(src, encoding='utf-8').read()
start = text.find(f'diff --git a/{path} b/{path}\n')
if start < 0: raise SystemExit(f'patch path not found: {path}')
end = text.find('\ndiff --git a/', start + 1)
block = text[start:] if end < 0 else text[start:end+1]
open(dst, 'w', encoding='utf-8').write(block)
PY
  git apply --recount --ignore-space-change --ignore-whitespace "$selected"
}

extract_apply 4 extension/content.js
curl -fsSL https://raw.githubusercontent.com/b8vipvip/ModelPro/main/extension/page-model-evidence.js -o extension/page-model-evidence.js
python - <<'PY'
p='extension/page-model-evidence.js'
s=open(p,encoding='utf-8').read().replace("version: '1.2.0'", "version: '1.3.0'", 1)
open(p,'w',encoding='utf-8').write(s)
PY

curl -fsSL https://raw.githubusercontent.com/b8vipvip/ModelPro/main/extension/composer-send-compat.js -o extension/composer-send-compat.js
python - <<'PY'
p='extension/composer-send-compat.js'
s=open(p,encoding='utf-8').read().replace("const MARKER = 'modelproSendCompat';", "const MARKER = 'gptworkSendCompat';").replace('modelproOriginalTestid','gptworkOriginalTestid')
open(p,'w',encoding='utf-8').write(s)
PY

extract_apply 10 extension/network-monitor.js
extract_apply 11 extension/background.js

python - <<'PY'
from pathlib import Path
import json
p=Path('extension/background.js'); s=p.read_text(encoding='utf-8')
s=s.replace("const RUNTIME_CODE_VERSION = '0.1.44';", "const RUNTIME_CODE_VERSION = '0.5.145';", 1)
s=s.replace("const RUNTIME_CODE_VERSION = '0.5.144';", "const RUNTIME_CODE_VERSION = '0.5.145';", 1)
p.write_text(s,encoding='utf-8')
p=Path('extension/manifest.json'); m=json.loads(p.read_text(encoding='utf-8')); m['version']='0.5.145'
scripts=m['content_scripts'][0]['js']
if 'composer-send-compat.js' not in scripts: scripts.insert(scripts.index('content.js'),'composer-send-compat.js')
p.write_text(json.dumps(m,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
p=Path('extension/package.json'); pkg=json.loads(p.read_text(encoding='utf-8')); pkg['version']='0.5.145'
cmd=pkg['scripts']['test']
if 'node --check composer-send-compat.js' not in cmd: cmd=cmd.replace('node --check content.js','node --check composer-send-compat.js && node --check content.js')
pkg['scripts']['test']=cmd; p.write_text(json.dumps(pkg,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
for f in ['native-core/Cargo.toml','native-core/Cargo.lock','packaging/windows/GPTWork.iss']:
    p=Path(f); p.write_text(p.read_text(encoding='utf-8').replace('0.5.144','0.5.145'),encoding='utf-8')
t=Path('extension/tests/v0.5.145-redesign-verified-chain.test.mjs')
t.write_text(r'''import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
const r=(p)=>readFile(new URL('../'+p,import.meta.url),'utf8');
test('v0.5.145 ports live-validated redesigned Chat and hidden Work chain',async()=>{
  const [b,c,n,p,m]=await Promise.all([r('background.js'),r('content.js'),r('network-monitor.js'),r('page-model-evidence.js'),r('manifest.json')]);
  assert.equal(JSON.parse(m).version,'0.5.145');
  assert.match(c,/defaultChatDirectModelRows/); assert.match(c,/picker-mode-a-redesigned-direct-chat-list/); assert.match(c,/verification_model_selection_deferred_to_network/);
  assert.match(p,/redesignedDefaultChatEvidence/); assert.match(p,/composer-redesign-default-sol/);
  assert.match(n,/Network\.streamResourceContent/); assert.match(n,/initial_conversation_aborted/); assert.match(n,/defaultModel: evidence\.defaultModel/);
  assert.match(b,/__work_transport__/); assert.match(b,/normal_work_turn_work_profile_confirmed_by_default_model/); assert.match(b,/activationDefaultModel === activationTarget/);
  assert.match(b,/const verified = Boolean\(requestId\) && requestConfirmed && responseConfirmed/);
});
test('redesigned send compatibility loads before content runtime',async()=>{
  const [m,compat]=await Promise.all([r('manifest.json'),r('composer-send-compat.js')]); const scripts=JSON.parse(m).content_scripts[0].js;
  assert.ok(scripts.indexOf('composer-send-compat.js')>=0 && scripts.indexOf('composer-send-compat.js')<scripts.indexOf('content.js')); assert.match(compat,/gptworkSendCompat/); assert.match(compat,/data-testid', 'send-button'/);
});
''',encoding='utf-8')
PY

rm -f .github/workflows/apply-v0.5.145-redesign-chain.yml .github/apply-v0.5.145.sh
git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git add -A
git commit -m "fix: port live-validated ChatGPT redesign verification chain"
git push origin "HEAD:${GITHUB_REF_NAME}"
