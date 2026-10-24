import { expect, test } from '@playwright/test';
import { readFileSync, mkdirSync } from 'node:fs';

test('partial speech moves the visible word before finalization in both live views', async ({ browser }) => {
  const c = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await c.goto('/control#owner=ui-test-owner-capability-0001');
  await c.waitForSelector('.topbar');
  const url = await c.locator('.copy-row a').getAttribute('href');
  const r = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await r.goto(url!.replace(/^http:\/\/[^/]+/, ''));
  await c.evaluate(async () => {
    const socket = new WebSocket(`${location.origin.replace('http', 'ws')}/ws/control`);
    await new Promise<void>(resolve => socket.addEventListener('open', () => resolve(), { once: true }));
    (window as unknown as { liveTestSocket: WebSocket }).liveTestSocket = socket;
  });
  const send = (message: unknown) => c.evaluate(m => (window as unknown as { liveTestSocket: WebSocket }).liveTestSocket.send(JSON.stringify(m)), message);
  const epoch = Date.now();
  await send({ type: 'hold', on: false });
  await send({ type: 'blank', on: false });
  await send({ type: 'mode', mode: 'hybrid' });
  await send({ type: 'style', patch: { readingMode: 'follow', layout: 'fullframe' } });
  await send({ type: 'capture', captureEpoch: epoch, event: 'recording' });
  await send({ type: 'goto', key: '18:1' });
  const corpus = JSON.parse(readFileSync('data/processed/corpus.json', 'utf8'));
  const words = corpus.verses.find((v: { key: string }) => v.key === '18:1').searchText.split(/\s+/);
  let seq = 0;
  const partial = (n: number) => send({ type: 'transcript', captureEpoch: epoch, seq: seq++, receivedAt: 0, tokens: [{ text: words.slice(0, n).join(' '), isFinal: false }] });
  try {
  mkdirSync('test-results/live-follow', { recursive: true });
  await partial(6);
  await expect(r.locator('.active-word')).toHaveCount(1);
  await expect(r.locator('.word-meaning.is-active')).toHaveCount(1);
  await expect(r.locator('.gloss')).toHaveCount(0);
  const first = Number(await r.locator('.active-word').getAttribute('data-word-index'));
  await r.screenshot({ path: 'test-results/live-follow/first-word-position.png' });
  for (const n of [7, 8, 9]) {
    await c.waitForTimeout(300);
    await partial(n);
    await expect(r.locator('.active-word')).toHaveCount(1);
    await r.screenshot({ path: `test-results/live-follow/position-${n}.png` });
  }
  await expect.poll(async () => Number(await r.locator('.active-word').getAttribute('data-word-index'))).toBeGreaterThan(first);
  mkdirSync('test-results/live-follow', { recursive: true });
  await r.screenshot({ path: 'test-results/live-follow/follow-words.png' });
  await c.screenshot({ path: 'test-results/live-follow/control.png', fullPage: true });
  await c.getByRole('radio', { name: 'Word focus', exact: true }).click();
  await expect(r.locator('.focus-word[data-active="true"]')).toBeVisible();
  await r.screenshot({ path: 'test-results/live-follow/word-focus.png' });
  await c.getByRole('radio', { name: 'Full ayah', exact: true }).click();
  await expect(r.locator('.active-word')).toHaveCount(0);
  const displayWords = corpus.verses.find((v: { key: string }) => v.key === '18:1').arabicDisplay.trim().split(/\s+/);
  await expect(r.locator('.quran-word')).toHaveCount(displayWords.length);
  await c.getByRole('radio', { name: 'Follow words', exact: true }).click();
  await expect(r.locator('.active-word')).toHaveCount(1);
  const held = await r.locator('.active-word').getAttribute('data-word-index');
  await send({ type: 'hold', on: true });
  await partial(12);
  await expect(r.locator('.active-word')).toHaveAttribute('data-word-index', held!);
  await send({ type: 'capture', captureEpoch: epoch, event: 'stopped' });
  await expect(r.locator('.active-word')).toHaveCount(0);
  } finally {
    await send({ type: 'capture', captureEpoch: epoch, event: 'stopped' });
    await c.waitForTimeout(100);
    await c.close(); await r.close();
  }
});
