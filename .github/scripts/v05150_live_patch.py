from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text(encoding='utf-8')
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{path}: expected one match, found {count}')
    p.write_text(text.replace(old, new, 1), encoding='utf-8')


replace_once(
    'extension/content.js',
    """      const attempted = await modelPickerPointer(candidate, 'click', 'verification-model-row');
      if (!attempted) return { attempted: false, observation: collectObservation() };
      // Never keep using the pre-click row as a liveness authority. Radix replaces or
""",
    """      const attempted = await modelPickerPointer(candidate, 'click', 'verification-model-row');
      if (!attempted) {
        const observation = collectObservation();
        // Live v0.5.149 evidence shows the redesigned direct Chat list can expose the
        // exact composer-owned Picker A radio row while Chromium's post-debugger
        // elementFromPoint readiness gate returns no stable hit. Picker A verification
        // already owns an explicit network transaction for the same concrete model, so
        // allow only these two direct-Chat rows to continue to network evidence. Picker B
        // still requires a real UI selection because it mutates Work's model state.
        const networkDeferredAfterPointerReject = modern.pickerMode === 'A'
          && (desired === 'gpt-5.5' || desired === 'gpt-5.6-sol')
          && candidate.isConnected
          && visible(candidate)
          && modern.picker?.contains?.(candidate) === true;
        pointerTrace(
          networkDeferredAfterPointerReject
            ? 'verification_model_selection_deferred_to_network'
            : 'verification_model_selection_unconfirmed',
          {
            source: 'verification-model-row-pointer-rejected', desired, selectorKey: wantedKey, label: wantedLabel,
            pickerMode: modern.pickerMode || null,
            reason: networkDeferredAfterPointerReject ? 'owned_picker_a_row_pointer_hit_test_unavailable' : 'pointer_dispatch_rejected',
            observation,
          },
        );
        if (!networkDeferredAfterPointerReject) return { attempted: false, observation, uiConfirmed: false };
        await closeModelMenus(modern.trigger);
        return { attempted: true, observation, uiConfirmed: false, networkDeferred: true };
      }
      // Never keep using the pre-click row as a liveness authority. Radix replaces or
""",
)

replace_once('extension/background.js', "const RUNTIME_CODE_VERSION = '0.5.149';", "const RUNTIME_CODE_VERSION = '0.5.150';")
replace_once('extension/manifest.json', '"version": "0.5.149"', '"version": "0.5.150"')
replace_once('extension/package.json', '"version": "0.5.149"', '"version": "0.5.150"')
replace_once('native-core/Cargo.toml', 'version = "0.5.149"', 'version = "0.5.150"')

cargo = Path('native-core/Cargo.lock')
cargo_text = cargo.read_text(encoding='utf-8')
marker = 'name = "gptwork-core"\nversion = "0.5.149"'
if cargo_text.count(marker) != 1:
    raise SystemExit(f'native-core/Cargo.lock: expected one gptwork-core v0.5.149 marker, found {cargo_text.count(marker)}')
cargo.write_text(cargo_text.replace(marker, 'name = "gptwork-core"\nversion = "0.5.150"', 1), encoding='utf-8')

replace_once('packaging/windows/GPTWork.iss', '#define MyAppVersion "0.5.149"', '#define MyAppVersion "0.5.150"')

test_path = Path('extension/tests/v05150-picker-a-network-defer.test.mjs')
test_path.write_text("""import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const content = await readFile(new URL('../content.js', import.meta.url), 'utf8');
const background = await readFile(new URL('../background.js', import.meta.url), 'utf8');
const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const cargoToml = await readFile(new URL('../../native-core/Cargo.toml', import.meta.url), 'utf8');
const cargoLock = await readFile(new URL('../../native-core/Cargo.lock', import.meta.url), 'utf8');
const installer = await readFile(new URL('../../packaging/windows/GPTWork.iss', import.meta.url), 'utf8');

test('v0.5.150 defers only the exact owned redesigned Picker A row when trusted hit-testing is unavailable', () => {
  const start = content.indexOf(\"const attempted = await modelPickerPointer(candidate, 'click', 'verification-model-row')\");
  const end = content.indexOf('// Never keep using the pre-click row as a liveness authority.', start);
  assert.ok(start >= 0 && end > start);
  const block = content.slice(start, end);
  assert.match(block, /networkDeferredAfterPointerReject = modern\\.pickerMode === 'A'/);
  assert.match(block, /desired === 'gpt-5\\.5' \\|\\| desired === 'gpt-5\\.6-sol'/);
  assert.match(block, /candidate\\.isConnected/);
  assert.match(block, /visible\\(candidate\\)/);
  assert.match(block, /modern\\.picker\\?\\.contains\\?\\.\\(candidate\\) === true/);
  assert.match(block, /owned_picker_a_row_pointer_hit_test_unavailable/);
  assert.match(block, /return \\{ attempted: true, observation, uiConfirmed: false, networkDeferred: true \\}/);
});

test('v0.5.150 keeps Picker B and trusted-pointer ownership strict', () => {
  assert.match(content, /if \\(!networkDeferredAfterPointerReject\\) return \\{ attempted: false/);
  assert.match(content, /function pointerStillOwnsPoint/);
  assert.match(content, /hit === element \\|\\| element\\.contains\\?\\.\\(hit\\)/);
  assert.match(content, /rejected_unstable_hit_test/);
  assert.match(background, /if \\(selection\\.selectionAttempted !== true && item\\.pickerMode === 'B'/);
  assert.match(background, /if \\(!transportOnly && selection\\.selectionAttempted !== true\\) throw new Error\\('Model selection control was not activated'\\)/);
});

test('v0.5.150 release version surfaces stay synchronized', () => {
  assert.equal(manifest.version, '0.5.150');
  assert.equal(pkg.version, '0.5.150');
  assert.match(background, /const RUNTIME_CODE_VERSION = '0\\.5\\.150'/);
  assert.match(cargoToml, /version = \"0\\.5\\.150\"/);
  assert.match(cargoLock, /name = \"gptwork-core\"\\nversion = \"0\\.5\\.150\"/);
  assert.match(installer, /#define MyAppVersion \"0\\.5\\.150\"/);
});
""", encoding='utf-8')
