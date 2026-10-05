// The hosted service under misuse and ordinary wear: floods, owner-only settings, paid requests,
// shared networks, and overlay links that outlive their sessions.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { FastifyInstance } from 'fastify';
import { buildApp, networkOf } from '../../src/server/app';
import { CreditStore } from '../../src/server/billing/credits';
import { SessionHub } from '../../src/server/billing/hub';
import { VisitorIdentity } from '../../src/server/billing/identity';
import { OverlayLinks } from '../../src/server/billing/overlay-links';
import { CommandResolver } from '../../src/server/commands/reducer';
import { DISCONNECT_GRACE_MS, Session } from '../../src/server/sessions';
import type { ControlServerMessage, DisplayStyle } from '../../src/shared/contracts';
import { fullCorpus, VirtualClock } from '../helpers';

const { corpus, ix } = fullCorpus();
const resolver = new CommandResolver(corpus, null, null);
const options = (extra: Partial<ConstructorParameters<typeof Session>[0]> = {}): ConstructorParameters<typeof Session>[0] => ({
  corpus,
  ix,
  resolver,
  decisionClient: null,
  mode: 'deterministic',
  setup: { soniox: true, jev: { provider: null, configured: false, detail: '' }, semantic: () => 'unavailable' },
  overlayUrl: (v) => `view:${v}`,
  ...extra,
});

describe('networks', () => {
  it('keys IPv4 as is and IPv6 by its /64', () => {
    expect(networkOf('203.0.113.9')).toBe('203.0.113.9');
    expect(networkOf('::ffff:203.0.113.9')).toBe('203.0.113.9');
    expect(networkOf('2001:db8:1:2:aaaa:bbbb:cccc:dddd')).toBe('2001:db8:1:2::/64');
    expect(networkOf('2001:db8:1:2::9')).toBe('2001:db8:1:2::/64');
    expect(networkOf('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(networkOf('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
    expect(networkOf('unknown')).toBe('unknown');
  });
});

describe('saved overlay links', () => {
  it('keeps a visitor’s link and look, and a replaced link stops resolving', () => {
    const links = new OverlayLinks(':memory:');
    links.saveView('v1', 'view-a');
    links.saveStyle('v1', { layout: 'lowerthird' });
    expect(links.get('v1')).toEqual({ view: 'view-a', style: { layout: 'lowerthird' }, stream: null });
    // A charity stream's settings and donations are kept with the link.
    links.saveStream('v1', { settings: { partner: 'Partner' }, donations: [], total: 0, count: 0 });
    expect(links.get('v1')?.stream).toEqual({ settings: { partner: 'Partner' }, donations: [], total: 0, count: 0 });
    expect(links.visitorOf('view-a')).toBe('v1');
    links.saveView('v1', 'view-b');
    expect(links.visitorOf('view-a')).toBeNull();
    expect(links.visitorOf('view-b')).toBe('v1');
    links.close();
  });

  it('a session starts with the saved look and saves changes to it', () => {
    const saved: DisplayStyle[] = [];
    const s = new Session(options({ style: { layout: 'lowerthird', background: 'transparent' }, onStyle: (st) => saved.push(st) }));
    expect(s.display.style.layout).toBe('lowerthird');
    s.handle({ type: 'style', patch: { background: 'solid' } });
    expect(saved.at(-1)?.background).toBe('solid');
    expect(saved.at(-1)?.layout).toBe('lowerthird');
  });
});

describe('the display while reciting', () => {
  it('distinguishes the first chosen translation page from automatic following and resets on a new ayah', () => {
    const s = new Session(options());
    s.handle({ type: 'goto', key: '2:282' });
    expect(s.display.englishPage).toBeNull();
    s.handle({ type: 'page', region: 'english', page: 0 });
    expect(s.display.englishPage).toBe(0);
    s.handle({ type: 'english_auto' });
    expect(s.display.englishPage).toBeNull();
    s.handle({ type: 'page', region: 'english', page: 3 });
    s.handle({ type: 'goto', key: '2:255' });
    expect(s.display.englishPage).toBeNull();
  });

  it('turns from automatic page one and wraps a timed translation without restoring recitation following', async () => {
    const clock = new VirtualClock();
    const s = new Session(options({ clock }));
    s.handle({ type: 'style', patch: { translationPageSeconds: 1 } });
    s.handle({ type: 'goto', key: '2:282' });
    s.handle({ type: 'layout', revision: s.display.revision, key: '2:282', englishPages: 2, arabicPages: 3, promotedToFullFrame: false });
    expect(s.display.englishPage).toBeNull();
    await clock.advance(1000);
    expect(s.display.englishPage).toBe(1);
    await clock.advance(1000);
    expect(s.display.englishPage).toBe(0);
  });

  it('turns translation pages on time while the highlight moves', async () => {
    const clock = new VirtualClock();
    const s = new Session(options({ clock }));
    s.handle({ type: 'capture', captureEpoch: 1, event: 'recording' });
    s.handle({ type: 'style', patch: { translationPageSeconds: 10 } });
    s.handle({ type: 'goto', key: '2:282' });
    s.handle({ type: 'layout', revision: s.display.revision, key: '2:282', englishPages: 2, arabicPages: 3, promotedToFullFrame: false });
    const words = corpus.verse('2:282')!.searchText.split(/\s+/);
    for (let n = 1; n <= 24; n++) {
      await clock.advance(500);
      s.handle({ type: 'transcript', captureEpoch: 1, seq: n, receivedAt: clock.t, audioMs: clock.t, tokens: words.slice(0, n).map((w, i) => ({ text: `${i ? ' ' : ''}${w}`, isFinal: false, startMs: i * 500, endMs: i * 500 + 400 })) });
    }
    expect(s.display.englishPage).toBe(1);
  });

  it('drops the highlight, not the ayah, when the control page goes away while listening', () => {
    const clock = new VirtualClock();
    const s = new Session(options({ clock }));
    s.controlConnected();
    s.handle({ type: 'capture', captureEpoch: 1, event: 'recording' });
    s.handle({ type: 'goto', key: '36:9' });
    const words = corpus.verse('36:9')!.searchText.split(/\s+/);
    s.handle({ type: 'transcript', captureEpoch: 1, seq: 0, receivedAt: 0, tokens: words.slice(0, 4).map((w, i) => ({ text: `${i ? ' ' : ''}${w}`, isFinal: false, startMs: i * 600, endMs: i * 600 + 400 })) });
    expect(s.display.cursor).toBeTruthy();
    s.controlDisconnected();
    expect(s.display.verse?.key).toBe('36:9');
    expect(s.display.cursor ?? null).toBeNull();
  });

  it('hides the ayah, never clears it, once listening has been lost for the grace, and shows it again when listening returns', async () => {
    const clock = new VirtualClock();
    const s = new Session(options({ clock }));
    const shown: Array<string | null> = [];
    s.onDisplay((d) => shown.push(d.visible ? d.verse!.key : null));
    s.controlConnected();
    s.handle({ type: 'capture', captureEpoch: 1, event: 'recording' });
    s.handle({ type: 'goto', key: '67:2' });
    s.controlDisconnected();
    await clock.advance(DISCONNECT_GRACE_MS - 1000);
    expect(s.display).toMatchObject({ visible: true, verse: { key: '67:2' } });
    await clock.advance(1000);
    expect(DISCONNECT_GRACE_MS).toBeGreaterThanOrEqual(15_000); // a page reload never touches the stream
    expect(s.display.verse?.key).toBe('67:2');
    expect(s.display.visible).toBe(false);
    expect(s.snapshot()).toMatchObject({ blanked: true, trackerVerse: '67:2' });
    expect(s.snapshot().notice).toMatch(/^Hidden from stream: listening stopped unexpectedly\..*67:2/);
    // The page is back (reopened): the stream stays hidden until listening starts again, then the ayah returns by itself.
    s.controlConnected();
    s.handle({ type: 'capture', captureEpoch: 2, event: 'starting' });
    expect(s.display.visible).toBe(false);
    s.handle({ type: 'capture', captureEpoch: 2, event: 'recording' });
    expect(s.display).toMatchObject({ visible: true, verse: { key: '67:2' } });
    expect(s.snapshot().notice).toBeNull();
    expect(shown).toEqual(['67:2', null, '67:2']);
    // The same after the stream itself fails while the page stays open.
    s.handle({ type: 'capture', captureEpoch: 2, event: 'error', detail: 'Microphone lost' });
    await clock.advance(DISCONNECT_GRACE_MS);
    expect(s.display).toMatchObject({ visible: false, verse: { key: '67:2' } });
    s.handle({ type: 'capture', captureEpoch: 3, event: 'recording' });
    expect(s.display.visible).toBe(true);
  });

  it('never shows again an ayah the broadcaster hid', async () => {
    const clock = new VirtualClock();
    const s = new Session(options({ clock }));
    s.controlConnected();
    s.handle({ type: 'capture', captureEpoch: 1, event: 'recording' });
    s.handle({ type: 'goto', key: '67:2' });
    s.handle({ type: 'blank', on: true });
    s.controlDisconnected();
    await clock.advance(DISCONNECT_GRACE_MS + 1000);
    s.controlConnected();
    s.handle({ type: 'capture', captureEpoch: 2, event: 'recording' });
    expect(s.display).toMatchObject({ visible: false, verse: { key: '67:2' } });
    // Hidden by the outage, then hidden again by the broadcaster: the hide is now theirs.
    s.handle({ type: 'blank', on: false });
    s.controlDisconnected();
    await clock.advance(DISCONNECT_GRACE_MS);
    expect(s.display.visible).toBe(false);
    s.controlConnected();
    s.handle({ type: 'blank', on: true });
    s.handle({ type: 'capture', captureEpoch: 3, event: 'recording' });
    expect(s.display.visible).toBe(false);
    // Unhide is always the broadcaster's to press, and clears the explanation with the hide.
    s.handle({ type: 'blank', on: false });
    expect(s.display.visible).toBe(true);
    expect(s.snapshot().notice).toBeNull();
  });

  it('keeps the ayah up when the page is back within the grace, or when asked to', async () => {
    const clock = new VirtualClock();
    const s = new Session(options({ clock }));
    s.controlConnected();
    s.handle({ type: 'capture', captureEpoch: 1, event: 'recording' });
    s.handle({ type: 'goto', key: '67:2' });
    s.controlDisconnected();
    await clock.advance(DISCONNECT_GRACE_MS - 5000);
    s.controlConnected(); // reloaded: the broadcaster is back and decides
    await clock.advance(DISCONNECT_GRACE_MS);
    expect(s.display).toMatchObject({ visible: true, verse: { key: '67:2' } });
    expect(s.snapshot().notice).toBeNull();
    // "Keep the ayah up if the microphone disconnects"
    s.handle({ type: 'pin', on: true });
    s.handle({ type: 'capture', captureEpoch: 2, event: 'recording' });
    s.controlDisconnected();
    await clock.advance(DISCONNECT_GRACE_MS * 4);
    expect(s.display).toMatchObject({ visible: true, verse: { key: '67:2' } });
  });
});

describe('the hosted service', () => {
  let app: FastifyInstance;
  let base = '';
  let credits: CreditStore;
  let hub: SessionHub;
  let links: OverlayLinks;
  const origin = () => base;

  beforeAll(async () => {
    credits = new CreditStore(':memory:', { freeSecondsPerMonth: 600, ipDailyFreeSeconds: 3600, globalDailyFreeSeconds: 36000, holdMaxSeconds: 300, holdMinSeconds: 20 });
    links = new OverlayLinks(':memory:');
    let n = 0;
    hub = new SessionHub(
      (visitor) => {
        const saved = links.get(visitor);
        const view = saved?.view ?? `view-${visitor.slice(0, 8)}-${n++}-padding`;
        if (!saved) links.saveView(visitor, view);
        return new Session(options({ viewToken: view, onViewToken: (v) => links.saveView(visitor, v) }));
      },
      undefined,
      undefined,
      (view) => links.visitorOf(view),
    );
    const port = 45170 + Math.floor(Math.random() * 500);
    ({ app } = await buildApp({ port, hosted: { hub, credits, identity: new VisitorIdentity(Buffer.alloc(48, 9)), reading: new Session(options()) } }));
    await app.listen({ host: '127.0.0.1', port });
    base = `http://127.0.0.1:${port}`;
  });
  afterAll(async () => {
    await app?.close();
    await new Promise((r) => setTimeout(r, 100));
    credits?.close();
    links?.close();
  });

  const visit = async () => {
    const r = await fetch(`${base}/api/me`, { headers: { origin: origin() } });
    return r.headers.get('set-cookie')!.split(';')[0];
  };
  const control = async (cookie: string) => {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/ws/control`, { headers: { origin: origin(), cookie } });
    const msgs: ControlServerMessage[] = [];
    ws.on('message', (d) => msgs.push(JSON.parse(String(d))));
    await new Promise<void>((r) => ws.on('open', () => r()));
    return { ws, msgs, closed: new Promise<number>((r) => ws.on('close', (code) => r(code))) };
  };
  const until = async (cond: () => boolean, ms = 3000) => {
    const end = Date.now() + ms;
    while (!cond()) {
      if (Date.now() > end) throw new Error('timeout');
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  it('lets anyone read without a visitor cookie', async () => {
    const r = await fetch(`${base}/api/surah/112`);
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toContain('max-age');
    const body = (await r.json()) as { ayahs: unknown[] };
    expect(body.ayahs).toHaveLength(4);
    expect((await fetch(`${base}/api/chapters`)).status).toBe(200);
    expect((await fetch(`${base}/api/verse/1:1`)).status).toBe(200);
  });

  it('ignores the owner’s tracker mode setting from visitors', async () => {
    const cookie = await visit();
    const c = await control(cookie);
    c.ws.send(JSON.stringify({ type: 'mode', mode: 'jev_required' }));
    await new Promise((r) => setTimeout(r, 100));
    const id = new VisitorIdentity(Buffer.alloc(48, 9)).verify(cookie.split('=')[1])!;
    expect(hub.peek(id)?.follower.mode).toBe('deterministic');
    c.ws.close();
  });

  it('limits paid requests per page and says so', async () => {
    const c = await control(await visit());
    for (let i = 0; i < 6; i++) c.ws.send(JSON.stringify({ type: 'command', requestId: `r${i}`, text: '2:255', source: 'typed' }));
    await until(() => c.msgs.some((m) => m.type === 'command_result' && m.result.kind === 'no_match' && /a lot of requests/.test(m.result.message)));
    c.ws.close();
  });

  it('closes a page that floods the server', async () => {
    const c = await control(await visit());
    for (let i = 0; i < 200; i++) c.ws.send(JSON.stringify({ type: 'hold', on: false }));
    expect(await c.closed).toBe(1008);
  });

  it('keeps an overlay link working after its session is dropped', async () => {
    const cookie = await visit();
    const c = await control(cookie);
    await until(() => c.msgs.some((m) => m.type === 'snapshot'));
    const snap = c.msgs.find((m) => m.type === 'snapshot') as Extract<ControlServerMessage, { type: 'snapshot' }>;
    const view = snap.snapshot.overlay.url.replace('view:', '');
    c.ws.close();
    await c.closed;
    await new Promise((r) => setTimeout(r, 50));
    hub.sweep(Date.now() + 31 * 60_000); // idle: no page, no overlay, no microphone
    const id = new VisitorIdentity(Buffer.alloc(48, 9)).verify(cookie.split('=')[1])!;
    expect(hub.peek(id)).toBeNull();
    // OBS reconnects with the same link: the visitor's session comes back with it.
    const o = new WebSocket(`${base.replace('http', 'ws')}/ws/overlay`, { headers: { origin: origin() } });
    const got: Array<{ type: string }> = [];
    o.on('message', (d) => got.push(JSON.parse(String(d))));
    await new Promise<void>((r) => o.on('open', () => r()));
    o.send(JSON.stringify({ type: 'hello', view, role: 'overlay' }));
    await until(() => got.some((m) => m.type === 'display'));
    expect(got.some((m) => m.type === 'denied')).toBe(false);
    // While it is connected the session is kept, and if it is dropped anyway the overlay is told to reconnect.
    const closed = new Promise<number>((r) => o.on('close', (code) => r(code)));
    hub.sweep(Date.now() + 31 * 60_000);
    expect(hub.peek(id)).not.toBeNull();
    hub.peek(id)!.dispose();
    expect(await closed).toBe(4410);
  });
});

