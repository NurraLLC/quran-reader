// Reader pages are readable without running the app (search and answer engines, link previews): each
// route gets its own title, description and canonical address, a short static summary in <noscript>,
// and the stream outputs (overlay, reading screen, charity scene) are kept out of search results.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/server/app';
import { CreditStore } from '../../src/server/billing/credits';
import { SessionHub } from '../../src/server/billing/hub';
import { VisitorIdentity } from '../../src/server/billing/identity';
import { CommandResolver } from '../../src/server/commands/reducer';
import { Session } from '../../src/server/sessions';
import { fullCorpus } from '../helpers';

const head = (html: string) => html.slice(0, html.indexOf('</head>'));
const title = (html: string) => html.match(/<title>([^<]*)<\/title>/)?.[1];
const meta = (html: string, name: string) => html.match(new RegExp(`<meta name="${name}" content="([^"]*)"`))?.[1];
const canonical = (html: string) => html.match(/<link rel="canonical" href="([^"]*)"/)?.[1];
const summary = (html: string) => html.match(/<noscript>([\s\S]*?)<\/noscript>/)?.[1] ?? '';

describe.skipIf(!existsSync('dist/web/index.html'))('reader pages for crawlers (hosted under nurra.org/quran-reader)', () => {
  let app: FastifyInstance;
  let credits: CreditStore;
  let base = '';
  beforeAll(async () => {
    const { corpus, ix } = fullCorpus();
    const resolver = new CommandResolver(corpus, null, null);
    credits = new CreditStore(':memory:');
    const hub = new SessionHub(() => new Session({ corpus, ix, resolver, decisionClient: null, mode: 'deterministic', setup: { soniox: false, jev: { provider: null, configured: false, detail: '' }, semantic: () => '' }, overlayUrl: (v) => v }));
    const port = 47100 + Math.floor(Math.random() * 400);
    ({ app } = await buildApp({ basePath: '/quran-reader', port, hosted: { hub, credits, identity: new VisitorIdentity(Buffer.alloc(48, 5)), publicOrigin: 'https://nurra.org' } }));
    await app.listen({ host: '127.0.0.1', port });
    base = `http://127.0.0.1:${port}/quran-reader`;
  });
  afterAll(async () => { await app?.close(); credits?.close(); });
  const page = async (path: string) => (await fetch(`${base}${path}`)).text();

  it('gives each page its own title, description and canonical address', async () => {
    const start = await page('/');
    expect(title(start)).toBe('Quran Reader: recite, and the page follows along');
    expect(meta(start, 'description')).toContain('Each word you recite lights up with its meaning');
    expect(canonical(start)).toBe('https://nurra.org/quran-reader/');
    expect(canonical(await page('/reader'))).toBe('https://nurra.org/quran-reader/');

    const control = await page('/control');
    expect(title(control)).toBe('Stream controls · Quran Reader');
    expect(meta(control, 'description')).toMatch(/OBS/);
    expect(canonical(control)).toBe('https://nurra.org/quran-reader/control');

    const about = await page('/about');
    expect(title(about)).toBe('Why we built this · Quran Reader');
    expect(canonical(about)).toBe('https://nurra.org/quran-reader/about');
    for (const html of [start, control, about]) expect(meta(html, 'robots')).toBeUndefined();
  });

  it('keeps the stream outputs out of search results', async () => {
    for (const path of ['/overlay', '/read', '/stream']) {
      const html = await page(path);
      expect(meta(html, 'robots'), path).toBe('noindex');
      expect(canonical(html), path).toBeUndefined();
      expect(summary(html), path).toBe('');
    }
  });

  it('carries a short static summary with links that work without the app', async () => {
    const start = summary(await page('/'));
    expect(start).toContain('<h1>Recite, and the page follows along.</h1>');
    expect(start).toContain('href="/quran-reader/privacy.html"');
    expect(start).toContain('href="/quran-reader/about"');
    expect(summary(await page('/about'))).toContain('King Fahd Glorious Quran Printing Complex');
    expect(summary(await page('/control'))).toContain('OBS');
    // The summary sits outside the app's root, so the running app never shows or replaces it.
    const html = await page('/');
    expect(html.indexOf('<noscript>')).toBeGreaterThan(html.indexOf('<div id="root"></div>'));
    expect(head(html)).not.toContain('<noscript>');
  });
});
