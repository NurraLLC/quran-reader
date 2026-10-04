import { expect, test, type Page } from '@playwright/test';

const OWNER = 'ui-test-owner-capability-0001';
test.use({ screenshot: 'only-on-failure' });
const errors = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => {
  const messages: string[] = [];
  errors.set(page, messages);
  page.on('pageerror', (error) => messages.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') messages.push(message.text()); });
});
test.afterEach(async ({ page }) => {
  await test.info().attach('console-errors', { body: JSON.stringify(errors.get(page)), contentType: 'application/json' });
  expect(errors.get(page)).toEqual([]);
});

async function openAyah(page: Page, key: string) {
  if (!await page.getByLabel('Type a request').isVisible()) await page.getByRole('button', { name: 'Type instead' }).click();
  await page.getByLabel('Type a request').fill(key);
  await page.getByLabel('Type a request').press('Enter');
  await expect(page.locator('.r-ayah.current')).toHaveAttribute('id', `a-${key}`);
  await expect(page.getByLabel('Type a request')).not.toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

test.describe('reading accessibility', () => {
  test.use({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });

  test('source scripture stays readable and ayah numbers support keyboard selection', async ({ page }) => {
    await page.goto(`/reader#owner=${OWNER}`);
    await expect(page.locator('.r-top')).toBeVisible();
    await page.getByRole('radio', { name: 'Both', exact: true }).click();
    await openAyah(page, '112:2');
    await page.screenshot({ path: 'test-results/continuity-accessibility.png' });
    const source = await (await page.request.get('/api/verse/112:2')).json();
    const snapshot = await page.locator('.r-ayah.current').ariaSnapshot();
    await test.info().attach('ayah-accessibility', { body: snapshot, contentType: 'text/plain' });
    expect(snapshot).toMatch(/^- group /);
    expect(snapshot).toContain(source.english);
    const { toQpcHafsEncoding } = await import('../../src/shared/display-encoding');
    expect(snapshot).toContain(toQpcHafsEncoding(source.arabic).split(/\s+/)[0]);
    const lastWord = page.locator('.r-ayah.current .r-word').last();
    await lastWord.click({ position: { x: 1, y: (await lastWord.boundingBox())!.height / 2 } });
    await expect(lastWord).toHaveClass(/peeked/);
    await page.locator('[id="a-112:3"] .r-ayah-follow').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.r-ayah.current')).toHaveAttribute('id', 'a-112:3');
    await page.getByRole('radio', { name: 'English', exact: true }).click();
    await page.locator('[id="a-112:2"] .r-ayah-follow').focus();
    await page.keyboard.press('Space');
    await expect(page.locator('.r-ayah.current')).toHaveAttribute('id', 'a-112:2');
  });
});

async function openingInReadingArea(page: Page) {
  return page.evaluate(() => {
    const current = document.querySelector('.r-ayah.current');
    const opening = current?.querySelector('.r-word, .r-en')?.getBoundingClientRect();
    const header = document.querySelector('.r-top')!.getBoundingClientRect();
    const dock = document.querySelector('.r-dock')!.getBoundingClientRect();
    return !!opening && opening.top >= header.bottom && opening.top < dock.top - 28;
  });
}

for (const viewport of [{ width: 320, height: 568 }, { width: 390, height: 844 }, { width: 1280, height: 900 }]) {
  test.describe(`${viewport.width}px reading continuity`, () => {
    test.use({ viewport, reducedMotion: 'reduce' });

    test.beforeEach(async ({ page }) => {
      await page.goto(`/reader#owner=${OWNER}`);
      await expect(page.locator('.r-top')).toBeVisible();
      await page.getByRole('radio', { name: 'Both', exact: true }).click();
    });

    test('Home and Continue reveal the selected ayah again', async ({ page }) => {
      await openAyah(page, '67:20');
      await expect.poll(() => openingInReadingArea(page)).toBe(true);
      await page.getByRole('button', { name: /^Menu/ }).click();
      await page.getByRole('button', { name: /^Home/ }).click();
      await page.getByRole('button', { name: 'Continue at Al-Mulk 67:20' }).click();
      await expect.poll(() => openingInReadingArea(page)).toBe(true);
    });

    test('switching language keeps the selected ayah visible while reading silently', async ({ page }) => {
      await openAyah(page, '67:20');
      await page.getByRole('radio', { name: 'English', exact: true }).click();
      await expect(page.locator('.reader')).toHaveAttribute('data-lang', 'english');
      await expect.poll(() => openingInReadingArea(page)).toBe(true);
      await page.getByRole('radio', { name: 'Both', exact: true }).click();
      await expect.poll(() => openingInReadingArea(page)).toBe(true);
    });

    test('requesting the same current ayah reveals it after scrolling away', async ({ page }) => {
      await openAyah(page, '67:20');
      await page.evaluate(() => scrollTo(0, 0));
      expect(await openingInReadingArea(page)).toBe(false);
      await openAyah(page, '67:20');
      await expect.poll(() => openingInReadingArea(page)).toBe(true);
    });

    test('browsing within a long ayah pauses following across language changes until Back', async ({ page }) => {
      await openAyah(page, '2:282');
      await expect.poll(() => openingInReadingArea(page)).toBe(true);
      await page.mouse.wheel(0, 700);
      await expect(page.locator('.r-back')).toBeVisible();
      await page.getByRole('radio', { name: 'English', exact: true }).click();
      await expect(page.locator('.reader')).toHaveAttribute('data-lang', 'english');
      await expect(page.locator('.r-back')).toBeVisible();
      expect(await openingInReadingArea(page)).toBe(false);
      await page.getByRole('button', { name: 'Back to 2:282' }).click();
      await expect.poll(() => openingInReadingArea(page)).toBe(true);
      await expect(page.locator('.r-back')).toHaveCount(0);
      // English has one tall paragraph. Its number/opening, rather than the paragraph's
      // intersecting rectangle, must also leave view before a language/size reflow.
      await page.mouse.wheel(0, 700);
      await expect(page.locator('.r-back')).toBeVisible();
      await page.getByRole('radio', { name: 'Both', exact: true }).click();
      await expect(page.locator('.r-back')).toBeVisible();
      await page.getByRole('button', { name: 'Back to 2:282' }).click();
      await expect.poll(() => openingInReadingArea(page)).toBe(true);
    });

    test('long ayahs open at their beginning and remain scrollable', async ({ page }) => {
      await openAyah(page, '2:282');
      await expect.poll(() => openingInReadingArea(page)).toBe(true);
      await page.screenshot({ path: `test-results/continuity-${viewport.width}-long-both.png` });
      await page.getByRole('radio', { name: 'English', exact: true }).click();
      await expect.poll(() => openingInReadingArea(page)).toBe(true);
      await page.getByRole('button', { name: /^Menu/ }).click();
      await page.getByRole('button', { name: /^Reading appearance/ }).click();
      for (let i = 0; i < 7; i++) await page.getByRole('button', { name: 'Larger reading text' }).click();
      await page.getByRole('button', { name: 'Return to reading' }).click();
      await expect.poll(() => openingInReadingArea(page)).toBe(true);
      await page.screenshot({ path: `test-results/continuity-${viewport.width}-long-english.png` });
      const paragraph = page.locator('.r-ayah.current .r-en');
      await paragraph.evaluate((el) => el.scrollIntoView({ block: 'end' }));
      const atEnd = await page.evaluate(() => scrollY);
      await paragraph.evaluate((el) => el.scrollIntoView({ block: 'start' }));
      expect(await page.evaluate(() => scrollY)).toBeLessThan(atEnd);
      await expect.poll(() => openingInReadingArea(page)).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    });
  });
}
