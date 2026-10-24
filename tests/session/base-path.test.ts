// Served under a path of another site (nurra.org/quran-reader): every address the browser gets
// carries the prefix, and requests work with or without it (a proxy may strip it or not).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { buildApp, normalizeBase, stripBase } from '../../src/server/app';
import { CommandResolver } from '../../src/server/commands/reducer';
import { Session } from '../../src/server/sessions';
import { fullCorpus } from '../helpers';
import { CreditStore } from '../../src/server/billing/credits';
import { SessionHub } from '../../src/server/billing/hub';
import { VisitorIdentity } from '../../src/server/billing/identity';
import { WebSocket } from 'ws';

describe('base path helpers', () => {
  it('normalizes and strips', () => {
    expect(normalizeBase('quran-reader/')).toBe('/quran-reader');
    expect(normalizeBase('/')).toBe('');
    expect(normalizeBase(undefined)).toBe('');
    expect(stripBase('/quran-reader', '/quran-reader')).toBe('/');
    expect(stripBase('/quran-reader/api/me', '/quran-reader')).toBe('/api/me');
    expect(stripBase('/quran-reader?x=1', '/quran-reader')).toBe('/?x=1');
    expect(stripBase('/api/me', '/quran-reader')).toBe('/api/me');
    expect(stripBase('/quran-readers', '/quran-reader')).toBe('/quran-readers');
  });
});

describe.skipIf(!existsSync('dist/web/index.html'))('serving under /quran-reader', () => {
  let app: FastifyInstance;
  let base = '';
  beforeAll(async () => {
    const { corpus, ix } = fullCorpus();
    const session = new Session({ corpus, ix, resolver: new CommandResolver(corpus, null, null), decisionClient: null, mode: 'deterministic', setup: { soniox: false, jev: { provider: null, configured: false, detail: '' }, semantic: () => '' }, overlayUrl: (v) => v });
    const port = 46170 + Math.floor(Math.random() * 500);
    ({ app } = await buildApp({ basePath: '/quran-reader', extraHosts: ['reader-origin.test'], session, port, ownerToken: 'base-path-test-owner-token-000001' }));
    await app.listen({ host: '127.0.0.1', port });
    base = `http://127.0.0.1:${port}`;
  });
  afterAll(async () => app?.close());

  it('gives the page addresses under the base, and answers with or without it', async () => {
    const html = await (await fetch(`${base}/quran-reader/reader`)).text();
    expect(html).toContain('<meta name="qo-base" content="/quran-reader" />');
    expect(html).toMatch(/src="\/quran-reader\/assets\/index-[^"]+\.js"/);
    expect(html).toContain('href="/quran-reader/manifest.webmanifest"');
    expect(html).toMatch(/url\(['"]?\/quran-reader\/fonts\/UthmanicHafs_V22\.ttf/);
    expect(html).not.toMatch(/(src|href)="\.\//);
    const manifest = await (await fetch(`${base}/quran-reader/manifest.webmanifest`)).json();
    expect(manifest.start_url).toBe('/quran-reader/');
    expect(manifest.icons[0].src).toBe('/quran-reader/icon-192.png');
    expect((await fetch(`${base}/quran-reader/api/owner/status`)).status).toBe(200);
    expect((await fetch(`${base}/api/owner/status`)).status).toBe(200); // a proxy that strips the prefix
    const home = await fetch(`${base}/quran-reader`, { redirect: 'manual' });
    expect(home.headers.get('location')).toBe('/quran-reader/control');
  });

  it('accepts the origin name a proxy forwards to, and no other host', async () => {
    const http = await import('node:http');
    const status = (host: string) =>
      new Promise<number>((resolve, reject) => {
        const u = new URL(`${base}/quran-reader/api/owner/status`);
        http.get({ hostname: u.hostname, port: u.port, path: u.pathname, headers: { host } }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        }).on('error', reject);
      });
    expect(await status('reader-origin.test')).toBe(200);
    expect(await status('evil.example')).toBe(421);
  });
});

describe('the visitor cookie under a base path', () => {
  it('is scoped to the app, so the rest of the site never receives it', async () => {
    const { corpus, ix } = fullCorpus();
    const resolver = new CommandResolver(corpus, null, null);
    const credits = new CreditStore(':memory:');
    const hub = new SessionHub(() => new Session({ corpus, ix, resolver, decisionClient: null, mode: 'deterministic', setup: { soniox: false, jev: { provider: null, configured: false, detail: '' }, semantic: () => '' }, overlayUrl: (v) => v }));
    const port = 46700 + Math.floor(Math.random() * 300);
    const { app } = await buildApp({ basePath: '/quran-reader', port, hosted: { hub, credits, identity: new VisitorIdentity(Buffer.alloc(48, 3)) } });
    await app.listen({ host: '127.0.0.1', port });
    try {
      const r = await fetch(`http://127.0.0.1:${port}/quran-reader/api/me`, { headers: { origin: `http://127.0.0.1:${port}` } });
      expect(r.headers.get('set-cookie')).toMatch(/qo_visitor=[^;]+;.*Path=\/quran-reader;/);
      // A returning visitor whose cookie was issued site-wide keeps the same identity under the
      // app's path, and the site-wide copy is expired.
      const cookie = r.headers.get('set-cookie')!.split(';')[0];
      const again = await fetch(`http://127.0.0.1:${port}/quran-reader/api/me`, { headers: { origin: `http://127.0.0.1:${port}`, cookie } });
      const set = again.headers.getSetCookie();
      expect(set.find((c) => c.includes('Path=/quran-reader'))).toMatch(new RegExp(`^${cookie.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')};`));
      expect(set.find((c) => /Path=\/;/.test(c))).toMatch(/^qo_visitor=;.*Max-Age=0/);
      // A browser can send an old domain-scoped copy before the current app-scoped cookie.
      // Keep the verified identity when migrating, and use it for the control socket too.
      for (const old of ['expired.invalid', '%E0%A4%A']) {
        const duplicates = `qo_visitor=${old}; ${cookie}; qo_visitor=another.invalid`;
        const headers = { origin: `http://127.0.0.1:${port}`, cookie: duplicates };
        const returning = await fetch(`http://127.0.0.1:${port}/quran-reader/api/me`, { headers });
        expect(returning.headers.getSetCookie().find(c => c.includes('Path=/quran-reader'))?.split(';')[0]).toBe(cookie);
        expect(await (await fetch(`http://127.0.0.1:${port}/quran-reader/api/owner/status`, { headers })).json()).toEqual({ owner: true });
        await new Promise<void>((resolve, reject) => {
          const ws = new WebSocket(`ws://127.0.0.1:${port}/quran-reader/ws/control`, { headers });
          const timer = setTimeout(() => { ws.terminate(); reject(Error('Visitor control connection timed out')); }, 3000);
          ws.once('message', raw => { clearTimeout(timer); ws.close(); expect(JSON.parse(raw.toString()).type).toBe('snapshot'); resolve(); });
          ws.once('close', code => { clearTimeout(timer); if (code === 4401) reject(Error('Valid visitor cookie was masked')); });
          ws.once('error', err => { clearTimeout(timer); reject(err); });
        });
      }
    } finally {
      await app.close();
      await new Promise((res) => setTimeout(res, 100));
      credits.close();
    }
  });
});

