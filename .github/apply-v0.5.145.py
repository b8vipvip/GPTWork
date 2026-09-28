from pathlib import Path
import json
import urllib.request


def replace_once(text, old, new, label):
    if old not in text:
        raise SystemExit(f"missing patch anchor: {label}")
    return text.replace(old, new, 1)


# content.js: redesigned direct Chat picker + network-deferred UI acknowledgement.
p = Path("extension/content.js")
s = p.read_text(encoding="utf-8")
direct_fn = '''  function defaultChatDirectModelRows(picker) {
    if (!picker || !visible(picker)) return [];
    // 2026-09 ChatGPT redesign: the top-level composer menu itself contains the
    // two Chat models and an accessible Select-model control. The model rows are
    // already authoritative; clicking the nested opener leaves this valid list.
    if (picker.matches?.('[data-testid="composer-intelligence-picker-content"]')) return [];
    const rows = distinctModelRows(picker);
    const models = new Set(rows.map((row) => rowModelDescriptor(row).model).filter(Boolean));
    if (models.size !== 2 || !models.has('gpt-5.5') || !models.has('gpt-5.6-sol')) return [];
    return rows.filter((row) => {
      const model = rowModelDescriptor(row).model;
      return model === 'gpt-5.5' || model === 'gpt-5.6-sol';
    });
  }

'''
if "function defaultChatDirectModelRows(picker)" not in s:
    s = replace_once(s, "  function advancedPickerView(picker) {", direct_fn + "  function advancedPickerView(picker) {", "direct picker helper")

old = '''    const initialOpener = modelSubmenuOpener(picker);
    const initialAdvanced = advancedPickerToggle(picker);'''
new = '''    const redesignedDirectRows = defaultChatDirectModelRows(picker);
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

    const initialOpener = modelSubmenuOpener(picker);
    const initialAdvanced = advancedPickerToggle(picker);'''
if "picker-mode-a-redesigned-direct-chat-list" not in s:
    s = replace_once(s, old, new, "redesigned picker early authority")

old = '''      const observation = collectObservation();
      pointerTrace(confirmed ? 'verification_model_selection_confirmed' : 'verification_model_selection_unconfirmed', {
        source: 'verification-model-row', desired, selectorKey: wantedKey, label: wantedLabel,
        observation,
      });
      if (!confirmed) {
        await closeModelMenus(modern.trigger);
        return { attempted: false, observation };
      }
      return { attempted: true, observation };'''
new = '''      const observation = collectObservation();
      const networkDeferred = !confirmed
        && modern.pickerMode === 'A'
        && (desired === 'gpt-5.5' || desired === 'gpt-5.6-sol');
      pointerTrace(
        confirmed
          ? 'verification_model_selection_confirmed'
          : networkDeferred
            ? 'verification_model_selection_deferred_to_network'
            : 'verification_model_selection_unconfirmed',
        {
          source: 'verification-model-row', desired, selectorKey: wantedKey, label: wantedLabel,
          pickerMode: modern.pickerMode || null,
          observation,
        },
      );
      if (!confirmed && !networkDeferred) {
        await closeModelMenus(modern.trigger);
        return { attempted: false, observation, uiConfirmed: false };
      }
      return { attempted: true, observation, uiConfirmed: confirmed };'''
if "verification_model_selection_deferred_to_network" not in s:
    s = replace_once(s, old, new, "network deferred selection")
p.write_text(s, encoding="utf-8")


# background.js: hidden Work profiles confirmed by exact default_model_slug.
p = Path("extension/background.js")
s = p.read_text(encoding="utf-8")
s = replace_once(s, "const RUNTIME_CODE_VERSION = '0.5.144';", "const RUNTIME_CODE_VERSION = '0.5.145';", "runtime version")
old = '''      let selectionResponse = await sendTabMessage(tabId, { type: 'GPTLOCK_VERIFY_ACCOUNT_MODEL', model: item.model, selectorKey: item.selectorKey, label: item.label });
      let selection = selectionResponse?.result || {};'''
new = '''      const transportOnly = item.selectorKey === '__work_transport__';
      let selectionResponse = null;
      let selection = { selectionAttempted: false, observation: state.pageObservation || null };
      if (!transportOnly) {
        selectionResponse = await sendTabMessage(tabId, { type: 'GPTLOCK_VERIFY_ACCOUNT_MODEL', model: item.model, selectorKey: item.selectorKey, label: item.label });
        selection = selectionResponse?.result || {};
      }'''
if "const transportOnly = item.selectorKey === '__work_transport__';" not in s:
    s = replace_once(s, old, new, "transport-only selection bypass")
if "if (!transportOnly && selection.selectionAttempted !== true)" not in s:
    s = replace_once(
        s,
        "      if (selection.selectionAttempted !== true) throw new Error('Model selection control was not activated');",
        "      if (!transportOnly && selection.selectionAttempted !== true) throw new Error('Model selection control was not activated');\n      if (transportOnly) logRuntime('info', 'verification', 'verification_hidden_work_transport_probe', { tabId, model: item.model });",
        "transport-only selection authority",
    )
old = '''        // Do not reload/stop/recover this bootstrap turn. A failed product Work request
        // is evidence that the transition did not happen; recovery must not become a
        // second authority that mutates the page.
        let workCatalog = null;'''
new = '''        // Do not reload/stop/recover this bootstrap turn. The redesigned composer may
        // keep the visible two-row Chat picker even after normal Work policy activates.
        // Preserve the activation turn's independent response authority before DOM
        // rediscovery; exact default_model_slug is the Work-profile identity contract.
        const activationRewrite = state.lastRewrite;
        const activationResponse = state.lastResponseEvidence;
        const activationTarget = normalizeConcreteModelId(activationRewrite?.modelAfter);
        const activationDefaultModel = normalizeConcreteModelId(activationResponse?.defaultModel);
        const activationWorkConfirmed = Boolean(
          activationSettled?.settled === true
            && activationRewrite?.authorityKind === 'normal-policy'
            && activationRewrite?.requestId
            && activationResponse?.requestId === activationRewrite.requestId
            && activationTarget
            && modelTransportId(activationTarget) !== activationTarget
            && activationDefaultModel === activationTarget
        );
        let workCatalog = null;'''
if "const activationWorkConfirmed = Boolean(" not in s:
    s = replace_once(s, old, new, "work activation response authority")
old = '''        const entered = activationSettled?.settled === true && workCatalog?.pickerMode === 'B';
        const addedFromB = entered ? mergeCatalog(workCatalog, 'work-picker-b') : 0;
        progress.workDiscovery = {
          attempted: true,
          entered,
          reason: entered ? 'normal_work_turn_picker_b_observed'
            : activationSettled?.interrupted === true ? 'normal_work_turn_interrupted'
              : activationSettled?.settled === true ? 'picker_b_not_observed'
                : 'normal_work_turn_not_settled',
          runtimeEnabled: true,
          source: 'normal_work_policy_request',
          pickerMode: workCatalog?.pickerMode ?? null,
          added: addedFromB,
        };
        logRuntime(entered ? 'info' : 'warn', 'verification', 'verification_work_mode_transition', {
          tabId, phase: 'post_gpt_5_6_sol', entered,
          source: 'normal_work_policy_request',
          reason: progress.workDiscovery.reason,
          pickerMode: workCatalog?.pickerMode ?? null,
          added: addedFromB,
        });
        workActivationPending = false;
        if (addedFromB) stablePasses = 0;'''
new = '''        const pickerBEntered = activationSettled?.settled === true && workCatalog?.pickerMode === 'B';
        let addedFromWork = pickerBEntered ? mergeCatalog(workCatalog, 'work-picker-b') : 0;
        if (!pickerBEntered && activationWorkConfirmed) {
          addedFromWork += mergeCatalog({
            pickerMode: null,
            reasoningLevels: workCatalog?.reasoningLevels || [],
            rows: [
              ['gpt-5.6-luna','GPT-5.6 Luna'],
              ['gpt-5.6-terra','GPT-5.6 Terra'],
              ['gpt-6-astra','GPT-6 Astra'],
              ['gpt-6-luna','GPT-6 Luna'],
              ['gpt-6-sol','GPT-6 Sol'],
            ].map(([model,label]) => ({ model, rawId:model, label, selectorKey:'__work_transport__', pickerMode:null })),
          }, 'work-response-hidden');
        }
        const entered = pickerBEntered || activationWorkConfirmed;
        progress.workDiscovery = {
          attempted: true,
          entered,
          reason: pickerBEntered ? 'normal_work_turn_picker_b_observed'
            : activationWorkConfirmed ? 'normal_work_turn_work_profile_confirmed_by_default_model'
              : activationSettled?.interrupted === true ? 'normal_work_turn_interrupted'
                : activationSettled?.settled === true ? 'picker_b_not_observed_and_work_response_unconfirmed'
                  : 'normal_work_turn_not_settled',
          runtimeEnabled: true,
          source: activationWorkConfirmed && !pickerBEntered ? 'normal_work_response_default_model' : 'normal_work_policy_request',
          pickerMode: workCatalog?.pickerMode ?? null,
          added: addedFromWork,
          activationTarget,
          activationDefaultModel,
          activationWorkConfirmed,
        };
        logRuntime(entered ? 'info' : 'warn', 'verification', 'verification_work_mode_transition', {
          tabId, phase: 'post_gpt_5_6_sol', entered,
          source: progress.workDiscovery.source,
          reason: progress.workDiscovery.reason,
          pickerMode: workCatalog?.pickerMode ?? null,
          added: addedFromWork,
          activationTarget,
          activationDefaultModel,
          activationWorkConfirmed,
        });
        workActivationPending = false;
        if (addedFromWork) stablePasses = 0;'''
if "picker_b_not_observed_and_work_response_unconfirmed" not in s:
    s = replace_once(s, old, new, "hidden Work transition fallback")
p.write_text(s, encoding="utf-8")


# network-monitor.js: recover response identity from HTTP-200 ERR_ABORTED SSE.
p = Path("extension/network-monitor.js")
s = p.read_text(encoding="utf-8")
if "RESPONSE_STREAM_CAPTURE_MAX_BYTES" not in s:
    s = replace_once(s, "const PROVISIONAL_STREAM_WINDOW_MS = 12 * 1000;\n", "const PROVISIONAL_STREAM_WINDOW_MS = 12 * 1000;\nconst RESPONSE_STREAM_CAPTURE_MAX_BYTES = 4 * 1024 * 1024;\n", "stream cap")
helper = '''function decodeBase64Chunks(chunks = []) {
  const parts = [];
  let total = 0;
  for (const encoded of chunks) {
    if (typeof encoded !== 'string' || !encoded) continue;
    try {
      const binary = atob(encoded);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      parts.push(bytes);
      total += bytes.length;
    } catch {}
  }
  if (!total) return '';
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) { merged.set(part, offset); offset += part.length; }
  return new TextDecoder().decode(merged);
}

'''
if "function decodeBase64Chunks" not in s:
    s = replace_once(s, "export function hasCompleteResponseEvidence(evidence) {", helper + "export function hasCompleteResponseEvidence(evidence) {", "stream decode helper")
old = '''    } else if (method === 'Network.responseReceived') {
      this.handleResponse(tabId, params);
    } else if (method === 'Network.loadingFinished') {
      await this.handleFinished(tabId, params);
    } else if (method === 'Network.loadingFailed') {
      this.handleFailed(tabId, params);'''
new = '''    } else if (method === 'Network.responseReceived') {
      await this.handleResponse(tabId, params);
    } else if (method === 'Network.dataReceived') {
      this.handleDataReceived(tabId, params);
    } else if (method === 'Network.loadingFinished') {
      await this.handleFinished(tabId, params);
    } else if (method === 'Network.loadingFailed') {
      await this.handleFailed(tabId, params);'''
if "method === 'Network.dataReceived'" not in s:
    s = replace_once(s, old, new, "network event dispatch")
stream_methods = '''  appendResponseStreamChunk(record, encoded) {
    if (!record || typeof encoded !== 'string' || !encoded || record.streamCaptureOverflowed) return;
    const estimatedBytes = Math.floor((encoded.length * 3) / 4);
    if ((record.streamCaptureBytes || 0) + estimatedBytes > RESPONSE_STREAM_CAPTURE_MAX_BYTES) {
      record.streamCaptureOverflowed = true;
      return;
    }
    if (!Array.isArray(record.streamChunks)) record.streamChunks = [];
    record.streamChunks.push(encoded);
    record.streamCaptureBytes = (record.streamCaptureBytes || 0) + estimatedBytes;
  }

  responseStreamBody(record) {
    return decodeBase64Chunks(record?.streamChunks || []);
  }

  handleDataReceived(tabId, params) {
    if (typeof params.data !== 'string' || !params.data) return;
    const record = this.requests.get(this.key(tabId, String(params.requestId)));
    if (!record?.streamCaptureStarted) return;
    this.appendResponseStreamChunk(record, params.data);
  }

'''
if "appendResponseStreamChunk(record, encoded)" not in s:
    s = replace_once(s, "  handleResponse(tabId, params) {", stream_methods + "  async handleResponse(tabId, params) {", "stream capture methods")
elif "  handleResponse(tabId, params) {" in s:
    s = s.replace("  handleResponse(tabId, params) {", "  async handleResponse(tabId, params) {", 1)
capture = '''    if (record.responseVerificationEnabled && !record.streamCaptureStarted) {
      record.streamCaptureStarted = true;
      record.streamChunks = [];
      record.streamCaptureBytes = 0;
      record.streamCaptureOverflowed = false;
      record.streamCaptureError = null;
      try {
        const streamed = await debuggerCall(
          'sendCommand',
          this.target(tabId),
          'Network.streamResourceContent',
          { requestId: record.requestId },
        );
        this.appendResponseStreamChunk(record, streamed?.bufferedData ?? '');
      } catch (error) {
        record.streamCaptureError = safeError(error);
      }
    }
'''
if "Network.streamResourceContent" not in s:
    s = replace_once(s, "    record.status = params.response?.status ?? null;\n", "    record.status = params.response?.status ?? null;\n" + capture, "start response stream capture")
if "const streamedBody = this.responseStreamBody(record);" not in s:
    s = replace_once(s, '''    } catch (error) {
      bodyError = safeError(error);
    }

    const handoff = this.resolveFinishedHandoff(tabId, record, body);''', '''    } catch (error) {
      bodyError = safeError(error);
    }
    const streamedBody = this.responseStreamBody(record);
    if ((!body || bodyError) && streamedBody) {
      body = streamedBody;
      bodyError = null;
    }

    const handoff = this.resolveFinishedHandoff(tabId, record, body);''', "finished stream fallback")
if "streamCaptureBytes: record.streamCaptureBytes || 0" not in s:
    s = replace_once(s, '''      stage: record.downstream ? 'downstream_http' : 'initial_conversation',
      streamHandoff,
      ...evidence.diagnostics,''', '''      stage: record.downstream ? 'downstream_http' : 'initial_conversation',
      streamHandoff,
      streamCaptureBytes: record.streamCaptureBytes || 0,
      streamCaptureOverflowed: record.streamCaptureOverflowed === true,
      streamCaptureError: record.streamCaptureError || null,
      ...evidence.diagnostics,''', "finished stream diagnostics")
# Current GPTWork extracted defaultModel but failed to forward it through network-monitor.
old = '''      status: record.status,
      model: evidence.model,
      reasoning: evidence.reasoning,'''
new = '''      status: record.status,
      model: evidence.model,
      defaultModel: evidence.defaultModel,
      defaultModelField: evidence.defaultModelField,
      reasoning: evidence.reasoning,'''
if "defaultModel: evidence.defaultModel" not in s:
    s = replace_once(s, old, new, "finished default model propagation")
old_failed = '''  handleFailed(tabId, params) {
    const key = this.key(tabId, String(params.requestId));
    const record = this.requests.get(key);
    if (!record) return;
    this.requests.delete(key);
    if (!record.responseVerificationEnabled) return;
    this.onFailure(tabId, {
      requestId: record.requestId,
      error: params.errorText || 'network_loading_failed',
      canceled: Boolean(params.canceled),
      endpoint: record.endpoint,
      httpStatus: record.status,
      downstream: Boolean(record.downstream),
    });
  }'''
new_failed = '''  async handleFailed(tabId, params) {
    const key = this.key(tabId, String(params.requestId));
    const record = this.requests.get(key);
    if (!record) return;
    this.requests.delete(key);
    if (!record.responseVerificationEnabled) return;

    const recoveredBody = this.responseStreamBody(record);
    if (Boolean(params.canceled) && Number(record.status) === 200 && recoveredBody) {
      const handoff = this.resolveFinishedHandoff(tabId, record, recoveredBody);
      if (this.downstreamResponseMatchesHandoff(record, recoveredBody, handoff)) {
        const evidence = extractResponseEvidence({
          body: recoveredBody,
          headers: record.responseHeaders,
          mimeType: record.mimeType,
        });
        const streamHandoff = !record.downstream && handoff ? publicStreamHandoff(handoff) : null;
        const streamContext = handoff
          ? this.streamContext(handoff, {
            isDownstream: Boolean(record.downstream),
            transport: 'sse',
            direction: 'received',
            stage: record.downstream ? 'downstream_http_aborted' : 'initial_conversation_aborted',
            matchBasis: record.matchBasis ?? (record.downstream ? 'handoff_marker' : 'formal_request'),
          })
          : null;
        const diagnostics = {
          endpoint: record.endpoint,
          httpStatus: record.status,
          transport: 'sse',
          direction: 'received',
          stage: record.downstream ? 'downstream_http_aborted' : 'initial_conversation_aborted',
          terminalEvent: 'loadingFailed',
          networkError: params.errorText || 'network_loading_failed',
          streamHandoff,
          streamCaptureBytes: record.streamCaptureBytes || 0,
          streamCaptureOverflowed: record.streamCaptureOverflowed === true,
          streamCaptureError: record.streamCaptureError || null,
          ...evidence.diagnostics,
        };
        if (hasResponseMetadataEvidence(evidence)) {
          this.onEvidence(tabId, {
            requestId: record.requestId,
            capturedAt: new Date().toISOString(),
            status: record.status,
            model: evidence.model,
            defaultModel: evidence.defaultModel,
            defaultModelField: evidence.defaultModelField,
            reasoning: evidence.reasoning,
            conflicts: evidence.conflicts,
            fields: evidence.fields,
            bodyError: null,
            rawResponseBody: recoveredBody,
            streamContext,
            diagnostics,
          });
          return;
        }
        this.onStreamData?.(tabId, {
          requestId: record.requestId,
          capturedAt: new Date().toISOString(),
          rawStreamData: recoveredBody,
          diagnostics: { ...diagnostics, verificationSuppressedReason: 'aborted_partial_metadata_incomplete' },
          streamContext,
        });
      }
    }

    this.onFailure(tabId, {
      requestId: record.requestId,
      error: params.errorText || 'network_loading_failed',
      canceled: Boolean(params.canceled),
      endpoint: record.endpoint,
      httpStatus: record.status,
      downstream: Boolean(record.downstream),
    });
  }'''
if "const recoveredBody = this.responseStreamBody(record);" not in s:
    s = replace_once(s, old_failed, new_failed, "aborted response recovery")
p.write_text(s, encoding="utf-8")


# Copy the live-validated standalone compatibility files from ModelPro v0.1.44 main.
def download(url, path):
    with urllib.request.urlopen(url, timeout=30) as response:
        data = response.read().decode("utf-8")
    Path(path).write_text(data, encoding="utf-8")


download("https://raw.githubusercontent.com/b8vipvip/ModelPro/main/extension/page-model-evidence.js", "extension/page-model-evidence.js")
download("https://raw.githubusercontent.com/b8vipvip/ModelPro/main/extension/composer-send-compat.js", "extension/composer-send-compat.js")
p = Path("extension/composer-send-compat.js")
p.write_text(p.read_text(encoding="utf-8").replace("modelproSendCompat", "gptworkSendCompat"), encoding="utf-8")


# Coordinated package/version + load order.
p = Path("extension/manifest.json")
m = json.loads(p.read_text(encoding="utf-8"))
m["version"] = "0.5.145"
scripts = m["content_scripts"][0]["js"]
if "composer-send-compat.js" not in scripts:
    scripts.insert(scripts.index("astra-model-evidence.js") + 1, "composer-send-compat.js")
p.write_text(json.dumps(m, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

p = Path("extension/package.json")
pkg = json.loads(p.read_text(encoding="utf-8"))
pkg["version"] = "0.5.145"
cmd = pkg["scripts"]["test"]
if "node --check composer-send-compat.js" not in cmd:
    cmd = cmd.replace("node --check astra-model-evidence.js &&", "node --check astra-model-evidence.js && node --check composer-send-compat.js &&", 1)
pkg["scripts"]["test"] = cmd
p.write_text(json.dumps(pkg, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

for file, old, new in [
    ("native-core/Cargo.toml", 'version = "0.5.144"', 'version = "0.5.145"'),
    ("native-core/Cargo.lock", 'version = "0.5.144"', 'version = "0.5.145"'),
    ("packaging/windows/GPTWork.iss", '#define MyAppVersion "0.5.144"', '#define MyAppVersion "0.5.145"'),
]:
    p = Path(file)
    text = p.read_text(encoding="utf-8")
    if old not in text:
        raise SystemExit(f"missing version anchor: {file}")
    p.write_text(text.replace(old, new, 1), encoding="utf-8")


test = Path("extension/tests/modelpro-v0144-redesign-sync.test.mjs")
test.write_text(r'''import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const r = (path) => readFile(new URL('../' + path, import.meta.url), 'utf8');

test('v0.5.145 ports live-validated ModelPro v0.1.44 redesign authority', async () => {
  const [background, content, network, evidence, manifestText, packageText] = await Promise.all([
    r('background.js'), r('content.js'), r('network-monitor.js'), r('page-model-evidence.js'),
    r('manifest.json'), r('package.json'),
  ]);
  const manifest = JSON.parse(manifestText);
  const pkg = JSON.parse(packageText);
  assert.equal(manifest.version, '0.5.145');
  assert.equal(pkg.version, '0.5.145');
  assert.ok(manifest.content_scripts[0].js.includes('composer-send-compat.js'));
  assert.match(content, /picker-mode-a-redesigned-direct-chat-list/);
  assert.match(content, /verification_model_selection_deferred_to_network/);
  assert.match(evidence, /composer-redesign-default-sol/);
  assert.match(evidence, /open-picker-default-sol/);
  assert.match(network, /Network\.streamResourceContent/);
  assert.match(network, /initial_conversation_aborted/);
  assert.match(network, /defaultModel: evidence\.defaultModel/);
  assert.match(background, /__work_transport__/);
  assert.match(background, /normal_work_turn_work_profile_confirmed_by_default_model/);
  assert.match(background, /activationDefaultModel === activationTarget/);
  for (const model of ['gpt-5.6-luna','gpt-5.6-terra','gpt-6-astra','gpt-6-luna','gpt-6-sol']) {
    assert.ok(background.includes(model));
  }
});
''', encoding="utf-8")
