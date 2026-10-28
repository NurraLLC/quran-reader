import { expect, it } from 'vitest';
import { estimateSupportHours } from '../../src/shared/support-budget';
import { CreditStore } from '../../src/server/billing/credits';
import { StripeBilling } from '../../src/server/billing/stripe';

it('quotes additional capacity from the same rounded funding, fees and protected costs as the ledger', () => {
  const store = new CreditStore(':memory:', {
    costCentsPerHour: 13, operatingReserveUsdMicros: 6_000_000,
    freeSecondsPerMonth: 0, ipDailyFreeSeconds: 0, globalDailyFreeSeconds: 0, holdMinSeconds: 20, holdMaxSeconds: 1200,
  });
  try {
    // $4 already funded, $6 protected: a new gift first covers the shortfall.
    store.grantPool(Math.floor(400 * 3600 / 13), 'owner');
    const before = store.poolSeconds();
    const billing = new StripeBilling('sk_test_fixture', 'whsec_fixture');
    const quote = billing.sponsoredHours(1000, before);
    const event = { id: 'evt_fixture', type: 'checkout.session.completed', data: { object: { id: 'cs_fixture', payment_status: 'paid', amount_total: 1000, currency: 'usd', metadata: { kind: 'donation', amount: '1000' } } } };
    const gift = billing.gift(event)!;
    // A standard domestic-card example. The production fee still comes from Stripe.
    store.grantPool(gift.seconds, gift.paymentId, gift.amountCents, gift.currency, Date.now(), { id: 'stripe:txn_fixture', usdMicros: 590_000 });
    expect(quote).toBe(57);
    expect(quote).toBe(Math.round(Math.max(0, store.poolSeconds()) / 3600));
    expect(quote).toBe(estimateSupportHours(1000, 13, before));
  } finally { store.close(); }
});

it('does not subtract an already funded reserve twice or promise capacity for an uncovered deficit', () => {
  expect([500, 1000, 2500].map((c) => estimateSupportHours(c, 13, 104150))).toEqual([35, 72, 184]);
  expect(estimateSupportHours(500, 13, -999999)).toBe(0);
  expect(estimateSupportHours(0)).toBe(0);
  expect(estimateSupportHours(100, 100)).toBe(1);
});
