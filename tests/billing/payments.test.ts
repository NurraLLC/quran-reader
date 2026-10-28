// Community donations only: no personal purchases or account recovery. Stripe is mocked.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/server/app';
import { CreditStore } from '../../src/server/billing/credits';
import { SessionHub } from '../../src/server/billing/hub';
import { VisitorIdentity } from '../../src/server/billing/identity';
import { signForTest, StripeBilling } from '../../src/server/billing/stripe';
import { CommandResolver } from '../../src/server/commands/reducer';
import { Session } from '../../src/server/sessions';
import type { CreditView } from '../../src/shared/contracts';
import { fullCorpus } from '../helpers';

const WEBHOOK = 'whsec_test_0123456789';
let app: FastifyInstance;
let base = '';
let origin = '';
let credits: CreditStore;
const stripeCalls: Array<{ url: string; body: URLSearchParams }> = [];
let feeUnavailable = false;

beforeAll(async () => {
  const { corpus, ix } = fullCorpus();
  const resolver = new CommandResolver(corpus, null, null);
  credits = new CreditStore(':memory:', { freeSecondsPerMonth: 0, ipDailyFreeSeconds: 0, globalDailyFreeSeconds: 0, holdMaxSeconds: 300, holdMinSeconds: 20 });
  const hub = new SessionHub(
    () =>
      new Session({ corpus, ix, resolver, decisionClient: null, mode: 'deterministic', setup: { soniox: true, jev: { provider: null, configured: false, detail: '' }, semantic: () => 'unavailable' }, overlayUrl: (v) => `${origin}/overlay#view=${v}` }),
  );
  const stripeFetch = (async (url: string, init: RequestInit) => {
    if (init.method !== 'POST') {
      if (feeUnavailable) return new Response('{}', { status: 503 });
      const id = new URL(url).pathname.split('/').at(-1)!;
      return new Response(JSON.stringify({ id, payment_status: 'paid', amount_total: 1000, currency: 'usd', livemode: false,
        payment_intent: { latest_charge: { paid: true, balance_transaction: { id: `txn_${id}`, amount: 1000, fee: 59, net: 941, currency: 'usd' } } } }));
    }
    stripeCalls.push({ url, body: new URLSearchParams(String(init.body)) });
    return new Response(JSON.stringify({ id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1' }), { status: 200 });
  }) as unknown as typeof fetch;
  const billing = new StripeBilling('sk_test_x', WEBHOOK, stripeFetch);
  const port = 45170 + Math.floor(Math.random() * 500);
  ({ app } = await buildApp({ port, sonioxApiKey: 'k', hosted: { hub, credits, identity: new VisitorIdentity(Buffer.alloc(48, 9)), billing } }));
  await app.listen({ host: '127.0.0.1', port });
  base = `http://127.0.0.1:${port}`;
  origin = base;
});
afterAll(async () => {
  await app?.close();
  await new Promise((r) => setTimeout(r, 200));
  credits?.close();
});

type Me = { credits: CreditView; billing: { donations: Array<{ amountCents: number; price: string }> } | null };
async function me(cookie?: string): Promise<{ cookie: string; body: Me }> {
  const r = await fetch(`${base}/api/me`, { headers: { origin, ...(cookie ? { cookie } : {}) } });
  return { cookie: cookie ?? r.headers.get('set-cookie')!.split(';')[0], body: (await r.json()) as Me };
}
const paidEvent = (visitor: string, over: Record<string, unknown> = {}) =>
  JSON.stringify({
    id: 'evt_1',
    type: 'checkout.session.completed',
    data: { object: { id: 'cs_test_1', payment_status: 'paid', client_reference_id: visitor, metadata: { visitor, pack: 'h20' }, amount_total: 300, currency: 'usd', ...over } },
  });
const webhook = (payload: string, sig = signForTest(payload, WEBHOOK)) => fetch(`${base}/api/billing/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': sig }, body: payload });

describe('no public accounts or personal purchases', () => {
  it('exposes no recovery code or plans and refuses retired personal routes', async () => {
    const v = await me();
    expect(v.body).not.toHaveProperty('recoveryCode');
    expect(v.body.billing).not.toHaveProperty('packs');
    for (const route of ['/api/me/restore', '/api/billing/checkout']) {
      const r = await fetch(base + route, { method: 'POST', headers: { origin, cookie: v.cookie, 'content-type': 'application/json' }, body: '{}' });
      expect(r.status).toBe(404);
    }
    expect((await webhook(paidEvent('ignored'))).status).toBe(200);
    expect((await me(v.cookie)).body.credits.paid).toBe(0);
    expect((await webhook(paidEvent('ignored'), 't=1,v1=forged')).status).toBe(400);
  });
});

describe('sponsoring listening for others', () => {
  it('rejects mismatched payment mode, amount, currency and incomplete fee records', async () => {
    const good = { id: 'cs_fee', payment_status: 'paid', amount_total: 1000, currency: 'usd', livemode: false,
      payment_intent: { latest_charge: { paid: true, balance_transaction: { id: 'txn_fee', amount: 1000, fee: 59, net: 941, currency: 'usd' } } } };
    for (const override of [{ livemode: true }, { amount_total: 500 }, { currency: 'eur' }, { id: 'wrong' }, { payment_status: 'unpaid' }, { payment_intent: { latest_charge: { paid: true, balance_transaction: null } } }]) {
      const billing = new StripeBilling('sk_test_fixture', WEBHOOK, (async () => new Response(JSON.stringify({ ...good, ...override }))) as typeof fetch);
      await expect(billing.feeFor({ paymentId: 'cs_fee', amountCents: 1000, currency: 'usd' })).rejects.toThrow();
    }
  });
  type Donation = { amountCents: number; price: string; hours: number };
  const donationEvent = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      id: 'evt_d1',
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_test_donation_1', payment_status: 'paid', client_reference_id: 'x', metadata: { kind: 'donation', amount: '1000' }, amount_total: 1000, currency: 'usd', ...over } },
    });

  it('offers donations and opens a checkout that is a gift, not a purchase', async () => {
    const v = await me();
    const offered = (v.body.billing as unknown as { donations: Donation[] }).donations;
    expect(offered).toEqual([
      { amountCents: 500, price: '$5.00', hours: 35 },
      { amountCents: 1000, price: '$10.00', hours: 72 },
      { amountCents: 2500, price: '$25.00', hours: 184 },
    ]);
    const post = (amountCents: number) => fetch(`${base}/api/billing/donate`, { method: 'POST', headers: { origin, cookie: v.cookie, 'content-type': 'application/json' }, body: JSON.stringify({ amountCents }) });
    expect((await post(123)).status).toBe(400);
    expect(await (await post(1000)).json()).toEqual({ url: 'https://checkout.stripe.com/c/pay/cs_test_1' });
    const call = stripeCalls.at(-1)!;
    expect(call.body.get('metadata[kind]')).toBe('donation');
    expect(call.body.get('line_items[0][price_data][unit_amount]')).toBe('1000');
    expect(call.body.get('metadata[pack]')).toBeNull();
    expect(call.body.get('success_url')).toBe(`${origin}/?donated=1&session_id={CHECKOUT_SESSION_ID}`);
    expect(call.body.get('line_items[0][price_data][product_data][description]')).toContain('About 72 shared listening hours after estimated card fees and current costs');
  });

  it('fills the shared pool once per payment, and nothing for tampered amounts', async () => {
    const visitor = await me();
    const receipt = () => fetch(`${base}/api/billing/contribution/cs_test_donation_1`, { headers: { cookie: visitor.cookie } }).then((r) => r.json());
    expect(await receipt()).toEqual({ confirmed: false });
    const before = (await me()).body.credits.pool;
    expect((await webhook(donationEvent({ amount_total: 100, id: 'cs_cheap_gift' }))).status).toBe(200);
    expect((await webhook(donationEvent({ metadata: { kind: 'donation', amount: '777' }, amount_total: 777, id: 'cs_odd' }))).status).toBe(200);
    expect((await me()).body.credits.pool).toBe(before);
    expect((await webhook(donationEvent())).status).toBe(200);
    expect(await receipt()).toEqual({ confirmed: true });
    expect((await webhook(donationEvent())).status).toBe(200); // a retried delivery adds nothing
    expect((await me()).body.credits.pool).toBe(before + Math.floor(1000 * 3600 / 13) - Math.ceil(59 * 3600 / 13));
  });

  it('retries unavailable fee accounting without exposing a partial grant', async () => {
    const before = credits.poolStats();
    const payload = donationEvent({ id: 'cs_retry' });
    feeUnavailable = true;
    try { expect((await webhook(payload)).status).toBe(503); }
    finally { feeUnavailable = false; }
    expect(credits.contributionConfirmed('cs_retry')).toBe(false);
    expect(credits.poolStats()).toEqual(before);
    expect((await webhook(payload)).status).toBe(200);
    expect(credits.contributionConfirmed('cs_retry')).toBe(true);
    const after = credits.poolStats();
    expect(after.given - before.given).toBe(Math.floor(1000 * 3600 / 13));
    expect(after.costUsdMicros - before.costUsdMicros).toBe(590_000);
    expect((await webhook(payload)).status).toBe(200);
    expect(credits.poolStats()).toEqual(after);
  });

  it('lets anyone whose own time is gone keep listening from the pool, up to the daily amount', async () => {
    const v = await me();
    const c = v.body.credits;
    expect(c.sponsored).toBe(3600); // default one hour a day per visitor
    expect(c.available).toBe(3600);
  });
});
