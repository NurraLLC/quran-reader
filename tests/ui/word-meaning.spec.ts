import { expect, test, type Locator } from '@playwright/test';
import { readFileSync } from 'node:fs';

const OWNER = 'ui-test-owner-capability-0001';
const corpus = JSON.parse(readFileSync('data/processed/corpus.json', 'utf8'));
test.use({ video: 'on' });

async function aligned(ayah: Locator) {
  const geometry = await ayah.evaluate((el) => {
    const meaning = el.querySelector<HTMLElement>('.word-meaning.is-active')!;
    const word = meaning.parentElement!.querySelector('.r-word')!;
    const a = word.getBoundingClientRect(), b = meaning.getBoundingClientRect(), c = el.getBoundingClientRect();
    const want = Math.max(c.left + 8 + b.width / 2, Math.min(c.right - 8 - b.width / 2, a.left + a.width / 2));
    return { error: Math.abs(b.left + b.width / 2 - want), gap: b.top - a.bottom, left: b.left, right: b.right };
  });
  expect(geometry.error).toBeLessThan(1);
  expect(geometry.gap).toBeGreaterThanOrEqual(1);
  expect(geometry.gap).toBeLessThan(5);
}

for (const width of [375, 1280]) {
  test.describe(`paired meanings at ${width}px`, () => {
    test.use({ viewport: { width, height: 900 } });
    test('exact meanings remain beneath their Arabic words through recitation and inspection', async ({ page }, info) => {
      await page.goto(`/reader#owner=${OWNER}`);
      await expect(page.locator('.r-top')).toBeVisible();
      await page.getByRole('radio', { name: 'Both', exact: true }).click();
      await page.evaluate(async () => {
        const ws = new WebSocket(`${location.origin.replace('http', 'ws')}/ws/control`);
        await new Promise<void>((resolve) => ws.addEventListener('open', () => resolve(), { once: true }));
        (window as unknown as { meaningSocket: WebSocket }).meaningSocket = ws;
      });
      const send = (m: unknown) => page.evaluate((msg) => (window as unknown as { meaningSocket: WebSocket }).meaningSocket.send(JSON.stringify(msg)), m);
      const epoch = Date.now();
      let seq = 0;
      const say = (words: string[]) => send({ type: 'transcript', captureEpoch: epoch, seq: seq++, receivedAt: 0,
        tokens: [{ text: words.join(' '), isFinal: false }] });
      await send({ type: 'hold', on: false });
      await send({ type: 'capture', captureEpoch: epoch, event: 'recording' });
      await send({ type: 'goto', key: '95:3' });
      const words = corpus.verses.find((v: { key: string }) => v.key === '95:3').searchText.split(/\s+/);
      const current = page.locator('.r-ayah.current');
      await expect(current).toHaveAttribute('id', 'a-95:3');
      const source = (await (await page.request.get('/api/surah/95')).json()).ayahs.find((a: { key: string }) => a.key === '95:3');
      await page.evaluate(() => document.fonts.ready);
      const geometry = () => current.locator('.r-en').evaluate((el) => ({ y: el.getBoundingClientRect().top + scrollY, height: el.getBoundingClientRect().height }));
      const before = await geometry();
      try {
        for (let n = 1; n <= words.length; n++) {
          await say(words.slice(0, n));
          await expect(current.locator('.word-meaning.is-active')).toHaveAttribute('data-meaning-index', String(n - 1));
          await expect(current.locator('.word-meaning.is-active')).toHaveText(source.glosses[n - 1]);
          await expect(current.locator('.r-en')).toHaveText(source.english);
          await aligned(current);
          expect(await geometry()).toEqual(before);
          await page.waitForTimeout(600);
        }
        // Every completed word keeps its own space, including balad between the two others.
        const shown = current.locator('.word-meaning:is(.is-active, .is-context)');
        await expect(shown).toHaveCount(3);
        await expect(current.locator('[data-meaning-index="1"]')).toHaveText(source.glosses[1]);
        const boxes = await shown.evaluateAll((els) => els.map((el) => {
          const r = el.getBoundingClientRect();
          return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, visible: getComputedStyle(el).visibility };
        }));
        for (let i = 0; i < boxes.length; i++) {
          expect(boxes[i].visible).toBe('visible');
          for (let j = i + 1; j < boxes.length; j++) {
            const a = boxes[i], b = boxes[j];
            expect(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top).toBe(true);
          }
        }
        await page.waitForTimeout(1000); // A breath does not guess another word or remove its meaning.
        await page.screenshot({ path: info.outputPath('paired-meaning.png') });
        await current.locator('.r-word').first().click();
        await expect(current.locator('.word-meaning.is-active')).toHaveAttribute('data-meaning-index', '0');
        await aligned(current);
        await send({ type: 'capture', captureEpoch: epoch, event: 'stopped' });
        await send({ type: 'goto', key: '2:282' });
        await expect(current).toHaveAttribute('id', 'a-2:282');
        const longSource = (await (await page.request.get('/api/surah/2')).json()).ayahs.find((a: { key: string }) => a.key === '2:282');
        const all = current.locator('.r-word[role="button"]');
        for (const at of [0, Math.floor(await all.count() / 2), await all.count() - 1]) {
          await all.nth(at).click();
          const index = Number(await all.nth(at).getAttribute('data-rove'));
          await expect(current.locator('.word-meaning.is-active')).toHaveText(longSource.glosses[index]);
          await aligned(current);
          const box = (await current.locator('.word-meaning.is-active').boundingBox())!;
          expect(box.x).toBeGreaterThanOrEqual(0);
          expect(box.x + box.width).toBeLessThanOrEqual(width);
        }
        await expect(current.locator('.r-en')).toHaveText(longSource.english);
        // Once three newer meanings have arrived, the oldest leaves softly instead of stacking up.
        await all.nth(1).click();
        await expect(current.locator('[data-meaning-index="0"]')).toHaveAttribute('aria-hidden', 'true');
        await expect.poll(() => current.locator('[data-meaning-index="0"]').evaluate((el) => getComputedStyle(el).opacity)).toBe('0');
        await expect(current.locator('.word-meaning:is(.is-active, .is-context)')).toHaveCount(3);
        expect(await current.locator('.word-meaning.is-active').evaluate((el) => getComputedStyle(el).animationName)).toBe('meaning-reveal');
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
        await page.emulateMedia({ reducedMotion: 'reduce' });
        expect(await current.locator('.word-meaning.is-active').evaluate((el) => getComputedStyle(el).transitionDuration)).toBe('0s');
        expect(await current.locator('.word-meaning.is-active').evaluate((el) => getComputedStyle(el).animationName)).toBe('none');
        expect(await current.locator('.word-meaning.is-active').evaluate((el) => getComputedStyle(el.parentElement!, '::before').animationName)).toBe('none');
        expect(await current.locator('.word-meaning.is-active').evaluate((el) => getComputedStyle(el.parentElement!, '::before').transitionDuration)).toBe('0s');
        await page.screenshot({ path: info.outputPath('long-ayah.png') });
      } finally {
        await send({ type: 'capture', captureEpoch: epoch, event: 'stopped' });
      }
    });
  });
}
