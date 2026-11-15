export const DEFAULT_RESPONSE_EVIDENCE_TIMEOUT_MS = 120_000;

export function createResponseEvidenceWatchdog(
  key,
  now = Date.now(),
  timeoutMs = DEFAULT_RESPONSE_EVIDENCE_TIMEOUT_MS,
) {
  const normalizedKey = String(key ?? '').trim();
  const startedAt = Number(now);
  const timeout = Number(timeoutMs);
  if (!normalizedKey || !Number.isFinite(startedAt) || !Number.isFinite(timeout) || timeout <= 0) {
    return null;
  }
  return {
    key: normalizedKey,
    startedAt,
    lastActivityAt: startedAt,
    deadlineAt: startedAt + timeout,
    activityCount: 0,
  };
}

export function touchResponseEvidenceWatchdog(
  watchdog,
  key,
  now = Date.now(),
  timeoutMs = DEFAULT_RESPONSE_EVIDENCE_TIMEOUT_MS,
) {
  const normalizedKey = String(key ?? '').trim();
  const activityAt = Number(now);
  const timeout = Number(timeoutMs);
  if (!watchdog || watchdog.key !== normalizedKey
    || !Number.isFinite(activityAt) || !Number.isFinite(timeout) || timeout <= 0) {
    return watchdog;
  }
  return {
    ...watchdog,
    lastActivityAt: activityAt,
    deadlineAt: activityAt + timeout,
    activityCount: Math.max(0, Number(watchdog.activityCount) || 0) + 1,
  };
}

export function isResponseEvidenceWatchdogExpired(watchdog, key, now = Date.now()) {
  const normalizedKey = String(key ?? '').trim();
  const currentTime = Number(now);
  return Boolean(
    watchdog
      && normalizedKey
      && watchdog.key === normalizedKey
      && Number.isFinite(currentTime)
      && Number.isFinite(Number(watchdog.deadlineAt))
      && currentTime >= Number(watchdog.deadlineAt),
  );
}
