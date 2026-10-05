// Hosted browser flow through the actual audio relay. All provider/payment endpoints are local
// stand-ins; the microphone is a tone, never generated Quran recitation or the owner's microphone.
import { test, expect, type WebSocketRoute } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { buildApp } from '../../src/server/app';
import { CreditStore } from '../../src/server/billing/credits';
import { VisitorIdentity } from '../../src/server/billing/identity';
import { SessionHub } from '../../src/server/billing/hub';
import { StripeBilling, signForTest } from '../../src/server/billing/stripe';
import { CommandResolver } from '../../src/server/commands/reducer';
import { Session } from '../../src/server/sessions';
import { fullCorpus } from '../helpers';

// The microphone plays a tone with breaths (breathingTone, below), so the voice detector has pauses to report.
test.use({ launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${breathingTone()}`] }, viewport: { width: 390, height: 844 } });

test('shared lifetime totals, donation readback, and browser audio through the protected relay', async ({ page }) => {
  const probe = createServer().listen(0, '127.0.0.1');
  await new Promise<void>((r) => probe.on('listening', r));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((r) => probe.close(() => r()));
  const base = `http://127.0.0.1:${port}`;
  const provider = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((r) => provider.on('listening', r));
  let bytes = 0;
  provider.on('connection', (s) => s.on('message', (d, binary) => { if (binary) bytes += (d as Buffer).length; }));
  const { corpus, ix } = fullCorpus();
  const credits = new CreditStore(':memory:', { freeSecondsPerMonth: 0, ipDailyFreeSeconds: 0, globalDailyFreeSeconds: 0, holdMaxSeconds: 1200, holdMinSeconds: 20, poolDailySecondsPerVisitor: 7200 });
  credits.grantPool(100 * 3600, 'fixture-funding');
  const past = Date.now() - 2 * 86_400_000;
  for (let i = 0; i < 75; i++) { credits.reserve(`fixture-${i}`, `fixture-ip-${i}`, past); credits.settle(`fixture-${i}`, past + 1200_000); }
  const resolver = new CommandResolver(corpus, null, null);
  const hub = new SessionHub(() => new Session({ corpus, ix, resolver, decisionClient: null, mode: 'deterministic', setup: { soniox: true, jev: { provider: null, configured: false, detail: '' }, semantic: () => '' }, overlayUrl: (v) => `${base}/quran-reader/overlay#view=${v}` }));
  let checkout: URLSearchParams | null = null;
  const billing = new StripeBilling('test-only', 'webhook-test-only', (async (_u, init) => {
    if (init?.method !== 'POST') return new Response(JSON.stringify({ id: 'checkout-test-gift', payment_status: 'paid', amount_total: 1000, currency: 'usd', livemode: false,
      payment_intent: { latest_charge: { paid: true, balance_transaction: { id: 'txn_fixture', amount: 1000, fee: 59, net: 941, currency: 'usd' } } } }));
    checkout = new URLSearchParams(String(init?.body));
    return new Response(JSON.stringify({ url: 'https://checkout.stripe.com/test-only' }));
  }) as typeof fetch);
  const { app } = await buildApp({ port, basePath: '/quran-reader', sonioxApiKey: 'test-only',
    speechEndpoint: `ws://127.0.0.1:${(provider.address() as { port: number }).port}`,
    fetchImpl: (async () => new Response(JSON.stringify({ api_key: 'provider-key-never-in-browser', expires_at: new Date(Date.now() + 60_000).toISOString() }), { status: 201 })) as typeof fetch,
    hosted: { hub, credits, identity: new VisitorIdentity(Buffer.alloc(48, 9)), billing },
  });
  await app.listen({ host: '127.0.0.1', port });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    await page.route('https://checkout.stripe.com/test-only', (r) => r.fulfill({ body: 'Test checkout only' }));
    await page.goto(`${base}/quran-reader/`);
    const panel = page.getByRole('region', { name: 'Sponsored recitation hours' });
    await expect(panel).toContainText('100 h');
    await expect(panel).toContainText('25 h');
    await expect(panel).toContainText('75 h');
    await expect(panel).not.toContainText(/month|goal|plan|bought/i);
    await page.screenshot({ path: 'test-results/support-entry-phone.png' });
    await panel.getByRole('button', { name: /Support Quran Reader/ }).click();
    await panel.scrollIntoViewIfNeeded();
    await panel.screenshot({ path: 'test-results/community-hours-fixture.png' });
    await page.getByRole('button', { name: /^Menu/ }).click();
    await page.getByRole('button', { name: /^Reading appearance/ }).click();
    await page.getByRole('radio', { name: /^Paper/ }).click();
    await page.getByRole('button', { name: 'Return to reading', exact: true }).click();
    await panel.locator('.r-pool-head').hover();
    // The real hover background must keep the normal-sized support label readable.
    const contrast = await panel.locator('.r-pool-head').evaluate((head) => {
      const luminance = (color: string) => {
        const rgb = color.match(/[\d.]+/g)!.slice(0, 3).map(Number).map((v) => {
          const c = v / 255; return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4;
        });
        return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
      };
      const bg = luminance(getComputedStyle(head).backgroundColor);
      const fg = luminance(getComputedStyle(head.querySelector('.r-pool-now')!).color);
      return (Math.max(bg, fg) + .05) / (Math.min(bg, fg) + .05);
    });
    expect(contrast).toBeGreaterThanOrEqual(4.5);
    await panel.screenshot({ path: 'test-results/paper-support-hover.png' });
    await page.getByRole('button', { name: /^Menu/ }).click();
    await page.getByRole('button', { name: /^Reading appearance/ }).click();
    await page.getByRole('radio', { name: /^Night/ }).click();
    await page.getByRole('button', { name: 'Return to reading', exact: true }).click();
    // Support sits below the reading and in the menu, never above the welcome or a surah.
    await expect(page.locator('.r-support-nav')).toHaveCount(0);
    const supportFromMenu = async () => {
      await page.getByRole('button', { name: /^Menu/ }).click();
      await page.getByRole('dialog', { name: 'Menu', exact: true }).getByRole('button', { name: /^Support Quran Reader/ }).click();
    };
    await supportFromMenu();
    const support = page.getByRole('dialog', { name: 'Support Quran Reader' });
    await expect(support).toContainText('not tax-deductible');
    await expect(support.getByRole('status')).toContainText('Test checkout — no real money');
    await page.route('**/api/billing/donate', (r) => r.fulfill({ status: 502, json: { error: 'The payment page could not be opened. Please try again.' } }), { times: 1 });
    await support.getByRole('button', { name: '$10 About 76 hours before costs' }).click();
    await expect(support.getByRole('alert')).toContainText('Please try again');
    await support.getByRole('button', { name: '$10 About 76 hours before costs' }).click();
    await expect(page).toHaveURL('https://checkout.stripe.com/test-only');
    expect(checkout!.get('line_items[0][price_data][unit_amount]')).toBe('1000');
    expect(checkout!.get('line_items[0][price_data][product_data][description]')).toContain('Nurra LLC');
    const event = JSON.stringify({ id: 'event-test-gift', type: 'checkout.session.completed', data: { object: { id: 'checkout-test-gift', payment_status: 'paid', metadata: { kind: 'donation', amount: '1000' }, amount_total: 1000, currency: 'usd' } } });
    for (let i = 0; i < 2; i++) {
      const response = await fetch(`${base}/quran-reader/api/billing/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': signForTest(event, 'webhook-test-only') }, body: event });
      expect(response.ok).toBe(true);
    }
    await page.goto(`${base}/quran-reader/?donated=1`);
    await expect(panel).toContainText('176 h'); // webhook replay never adds it twice
    await expect(panel).toContainText('147 h'); // actual processing fee reduces available hours
    await expect(page.locator('.r-toast')).toBeVisible();
    await page.getByRole('button', { name: 'Dismiss thank-you message' }).click();
    await expect(page.locator('.r-toast')).toHaveCount(0);
    await page.goto(`${base}/quran-reader/?donated=1`);
    await expect(page.locator('.r-toast')).toBeVisible();
    await expect(page.locator('.r-toast')).toHaveCount(0, { timeout: 10_000 });
    await page.reload();
    await expect(page.locator('.r-toast')).toHaveCount(0);
    await page.getByRole('button', { name: 'Start listening', exact: true }).click();
    const consent=page.getByRole('dialog',{name:'Before you turn on the microphone'});
    await expect(consent).toBeVisible();
    expect(bytes).toBe(0);
    await consent.getByRole('button',{name:'Keep reading'}).click();
    await expect(consent).toHaveCount(0);
    expect(bytes).toBe(0);
    await page.getByRole('button', { name: 'Start listening', exact: true }).click();
    await consent.getByRole('checkbox').check();
    await consent.screenshot({path:'test-results/voice-consent-phone.png'});
    await consent.getByRole('button',{name:'Agree and continue'}).click();
    await expect.poll(() => bytes).toBeGreaterThan(0); // real browser SDK -> app -> local provider
    await expect(page.getByRole('button', { name: 'Stop listening', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Stop listening', exact: true }).click();
    await expect.poll(() => provider.clients.size).toBe(0);
    expect(credits.poolStats().used).toBeGreaterThan(25 * 3600);
    // Unconfigured payments must remain discoverable without pretending checkout is available.
    await page.route('**/api/me', async (route) => {
      const response = await route.fetch();
      const state=await response.json();
      await route.fulfill({ response, json: { ...state, billing: null, sponsored: {...state.sponsored, operatingReserve:166154, operatingReserveUsdMicros:6000000, left:state.sponsored.left-166154} } });
    });
    await page.reload();
    await supportFromMenu();
    await expect(support.getByRole('status')).toContainText('Online contributions aren’t open yet');
    await expect(support).toContainText('$6.00 set aside for running costs');
    await expect(support).toContainText('This is reserved, not spent.');
    await expect(support).toContainText('Available for listening');
    await page.screenshot({ path: 'test-results/support-unavailable-phone.png' });
    await expect(support.getByRole('button', { name: /\$10/ })).toHaveCount(0);
    await support.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(support).toHaveCount(0);
    await page.goto(`${base}/quran-reader/about`);
    await page.screenshot({ path: 'test-results/about-community-phone.png', fullPage: true });
    await page.getByRole('link', { name: /Support Quran Reader/ }).click();
    await expect(page).toHaveURL(/about#support$/);
    await expect(page.getByRole('heading', { name: 'Support Quran Reader' })).toBeInViewport();
    const supportSection = page.locator('#support');
    await expect(supportSection).toContainText('When online contributions are available, payments go to Nurra LLC');
    await expect(supportSection.getByRole('status')).toContainText('Online contributions aren’t open yet');
    await expect(page.getByRole('link', { name: /Open the overlay controls/ })).toHaveAttribute('href', '/quran-reader/control');
    expect(errors).toEqual([]);
  } finally {
    await page.close();
    await app.close();
    for (const s of provider.clients) s.terminate();
    await new Promise<void>((r) => provider.close(() => r()));
    credits.close();
  }
});

// An iPhone (user agent) on the path Safari before 18.4 takes: it records only MP4/AAC, which
// Soniox's real-time API doesn't list, so the page sends 16 kHz PCM through the relay. The same
// session then loses its control socket (as a phone's network does) and has its screen turned off.
/** A looping 16 kHz mono WAV: a voice-like tone for 1 s, then 0.5 s of quiet (a breath), four times. */
function breathingTone(): string {
  const rate = 16_000;
  const samples = rate * 6;
  const buf = Buffer.alloc(44 + samples * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + samples * 2, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(samples * 2, 40);
  for (let t = 0; t < samples; t++) {
    const on = t % (rate * 1.5) < rate;
    const v = on ? 0.3 * Math.sin((2 * Math.PI * 220 * t) / rate) + 0.1 * Math.sin((2 * Math.PI * 660 * t) / rate) : 0;
    buf.writeInt16LE(Math.round(v * 32767), 44 + t * 2);
  }
  const file = path.join(tmpdir(), 'qo-breathing-tone.wav');
  writeFileSync(file, buf);
  return file;
}

test.describe('phone listening', () => {
  test.use({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1' });

  test('16 kHz PCM through the relay; listening survives a control-socket drop and the screen turning off', async ({ page, context }) => {
    test.setTimeout(90_000);
    const probe = createServer().listen(0, '127.0.0.1');
    await new Promise<void>((r) => probe.on('listening', r));
    const port = (probe.address() as { port: number }).port;
    await new Promise<void>((r) => probe.close(() => r()));
    const base = `http://127.0.0.1:${port}`;
    const provider = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise<void>((r) => provider.on('listening', r));
    const configs: Array<Record<string, unknown>> = [];
    const frames: Array<{ at: number; data: Buffer }> = [];
    provider.on('connection', (s) => s.on('message', (d, binary) => (binary ? frames.push({ at: Date.now(), data: Buffer.from(d as Buffer) }) : configs.push(JSON.parse(String(d))))));
    const { corpus, ix } = fullCorpus();
    const credits = new CreditStore(':memory:', { freeSecondsPerMonth: 0, ipDailyFreeSeconds: 0, globalDailyFreeSeconds: 0, holdMaxSeconds: 1200, holdMinSeconds: 20, poolDailySecondsPerVisitor: 7200 });
    credits.grantPool(10 * 3600, 'fixture-funding');
    const resolver = new CommandResolver(corpus, null, null);
    const hub = new SessionHub(() => new Session({ corpus, ix, resolver, decisionClient: null, mode: 'deterministic', setup: { soniox: true, jev: { provider: null, configured: false, detail: '' }, semantic: () => '' }, overlayUrl: (v) => `${base}/quran-reader/overlay#view=${v}` }));
    const identity = new VisitorIdentity(Buffer.alloc(48, 9));
    const { app } = await buildApp({ port, basePath: '/quran-reader', sonioxApiKey: 'test-only',
      speechEndpoint: `ws://127.0.0.1:${(provider.address() as { port: number }).port}`,
      fetchImpl: (async () => new Response(JSON.stringify({ api_key: 'provider-key-never-in-browser', expires_at: new Date(Date.now() + 60_000).toISOString() }), { status: 201 })) as typeof fetch,
      hosted: { hub, credits, identity },
    });
    await app.listen({ host: '127.0.0.1', port });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    // The control socket passes through here, so it can be dropped the way a phone's network drops it.
    const sent: Array<Array<{ at: number; m: string }>> = [];
    let drop: (() => Promise<void>) | null = null;
    await page.routeWebSocket(/\/ws\/control$/, (ws: WebSocketRoute) => {
      const server = ws.connectToServer();
      const log: Array<{ at: number; m: string }> = [];
      sent.push(log);
      ws.onMessage((m) => {
        if (typeof m === 'string') log.push({ at: Date.now(), m });
        server.send(m);
      });
      drop = async () => { await server.close(); await ws.close(); };
    });
    const session = async () => {
      const cookie = (await context.cookies()).find((c) => c.name === 'qo_visitor');
      return hub.peek(identity.verify(cookie?.value ?? null) ?? '')!;
    };
    const status = page.locator('.r-status');
    try {
      // Keeps the page's audio contexts reachable, to suspend one the way iOS does.
      await page.addInitScript(() => {
        const w = window as unknown as { __contexts: AudioContext[] };
        w.__contexts = [];
        window.AudioContext = class extends AudioContext {
          constructor(options?: AudioContextOptions) {
            super(options);
            w.__contexts.push(this);
          }
        };
      });
      await page.goto(`${base}/quran-reader/?stt=${encodeURIComponent('{"pcm":true}')}`);
      await page.getByRole('button', { name: 'Start listening', exact: true }).click();
      const consent = page.getByRole('dialog', { name: 'Before you turn on the microphone' });
      await consent.getByRole('checkbox').check();
      await consent.getByRole('button', { name: 'Agree and continue' }).click();

      // The provider is told the audio is raw PCM, and receives it as 60 ms chunks at real-time pace.
      await expect.poll(() => configs.length).toBe(1);
      expect(configs[0]).toMatchObject({ api_key: 'provider-key-never-in-browser', audio_format: 'pcm_s16le', sample_rate: 16_000, num_channels: 1 });
      await expect.poll(() => frames.length, { timeout: 10_000 }).toBeGreaterThan(20);
      const from = frames.length;
      await page.waitForTimeout(3000);
      const recent = frames.slice(from);
      const rate = recent.reduce((n, f) => n + f.data.length, 0) / ((recent.at(-1)!.at - frames[from - 1].at) / 1000);
      expect(recent.every((f) => f.data.length === 1920)).toBe(true);
      expect(rate).toBeGreaterThan(32_000 * 0.8);
      expect(rate).toBeLessThan(32_000 * 1.2);
      const peak = Math.max(...frames.map((f) => Math.max(...new Int16Array(f.data.buffer, f.data.byteOffset, f.data.length / 2).map(Math.abs))));
      expect(peak).toBeGreaterThan(5_000); // the fake microphone's tone, resampled, not silence
      // Breaths still reach the server in the stream's audio clock: time 0 is the first PCM chunk,
      // so a pause reported at `at` sits near the time since the provider's first audio.
      const voice = sent[0].filter((e) => e.m.includes('"type":"voice"')).map((e) => ({ at: e.at, ...(JSON.parse(e.m) as { speaking: boolean; audioMs: number }) }));
      expect(voice.some((v) => v.speaking) && voice.some((v) => !v.speaking)).toBe(true);
      for (const v of voice) expect(Math.abs(v.audioMs - (v.at - frames[0].at))).toBeLessThan(1500);
      await expect(page.getByRole('button', { name: 'Stop listening', exact: true })).toBeVisible();
      expect(await page.locator('.r-credits').evaluate((e) => e.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);

      // The control socket drops: on reconnect the page says its stream is still live, so the server
      // keeps following instead of treating the page as gone (it would clear the display after 5 s).
      await drop!();
      await expect.poll(() => sent.length).toBe(2);
      await expect.poll(() => sent[1].map((e) => JSON.parse(e.m)).find((m) => m.type === 'capture')).toMatchObject({ event: 'recording' });
      await page.waitForTimeout(6000);
      expect((await session()).snapshot().capture.phase).toBe('recording');

      // The screen turns off for a while: back on screen, the stream is restarted and the person is told why.
      const streams = configs.length;
      await page.evaluate(() => {
        const w = window as unknown as { __vis: DocumentVisibilityState };
        w.__vis = 'hidden';
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => w.__vis });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await page.waitForTimeout(5500);
      await page.evaluate(() => {
        (window as unknown as { __vis: DocumentVisibilityState }).__vis = 'visible';
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await expect(status).toContainText('Listening paused while the screen was off. Recite to continue.');
      await expect.poll(() => configs.length).toBe(streams + 1);
      expect(configs.at(-1)).toMatchObject({ audio_format: 'pcm_s16le', sample_rate: 16_000, num_channels: 1 });
      await expect(page.getByRole('button', { name: 'Stop listening', exact: true })).toBeVisible();
      await page.screenshot({ path: 'test-results/listening-after-screen-off-phone.png' });

      // iOS can keep the audio thread suspended until the next touch: the page asks for one, and the
      // touch brings it back.
      await page.evaluate(async () => {
        const ctx = (window as unknown as { __contexts: AudioContext[] }).__contexts.find((c) => c.state === 'running')!;
        const resume = ctx.resume;
        ctx.resume = () => Promise.resolve(); // refused, as iOS does without a touch
        (window as unknown as { __restoreResume: () => void }).__restoreResume = () => { ctx.resume = resume; };
        await ctx.suspend();
      });
      await expect(status).toContainText('Listening paused while the screen was off. Tap anywhere to continue.');
      await page.evaluate(() => (window as unknown as { __restoreResume: () => void }).__restoreResume());
      await page.locator('.r-page').click({ position: { x: 20, y: 20 } });
      await expect(status).not.toContainText('Tap anywhere to continue');
      expect(await page.evaluate(() => (window as unknown as { __contexts: AudioContext[] }).__contexts.filter((c) => c.state === 'running').length)).toBe(1);

      await page.getByRole('button', { name: 'Stop listening', exact: true }).click();
      await expect.poll(() => provider.clients.size).toBe(0);
      expect(errors).toEqual([]);
    } finally {
      await page.close();
      await app.close();
      for (const s of provider.clients) s.terminate();
      await new Promise<void>((r) => provider.close(() => r()));
      credits.close();
    }
  });
});
