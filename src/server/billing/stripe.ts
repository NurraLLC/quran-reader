// Voluntary community donations through Stripe Checkout. Signed, paid webhooks add hours
// to the shared pool exactly once. No personal purchases, accounts or subscriptions.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { estimateSupportHours } from '../../shared/support-budget';

/** Donation amounts and what each adds to the sponsored pool. */
export type Donations = { amountsCents: number[]; currency: string; centsPerHour: number };

/**
 * Default: $5, $10, $25. Conversion estimate: 13 cents per hour, so $10 adds 76 hours.
 * Provider usage and payment fees vary; this is not a guaranteed break-even rate. Override with QO_DONATIONS
 * (JSON array of cents) and QO_SPONSOR_CENTS_PER_HOUR.
 */
export const DEFAULT_DONATIONS: Donations = { amountsCents: [500, 1000, 2500], currency: 'usd', centsPerHour: 13 };

export function parseDonations(amounts: string | undefined, centsPerHour: string | undefined): Donations {
  const list = amounts ? (JSON.parse(amounts) as unknown) : DEFAULT_DONATIONS.amountsCents;
  if (!Array.isArray(list) || !list.length || !list.every((c) => Number.isInteger(c) && c >= 100 && c <= 100_000)) throw new Error('QO_DONATIONS must be a JSON array of amounts in cents (100 to 100000)');
  const cph = centsPerHour ? Number(centsPerHour) : DEFAULT_DONATIONS.centsPerHour;
  if (!Number.isFinite(cph) || cph < 1) throw new Error('QO_SPONSOR_CENTS_PER_HOUR must be a positive number');
  return { amountsCents: list as number[], currency: DEFAULT_DONATIONS.currency, centsPerHour: cph };
}

export class StripeBilling {
  constructor(
    private readonly secretKey: string,
    private readonly webhookSecret: string,
    private readonly fetchImpl: typeof fetch = fetch,
    readonly donations: Donations = DEFAULT_DONATIONS,
  ) {}

  get testMode(): boolean { return !/^(sk|rk)_live_/.test(this.secretKey); }

  /** Estimated spendable hours after card fees and the current pool shortfall. */
  sponsoredHours(amountCents: number, availableSeconds = 0): number {
    return estimateSupportHours(amountCents, this.donations.centsPerHour, availableSeconds);
  }

  /** A Stripe-hosted checkout page for a donation to the sponsored pool; returns its URL. */
  async checkoutDonation(visitorId: string, amountCents: number, origin: string, availableSeconds = 0): Promise<string> {
    if (!this.donations.amountsCents.includes(amountCents)) throw new Error('unknown amount');
    const form = new URLSearchParams({
      mode: 'payment',
      success_url: `${origin}/?donated=1&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/?canceled=1`,
      client_reference_id: visitorId,
      'metadata[kind]': 'donation',
      'metadata[amount]': String(amountCents),
      'line_items[0][quantity]': '1',
      'line_items[0][price_data][currency]': this.donations.currency,
      'line_items[0][price_data][unit_amount]': String(amountCents),
      'line_items[0][price_data][product_data][name]': 'Support Quran Reader',
      'line_items[0][price_data][product_data][description]': `One-time contribution to Nurra LLC. About ${this.sponsoredHours(amountCents, availableSeconds)} shared listening hours after estimated card fees and current costs. Future reader bills may reduce hours. Not a tax-deductible charitable donation.`,
    });
    return this.createSession(form);
  }

  /** What a verified event gives the sponsored pool, if it is a paid donation of an offered amount. */
  gift(event: StripeEvent): { amountCents: number; currency: string; seconds: number; paymentId: string } | null {
    if (event.type !== 'checkout.session.completed' && event.type !== 'checkout.session.async_payment_succeeded') return null;
    const s = event.data?.object;
    if (!s || s.payment_status !== 'paid' || s.metadata?.kind !== 'donation' || !s.id) return null;
    const amount = Number(s.metadata.amount);
    if (!this.donations.amountsCents.includes(amount)) return null;
    // What was paid must be what was offered (a tampered or stale session adds nothing).
    if (s.amount_total !== amount || s.currency !== this.donations.currency) return null;
    return { amountCents: amount, currency: this.donations.currency, seconds: Math.floor(amount * 3600 / this.donations.centsPerHour), paymentId: s.id };
  }

  /** Read the actual fee from Stripe, never infer it from an advertised percentage. A missing
   * balance transaction is retryable: the webhook must not acknowledge unaccounted funding.
   */
  async feeFor(gift: { paymentId: string; amountCents: number; currency: string }): Promise<{ id: string; usdMicros: number }> {
    const res = await this.fetchImpl(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(gift.paymentId)}?expand%5B%5D=payment_intent.latest_charge.balance_transaction`, {
      headers: { Authorization: `Bearer ${this.secretKey}` }, signal: AbortSignal.timeout(10_000), redirect: 'error',
    });
    if (!res.ok) throw new Error('Stripe fee lookup unavailable');
    const session = await res.json() as { id?: string; payment_status?: string; amount_total?: number; currency?: string; livemode?: boolean; payment_intent?: { latest_charge?: { paid?: boolean; balance_transaction?: { id?: string; amount?: number; fee?: number; net?: number; currency?: string } } } };
    const charge = session.payment_intent?.latest_charge;
    const balance = charge?.balance_transaction;
    if (session.id !== gift.paymentId || session.payment_status !== 'paid' || session.amount_total !== gift.amountCents || session.currency !== gift.currency || session.livemode !== !this.testMode || !charge?.paid || !balance?.id || balance.currency !== 'usd' || balance.amount !== gift.amountCents || !Number.isSafeInteger(balance.fee) || balance.fee! < 0 || balance.fee! > 1_000_000 || balance.net !== balance.amount! - balance.fee!) throw new Error('Stripe fee not ready or inconsistent');
    return { id: `stripe:${balance.id}`, usdMicros: balance.fee! * 10_000 };
  }

  private async createSession(form: URLSearchParams): Promise<string> {
    const res = await this.fetchImpl('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.secretKey}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json().catch(() => ({}))) as { url?: string; error?: { message?: string } };
    if (!res.ok || !body.url) throw new Error(body.error?.message ?? `Stripe checkout failed (${res.status})`);
    return body.url;
  }

  /**
   * The event in a webhook delivery, if its Stripe-Signature is valid and recent (Stripe's scheme:
   * HMAC-SHA256 of "timestamp.payload" with the endpoint secret; 5-minute tolerance).
   */
  verify(payload: string, signatureHeader: string | undefined, now = Date.now()): StripeEvent | null {
    if (!signatureHeader) return null;
    const parts = signatureHeader.split(',').map((p) => p.trim().split('='));
    const t = Number(parts.find(([k]) => k === 't')?.[1]);
    const sigs = parts.filter(([k]) => k === 'v1').map(([, v]) => v);
    if (!Number.isFinite(t) || !sigs.length || Math.abs(now / 1000 - t) > 300) return null;
    const want = Buffer.from(createHmac('sha256', this.webhookSecret).update(`${t}.${payload}`).digest('hex'));
    if (!sigs.some((s) => s.length === want.length && timingSafeEqual(Buffer.from(s), want))) return null;
    try {
      return JSON.parse(payload) as StripeEvent;
    } catch {
      return null;
    }
  }


}

export type StripeEvent = {
  id: string;
  type: string;
  data?: {
    object?: {
      id?: string;
      payment_status?: string;
      client_reference_id?: string | null;
      metadata?: Record<string, string>;
      amount_total?: number;
      currency?: string;
    };
  };
};

/** Test helper and documentation: the header Stripe would send for this payload. */
export function signForTest(payload: string, secret: string, t = Math.floor(Date.now() / 1000)): string {
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex')}`;
}
