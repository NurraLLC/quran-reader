// Live on stream in a real browser, through the hosted server and its audio relay (the recogniser is
// a local stand-in; the microphone is a tone, never generated recitation): opening the overlay link
// makes the page live, its listening shows no time limit, and when the server restarts (a deploy),
// listening comes back by itself once it is up, instead of stopping the broadcast: even when the page
// is back before OBS is, and the day's usual share on this network is already used.
//
// A restart is a new process: sessions live in memory and start afresh, while the ledger, the
// visitor key and the saved overlay links are on disk (main.ts hostedSetup). So the ayah that was on
// stream is NOT brought back on the hosted service today: keeping it would store what a visitor
// recited, which overlay-links.ts promises not to, until the owner words that change. Self-hosted
// runs keep it (tests/session/restart.test.ts).
import { expect, test } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { buildApp } from '../../src/server/app';
import { CreditStore } from '../../src/server/billing/credits';
import { SessionHub } from '../../src/server/billing/hub';
import { VisitorIdentity } from '../../src/server/billing/identity';
import { OverlayLinks } from '../../src/server/billing/overlay-links';
import { CommandResolver } from '../../src/server/commands/reducer';
import { Session } from '../../src/server/sessions';
import { fullCorpus } from '../helpers';

/** 16 kHz mono WAV: a steady voice-like tone (the fake microphone). */
function tone(): string {
  const rate = 16_000;
  const samples = 60 * rate;
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
  for (let t = 0; t < samples; t++) buf.writeInt16LE(Math.round((0.3 * Math.sin((2 * Math.PI * 220 * t) / rate) + 0.1 * Math.sin((2 * Math.PI * 660 * t) / rate)) * 32767), 44 + t * 2);
  const file = path.join(tmpdir(), 'qo-live-stream.wav');
  writeFileSync(file, buf);
  return file;
}

test.use({ launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${tone()}`, '--autoplay-policy=no-user-gesture-required'] }, viewport: { width: 1440, height: 900 } });

test('live on stream: no time limit, and listening comes back by itself after a server restart', async ({ page, context }) => {
  test.setTimeout(90_000);
  const probe = createServer().listen(0, '127.0.0.1');
  await new Promise<void>((r) => probe.on('listening', r));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((r) => probe.close(() => r()));
  const base = `http://127.0.0.1:${port}`;
  // The recogniser stand-in answers every stream with an (empty) result twice a second.
  const provider = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((r) => provider.on('listening', r));
  provider.on('connection', (s) => s.once('message', () => {
    let ms = 0;
    const t = setInterval(() => (s.readyState === s.OPEN ? s.send(JSON.stringify({ tokens: [], final_audio_proc_ms: ms, total_audio_proc_ms: (ms += 500) })) : clearInterval(t)), 500);
  }));
  const { corpus, ix } = fullCorpus();
  const credits = new CreditStore(':memory:', { freeSecondsPerMonth: 0, ipDailyFreeSeconds: 0, globalDailyFreeSeconds: 0, holdMaxSeconds: 1200, holdMinSeconds: 20, poolDailySecondsPerVisitor: 7200, poolDailySecondsPerNetwork: 1200 });
  credits.grantPool(100 * 3600, 'fixture-funding');
  // Someone else on this network has used today's network share: only a live stream may listen now.
  credits.reserve('fixture', '127.0.0.1', Date.now() - 1_300_000);
  credits.settle('fixture', Date.now() - 100_000);
  const resolver = new CommandResolver(corpus, null, null);
  // As on disk (overlay-links.db): each visitor's overlay link and look, found again after a restart.
  const links = new OverlayLinks(':memory:');
  // Each run of the server has its own sessions, made as main.ts hostedSetup makes them.
  const newHub = () => new SessionHub((visitor) => {
    const saved = links.get(visitor);
    const view = saved?.view ?? randomBytes(18).toString('base64url');
    if (!saved) links.saveView(visitor, view);
    return new Session({ corpus, ix, resolver, decisionClient: null, mode: 'deterministic', setup: { soniox: true, jev: { provider: null, configured: false, detail: '' }, semantic: () => '' }, overlayUrl: (v) => `${base}/overlay#view=${v}`,
      viewToken: view, onViewToken: (v) => links.saveView(visitor, v), style: saved?.style ?? undefined, onStyle: (st) => links.saveStyle(visitor, st) });
  }, undefined, undefined, (view) => links.visitorOf(view));
  // The server, started again on the same port after a restart: new sessions; the ledger, the visitor
  // key and the overlay links are kept, as on disk.
  const start = async () => {
    const { app } = await buildApp({ port, sonioxApiKey: 'test-only', speechEndpoint: `ws://127.0.0.1:${(provider.address() as { port: number }).port}`,
      fetchImpl: (async () => new Response(JSON.stringify({ api_key: 'provider-key-never-in-browser', expires_at: new Date(Date.now() + 60_000).toISOString() }), { status: 201 })) as typeof fetch,
      hosted: { hub: newHub(), credits, identity: new VisitorIdentity(Buffer.alloc(48, 7)) },
    });
    await app.listen({ host: '127.0.0.1', port });
    return app;
  };
  let app = await start();
  let streams = 0;
  provider.on('connection', () => streams++);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    await page.goto(`${base}/control`);
    await page.waitForSelector('.topbar');
    const hint = page.locator('.voice-card .hint').first();
    await expect(hint).toContainText('listening stops by itself after a while without recitation');
    // The reading screen (like OBS) opens the overlay link: the page is live.
    const overlayLink = (await page.getByRole('link', { name: 'Open reading screen' }).getAttribute('href'))!;
    let screen = await context.newPage();
    await screen.goto(overlayLink);
    await expect(page.getByText('Live on stream · no time limit')).toBeVisible();
    await expect(hint).toContainText('While you’re live on stream, listening stays on through breaks and talk with your audience, with no time limit.');
    await page.screenshot({ path: 'test-results/live-stream-control.png' });

    await page.getByRole('button', { name: 'Start listening' }).click();
    await page.getByRole('dialog', { name: 'Before you turn on the microphone' }).getByRole('checkbox').check();
    await page.getByRole('button', { name: 'Agree and continue' }).click();
    await expect(hint).toContainText('Recite and the screen follows');
    // An ayah is on stream when the server goes away.
    const find = page.getByLabel('Type a reference or what the ayah says');
    await find.fill('67:2');
    await find.press('Enter');
    await expect(screen.locator('article.verse')).toHaveAttribute('aria-label', /67:2/, { timeout: 15_000 });
    await expect(page.locator('.monitor-head .onair')).toHaveText('On screen');

    // The server restarts (a deploy): every connection drops, and nothing answers for a while,
    // longer than the listening library's own three retries. OBS is slower to come back than the page.
    await screen.close();
    await app.close();
    await expect(hint).toHaveText('The connection was lost. Reconnecting by itself…', { timeout: 30_000 });
    await expect(page.getByRole('button', { name: 'Stop listening' })).toBeVisible();
    await page.screenshot({ path: 'test-results/live-stream-reconnecting.png' });
    const before = streams;
    app = await start();
    await expect(page.getByText('OBS/readers connected: 0')).toBeVisible({ timeout: 15_000 }); // the page is back, OBS not yet
    await page.waitForTimeout(6_000); // a retry or two, refused as not live (the network's share is used)
    await expect(hint).toHaveText('The connection was lost. Reconnecting by itself…');
    screen = await context.newPage();
    await screen.goto(overlayLink); // OBS is back: its saved link finds the visitor's new session
    await expect(hint).toContainText('Recite and the screen follows', { timeout: 30_000 });
    expect(streams).toBeGreaterThan(before);
    await expect(page.getByText('Lost the connection')).toHaveCount(0);
    // Hosted today: the new session starts with nothing on screen (see the note at the top), on the
    // control page and in OBS alike, until the broadcaster recites or chooses an ayah again.
    await expect(page.locator('.monitor-head .onair')).toHaveText('Nothing on screen');
    await expect(screen.locator('article.verse')).toHaveCount(0);
    expect(errors).toEqual([]);
    await page.getByRole('button', { name: 'Stop listening' }).click();
  } finally {
    await app.close();
    await new Promise<void>((r) => provider.close(() => r()));
    credits.close();
    links.close();
  }
});
