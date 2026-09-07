function intOr(value, fallback = 0) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : fallback;
}

function nullableInt(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

export function normalizePlanPricing(plan = {}, nowMs = Date.now()) {
  const legacy = intOr(plan.price_cents ?? plan.priceCents, 0);
  const original = intOr(plan.original_price_cents ?? plan.originalPriceCents, legacy) || legacy;
  const promo = nullableInt(plan.promo_price_cents ?? plan.promoPriceCents);
  const rawEnd = String(plan.promo_ends_at ?? plan.promoEndsAt ?? '').trim();
  const endMs = rawEnd ? Date.parse(rawEnd) : NaN;
  const promoEndsAt = Number.isFinite(endMs) ? new Date(endMs).toISOString() : null;
  const promoActive = promo !== null && promo < original && Number.isFinite(endMs) && endMs > Number(nowMs);
  const priceCents = promoActive ? promo : original;
  return {
    priceCents,
    originalPriceCents: original,
    promoPriceCents: promo,
    promoEndsAt,
    promoActive,
    savingsCents: promoActive ? Math.max(0, original - promo) : 0,
  };
}
