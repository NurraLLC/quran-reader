import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const OWNER = 'ui-test-owner-capability-0001';
const output = (page: Page) => page.locator('.card', { has: page.getByRole('heading', { name: 'Stream output' }) });
const openVerse = async (page: Page, key: string) => {
  await page.getByLabel('Type a reference or what the ayah says').fill(key);
  await page.getByLabel('Type a reference or what the ayah says').press('Enter');
  await expect(page.locator('.preview .verse')).toHaveAttribute('aria-label', new RegExp(`${key}$`));
};

// Uses the keyboard so each size change passes through the real control and server channel.
async function size(page: Page, label: string, value: string) {
  const slider = page.getByRole('slider', { name: label, exact: true });
  await slider.press('Home');
  for (let n = 0; n < 30 && await slider.inputValue() !== value; n++) await slider.press('ArrowRight');
  await expect(slider).toHaveValue(value);
}

async function fits(page: Page) {
  const failures = await page.locator('.panel-on').evaluate((panel) => {
    const box = panel.getBoundingClientRect();
    return [...panel.querySelectorAll('.arabic .line, .english .line, .reference')].filter((node) => {
      const r = node.getBoundingClientRect();
      return r.left < box.left - 2 || r.right > box.right + 2 || r.top < box.top - 2 || r.bottom > box.bottom + 2;
    }).map((node) => node.className);
  });
  expect(failures).toEqual([]);
}

test('customize a look, mirror it to the audience, reload and restore', async ({ browser }) => {
  const errors: string[] = [];
  const c = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  c.on('pageerror', (e) => errors.push(e.message));
  await c.goto(`/control#owner=${OWNER}`);
  const card = output(c);
  await card.getByRole('button', { name: /^Reading/ }).click();
  await openVerse(c, '112:2');
  const url = await card.getByRole('link', { name: 'Open reading screen' }).getAttribute('href');
  const audience = await browser.newPage({ viewport: { width: 1920, height: 1080 }, reducedMotion: 'reduce' });
  audience.on('pageerror', (e) => errors.push(e.message));
  await audience.goto(url!.replace('#bg=solid&', '#'));
  await expect(audience.locator('.verse')).toHaveAttribute('aria-label', /112:2$/);
  await card.getByRole('button', { name: /^Stream captions/ }).click();
  await expect(audience.locator('.stage')).toHaveAttribute('data-layout', 'lowerthird');
  await card.getByRole('radio', { name: 'Top', exact: true }).click();
  await size(c, 'Distance from edge', '120');
  await expect.poll(() => audience.locator('.panel').evaluate((p) => p.getBoundingClientRect().top)).toBe(120);
  await size(c, 'Panel shading', '0.4');
  await expect.poll(() => audience.locator('.stage').evaluate((s) => (s as HTMLElement).style.getPropertyValue('--panel-opacity'))).toBe('0.4');
  await card.getByText('Text size, colour and details', { exact: true }).click();
  const before = await audience.locator('.english').evaluate((e) => parseFloat(getComputedStyle(e).fontSize));
  await size(c, 'English size', '1.4');
  await expect.poll(() => audience.locator('.english').evaluate((e) => parseFloat(getComputedStyle(e).fontSize))).toBeGreaterThan(before);
  await fits(audience);
  await audience.reload();
  await expect(audience.locator('.stage')).toHaveAttribute('data-position', 'top');
  await expect.poll(() => audience.locator('.panel').evaluate((p) => p.getBoundingClientRect().top)).toBe(120);
  await c.reload();
  await card.getByText('Text size, colour and details', { exact: true }).click();
  await expect(c.getByRole('slider', { name: 'English size', exact: true })).toHaveValue('1.4');
  await card.getByRole('button', { name: 'Restore default look' }).click();
  await expect(audience.locator('.stage')).toHaveAttribute('data-layout', 'fullframe');
  await expect(audience.locator('.stage')).toHaveAttribute('data-position', 'bottom');
  await expect(c.getByRole('slider', { name: 'English size', exact: true })).toHaveValue('1');
  await card.getByRole('button', { name: /^Arabic only/ }).click();
  await expect(audience.locator('.english')).toHaveCount(0);
  await expect(c.getByRole('slider', { name: 'English size', exact: true })).toBeDisabled();
  await expect(audience.locator('.stage')).toHaveAttribute('data-bg', 'transparent');
  await card.getByRole('button', { name: /^Reading/ }).click();
  await expect(audience.locator('.english')).toBeVisible();
  // Narrow control page: presets remain readable and settings stay within the viewport.
  await c.setViewportSize({ width: 390, height: 844 });
  expect(await c.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  mkdirSync('test-results/overlay-appearance', { recursive: true });
  await card.screenshot({ path: 'test-results/overlay-appearance/controls-phone.png' });
  await card.getByRole('link', { name: 'See audience preview' }).click();
  await expect(c.locator('.preview')).toBeInViewport();
  await c.setViewportSize({ width: 1440, height: 1000 });
  await card.screenshot({ path: 'test-results/overlay-appearance/controls-desktop.png' });
  await card.getByText('Text size, colour and details', { exact: true }).click();
  await c.locator('.overlay-appearance').screenshot({ path: 'test-results/overlay-appearance/appearance.png' });
  expect(errors).toEqual([]);
  await c.close();
  await audience.close();
});

test('largest text keeps every word of the longest ayah across pages', async ({ browser }) => {
  const c = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await c.goto(`/control#owner=${OWNER}`);
  const card = output(c);
  await card.getByRole('button', { name: /^Stream captions/ }).click();
  await card.getByText('Text size, colour and details', { exact: true }).click();
  await size(c, 'Arabic size', '1.25');
  await size(c, 'English size', '1.4');
  await openVerse(c, '2:282');
  const url = await card.getByRole('link', { name: 'Open reading screen' }).getAttribute('href');
  const audience = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await audience.goto(url!);
  // The caption band keeps the camera visible: the ayah pages inside it instead of taking the full frame.
  await expect(audience.locator('.stage')).toHaveAttribute('data-layout', 'lowerthird');
  await expect(audience.locator('.cont-ar')).toBeVisible();
  await expect(c.getByText(/Too long for the lower third/)).toHaveCount(0);
  const expected = await (await c.request.get('/api/verse/2:282')).json();
  for (const language of ['Arabic + English', 'English']) {
    await c.getByRole('radiogroup', { name: 'Language' }).getByRole('radio', { name: language, exact: true }).click();
    await expect(audience.locator('.stage')).toHaveAttribute('data-lang', language === 'English' ? 'english' : 'both');
    const marker = audience.locator('.english .cont');
    await expect(marker).toContainText('Translation');
    const total = Number((await marker.innerText()).match(/\/(\d+)/)![1]);
    const pager = c.locator('.pager > span', { hasText: 'Translation page' });
    const words: string[] = [];
    // Each cycle starts at page 1 because the previous full cycle wraps back to it.
    for (let n = 1; n <= total; n++) {
      await expect(marker).toContainText(`Translation ${n}/${total}`);
      words.push((await audience.locator('.english .line').allTextContents()).join(' '));
      await fits(audience);
      await pager.getByRole('button', { name: '›', exact: true }).click();
    }
    expect(words.join(' ').replace(/\s+/g, ' ').trim()).toBe(expected.english.replace(/\s+/g, ' ').trim());
  }
  // Arabic only also pages inside the caption band at the largest size.
  await c.getByRole('radiogroup', { name: 'Language' }).getByRole('radio', { name: 'Arabic', exact: true }).click();
  await expect(audience.locator('.english')).toHaveCount(0);
  await expect(audience.locator('.stage')).toHaveAttribute('data-layout', 'lowerthird');
  const pages = Number((await audience.locator('.cont-ar').innerText()).match(/\/(\d+)/)![1]);
  const arabicPager = c.locator('.pager > span', { hasText: /^Arabic/ });
  const arabic: string[] = [];
  for (let n = 1; n <= pages; n++) {
    await expect(audience.locator('.cont-ar')).toHaveAttribute('aria-label', `Arabic part ${n} of ${pages}`);
    arabic.push((await audience.locator('.quran-word').allTextContents()).join(' '));
    await fits(audience);
    if (n < pages) await arabicPager.getByRole('button', { name: '›', exact: true }).click();
  }
  // Display encoding is source-owned and deterministic, never generated.
  const { toQpcHafsEncoding } = await import('../../src/shared/display-encoding');
  expect(arabic.join(' ')).toBe(toQpcHafsEncoding(expected.arabic).replace(/\s+/g, ' ').trim());
  mkdirSync('test-results/overlay-appearance', { recursive: true });
  await audience.screenshot({ path: 'test-results/overlay-appearance/long-ayah.png' });
  await card.getByRole('button', { name: /^Reading/ }).click();
  await c.close();
  await audience.close();
});
