// A self-hosted restart (a crash, a closed terminal, an update) seen from the open pages: the old
// control tab is still the owner's, and OBS reconnects to the ayah it was showing, hidden or not.
// Two apps are built over one saved links file, as main.ts builds them; requests are injected, so
// nothing listens on a port.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type WebSocket from 'ws';
import { buildApp } from '../../src/server/app';
import { CommandResolver } from '../../src/server/commands/reducer';
import { localLinks, savedSessionOptions } from '../../src/server/local-links';
import { Session } from '../../src/server/sessions';
import type { ControlServerMessage, DisplayState, OverlayServerMessage } from '../../src/shared/contracts';
import { fullCorpus, VirtualClock } from '../helpers';

const PORT = 4317; // nominal: the Host and Origin the pages use
const origin = `http://127.0.0.1:${PORT}`;
const headers = (cookie?: string) => ({ host: `127.0.0.1:${PORT}`, origin, ...(cookie ? { cookie } : {}) });

const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
};

/** One run of the self-hosted server: its session and app over the saved links, as main.ts builds them. */
async function start(file: string) {
  const { corpus, ix } = fullCorpus();
  const saved = localLinks(file);
  const session = new Session({
    corpus,
    ix,
    resolver: new CommandResolver(corpus, null, null),
    decisionClient: null,
    mode: 'deterministic',
    setup: { soniox: false, jev: { provider: null, configured: false, detail: '' }, semantic: () => 'unavailable' },
    overlayUrl: (v) => `${origin}/overlay#view=${v}`,
    ...savedSessionOptions(saved),
  });
  const { app } = await buildApp({ session, port: PORT, ownerToken: saved.links.owner, ownerCookie: saved.links.cookie });
  await app.ready();
  const stop = async () => {
    await app.close();
    session.dispose();
  };
  return { app, session, saved, stop };
}

type Run = Awaited<ReturnType<typeof start>>;

/** The control page's socket; `closed` resolves with the close code (4401: not the owner). */
async function control(run: Run, cookie: string) {
  const msgs: ControlServerMessage[] = [];
  let closed: number | null = null;
  const ws: WebSocket = await run.app.injectWS('/ws/control', { headers: headers(cookie) }, {
    onInit: (s: WebSocket) => {
      s.on('message', (d) => msgs.push(JSON.parse(String(d))));
      s.on('close', (code) => (closed = code));
    },
  });
  return { ws, msgs, closed: () => closed, send: (m: unknown) => ws.send(JSON.stringify(m)) };
}

/** What OBS receives first when it reconnects with its saved overlay link. */
async function firstDisplay(run: Run, view: string): Promise<DisplayState> {
  const states: DisplayState[] = [];
  const ws: WebSocket = await run.app.injectWS('/ws/overlay', { headers: headers() }, {
    onInit: (s: WebSocket) => s.on('message', (d) => {
      const m = JSON.parse(String(d)) as OverlayServerMessage;
      if (m.type === 'display') states.push(m.state);
    }),
  });
  ws.send(JSON.stringify({ type: 'hello', view, role: 'overlay' }));
  await until(() => states.length > 0);
  ws.terminate();
  return states[0];
}

describe('a self-hosted restart', () => {
  it('keeps the owner signed in and the ayah on stream, hidden or not', async () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'qo-restart-')), 'local-links.json');
    let run = await start(file);
    const exchanged = await run.app.inject({ method: 'POST', url: '/api/owner/session', headers: headers(), payload: { token: run.saved.links.owner } });
    const cookie = String(exchanged.headers['set-cookie']).split(';')[0];
    const view = run.saved.links.view;
    let c = await control(run, cookie);
    c.send({ type: 'goto', key: '67:2' });
    await until(() => run.session.display.verse?.key === '67:2');
    c.ws.terminate();
    await run.stop();

    run = await start(file);
    // The old control tab reconnects with the cookie it already holds: no "Open the private control link".
    expect((await run.app.inject({ method: 'GET', url: '/api/owner/status', headers: headers(cookie) })).json()).toEqual({ owner: true });
    c = await control(run, cookie);
    await until(() => c.msgs.some((m) => m.type === 'snapshot'));
    expect(c.closed()).toBeNull();
    const snap = c.msgs.find((m) => m.type === 'snapshot') as Extract<ControlServerMessage, { type: 'snapshot' }>;
    expect(snap.snapshot.display?.verse?.key).toBe('67:2'); // the first snapshot carries the display
    expect(snap.snapshot.trackerVerse).toBe('67:2');
    // OBS reconnects with its saved link and shows the same ayah again.
    const shown = await firstDisplay(run, view);
    expect(shown.verse?.key).toBe('67:2');
    expect(shown.visible).toBe(true);
    // Following carries on from there: Next goes to 67:3.
    c.send({ type: 'nav', action: 'next' });
    await until(() => run.session.display.verse?.key === '67:3');
    // The broadcaster hides the stream; a restart keeps it hidden.
    c.send({ type: 'blank', on: true });
    await until(() => run.session.display.visible === false);
    c.ws.terminate();
    await run.stop();

    run = await start(file);
    const hidden = await firstDisplay(run, view);
    expect(hidden.verse?.key).toBe('67:3');
    expect(hidden.visible).toBe(false);
    c = await control(run, cookie);
    await until(() => c.msgs.some((m) => m.type === 'snapshot'));
    const after = c.msgs.find((m) => m.type === 'snapshot') as Extract<ControlServerMessage, { type: 'snapshot' }>;
    expect(after.snapshot.blanked).toBe(true);
    c.ws.terminate();
    await run.stop();
  });

  it('a cookie from another set of saved links is refused', async () => {
    const run = await start(path.join(mkdtempSync(path.join(tmpdir(), 'qo-restart-')), 'local-links.json'));
    const other = localLinks(path.join(mkdtempSync(path.join(tmpdir(), 'qo-restart-')), 'local-links.json'));
    try {
      expect((await run.app.inject({ method: 'GET', url: '/api/owner/status', headers: headers(`qo_owner=${other.links.cookie}`) })).json()).toEqual({ owner: false });
      const c = await control(run, `qo_owner=${other.links.cookie}`);
      await until(() => c.closed() !== null);
      expect(c.closed()).toBe(4401);
    } finally {
      await run.stop();
    }
  });

  it('saves the ayah when it or its hidden state changes, never per highlight step', async () => {
    const { corpus, ix } = fullCorpus();
    const clock = new VirtualClock();
    const saved: Array<{ key: string; hidden: boolean } | null> = [];
    const s = new Session({ corpus, ix, resolver: new CommandResolver(corpus, null, null), decisionClient: null, mode: 'deterministic', setup: { soniox: true, jev: { provider: null, configured: false, detail: '' }, semantic: () => '' }, overlayUrl: (v) => v, clock, onDisplayKey: (d) => saved.push(d) });
    const revisions: number[] = [];
    s.onDisplay((d) => revisions.push(d.revision));
    s.handle({ type: 'capture', captureEpoch: 1, event: 'recording' });
    s.handle({ type: 'goto', key: '36:9' });
    const words = corpus.verse('36:9')!.searchText.split(/\s+/);
    for (let n = 1; n <= words.length; n++) {
      await clock.advance(400);
      s.handle({ type: 'transcript', captureEpoch: 1, seq: n, receivedAt: clock.t, audioMs: clock.t, tokens: words.slice(0, n).map((w, i) => ({ text: `${i ? ' ' : ''}${w}`, isFinal: false, startMs: i * 400, endMs: i * 400 + 350 })) });
    }
    expect(revisions.length).toBeGreaterThan(words.length / 2); // the highlight moved many times
    expect(saved).toEqual([{ key: '36:9', hidden: false }]);
    s.handle({ type: 'blank', on: true });
    s.handle({ type: 'style', patch: { englishScale: 1.2 } });
    s.handle({ type: 'blank', on: true });
    expect(saved).toEqual([{ key: '36:9', hidden: false }, { key: '36:9', hidden: true }]);
    s.dispose();
  });

  it('starts from the saved ayah without saving it again, and ignores one the corpus does not have', () => {
    const { corpus, ix } = fullCorpus();
    const make = (initialDisplay: { key: string; hidden: boolean }, saved: unknown[]) => new Session({ corpus, ix, resolver: new CommandResolver(corpus, null, null), decisionClient: null, mode: 'deterministic', setup: { soniox: true, jev: { provider: null, configured: false, detail: '' }, semantic: () => '' }, overlayUrl: (v) => v, initialDisplay, onDisplayKey: (d) => saved.push(d) });
    const saved: unknown[] = [];
    const s = make({ key: '67:2', hidden: true }, saved);
    expect(s.display).toMatchObject({ verse: { key: '67:2' }, visible: false });
    s.handle({ type: 'style', patch: { englishScale: 1.3 } });
    expect(saved).toEqual([]);
    s.handle({ type: 'blank', on: false });
    expect(saved).toEqual([{ key: '67:2', hidden: false }]);
    s.dispose();
    const unknown = make({ key: '115:1', hidden: false }, []);
    expect(unknown.display.verse).toBeNull();
    expect(unknown.snapshot().trackerVerse).toBeNull();
    unknown.dispose();
  });

  it('refuses an owner cookie too short to be a secret', async () => {
    const { corpus, ix } = fullCorpus();
    const session = new Session({ corpus, ix, resolver: new CommandResolver(corpus, null, null), decisionClient: null, mode: 'deterministic', setup: { soniox: false, jev: { provider: null, configured: false, detail: '' }, semantic: () => '' }, overlayUrl: (v) => v });
    await expect(buildApp({ session, port: PORT, ownerCookie: 'short' })).rejects.toThrow(/owner cookie/i);
    session.dispose();
  });
});
