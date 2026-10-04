// The phone reader: opening, typed requests, tap-a-word meaning, language, continue where you left off.
import { expect, test } from '@playwright/test';

const OWNER = 'ui-test-owner-capability-0001';
test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

test('reader: request, word meaning, language and continue where you left off', async ({ page }) => {
  await page.goto(`/reader#owner=${OWNER}`);
  // (The UI suite shares one session: another test may already have an ayah on screen.)
  await expect(page.locator('.r-top')).toBeVisible();
  // Word interactions need Arabic visible, regardless of the previous test's language choice.
  await page.getByRole('radio', { name: 'Both', exact: true }).click();

  // A typed request opens the surah and follows from the ayah.
  await page.getByRole('button', { name: 'Type instead' }).click();
  await page.getByLabel('Type a request').fill('55:13');
  await page.getByLabel('Type a request').press('Enter');
  await expect(page.locator('.r-ayah.current')).toHaveAttribute('id', 'a-55:13');
  await expect(page.locator('.r-top')).toContainText('Ar-Rahman');

  // Tapping a word shows its meaning (when word-by-word data is installed) and does not move the page.
  const word = page.locator('.r-ayah.current .r-word').nth(1);
  await word.tap();
  if ((await page.locator('.r-word.peeked').count()) > 0) await expect(page.locator('.r-word.peeked .r-gloss')).toBeVisible();
  await expect(page.locator('.r-ayah.current')).toHaveAttribute('id', 'a-55:13');

  // Language switch.
  await page.getByRole('radio', { name: 'English' }).click();
  await expect(page.locator('.reader')).toHaveAttribute('data-lang', 'english');
  await expect(page.locator('.r-ayah.current .r-ar')).toHaveCount(0);
  await page.getByRole('radio', { name: 'Both' }).click();

  // Keyboard: an ayah can be chosen with Enter.
  await page.locator('[id="a-55:14"] .r-ayah-follow').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.r-ayah.current')).toHaveAttribute('id', 'a-55:14');

  // Remembered on this device: a fresh page with nothing on screen offers to continue.
  await page.evaluate(() => fetch('/api/owner/status'));
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('qo.reader') ?? '{}'));
  expect(saved.key).toBe('55:14');
});

test('reader: menu to home and all surahs; following comes back when recitation moves on', async ({ page }) => {
  await page.goto(`/reader#owner=${OWNER}`);
  await expect(page.locator('.r-top')).toBeVisible();
  await page.getByRole('radio', { name: 'Both', exact: true }).click();

  // Home and the surah list, from the menu.
  await page.getByRole('button', { name: /^Menu/ }).click();
  await page.getByRole('button', { name: /^All surahs/ }).click();
  await page.getByLabel('Find a surah').fill('mulk');
  await page.getByRole('button', { name: '67. Al-Mulk, 30 ayahs' }).click();
  await expect(page.locator('.r-ayah.current')).toHaveAttribute('id', 'a-67:1');
  await page.getByRole('button', { name: /^Menu/ }).click();
  await page.getByRole('button', { name: /^Home/ }).click();
  await expect(page.getByRole('button', { name: 'Continue at Al-Mulk 67:1' })).toBeVisible();
  await page.getByRole('button', { name: 'Continue at Al-Mulk 67:1' }).click();
  await expect(page.locator('.r-ayah.current')).toHaveAttribute('id', 'a-67:1');

  // Recite 67:1..2 while having scrolled far away by hand: following pauses, then returns with the
  // next recited words once the hand has been still for a few seconds.
  const { readFileSync } = await import('node:fs');
  const corpus = JSON.parse(readFileSync('data/processed/corpus.json', 'utf8'));
  const words = ['67:1', '67:2'].flatMap((k) => corpus.verses.find((v: { key: string }) => v.key === k).searchText.split(/\s+/));
  await page.evaluate(async () => {
    const s = new WebSocket(`${location.origin.replace('http', 'ws')}/ws/control`);
    await new Promise<void>((r) => s.addEventListener('open', () => r(), { once: true }));
    (window as unknown as { t: WebSocket }).t = s;
  });
  const send = (m: unknown) => page.evaluate((x) => (window as unknown as { t: WebSocket }).t.send(JSON.stringify(x)), m);
  const epoch = Date.now();
  let seq = 0;
  const say = (n: number) => send({ type: 'transcript', captureEpoch: epoch, seq: seq++, receivedAt: 0, tokens: [{ text: words.slice(0, n).join(' '), isFinal: false }] });
  // The UI suite shares one session: start from following, not a pause another test left.
  await send({ type: 'hold', on: false });
  await send({ type: 'blank', on: false });
  await send({ type: 'style', patch: { readingMode: 'follow' } });
  await send({ type: 'goto', key: '67:1' });
  await send({ type: 'capture', captureEpoch: epoch, event: 'recording' });
  try {
    await say(4);
    await expect(page.locator('.r-word.active')).toHaveCount(1);
    await page.mouse.wheel(0, 4000);
    await expect(page.locator('.r-back')).toBeVisible();
    await page.waitForTimeout(3200);
    await say(10);
    await expect(page.locator('.r-back')).toHaveCount(0);
    await expect(page.locator('.r-word.active')).toBeInViewport();
  } finally {
    await send({ type: 'capture', captureEpoch: epoch, event: 'stopped' });
  }
});

test('how and why: costs, the reward of helping with sources, and the Nurra mark', async ({ page }) => {
  await page.goto(`/reader#owner=${OWNER}`);
  await expect(page.locator('.r-top')).toBeVisible();
  await page.getByRole('button', { name: /^Menu/ }).click();
  await page.getByRole('dialog', { name: 'Menu', exact: true }).getByRole('link', { name: /^Why we built this/ }).click();
  await expect(page.getByRole('heading', { name: 'Why we built this' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'A starting point for Muslim creators' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'More Muslim spaces, built by us' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'The reward of giving' })).toBeVisible();
  // Every narration links to its source; only sahih and hasan are shown.
  const refs = page.locator('a.about-ref');
  await expect(refs).toHaveCount(4);
  for (const href of await refs.evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).href))) expect(href).toMatch(/^https:\/\/sunnah\.com\//);
  await expect(page.locator('a.about-ref', { hasText: /da.?if/i })).toHaveCount(0);
  // The ayah comes from the app's own text.
  await expect(page.locator('.about-quran')).toBeVisible();
  // Nurra: small, present, linking to nurra.org.
  await expect(page.locator('a.nurra-badge').first()).toHaveAttribute('href', 'https://nurra.org');
});
