export const ACCOUNT_REFRESH_ALARM = 'gptlock-account-refresh';
export const ACCOUNT_REFRESH_SOON_MS = 250;
export const ACCOUNT_REFRESH_PERIOD_MINUTES = 1;

export async function scheduleAccountRefresh(chromeApi = globalThis.chrome, delayMs = ACCOUNT_REFRESH_SOON_MS) {
  if (!chromeApi?.alarms?.create) throw new Error('Account refresh alarm is unavailable');
  await chromeApi.alarms.create(ACCOUNT_REFRESH_ALARM, {
    when: Date.now() + Math.max(0, Number(delayMs) || 0),
    periodInMinutes: ACCOUNT_REFRESH_PERIOD_MINUTES,
  });
}
