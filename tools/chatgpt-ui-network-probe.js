(() => {
  'use strict';

  const KEY = '__GPTWORK_CHATGPT_PROBE__';
  const VERSION = '2026.09.25.1';
  const existing = globalThis[KEY];
  if (existing?.active) {
    console.warn('[GPTWork probe] already running. Use __GPTWORK_CHATGPT_PROBE__.download() or .stop().');
    return;
  }

  const startedAt = new Date().toISOString();
  const MAX_EVENTS = 1200;
  const MAX_SNAPSHOTS = 180;
  const MAX_NETWORK = 300;
  const MODEL_KEY_RE = /(model|default_model|resolved_model|model_slug|thinking|reasoning|effort)/i;
  const CONVERSATION_RE = /\/backend-api\/(?:f\/)?conversation(?:\?|$|\/)/i;
  const COMPOSER_SELECTORS = [
    '#prompt-textarea',
    'textarea[data-testid*="prompt" i]',
    '[contenteditable="true"][data-testid*="composer" i]',
    '.ProseMirror[contenteditable="true"]',
    '[contenteditable="true"]',
  ];
  const MODELISH_SELECTORS = [
    '[data-testid*="model" i]',
    '[data-model]',
    '[data-model-id]',
    'button[class*="composer-pill"]',
    '[role="menuitemradio"][aria-checked="true"]',
    '[role="option"][aria-selected="true"]',
    '[aria-checked="true"]',
    '[aria-selected="true"]',
    '[data-state="checked"]',
    '[data-state="selected"]',
  ];
  const POPUP_SELECTORS = [
    '[role="menu"]',
    '[role="listbox"]',
    '[role="dialog"]',
    '[data-radix-menu-content]',
    '[data-radix-popper-content-wrapper]',
    '[data-radix-collection-item]',
  ];

  const state = {
    version: VERSION,
    startedAt,
    hrefAtStart: location.href,
    userAgent: navigator.userAgent,
    viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
    events: [],
    snapshots: [],
    network: [],
    counters: {
      mutations: 0,
      snapshots: 0,
      clicks: 0,
      pointerdowns: 0,
      fetches: 0,
      xhrs: 0,
      beacons: 0,
    },
    active: true,
  };

  const original = {
    fetch: globalThis.fetch,
    xhrOpen: XMLHttpRequest.prototype.open,
    xhrSend: XMLHttpRequest.prototype.send,
    beacon: navigator.sendBeacon?.bind(navigator) || null,
    pushState: history.pushState,
    replaceState: history.replaceState,
  };

  const iso = () => new Date().toISOString();
  const limit = (value, max = 220) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

  function pushCapped(target, item, max) {
    target.push(item);
    if (target.length > max) target.splice(0, target.length - max);
  }

  function logEvent(type, details = {}) {
    pushCapped(state.events, { at: iso(), type, ...details }, MAX_EVENTS);
  }

  function rectOf(element) {
    try {
      const r = element.getBoundingClientRect();
      return {
        x: Math.round(r.x),
        y: Math.round(r.y),
        width: Math.round(r.width),
        height: Math.round(r.height),
        top: Math.round(r.top),
        bottom: Math.round(r.bottom),
        left: Math.round(r.left),
        right: Math.round(r.right),
      };
    } catch {
      return null;
    }
  }

  function visible(element) {
    if (!(element instanceof Element) || !element.isConnected) return false;
    const rect = rectOf(element);
    if (!rect || rect.width <= 0 || rect.height <= 0) return false;
    let style;
    try { style = getComputedStyle(element); } catch { return false; }
    return style.display !== 'none'
      && style.visibility !== 'hidden'
      && Number(style.opacity || 1) !== 0
      && rect.bottom > 0
      && rect.right > 0
      && rect.top < innerHeight
      && rect.left < innerWidth;
  }

  function cssPath(element) {
    if (!(element instanceof Element)) return '';
    const parts = [];
    let node = element;
    for (let depth = 0; node && depth < 7 && node.nodeType === 1; depth += 1, node = node.parentElement) {
      let part = node.tagName.toLowerCase();
      if (node.id) {
        part += '#' + CSS.escape(node.id);
        parts.unshift(part);
        break;
      }
      const testid = node.getAttribute('data-testid');
      if (testid) part += '[data-testid="' + limit(testid, 80).replace(/"/g, '\\"') + '"]';
      else {
        const role = node.getAttribute('role');
        if (role) part += '[role="' + limit(role, 40).replace(/"/g, '\\"') + '"]';
        if (node.parentElement) {
          const siblings = [...node.parentElement.children].filter((x) => x.tagName === node.tagName);
          if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
        }
      }
      parts.unshift(part);
    }
    return parts.join(' > ');
  }

  function attrsOf(element) {
    const names = [
      'id', 'class', 'role', 'aria-label', 'aria-haspopup', 'aria-expanded', 'aria-controls',
      'aria-checked', 'aria-selected', 'title', 'data-testid', 'data-state', 'data-model',
      'data-model-id', 'data-value', 'data-slot', 'data-type',
    ];
    const out = {};
    for (const name of names) {
      const value = element?.getAttribute?.(name);
      if (value) out[name] = limit(value, 240);
    }
    return out;
  }

  function elementInfo(element) {
    if (!(element instanceof Element)) return null;
    const text = limit(element.innerText || element.textContent || '', 260);
    return {
      tag: element.tagName.toLowerCase(),
      text,
      attrs: attrsOf(element),
      rect: rectOf(element),
      path: cssPath(element),
    };
  }

  function normalizeModelText(value) {
    const text = String(value || '').toLowerCase().replace(/[\u200b-\u200d\ufeff]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!text) return null;

    const explicitTier = text.match(/(?:^|[^a-z0-9])gpt[\s-]?(\d+(?:\.\d+)*)(?:[\s-]+(astra|pro|sol|terra|luna))?(?:[\s-]+wm)?(?=$|[^a-z0-9])/i);
    if (explicitTier) return 'gpt-' + explicitTier[1] + (explicitTier[2] ? '-' + explicitTier[2].toLowerCase() : '');

    const bareTier = text.match(/(?:^|[^a-z0-9])(\d+(?:\.\d+)*)(?:[\s-]+(astra|pro|sol|terra|luna))(?:[\s-]+wm)?(?=$|[^a-z0-9])/i);
    if (bareTier) return 'gpt-' + bareTier[1] + '-' + bareTier[2].toLowerCase();

    return null;
  }

  function modelFromElement(element) {
    if (!(element instanceof Element)) return null;
    const values = [
      element.getAttribute('data-model'),
      element.getAttribute('data-model-id'),
      element.getAttribute('data-value'),
      element.getAttribute('aria-label'),
      element.getAttribute('title'),
      element.innerText,
      element.textContent,
    ].filter(Boolean);
    for (const value of values) {
      const model = normalizeModelText(value);
      if (model) return model;
    }
    return null;
  }

  function findComposer() {
    for (const selector of COMPOSER_SELECTORS) {
      const element = [...document.querySelectorAll(selector)].find(visible);
      if (element) return element;
    }
    return null;
  }

  function composerRoot(composer) {
    if (!composer) return null;
    const form = composer.closest('form');
    if (form && visible(form)) return form;
    const testRoot = composer.closest('[data-testid*="composer" i]');
    if (testRoot && visible(testRoot)) return testRoot;
    let node = composer.parentElement;
    for (let i = 0; node && i < 5; i += 1, node = node.parentElement) {
      if (visible(node) && node.querySelectorAll('button,[role="button"],[aria-haspopup]').length >= 2) return node;
    }
    return composer.parentElement;
  }

  function nearestInteractive(element) {
    return element?.closest?.('button,[role="button"],[role="menuitem"],[role="menuitemradio"],[role="option"],[aria-haspopup],[data-radix-collection-item]') || null;
  }

  function uniqueElements(elements) {
    return [...new Set(elements.filter(Boolean))];
  }

  function visiblePopups() {
    const all = [];
    for (const selector of POPUP_SELECTORS) {
      for (const element of document.querySelectorAll(selector)) if (visible(element)) all.push(element);
    }
    return uniqueElements(all).slice(0, 40);
  }

  function relevantPageControls(root) {
    const local = root
      ? [...root.querySelectorAll('button,[role="button"],[aria-haspopup],[data-testid],[data-model],[data-model-id]')].filter(visible)
      : [];

    const explicit = [];
    for (const selector of MODELISH_SELECTORS) {
      for (const element of document.querySelectorAll(selector)) {
        if (visible(element)) explicit.push(element);
      }
    }

    const globalModelish = [...document.querySelectorAll('button,[role="button"],[aria-haspopup]')]
      .filter((element) => {
        if (!visible(element)) return false;
        const attrs = attrsOf(element);
        const combined = [
          element.innerText,
          element.textContent,
          attrs['aria-label'],
          attrs.title,
          attrs['data-testid'],
          attrs['data-model'],
          attrs['data-model-id'],
        ].filter(Boolean).join(' ');
        return Boolean(normalizeModelText(combined))
          || /model|模型|thinking|reasoning|推理|思考/i.test(combined)
          || element.getAttribute('aria-haspopup') === 'menu';
      })
      .slice(0, 80);

    return uniqueElements([...local, ...explicit, ...globalModelish]).slice(0, 100);
  }

  function indicatorSnapshot() {
    const host = document.querySelector('#gptlock-indicator-host,#gptwork-indicator-host');
    if (!host) return null;
    const root = host.shadowRoot || host;
    return {
      host: elementInfo(host),
      text: limit(root?.innerText || root?.textContent || '', 600),
      htmlHint: limit(root?.innerHTML || '', 900),
    };
  }

  function snapshot(reason = 'manual', force = false) {
    const composer = findComposer();
    const root = composerRoot(composer);
    const controls = relevantPageControls(root);
    const popups = visiblePopups();

    const controlRows = controls.map((element) => ({
      ...elementInfo(element),
      model: modelFromElement(element),
    }));
    const popupRows = popups.map((popup) => ({
      popup: elementInfo(popup),
      rows: [...popup.querySelectorAll('button,[role="button"],[role="menuitem"],[role="menuitemradio"],[role="option"],[data-radix-collection-item],[aria-checked],[aria-selected]')]
        .filter(visible)
        .slice(0, 60)
        .map((row) => ({ ...elementInfo(row), model: modelFromElement(row) })),
    }));

    const detectedModels = [...new Set([
      ...controlRows.map((x) => x.model),
      ...popupRows.flatMap((x) => x.rows.map((y) => y.model)),
    ].filter(Boolean))];

    const item = {
      at: iso(),
      reason,
      href: location.href,
      pathname: location.pathname,
      title: document.title,
      viewport: { width: innerWidth, height: innerHeight },
      composer: elementInfo(composer),
      composerRoot: elementInfo(root),
      controls: controlRows,
      popups: popupRows,
      detectedModels,
      indicator: indicatorSnapshot(),
    };

    const fingerprint = JSON.stringify({
      href: item.href,
      composer: item.composer?.path || null,
      controls: item.controls.map((x) => [x.path, x.text, x.model, x.attrs['aria-expanded'], x.attrs['data-state']]),
      popups: item.popups.map((x) => [x.popup?.path, x.rows.map((y) => [y.text, y.model, y.attrs['aria-checked'], y.attrs['aria-selected'], y.attrs['data-state']])]),
      detectedModels,
      indicator: item.indicator?.text || '',
    });

    if (!force && state.lastSnapshotFingerprint === fingerprint) return item;
    state.lastSnapshotFingerprint = fingerprint;
    state.counters.snapshots += 1;
    pushCapped(state.snapshots, item, MAX_SNAPSHOTS);
    console.debug('[GPTWork probe] snapshot', reason, { detectedModels, controls: controlRows.length, popups: popupRows.length });
    return item;
  }

  function relevantBody(body) {
    if (body == null) return null;

    function inspectObject(value, depth = 0) {
      if (depth > 6 || value == null) return null;
      if (Array.isArray(value)) {
        const rows = value.slice(0, 12).map((x) => inspectObject(x, depth + 1)).filter((x) => x != null);
        return rows.length ? rows : null;
      }
      if (typeof value !== 'object') return typeof value === 'string' ? limit(value, 180) : value;

      const out = {};
      for (const [key, raw] of Object.entries(value)) {
        if (MODEL_KEY_RE.test(key)) {
          if (raw == null || ['string', 'number', 'boolean'].includes(typeof raw)) out[key] = typeof raw === 'string' ? limit(raw, 220) : raw;
          else {
            const nested = inspectObject(raw, depth + 1);
            if (nested != null) out[key] = nested;
          }
          continue;
        }

        if (depth < 3 && raw && typeof raw === 'object') {
          const nested = inspectObject(raw, depth + 1);
          if (nested && (Array.isArray(nested) ? nested.length : Object.keys(nested).length)) out[key] = nested;
        }
      }
      return Object.keys(out).length ? out : null;
    }

    try {
      if (typeof body === 'string') {
        const parsed = JSON.parse(body);
        return {
          kind: 'json-string',
          length: body.length,
          topLevelKeys: parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? Object.keys(parsed).slice(0, 80) : [],
          relevant: inspectObject(parsed),
        };
      }
      if (body instanceof URLSearchParams) {
        return { kind: 'urlsearchparams', relevant: Object.fromEntries([...body.entries()].filter(([key]) => MODEL_KEY_RE.test(key)).slice(0, 40)) };
      }
      if (body instanceof FormData) {
        return { kind: 'formdata', keys: [...body.keys()].slice(0, 80) };
      }
      if (body instanceof Blob) return { kind: 'blob', type: body.type, size: body.size };
      if (ArrayBuffer.isView(body)) return { kind: body.constructor?.name || 'typed-array', byteLength: body.byteLength };
      if (body instanceof ArrayBuffer) return { kind: 'arraybuffer', byteLength: body.byteLength };
      return { kind: typeof body, value: limit(body, 180) };
    } catch (error) {
      return { kind: typeof body, parseError: limit(error?.message || error, 220), length: typeof body === 'string' ? body.length : null };
    }
  }

  function responseHeaders(headers) {
    const out = {};
    try {
      for (const [key, value] of headers.entries()) {
        if (/model|reason|thinking|content-type|openai|request-id/i.test(key)) out[key] = limit(value, 240);
      }
    } catch {}
    return out;
  }

  function networkRecord(kind, phase, data = {}) {
    const item = { at: iso(), kind, phase, ...data };
    pushCapped(state.network, item, MAX_NETWORK);
    console.debug('[GPTWork probe] network', kind, phase, item);
    return item;
  }

  function shouldCaptureUrl(url) {
    try {
      const parsed = new URL(String(url), location.href);
      return parsed.hostname === 'chatgpt.com' && CONVERSATION_RE.test(parsed.pathname + parsed.search);
    } catch {
      return false;
    }
  }

  async function captureRequestInput(input, init, kind) {
    const url = typeof input === 'string' || input instanceof URL ? String(input) : input?.url || '';
    if (!shouldCaptureUrl(url)) return;
    const method = String(init?.method || input?.method || 'GET').toUpperCase();
    let bodyInfo = null;

    if (init && Object.prototype.hasOwnProperty.call(init, 'body')) {
      bodyInfo = relevantBody(init.body);
    } else if (input instanceof Request) {
      try {
        const text = await input.clone().text();
        bodyInfo = relevantBody(text);
      } catch (error) {
        bodyInfo = { kind: 'request-clone-error', error: limit(error?.message || error, 220) };
      }
    }

    networkRecord(kind, 'request', {
      method,
      url: new URL(url, location.href).pathname,
      body: bodyInfo,
    });
    snapshot(kind + '-request', true);
  }

  globalThis.fetch = function probeFetch(input, init) {
    state.counters.fetches += 1;
    void captureRequestInput(input, init, 'fetch');
    const promise = original.fetch.apply(this, arguments);
    try {
      const url = typeof input === 'string' || input instanceof URL ? String(input) : input?.url || '';
      if (shouldCaptureUrl(url)) {
        Promise.resolve(promise).then((response) => {
          networkRecord('fetch', 'response', {
            url: new URL(url, location.href).pathname,
            status: response?.status ?? null,
            headers: response?.headers ? responseHeaders(response.headers) : {},
          });
        }, (error) => {
          networkRecord('fetch', 'response-error', { url: new URL(url, location.href).pathname, error: limit(error?.message || error, 220) });
        });
      }
    } catch {}
    return promise;
  };

  XMLHttpRequest.prototype.open = function probeXhrOpen(method, url) {
    this.__gptworkProbe = { method: String(method || 'GET').toUpperCase(), url: String(url || '') };
    return original.xhrOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function probeXhrSend(body) {
    state.counters.xhrs += 1;
    const meta = this.__gptworkProbe;
    if (meta && shouldCaptureUrl(meta.url)) {
      networkRecord('xhr', 'request', {
        method: meta.method,
        url: new URL(meta.url, location.href).pathname,
        body: relevantBody(body),
      });
      this.addEventListener('loadend', () => {
        networkRecord('xhr', 'response', {
          url: new URL(meta.url, location.href).pathname,
          status: this.status,
        });
      }, { once: true });
      snapshot('xhr-request', true);
    }
    return original.xhrSend.apply(this, arguments);
  };

  if (original.beacon) {
    try {
      navigator.sendBeacon = function probeBeacon(url, data) {
        state.counters.beacons += 1;
        if (shouldCaptureUrl(url)) {
          networkRecord('beacon', 'request', {
            url: new URL(String(url), location.href).pathname,
            body: relevantBody(data),
          });
          snapshot('beacon-request', true);
        }
        return original.beacon(url, data);
      };
    } catch {}
  }

  function routeChanged(source) {
    logEvent('route', { source, href: location.href });
    setTimeout(() => snapshot('route-' + source, true), 80);
  }

  history.pushState = function probePushState() {
    const result = original.pushState.apply(this, arguments);
    routeChanged('pushState');
    return result;
  };

  history.replaceState = function probeReplaceState() {
    const result = original.replaceState.apply(this, arguments);
    routeChanged('replaceState');
    return result;
  };

  const onPopState = () => routeChanged('popstate');
  addEventListener('popstate', onPopState, true);

  const onPointerDown = (event) => {
    state.counters.pointerdowns += 1;
    const interactive = nearestInteractive(event.target);
    logEvent('pointerdown', { x: Math.round(event.clientX), y: Math.round(event.clientY), target: elementInfo(interactive || event.target) });
  };
  const onClick = (event) => {
    state.counters.clicks += 1;
    const interactive = nearestInteractive(event.target);
    logEvent('click', { x: Math.round(event.clientX), y: Math.round(event.clientY), target: elementInfo(interactive || event.target) });
    setTimeout(() => snapshot('after-click', true), 100);
  };
  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('click', onClick, true);

  let scheduled = 0;
  function scheduleMutationSnapshot() {
    if (scheduled) return;
    scheduled = setTimeout(() => {
      scheduled = 0;
      snapshot('mutation');
    }, 280);
  }

  const observer = new MutationObserver((records) => {
    state.counters.mutations += records.length;
    let relevant = false;
    for (const record of records) {
      const target = record.target instanceof Element ? record.target : record.target?.parentElement;
      if (!target) continue;
      if (target.closest?.('form,[role="menu"],[role="listbox"],[role="dialog"],[data-radix-popper-content-wrapper]')) {
        relevant = true;
        break;
      }
      const text = limit(target.innerText || target.textContent || '', 120);
      if (/model|模型|astra|sol|terra|luna|gpt|thinking|reasoning|推理|思考/i.test(text)) {
        relevant = true;
        break;
      }
    }
    if (relevant) scheduleMutationSnapshot();
  });
  observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-expanded', 'aria-checked', 'aria-selected', 'data-state', 'data-model', 'data-model-id', 'data-testid'] });

  const interval = setInterval(() => snapshot('heartbeat'), 2500);

  function payload() {
    snapshot('export-final', true);
    return {
      ...state,
      active: state.active,
      exportedAt: iso(),
      durationMs: Date.now() - Date.parse(startedAt),
      lastSnapshotFingerprint: undefined,
    };
  }

  function download(filename) {
    const data = payload();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename || ('gptwork-chatgpt-probe-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json');
    document.documentElement.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 1000);
    console.info('[GPTWork probe] log exported:', a.download);
    return data;
  }

  function mark(label) {
    logEvent('mark', { label: limit(label, 160) });
    return snapshot('mark-' + limit(label, 80), true);
  }

  function stop() {
    if (!state.active) return payload();
    state.active = false;
    observer.disconnect();
    clearInterval(interval);
    if (scheduled) clearTimeout(scheduled);
    document.removeEventListener('pointerdown', onPointerDown, true);
    document.removeEventListener('click', onClick, true);
    removeEventListener('popstate', onPopState, true);
    try { globalThis.fetch = original.fetch; } catch {}
    try { XMLHttpRequest.prototype.open = original.xhrOpen; } catch {}
    try { XMLHttpRequest.prototype.send = original.xhrSend; } catch {}
    try { if (original.beacon) navigator.sendBeacon = original.beacon; } catch {}
    try { history.pushState = original.pushState; } catch {}
    try { history.replaceState = original.replaceState; } catch {}
    logEvent('probe-stopped');
    console.info('[GPTWork probe] stopped. Use __GPTWORK_CHATGPT_PROBE__.download() to export.');
    return payload();
  }

  globalThis[KEY] = Object.freeze({
    version: VERSION,
    get active() { return state.active; },
    snapshot: (reason = 'manual') => snapshot(reason, true),
    mark,
    download,
    data: payload,
    stop,
  });

  snapshot('probe-start', true);
  console.info(
    '%cGPTWork ChatGPT probe started',
    'font-weight:bold;color:#2563eb',
    '\nVersion:', VERSION,
    '\nIt records composer/model-picker DOM structure and sanitized conversation request model/reasoning fields only.',
    '\nAfter the test run: __GPTWORK_CHATGPT_PROBE__.download()'
  );
})();
