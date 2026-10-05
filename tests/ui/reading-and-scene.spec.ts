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

/** The small credit pill never covers text (it takes the corner away from the captions). */
async function creditClear(page: Page) {
  const hits = await page.evaluate(() => {
    const credit = document.querySelector('.stage-credit')?.getBoundingClientRect();
    if (!credit) return ['no credit shown'];
    return [...document.querySelectorAll('.arabic .line, .english .line, .cont, .reference')].filter((n) => {
      const r = document.createRange(); r.selectNodeContents(n); const b = r.getBoundingClientRect();
      return b.right > credit.left && b.left < credit.right && b.bottom > credit.top && b.top < credit.bottom;
    }).map((n) => n.className);
  });
  expect(hits).toEqual([]);
}

/** Every visible text box of the stage stays inside its panel, and nothing covers the reference. */
async function keptInPanel(page: Page) {
  const problems = await page.locator('.panel-on').evaluate((panel) => {
    const box = panel.getBoundingClientRect();
    const text = (el: Element) => { const r = document.createRange(); r.selectNodeContents(el); return r.getBoundingClientRect(); };
    const nodes = [...panel.querySelectorAll('.arabic .line, .english .line, .cont, .reference')];
    const out = nodes.filter((n) => { const r = n.getBoundingClientRect(); return r.top < box.top - 2 || r.bottom > box.bottom + 2 || r.left < box.left - 2 || r.right > box.right + 2; }).map((n) => `outside: ${n.className}`);
    const ref = panel.querySelector('.reference')?.getBoundingClientRect();
    if (ref) for (const n of panel.querySelectorAll('.arabic .line, .english .line, .cont, .gloss')) {
      const r = n.classList.contains('cont') ? text(n) : n.getBoundingClientRect();
      if (r.bottom > ref.top + 1 && r.top < ref.bottom - 1 && r.right > ref.left && r.left < ref.right) out.push(`covers the reference: ${n.className}`);
    }
    return out;
  });
  expect(problems).toEqual([]);
}

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

test('Stream captions page a long ayah inside the caption band instead of covering the camera', async ({ browser }) => {
  test.setTimeout(150_000);
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const c = await context.newPage();
  const errors: string[] = [];
  c.on('pageerror', (e) => errors.push(e.message));
  await c.goto(`/control#owner=${OWNER}`);
  await c.getByRole('button', { name: /^Stream captions/ }).click();
  await request(c, '2:255');
  const readingUrl = await c.getByRole('link', { name: 'Open reading screen' }).getAttribute('href');
  const outputs: Page[] = [];
  for (const url of [readingUrl!.replace('#bg=solid&', '#'), readingUrl!]) {
    const p = await context.newPage();
    await p.setViewportSize({ width: 1920, height: 1080 });
    p.on('pageerror', (e) => errors.push(e.message));
    await p.goto(url);
    outputs.push(p);
  }
  const [overlay, reading] = outputs;
  const send = await controlSocket(c);
  await send({ type: 'style', patch: { translationPageSeconds: 0 } });
  const { toQpcHafsEncoding } = await import('../../src/shared/display-encoding');
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
  for (const key of ['2:255', '2:282']) {
    await request(c, key);
    for (const p of outputs) {
      await expect(p.locator('.verse')).toHaveAttribute('aria-label', new RegExp(`${key}$`));
      await expect(p.locator('.stage')).toHaveAttribute('data-layout', 'lowerthird');
    }
    await expect(c.locator('.warn', { hasText: 'Too long for the lower third' })).toHaveCount(0);
    const source = await (await c.request.get(`/api/verse/${key}`)).json();
    // Every Arabic word, page by page, in order.
    const [, arPages] = await pageOf(reading, '.cont-ar');
    expect(arPages).toBeGreaterThan(1);
    const arabic: string[] = [];
    for (let i = 0; i < arPages; i++) {
      await send({ type: 'page', region: 'arabic', page: i });
      for (const p of outputs) await expect(p.locator('.cont-ar')).toHaveAttribute('aria-label', `Arabic part ${i + 1} of ${arPages}`);
      await expect(overlay.locator('.stage')).toHaveAttribute('data-layout', 'lowerthird');
      arabic.push((await reading.locator('.quran-word').allTextContents()).join(' '));
      for (const p of outputs) await keptInPanel(p);
    }
    expect(norm(arabic.join(' '))).toBe(norm(toQpcHafsEncoding(source.arabic)));
    await send({ type: 'arabic_auto' });
    // The whole translation, page by page.
    const [, enPages] = await pageOf(reading, '.english .cont');
    const english: string[] = [];
    for (let i = 0; i < enPages; i++) {
      await send({ type: 'page', region: 'english', page: i });
      await expect(reading.locator('.english .cont')).toContainText(`Translation ${i + 1}/${enPages}`);
      english.push((await reading.locator('.english .line').allTextContents()).join(' '));
      for (const p of outputs) await keptInPanel(p);
    }
    expect(norm(english.join(' '))).toBe(norm(source.english));
    await send({ type: 'page', region: 'english', page: 0 });
    mkdirSync('test-results/product-pass', { recursive: true });
    await reading.screenshot({ path: `test-results/product-pass/captions-${key.replace(':', '-')}.png` });
  }
  // Reciting 2:255: the band never gives way to the full frame; Arabic and translation pages follow.
  const layouts = new Set<string>();
  const arabicSeen: number[] = [];
  const englishSeen: number[] = [];
  await recite(send, '2:255', async () => {
    layouts.add((await overlay.locator('.stage').getAttribute('data-layout')) ?? '');
    const [a] = await pageOf(overlay, '.cont-ar');
    const [e] = await pageOf(overlay, '.english .cont');
    if (arabicSeen.at(-1) !== a) arabicSeen.push(a);
    if (englishSeen.at(-1) !== e) englishSeen.push(e);
  });
  expect([...layouts]).toEqual(['lowerthird']);
  const [, arTotal] = await pageOf(overlay, '.cont-ar');
  const [, enTotal] = await pageOf(overlay, '.english .cont');
  expect(arabicSeen).toEqual(Array.from({ length: arTotal }, (_, i) => i + 1));
  expect(englishSeen).toEqual(Array.from({ length: enTotal }, (_, i) => i + 1));
  // Captions at the top, nearest the edge: a paged band fills to its top, so the credit takes the bottom corner.
  await send({ type: 'style', patch: { captionPosition: 'top', captionInset: 24 } });
  await request(c, '2:282');
  for (const p of outputs) {
    await expect(p.locator('.stage')).toHaveAttribute('data-position', 'top');
    await expect(p.locator('.verse')).toHaveAttribute('aria-label', /2:282$/);
    await keptInPanel(p);
    await creditClear(p);
  }
  await reading.screenshot({ path: 'test-results/product-pass/captions-top-2-282.png' });
  await c.getByRole('button', { name: /^Reading/ }).click();
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
