import { createHash, randomInt, timingSafeEqual } from 'node:crypto';

export const ZPAY_ORIGIN = 'https://zpayz.cn';
export const ZPAY_SUBMIT_URL = `${ZPAY_ORIGIN}/submit.php`;
export const ZPAY_API_URL = `${ZPAY_ORIGIN}/api.php`;

function cleanEntries(input) {
  const entries = input instanceof URLSearchParams ? [...input.entries()] : Object.entries(input || {});
  return entries
    .filter(([key, value]) => key !== 'sign' && key !== 'sign_type' && value !== null && value !== undefined && String(value) !== '')
    .map(([key, value]) => [String(key), String(value)])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

export function zpaySign(input, key) {
  const canonical = cleanEntries(input).map(([name, value]) => `${name}=${value}`).join('&');
  return createHash('md5').update(`${canonical}${String(key || '')}`, 'utf8').digest('hex');
}

export function verifyZpaySignature(input, key) {
  const provided = input instanceof URLSearchParams ? input.get('sign') : input?.sign;
  const signType = input instanceof URLSearchParams ? input.get('sign_type') : input?.sign_type;
  if (!provided || String(signType || '').toUpperCase() !== 'MD5') return false;
  const expected = zpaySign(input, key);
  const left = Buffer.from(String(provided).toLowerCase());
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function centsFromZpayMoney(value) {
  const raw = String(value ?? '').trim();
  if (!/^\d{1,9}(?:\.\d{1,2})?$/.test(raw)) return null;
  const [whole, fraction = ''] = raw.split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(cents) && cents >= 0 ? cents : null;
}

export function zpayMoneyFromCents(value) {
  const cents = Number(value);
  if (!Number.isSafeInteger(cents) || cents < 0) throw new Error('Invalid payment amount');
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

function compactText(value, max = 240) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function createApiError(message, code = 'ZPAY_API_ERROR') {
  const error = new Error(message);
  error.code = code;
  error.status = 502;
  return error;
}

function authFailureMessage(body) {
  const message = compactText(body?.msg || body?.message || body?.error || '');
  if (!message) return '';
  const normalized = message.toLowerCase();
  const patterns = [
    /商户.*(不存在|无效|禁用|封禁|异常)/,
    /(pid|商户id|商户号).*(错误|无效|不存在|不正确)/i,
    /(密钥|key).*(错误|无效|不正确|校验失败|验证失败)/i,
    /(鉴权|认证|授权).*(失败|错误|无效)/,
    /unauthori[sz]ed|authentication failed|invalid credentials?|invalid (merchant|pid|key)/i,
  ];
  return patterns.some((pattern) => pattern.test(message) || pattern.test(normalized)) ? message : '';
}

function makeProbeTradeNo() {
  const timestamp = String(Date.now());
  const suffix = String(randomInt(0, 1_000_000)).padStart(6, '0');
  return `99${timestamp}${suffix}`.padEnd(32, '0').slice(0, 32);
}

export function createZpayClient({ pid, key, fetchImpl = globalThis.fetch }) {
  const merchantId = String(pid || '').trim();
  const merchantKey = String(key || '');
  if (!merchantId || !merchantKey) throw new Error('ZPAY merchant credentials are incomplete');
  if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable');

  async function requestRaw(params) {
    const url = new URL(ZPAY_API_URL);
    for (const [name, value] of Object.entries(params)) url.searchParams.set(name, String(value));

    let response;
    try {
      response = await fetchImpl(url, { method: 'GET', headers: { accept: 'application/json' } });
    } catch (cause) {
      const detail = compactText(cause?.message || cause || 'network error');
      throw createApiError(`ZPAY API 网络连接失败：${detail}`, 'ZPAY_NETWORK_ERROR');
    }

    const text = await response.text().catch(() => '');
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch {}

    if (!response.ok) {
      const detail = compactText(body?.msg || body?.message || text);
      throw createApiError(detail ? `ZPAY API HTTP ${response.status}：${detail}` : `ZPAY API HTTP ${response.status}`);
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      const preview = compactText(text);
      throw createApiError(preview
        ? `ZPAY API 返回了非 JSON 响应（HTTP ${response.status}）：${preview}`
        : `ZPAY API 返回了空响应（HTTP ${response.status}）`, 'ZPAY_INVALID_RESPONSE');
    }
    return body;
  }

  async function request(params) {
    const body = await requestRaw(params);
    if (Number(body.code) !== 1) {
      throw createApiError(compactText(body?.msg) || `ZPAY API 返回错误 code=${String(body.code ?? '')}`);
    }
    return body;
  }

  async function probeCredentials() {
    const outTradeNo = makeProbeTradeNo();
    const body = await requestRaw({ act: 'order', pid: merchantId, key: merchantKey, out_trade_no: outTradeNo });
    if (Number(body.code) === 1) {
      return { ...body, balance: '', probe: 'order', credentialStatus: 'accepted' };
    }

    const authFailure = authFailureMessage(body);
    if (authFailure) throw createApiError(`ZPAY 商户凭据校验失败：${authFailure}`, 'ZPAY_AUTH_ERROR');

    // ZPAY's published API documents act=order, but not act=balance. A deliberately
    // nonexistent numeric order exercises the documented authenticated endpoint without
    // creating a payment. Any structured non-auth business response proves the gateway
    // and merchant API are reachable; callers can surface the upstream message for diagnostics.
    return {
      code: 1,
      msg: compactText(body?.msg) || `ZPAY API 已响应（upstream code=${String(body.code ?? '')}）`,
      balance: '',
      probe: 'order',
      credentialStatus: 'api_reachable',
      upstreamCode: body.code ?? null,
    };
  }

  return {
    probeCredentials,
    // Backward-compatible name used by the admin route. ZPAY does not publish an act=balance API;
    // keep this method so older callers continue to work while using the documented order probe.
    queryBalance: probeCredentials,
    queryOrder(outTradeNo) { return request({ act: 'order', pid: merchantId, key: merchantKey, out_trade_no: String(outTradeNo) }); },
  };
}
