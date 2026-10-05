// Launch fixes for the personal reader, measured in the real page: meanings stay on a phone's screen,
// menus never move the passage, the place survives language/size changes and a return, typed "Name N"
// opens that ayah and says so without covering the passage, the start page's example plays once,
// and the keyboard reaches the controls and every word's meaning in a few steps.
import { expect, test, type Page } from '@playwright/test';

const OWNER = 'ui-test-owner-capability-0001';

async function open(page: Page) {
  await page.goto(`/reader#owner=${OWNER}`);
  await expect(page.locator('.r-top')).toBeVisible();
  await page.getByRole('radio', { name: 'Both', exact: true }).click();
  await expect(page.locator('.reader')).toHaveAttribute('data-lang', 'both');
}

async function openAyah(page: Page, text: string, key: string) {
  if (!(await page.getByLabel('Type a request').isVisible())) await page.getByRole('button', { name: 'Type instead' }).click();
  await page.getByLabel('Type a request').fill(text);
  await page.getByLabel('Type a request').press('Enter');
  await expect(page.locator('.r-ayah.current')).toHaveAttribute('id', `a-${key}`);
  await page.evaluate(() => document.fonts.ready);
}

/** The ayah at the top of the reading band and how far into it, as the reader itself measures it. */
const place = (page: Page) => page.evaluate(() => {
  const top = document.querySelector('.r-top')!.getBoundingClientRect().height + 8;
  for (const el of document.querySelectorAll<HTMLElement>('.r-page .r-ayah')) {
    const r = el.getBoundingClientRect();
    if (r.bottom > top + 1) return { key: el.id.slice(2), gap: Math.round(r.top - top), fraction: r.top >= top ? 0 : (top - r.top) / r.height };
  }
  return null;
});

function expectSamePlace(after: Awaited<ReturnType<typeof place>>, before: Awaited<ReturnType<typeof place>>) {
  expect(after?.key).toBe(before?.key);
  if (before!.gap >= 0) expect(Math.abs(after!.gap - before!.gap)).toBeLessThanOrEqual(2);
  else expect(Math.abs(after!.fraction - before!.fraction)).toBeLessThanOrEqual(0.02);
}

const currentTop = (page: Page) => page.locator('.r-ayah.current').evaluate((el) => el.getBoundingClientRect().top);
/** Sequential focus starts again from the top of the page (as after a fresh load). */
const fromTop = (page: Page) => page.evaluate(() => {
  document.body.tabIndex = -1;
  document.body.focus({ preventScroll: true });
  document.body.removeAttribute('tabindex');
});

test.describe('phone', () => {
  test.use({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });

  test('every word meaning stays on the screen and the page never widens', async ({ page }) => {
    await open(page);
    for (const key of ['2:255', '2:125']) {
      await openAyah(page, key, key);
      const words = page.locator(`[id="a-${key}"] .r-word[role="button"]`);
      const n = await words.count();
      expect(n).toBeGreaterThan(20);
      for (let i = 0; i < n; i++) {
        await words.nth(i).scrollIntoViewIfNeeded();
        await words.nth(i).click();
        const box = (await words.nth(i).locator('.r-gloss').boundingBox())!;
        expect(box.x, `${key} word ${i}`).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width, `${key} word ${i}`).toBeLessThanOrEqual(375);
      }
      expect(await page.evaluate(() => ({ w: innerWidth, s: document.documentElement.scrollWidth }))).toEqual({ w: 375, s: 375 });
      const dock = (await page.locator('.r-dock').boundingBox())!;
      expect(dock.x + dock.width).toBeLessThanOrEqual(375);
      expect(dock.y + dock.height).toBeLessThanOrEqual(812);
    }
    await page.screenshot({ path: 'test-results/reader-launch/phone-meaning-2-125.png' });
  });

  test('a typed surah name and number opens that ayah; the confirmation never covers the passage', async ({ page }) => {
    await open(page);
    await openAyah(page, 'Kahf 10', '18:10');
    await expect(page.locator('.r-status')).toContainText('Opened 18:10.');
    await expect(page.locator('.r-sheet')).toHaveCount(0);
    await openAyah(page, 'Maryam', '19:1');
    await expect(page.locator('.r-status')).toContainText('Opened 19:1 · Surah Maryam starts at 19:1.');
    await openAyah(page, 'last ayah of Al-Baqarah', '2:286');
    await expect(page.locator('.r-status')).toContainText('The last ayah of Surah Al-Baqarah is 2:286.');
    await expect(page.locator('.r-sheet')).toHaveCount(0);
    await page.screenshot({ path: 'test-results/reader-launch/phone-confirmation-in-status.png' });
  });
});

for (const viewport of [{ width: 375, height: 812 }, { width: 1440, height: 900 }]) {
  test(`${viewport.width}px: opening Menu or Reading appearance never scrolls the passage`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await open(page);
    await openAyah(page, '2:255', '2:255');
    // The page itself carries no scroll padding; the reading targets carry the band's margins.
    const margins = await page.evaluate(() => {
      const ayah = getComputedStyle(document.querySelector('.r-ayah')!);
      return { padding: getComputedStyle(document.documentElement).scrollPaddingTop, top: ayah.scrollMarginTop, bottom: ayah.scrollMarginBottom,
        header: Math.round(document.querySelector('.r-top')!.getBoundingClientRect().height), dock: Math.round(document.querySelector('.r-dock')!.getBoundingClientRect().height) };
    });
    expect(margins.padding).toBe('auto');
    expect(margins.top).toBe(`${margins.header + 8}px`);
    expect(margins.bottom).toBe(`${margins.dock + 28}px`);
    const before = await currentTop(page);
    await page.getByRole('button', { name: /^Menu/ }).click();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(Math.abs((await currentTop(page)) - before)).toBeLessThanOrEqual(1);
    await page.getByRole('button', { name: /^Menu/ }).click();
    await page.getByRole('button', { name: /^Reading appearance/ }).click();
    await page.getByRole('button', { name: 'Return to reading' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Menu/ })).toBeFocused();
    expect(Math.abs((await currentTop(page)) - before)).toBeLessThanOrEqual(1);
  });
}

test.describe('reading on by hand', () => {
  test.use({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });

  test('language and text size keep the place being read', async ({ page }) => {
    await open(page);
    await openAyah(page, '2:255', '2:255');
    await page.mouse.wheel(0, 1500);
    await expect(page.locator('.r-back')).toBeVisible();
    const start = await place(page);
    expect(start?.key).not.toBe('2:255');
    for (const lang of ['English', 'Both', 'عربي', 'Both'] as const) {
      const before = await place(page);
      await page.getByRole('radio', { name: lang, exact: true }).click();
      await expect(page.getByRole('radio', { name: lang, exact: true })).toHaveAttribute('aria-checked', 'true');
      expectSamePlace(await place(page), before);
    }
    await page.getByRole('button', { name: /^Menu/ }).click();
    await page.getByRole('button', { name: /^Reading appearance/ }).click();
    for (let i = 0; i < 4; i++) {
      const before = await place(page);
      await page.getByRole('button', { name: 'Larger reading text' }).click();
      expectSamePlace(await place(page), before);
    }
    await page.getByRole('button', { name: 'Return to reading' }).click();
    await expect(page.locator('.r-back')).toBeVisible();
  });

  test('a return continues where silent reading stopped, with the chosen ayah one tap away', async ({ page }) => {
    await open(page);
    await openAyah(page, '2:255', '2:255');
    await page.mouse.wheel(0, 2200);
    await expect(page.locator('.r-back')).toBeVisible();
    await page.waitForTimeout(400); // the place is noted once scrolling settles
    const read = (await place(page))!;
    expect(read.key).not.toBe('2:255');
    await page.reload();
    await expect(page.locator('.r-ayah.current')).toHaveAttribute('id', 'a-2:255');
    await expect.poll(async () => (await place(page))?.key).toBe(read.key);
    await expect(page.getByRole('button', { name: 'Back to 2:255' })).toBeVisible();
    await page.getByRole('button', { name: /^Menu/ }).click();
    await page.getByRole('button', { name: /^Home/ }).click();
    await page.getByRole('button', { name: `Continue at Al-Baqarah ${read.key}` }).click();
    await expect.poll(async () => (await place(page))?.key).toBe(read.key);
    await page.getByRole('button', { name: 'Back to 2:255' }).click();
    // A long ayah is shown from its opening words.
    await expect.poll(async () => page.locator('.r-ayah.current .r-word').first().evaluate((el) => {
      const r = el.getBoundingClientRect();
      return r.top >= document.querySelector('.r-top')!.getBoundingClientRect().bottom && r.top < innerHeight / 2;
    })).toBe(true);
  });
});

test.describe('the start page example', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  async function home(page: Page) {
    await open(page);
    if (await page.locator('.r-welcome').count() === 0) {
      await page.getByRole('button', { name: /^Menu/ }).click();
      await page.getByRole('button', { name: /^Home/ }).click();
    }
    await expect(page.locator('.r-demo .r-demo-line').first()).toBeVisible();
    await expect(page.locator('.r-demo-badge')).toHaveText('Example');
  }

  test('plays once, then rests; Next word and a tapped word take over', async ({ page }) => {
    await home(page);
    const play = page.locator('.r-demo-controls button').first();
    await expect(play).toHaveText('Pause', { timeout: 5_000 });
    await expect(play).toHaveText('Replay', { timeout: 20_000 });
    const rest = await page.locator('.r-demo .r-word.active').textContent();
    await page.waitForTimeout(2500);
    await expect(play).toHaveText('Replay'); // it does not loop
    expect(await page.locator('.r-demo .r-word.active').textContent()).toBe(rest);
    await page.getByRole('button', { name: 'Next word' }).click();
    await expect(play).toHaveText('Play');
    await expect(page.locator('.r-demo .r-demo-line.current .r-word').first()).toHaveClass(/active/);
    await page.locator('.r-demo .r-demo-line.current .r-word').nth(2).click();
    await expect(page.locator('.r-demo .r-demo-line.current .r-word').nth(2)).toHaveClass(/active/);
    await expect(page.locator('.r-demo .r-gloss')).toHaveText('the Most Gracious');
    await page.waitForTimeout(1500);
    await expect(page.locator('.r-demo .r-demo-line.current .r-word').nth(2)).toHaveClass(/active/); // stays paused
  });

  test('never plays by itself with reduced motion', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await home(page);
    await page.waitForTimeout(3000);
    await expect(page.locator('.r-demo-controls button').first()).toHaveText('Play');
    await expect(page.locator('.r-demo .r-demo-line.current .r-word').first()).toHaveClass(/active/);
    await expect(page.locator('.r-demo .r-gloss')).toHaveText('In (the) name');
    await page.getByRole('button', { name: 'Next word' }).click();
    await expect(page.locator('.r-demo .r-gloss')).toHaveText('(of) Allah');
  });
});

test('About credits each source and promises nothing the reader does not do', async ({ page }) => {
  await page.goto('/about');
  const how = page.locator('section', { has: page.getByRole('heading', { name: 'How it works' }) });
  await expect(how).toContainText('Arabic font: KFGQPC HAFS Uthmanic Script, by the King Fahd Glorious Quran Printing Complex');
  await expect(how).toContainText('English translation: Saheeh International (Dar Abul-Qasim)');
  await expect(how).toContainText('it doesn’t grade recitation or mark mistakes');
  await expect(how).not.toContainText('display font are provided through Quran Foundation');
  await expect(page.locator('.about-page')).not.toContainText('checking their hifz');
});

test.describe('keyboard', () => {
  test.use({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });

  test('a few Tab stops reach the controls, and arrow keys reach each word and its meaning', async ({ page }) => {
    await open(page);
    await openAyah(page, '2:255', '2:255');
    await expect(page.getByLabel('Type a request')).toHaveCount(0);
    await fromTop(page);
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Skip to reading controls' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: 'Type instead' })).toBeFocused();
    // From the top, through Al-Baqarah's 286 ayahs, to the controls.
    await fromTop(page);
    let stops = 0;
    for (; stops < 30; stops++) {
      await page.keyboard.press('Tab');
      if (await page.getByRole('button', { name: 'Type instead' }).evaluate((el) => el === document.activeElement)) break;
    }
    expect(stops + 1).toBeLessThanOrEqual(8);
    // Back into the passage: its one stop is the current ayah's number.
    await page.keyboard.press('Shift+Tab');
    await expect(page.locator('[id="a-2:255"] .r-ayah-follow')).toBeFocused();
    await page.keyboard.press('ArrowRight'); // right to left: the word before the number
    const word = page.locator('[id="a-2:255"] .r-word[role="button"]').last();
    await expect(word).toBeFocused();
    await expect(word.locator('.r-gloss')).toBeVisible();
    const meaning = (await word.locator('.r-gloss').textContent())!;
    await expect(page.locator('.r-sr-only[aria-live]').last()).toHaveText(meaning);
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('[id="a-2:255"] .r-word[role="button"]').nth(-2)).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('[id="a-2:256"] .r-ayah-follow')).toBeFocused();
    await expect(page.locator('.r-ayah .r-gloss')).toHaveCount(0); // a meaning shown from the keyboard leaves with focus
    await page.keyboard.press('Enter');
    await expect(page.locator('.r-ayah.current')).toHaveAttribute('id', 'a-2:256');
    await page.screenshot({ path: 'test-results/reader-launch/keyboard-2-256.png' });
  });
});
