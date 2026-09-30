const fs = require('node:fs');

function read(path) { return fs.readFileSync(path, 'utf8'); }
function write(path, value) { fs.writeFileSync(path, value); }
function replaceOnce(source, oldText, newText, label) {
  if (source.includes(newText)) return source;
  const index = source.indexOf(oldText);
  if (index < 0) throw new Error(`Missing patch anchor: ${label}`);
  if (source.indexOf(oldText, index + oldText.length) >= 0) throw new Error(`Ambiguous patch anchor: ${label}`);
  return source.slice(0, index) + newText + source.slice(index + oldText.length);
}

let content = read('extension/content.js');
content = replaceOnce(content,
`  function pointerOwnedVisiblePoint(element) {
    if (!element?.isConnected || !visible(element)) return null;
    const rect = element.getBoundingClientRect();
    const left = Math.max(0, rect.left);
    const right = Math.min(window.innerWidth, rect.right);
    const top = Math.max(0, rect.top);
    const bottom = Math.min(window.innerHeight, rect.bottom);
    if (right - left < 2 || bottom - top < 2) return null;
    // A picker row can extend underneath ChatGPT's fixed Composer at the viewport
    // bottom. Its geometric center is then occluded even though the visible upper
    // portion remains a valid click target. Sample only inside the viewport-visible
    // intersection and keep the exact DOM row as the sole ownership authority.
    const xs = [(left + right) / 2, left + (right - left) * 0.35, left + (right - left) * 0.65];
    const ys = [(top + bottom) / 2, top + Math.min(8, (bottom - top) * 0.25), bottom - Math.min(8, (bottom - top) * 0.25)];
    for (const y of ys) {
      for (const x of xs) {
        const point = { x, y };
        if (pointerStillOwnsPoint(element, point)) return point;
      }
    }
    return null;
  }
`,
`  function pointerOwnedVisiblePoint(element) {
    if (!element?.isConnected || !visible(element)) return null;
    const rect = element.getBoundingClientRect();
    const left = Math.max(0, rect.left);
    const right = Math.min(window.innerWidth, rect.right);
    const top = Math.max(0, rect.top);
    const bottom = Math.min(window.innerHeight, rect.bottom);
    if (right - left < 2 || bottom - top < 2) return null;
    // A picker row can extend underneath ChatGPT's fixed Composer at the viewport
    // bottom. Its geometric center is then occluded even though the visible upper
    // portion remains a valid click target. Sample only inside the viewport-visible
    // intersection and keep the exact DOM row as the sole ownership authority.
    const xs = [(left + right) / 2, left + (right - left) * 0.35, left + (right - left) * 0.65];
    const ys = [(top + bottom) / 2, top + Math.min(8, (bottom - top) * 0.25), bottom - Math.min(8, (bottom - top) * 0.25)];
    for (const y of ys) {
      for (const x of xs) {
        const point = { x, y };
        if (pointerStillOwnsPoint(element, point)) return point;
      }
    }
    return null;
  }

  // ChatGPT's 2026-09 ViewTrack keeps inactive picker panels mounted with normal
  // dimensions. CSS visibility is observation-only; an actionable model row must
  // also own a real viewport point through elementFromPoint().
  function interactionVisible(element) {
    return visible(element) && Boolean(pointerOwnedVisiblePoint(element));
  }
`, 'interaction visibility');

content = replaceOnce(content,
`      await sendMessage({ type: 'GPTLOCK_TRUSTED_POINTER_PREPARE' });
      // chrome.debugger's infobar and Radix slider transitions can both move the picker.`,
`      await sendMessage({ type: 'GPTLOCK_TRUSTED_POINTER_PREPARE' });
      if (!element.isConnected || !visible(element)) {
        pointerTrace('invalidated_after_debugger_attach', { traceId, action, source, target: compactElementProbe(element) });
        return false;
      }
      // chrome.debugger's infobar and Radix slider transitions can both move the picker.`, 'post-debugger liveness');

content = replaceOnce(content,
`    const rows = distinctModelRows(picker);
    const models = new Set(rows.map((row) => rowModelDescriptor(row).model).filter(Boolean));`,
`    const rows = distinctModelRows(picker).filter(interactionVisible);
    const models = new Set(rows.map((row) => rowModelDescriptor(row).model).filter(Boolean));`, 'direct model rows hit-test');

content = replaceOnce(content,
`  function advancedPickerToggle(picker) {
    return [...(picker?.querySelectorAll?.('[role="menuitem"],button,[role="button"]') || [])].filter(visible)
      .find((element) => /advanced|高级|進階|고급|avanzad|erweitert/i.test(normalizedPickerLabel(element))) || null;
  }

  function isModelListScope(scope) {`,
`  function advancedPickerToggle(picker) {
    return [...(picker?.querySelectorAll?.('[role="menuitem"],button,[role="button"]') || [])].filter(visible)
      .find((element) => /advanced|高级|進階|고급|avanzad|erweitert/i.test(normalizedPickerLabel(element))) || null;
  }

  function redesignedModelViewOpener(picker) {
    if (!picker || !visible(picker)) return null;
    const candidates = [...picker.querySelectorAll('[role="menuitem"],button,[role="button"]')]
      .filter((element) => interactionVisible(element))
      .filter((element) => !element.closest?.('#gptlock-indicator-host,#gptlock-verification-progress-host'))
      .filter((element) => {
        const descriptor = rowModelDescriptor(element);
        if (descriptor.model || descriptor.rawId) return false;
        if (element.matches?.('[role="slider"],input[type="range"]')) return false;
        if (element.querySelector?.('[role="slider"],input[type="range"]')) return false;
        const label = normalizedPickerLabel(element).replace(/[›»>]+\\s*$/, '').trim();
        return Boolean(normalizeDisplayedReasoning(label));
      });
    return candidates.length === 1 ? candidates[0] : null;
  }

  function isModelListScope(scope) {`, 'redesign view opener');

content = replaceOnce(content,
`    const redesignedDirectRows = defaultChatDirectModelRows(picker);
    if (redesignedDirectRows.length === 2) {
      pickerTopologyProbe('picker-mode-a-redesigned-direct-chat-list', {
        pageContext,
        pickerMode: 'A',
        ownedPicker: compactElementProbe(picker),
        modelRows: redesignedDirectRows.map((row) => ({
          element: compactElementProbe(row),
          descriptor: rowModelDescriptor(row),
        })),
      });
      return {
        trigger,
        picker,
        opener: null,
        submenu: picker,
        rows: redesignedDirectRows,
        pageContext,
        pickerMode: 'A',
      };
    }

    const initialOpener = modelSubmenuOpener(picker);`,
`    let redesignedDirectRows = defaultChatDirectModelRows(picker);
    if (redesignedDirectRows.length === 2) {
      pickerTopologyProbe('picker-mode-a-redesigned-direct-chat-list', {
        pageContext,
        pickerMode: 'A',
        ownedPicker: compactElementProbe(picker),
        modelRows: redesignedDirectRows.map((row) => ({
          element: compactElementProbe(row),
          descriptor: rowModelDescriptor(row),
        })),
      });
      return {
        trigger,
        picker,
        opener: null,
        submenu: picker,
        rows: redesignedDirectRows,
        pageContext,
        pickerMode: 'A',
      };
    }

    // The redesigned picker may open on the reasoning slider while its model panel
    // stays mounted in an inactive ViewPanel. Navigate through the exact visible
    // reasoning summary row, then reacquire only hit-test-owned rows in this picker.
    const modelViewOpener = redesignedModelViewOpener(picker);
    if (modelViewOpener) {
      pickerTopologyProbe('picker-redesign-reasoning-view-detected', {
        pageContext,
        opener: compactElementProbe(modelViewOpener),
      });
      const navigated = await modelPickerPointer(modelViewOpener, 'click', 'model-picker-redesign-model-view');
      if (navigated) {
        redesignedDirectRows = await waitUntil(() => {
          const rows = defaultChatDirectModelRows(picker);
          return rows.length === 2 ? rows : null;
        }, 2600, 80) || [];
        if (redesignedDirectRows.length === 2) {
          pickerTopologyProbe('picker-mode-a-redesigned-model-view', {
            pageContext,
            pickerMode: 'A',
            ownedPicker: compactElementProbe(picker),
            modelRows: redesignedDirectRows.map((row) => ({
              element: compactElementProbe(row),
              descriptor: rowModelDescriptor(row),
            })),
          });
          return { trigger, picker, opener: null, submenu: picker, rows: redesignedDirectRows, pageContext, pickerMode: 'A' };
        }
      }
    }

    const initialOpener = modelSubmenuOpener(picker);`, 'viewtrack navigation');
write('extension/content.js', content);

let background = read('extension/background.js');
background = replaceOnce(background,
`  createVerificationCatalog,
  summarizeVerificationOutcome,
  createModelVerificationHistoryRecord,
} from './vendor/modelpro/model-verification.js';`,
`  createVerificationCatalog,
  summarizeVerificationOutcome,
  createModelVerificationHistoryRecord,
  shouldRetryTransientResponse,
  publishableVerificationResults,
} from './vendor/modelpro/model-verification.js';`, 'ModelPro v0.1.46 imports');

background = replaceOnce(background,
`  const models = (Array.isArray(progress?.results) ? progress.results : [])
    .filter((item) => item?.requestConfirmed === true && normalizeConcreteModelId(item?.model))
    .map((item) => ({`,
`  const models = publishableVerificationResults(progress?.results, normalizeConcreteModelId)
    .map((item) => ({`, 'strict shared catalog publication');

background = replaceOnce(background,
`  let index = 0;
  let stablePasses = 0;
  while (index < queue.length || stablePasses < 2) {`,
`  let index = 0;
  let stablePasses = 0;
  const transientRetryCounts = new Map();
  while (index < queue.length || stablePasses < 2) {`, 'retry counter');

background = replaceOnce(background,
`      const result = {
        model: item.model || requestModel, rawModel: item.rawModel || requestModel,
        selectorKey: item.selectorKey, label: item.label, verified,
        selected: selection.selectionAttempted === true, requestConfirmed, responseConfirmed,
        requestId, requestModel, networkObservedRequestModel, responseModel, rawResponseModel, evidenceModel,
        responseReasoning: responseEvidence?.reasoning ?? null,
        responseVerdict: responseConfirmed ? 'verified' : state.lastVerification?.verdict ?? null,
        responseIssue: responseConfirmed ? null : state.evidenceIssue ?? null,
        pickerMode: item.pickerMode || null,
        evidenceSource,
        timedOut: waited.timedOut, turnSettled: true, observation: selection.observation || null,
      };
      progress.results.push(result);`,
`      const retryKey = catalog.identity(item);
      const retryCount = transientRetryCounts.get(retryKey) || 0;
      const result = {
        model: item.model || requestModel, rawModel: item.rawModel || requestModel,
        selectorKey: item.selectorKey, label: item.label, verified,
        selected: selection.selectionAttempted === true, requestConfirmed, responseConfirmed,
        requestId, requestModel, networkObservedRequestModel, responseModel, rawResponseModel, evidenceModel,
        responseReasoning: responseEvidence?.reasoning ?? null,
        responseVerdict: responseConfirmed ? 'verified' : state.lastVerification?.verdict ?? null,
        responseIssue: responseConfirmed ? null : state.evidenceIssue ?? null,
        responseHttpStatus: Number(responseEvidence?.diagnostics?.httpStatus || 0),
        responseBodyError: responseEvidence?.bodyError ?? null,
        retryCount,
        pickerMode: item.pickerMode || null,
        evidenceSource,
        timedOut: waited.timedOut, turnSettled: true, observation: selection.observation || null,
      };
      if (shouldRetryTransientResponse(result, { maxRetries: 1 })) {
        transientRetryCounts.set(retryKey, retryCount + 1);
        logRuntime('warn', 'verification', 'account_model_verification_transient_response_retry', {
          tabId, index: index + 1, total: queue.length, model: result.model,
          requestId: result.requestId, responseHttpStatus: result.responseHttpStatus,
          responseBodyError: result.responseBodyError, responseIssue: result.responseIssue,
          retryCount: retryCount + 1, maxRetries: 1,
        });
        verificationTransactions.delete(Number(tabId));
        await broadcastTabState(tabId);
        await sleep(650);
        continue;
      }
      progress.results.push(result);`, 'bounded transient response retry');

background = background.replace("const RUNTIME_CODE_VERSION = '0.5.157';", "const RUNTIME_CODE_VERSION = '0.5.158';");
if (!background.includes("const RUNTIME_CODE_VERSION = '0.5.158';")) throw new Error('Runtime version bump failed');
write('extension/background.js', background);

const manifestPath = 'extension/manifest.json';
const manifest = JSON.parse(read(manifestPath));
manifest.version = '0.5.158';
write(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
const packagePath = 'extension/package.json';
const pkg = JSON.parse(read(packagePath));
pkg.version = '0.5.158';
write(packagePath, JSON.stringify(pkg, null, 2) + '\n');

let cargoToml = read('native-core/Cargo.toml');
cargoToml = cargoToml.replace(/^version = "0\.5\.157"/m, 'version = "0.5.158"');
write('native-core/Cargo.toml', cargoToml);
let cargoLock = read('native-core/Cargo.lock');
cargoLock = cargoLock.replace(/(name = "gptwork-core"\nversion = ")0\.5\.157("\n)/, '$10.5.158$2');
write('native-core/Cargo.lock', cargoLock);
let installer = read('packaging/windows/GPTWork.iss');
installer = installer.replace('#define MyAppVersion "0.5.157"', '#define MyAppVersion "0.5.158"');
write('packaging/windows/GPTWork.iss', installer);

let seam = read('extension/tests/modelpro-v0145-policy-consumer.test.mjs');
seam = seam.replace('ModelPro v0.1.45 verification policy seam', 'ModelPro v0.1.46 verification policy seam');
seam = seam.replace("assert.equal(metadata.version, '0.1.45');", "assert.equal(metadata.version, '0.1.46');");
seam = seam.replace("assert.equal(metadata.commit, '33bc784dbf91c52aa1776ee46550acb2dcf04c8b');", "assert.equal(metadata.commit, 'f674411521d54f03682b7c60102a9c21d449f53d');");
seam = seam.replace("assert.equal(metadata.blob, 'b7a070a4aeec86b4cb7e0c4ec4dc4750b4e2e215');", "assert.equal(metadata.blob, '5ab85559688ed0b605b517e27eec0682361d035c');");
seam = seam.replace("assert.match(vendor, /export function createModelVerificationHistoryRecord/);", "assert.match(vendor, /export function createModelVerificationHistoryRecord/);\n  assert.match(vendor, /export function shouldRetryTransientResponse/);\n  assert.match(vendor, /export function publishableVerificationResults/);");
seam = seam.replace('ModelPro v0.1.45 seam remains pinned', 'ModelPro v0.1.46 seam remains pinned');
write('extension/tests/modelpro-v0145-policy-consumer.test.mjs', seam);

const testPath = 'extension/tests/v05158-modelpro-v0146-redesign-compat.test.mjs';
if (!fs.existsSync(testPath)) {
  write(testPath, `import assert from 'node:assert/strict';\nimport { readFile } from 'node:fs/promises';\nimport test from 'node:test';\n\nconst r = (path) => readFile(new URL('../' + path, import.meta.url), 'utf8');\n\ntest('v0.5.158 consumes ModelPro v0.1.46 ViewTrack and transient-response policy', async () => {\n  const [background, content, vendor, source, manifestText, packageText] = await Promise.all([\n    r('background.js'), r('content.js'), r('vendor/modelpro/model-verification.js'),\n    r('vendor/modelpro/MODELPRO_SOURCE.json'), r('manifest.json'), r('package.json'),\n  ]);\n  const metadata = JSON.parse(source);\n  assert.equal(metadata.version, '0.1.46');\n  assert.equal(metadata.commit, 'f674411521d54f03682b7c60102a9c21d449f53d');\n  assert.equal(metadata.blob, '5ab85559688ed0b605b517e27eec0682361d035c');\n  assert.match(vendor, /export function shouldRetryTransientResponse/);\n  assert.match(vendor, /export function publishableVerificationResults/);\n  assert.match(content, /function interactionVisible\\(element\\)/);\n  assert.match(content, /distinctModelRows\\(picker\\)\\.filter\\(interactionVisible\\)/);\n  assert.match(content, /function redesignedModelViewOpener\\(picker\\)/);\n  assert.match(content, /model-picker-redesign-model-view/);\n  assert.match(content, /invalidated_after_debugger_attach/);\n  assert.match(background, /account_model_verification_transient_response_retry/);\n  assert.match(background, /shouldRetryTransientResponse\\(result, \\{ maxRetries: 1 \\}\\)/);\n  assert.match(background, /publishableVerificationResults\\(progress\\?\\.results, normalizeConcreteModelId\\)/);\n  const manifest = JSON.parse(manifestText);\n  assert.equal(manifest.version, '0.5.158');\n  assert.equal(JSON.parse(packageText).version, manifest.version);\n  assert.match(background, /const RUNTIME_CODE_VERSION = '0\\.5\\.158';/);\n});\n`);
}

console.log('GPTWork v0.5.158 ModelPro v0.1.46 compatibility staged');
