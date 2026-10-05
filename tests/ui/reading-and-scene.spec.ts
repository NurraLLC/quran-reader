import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';

const OWNER = 'ui-test-owner-capability-0001';
const request = async (page: Page, key: string) => {
  const field = page.getByLabel('Type a reference or what the ayah says');
  await field.fill(key); await field.press('Enter');
  await expect(page.locator('.preview .verse')).toHaveAttribute('aria-label', new RegExp(`${key}$`));
};

/** A second control socket on the control page (owner cookie), as the page forwards recogniser results. */
async function controlSocket(c: Page) {
  await c.evaluate(async () => {
    const socket = new WebSocket(`${location.origin.replace('http', 'ws')}/ws/control`);
    await new Promise<void>((resolve) => socket.addEventListener('open', () => resolve(), { once: true }));
    (window as unknown as { pagingSocket: WebSocket }).pagingSocket = socket;
  });
  return (message: unknown) => c.evaluate((m) => (window as unknown as { pagingSocket: WebSocket }).pagingSocket.send(JSON.stringify(m)), message);
}

const searchWords = (key: string): string[] =>
  JSON.parse(readFileSync('data/processed/corpus.json', 'utf8')).verses.find((v: { key: string }) => v.key === key).searchText.split(/\s+/);

/** Recite an ayah word by word (final recogniser words, one per 100 ms); `step` runs after each word. */
async function recite(send: (m: unknown) => Promise<unknown>, key: string, step: () => Promise<void>) {
  const epoch = Date.now();
  await send({ type: 'hold', on: false });
  await send({ type: 'blank', on: false });
  await send({ type: 'mode', mode: 'deterministic' });
  await send({ type: 'capture', captureEpoch: epoch, event: 'recording' });
  await send({ type: 'goto', key });
  let seq = 0;
  try {
    for (const word of searchWords(key)) {
      await send({ type: 'transcript', captureEpoch: epoch, seq: seq++, receivedAt: 0, tokens: [{ text: ` ${word}`, isFinal: true }] });
      await new Promise((r) => setTimeout(r, 100));
      await step();
    }
    await new Promise((r) => setTimeout(r, 600));
    await step();
  } finally {
    await send({ type: 'capture', captureEpoch: epoch, event: 'stopped' });
  }
}

/** "Translation 2/5 · continues" → [2, 5]; [1, 1] when the translation has one page. */
const pageOf = async (page: Page, selector: string): Promise<[number, number]> => {
  const text = await page.locator(selector).first().textContent({ timeout: 2000 }).catch(() => null);
  const m = text?.match(/(\d+)\/(\d+)/);
  return m ? [Number(m[1]), Number(m[2])] : [1, 1];
};

test('reader appearance is remembered on this device and does not change the broadcast', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 320, height: 740 }, reducedMotion: 'reduce' });
  const c = await context.newPage();
  await c.goto(`/control#owner=${OWNER}`);
  await c.getByRole('button', { name: /^Reading/ }).click();
  await request(c, '112:2');
  const url = await c.getByRole('link', { name: 'Open reading screen' }).getAttribute('href');
  const overlay = await context.newPage();
  await overlay.goto(url!);
  await expect(overlay.locator('.english')).toBeVisible();
  const broadcastSize = await overlay.locator('.english').evaluate((e) => getComputedStyle(e).fontSize);
  const reader = await context.newPage();
  const errors: string[] = [];
  reader.on('pageerror', (e) => errors.push(e.message));
  await reader.goto('/reader');
  await expect(reader.locator('.r-ayah.current')).toHaveAttribute('id', 'a-112:2');
  const original = await reader.locator('.r-ayah.current .r-ar').evaluate((e) => getComputedStyle(e).fontSize);
  const arText = await reader.locator('.r-ayah.current .r-ar').innerText();
  await reader.getByRole('button', { name: /^Menu/ }).click();
  await reader.getByRole('button', { name: /^Reading appearance/ }).click();
  await reader.getByRole('radio', { name: /^Paper/ }).click();
  for (let n = 0; n < 7; n++) await reader.getByRole('button', { name: 'Larger reading text' }).click();
  await expect(reader.getByLabel('Reading text size')).toHaveText('135%');
  await expect(reader.getByRole('button', { name: 'Larger reading text' })).toBeDisabled();
  await reader.getByRole('button', { name: 'Return to reading' }).click();
  await expect(reader.locator('.reader')).toHaveAttribute('data-theme', 'paper');
  await expect(reader.locator('.r-menu-btn')).toBeFocused();
  expect(parseFloat(await reader.locator('.r-ayah.current .r-ar').evaluate((e) => getComputedStyle(e).fontSize))).toBeGreaterThan(parseFloat(original));
  expect(await reader.locator('.r-ayah.current .r-ar').innerText()).toBe(arText);
  expect(await overlay.locator('.english').evaluate((e) => getComputedStyle(e).fontSize)).toBe(broadcastSize);
  expect(await reader.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  mkdirSync('test-results/product-pass', { recursive: true });
  await reader.screenshot({ path: 'test-results/product-pass/paper-reader.png' });
  await reader.reload();
  await expect(reader.locator('.reader')).toHaveAttribute('data-theme', 'paper');
  await reader.getByRole('button', { name: /^Menu/ }).click();
  await reader.getByRole('button', { name: /^Reading appearance/ }).click();
  await expect(reader.getByLabel('Reading text size')).toHaveText('135%');
  await reader.screenshot({ path: 'test-results/product-pass/reading-appearance.png' });
  await reader.getByRole('radio', { name: /^Night/ }).click();
  await reader.keyboard.press('Escape');
  await expect(reader.getByRole('dialog')).toHaveCount(0);
  await expect(reader.locator('.reader')).toHaveAttribute('data-theme', 'night');
  expect(errors).toEqual([]);
  await context.close();
});

test('charity preview uses the actual scene and reaches every translation page in OBS', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, recordVideo: { dir: 'artifacts/product-pass-video', size: { width: 1440, height: 1000 } } });
  const c = await context.newPage();
  const errors: string[] = [];
  c.on('pageerror', (e) => errors.push(e.message));
  await c.goto(`/control#owner=${OWNER}`);
  await c.getByRole('button', { name: /^Reading/ }).click();
  await request(c, '2:282');
  const card = c.locator('.charity-card');
  await card.getByRole('button', { name: 'Preview charity scene' }).click();
  await expect(c.locator('.preview .cs-reader .verse')).toHaveAttribute('aria-label', /2:282$/);
  // A preview is a renderer, not an audience connection that grants live-stream allowances.
  await expect(c.locator('.conn')).toHaveText('OBS/readers connected: 0');
  const url = await card.getByRole('link', { name: 'Open the stream scene' }).getAttribute('href');
  const audience = await context.newPage();
  await audience.setViewportSize({ width: 1920, height: 1080 });
  audience.on('pageerror', (e) => errors.push(e.message));
  await audience.goto(url!);
  const marker = audience.locator('.english .cont');
  const previewMarker = c.locator('.preview .english .cont');
  await expect(marker).toContainText('Translation 1/');
  const total = Number((await marker.innerText()).match(/\/(\d+)/)![1]);
  expect(total).toBeGreaterThan(2);
  const pager = c.locator('.pager > span', { hasText: 'Translation page' });
  await expect(pager).toContainText(`1/${total}`);
  const words: string[] = [];
  for (let n = 1; n <= total; n++) {
    await expect(marker).toContainText(`Translation ${n}/${total}`);
    await expect(previewMarker).toHaveText(await marker.innerText());
    words.push((await audience.locator('.english .line').allTextContents()).join(' '));
    await pager.getByRole('button', { name: '›', exact: true }).click();
  }
  const source = await (await c.request.get('/api/verse/2:282')).json();
  expect(words.join(' ').replace(/\s+/g, ' ')).toBe(source.english.replace(/\s+/g, ' '));
  mkdirSync('test-results/product-pass', { recursive: true });
  await c.screenshot({ path: 'test-results/product-pass/charity-preview.png' });
  // Repeating the selected preview must retain its page controls.
  await c.getByRole('radio', { name: 'Charity scene', exact: true }).click();
  await expect(pager).toContainText(`1/${total}`);
  await c.getByRole('radio', { name: 'Overlay', exact: true }).click();
  await expect(c.locator('.preview .cs-scene')).toHaveCount(0);
  await expect(c.locator('.preview .verse')).toHaveAttribute('aria-label', /2:282$/);
  await c.getByRole('radiogroup', { name: 'Preview backdrop' }).getByRole('radio', { name: 'Light', exact: true }).click();
  await expect(c.locator('.preview')).toHaveClass(/preview-light/);
  await c.getByRole('radio', { name: 'Charity scene', exact: true }).click();
  await expect(previewMarker).toContainText(`Translation 1/${total}`);
  expect(errors).toEqual([]);
  await context.close();
});

test('every audience renderer turns its own translation pages with the recitation', async ({ browser }) => {
  test.setTimeout(120_000);
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const c = await context.newPage();
  const errors: string[] = [];
  c.on('pageerror', (e) => errors.push(e.message));
  await c.goto(`/control#owner=${OWNER}`);
  await c.getByRole('button', { name: /^Reading/ }).click();
  await request(c, '2:282');
  // The operator never selects the charity preview: the page counts it measures are the overlay's.
  await expect(c.getByRole('radio', { name: 'Overlay', exact: true })).toHaveAttribute('aria-checked', 'true');
  const sceneUrl = await c.locator('.charity-card').getByRole('link', { name: 'Open the stream scene' }).getAttribute('href');
  const readingUrl = await c.getByRole('link', { name: 'Open reading screen' }).getAttribute('href');
  const open = async (url: string) => {
    const p = await context.newPage();
    await p.setViewportSize({ width: 1920, height: 1080 });
    p.on('pageerror', (e) => errors.push(e.message));
    await p.goto(url);
    await expect(p.locator('.english .cont')).toContainText('Translation 1/');
    return p;
  };
  const overlay = await open(readingUrl!.replace('#bg=solid&', '#'));
  const scene = await open(sceneUrl!);
  const [, overlayTotal] = await pageOf(overlay, '.english .cont');
  const [, sceneTotal] = await pageOf(scene, '.english .cont');
  // The charity panel needs more pages than the overlay the operator's preview measures.
  expect(sceneTotal).toBeGreaterThan(overlayTotal);
  const seen = { overlay: [] as number[], scene: [] as number[] };
  const send = await controlSocket(c);
  // "Long translations turn pages: only when I press ›" (the default): nobody has paged.
  await send({ type: 'style', patch: { translationPageSeconds: 0 } });
  await recite(send, '2:282', async () => {
    for (const [name, page] of [['overlay', overlay], ['scene', scene]] as const) {
      const [n] = await pageOf(page, '.english .cont');
      if (seen[name].at(-1) !== n) seen[name].push(n);
    }
  });
  // Each renderer shows every one of its own pages, in order, rising with the recitation to its last.
  expect(seen.overlay).toEqual(Array.from({ length: overlayTotal }, (_, i) => i + 1));
  expect(seen.scene).toEqual(Array.from({ length: sceneTotal }, (_, i) => i + 1));
  mkdirSync('test-results/product-pass', { recursive: true });
  await scene.screenshot({ path: 'test-results/product-pass/charity-scene-translation-followed.png' });
  // A page the broadcaster chooses past a renderer's last page holds that last page (never wraps to 1).
  await send({ type: 'page', region: 'english', page: sceneTotal - 1 });
  await expect(scene.locator('.english .cont')).toHaveText(`Translation ${sceneTotal}/${sceneTotal}`);
  await expect(overlay.locator('.english .cont')).toHaveText(`Translation ${overlayTotal}/${overlayTotal}`);
  await send({ type: 'page', region: 'english', page: 0 });
  expect(errors).toEqual([]);
  await context.close();
});

async function alphaAt(page: Page, x: number, y: number) {
  const png = await page.screenshot({ clip: { x, y, width: 2, height: 2 }, omitBackground: true });
  return page.evaluate(async (b64) => {
    const img = new Image(); img.src = `data:image/png;base64,${b64}`; await img.decode();
    const canvas = document.createElement('canvas'); canvas.width = img.width; canvas.height = img.height;
    const ctx = canvas.getContext('2d')!; ctx.drawImage(img, 0, 0);
    return ctx.getImageData(0, 0, 1, 1).data[3];
  }, png.toString('base64'));
}

test('shading changes rendered pixels, including the following mode’s soft backing', async ({ browser }) => {
  const c = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await c.goto(`/control#owner=${OWNER}`);
  await c.getByRole('button', { name: /^Reading/ }).click();
  await request(c, '112:2');
  const url = await c.getByRole('link', { name: 'Open reading screen' }).getAttribute('href');
  const audience = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await audience.goto(url!.replace('#bg=solid&', '#'));
  await expect(audience.locator('.verse')).toHaveAttribute('aria-label', /112:2$/);
  const shade = c.getByRole('slider', { name: 'Panel shading' });
  await shade.press('Home');
  await expect.poll(() => audience.locator('.stage').evaluate((s) => (s as HTMLElement).style.getPropertyValue('--panel-opacity'))).toBe('0.2');
  const faint = await alphaAt(audience, 960, 900);
  await shade.press('End');
  await expect.poll(() => audience.locator('.stage').evaluate((s) => (s as HTMLElement).style.getPropertyValue('--panel-opacity'))).toBe('1');
  expect(await alphaAt(audience, 960, 900)).toBeGreaterThan(faint + 10);
  await c.getByRole('button', { name: /^Reading/ }).click();
  await c.close(); await audience.close();
});
