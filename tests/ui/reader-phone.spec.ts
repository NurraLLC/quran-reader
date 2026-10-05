// The reader on the smallest phone in use (320×568): the consent's agreement and buttons stay in
// view, small controls answer a 44 px touch, and the recited word is kept between the measured
// header and dock (scroll-margin on the reading targets, never scroll-padding on the page, which made
// every focus of a header control scroll the passage), which grow with the title, the result sheet and typing.
import { expect, test, type Locator } from '@playwright/test';

const OWNER = 'ui-test-owner-capability-0001';
test.use({ viewport: { width: 320, height: 568 } });

/**
 * A touch this far above and below the drawn control (and beside it, when `dx`) still lands on it:
 * 44 px total for a 34 px control is 5 px each way. Side by side controls are only extended vertically.
 */
async function answersTouchAround(target: Locator, dx: number | null, dy: number) {
  return target.evaluate((el, [x, y]) => {
    const r = el.getBoundingClientRect();
    const points = [[r.left + r.width / 2, r.top - y], [r.left + r.width / 2, r.bottom + y]];
    if (x !== null) points.push([r.left - x, r.top + r.height / 2], [r.right + x, r.top + r.height / 2]);
    return points.map(([px, py]) => document.elementFromPoint(px, py)).every((h) => h === el || el.contains(h));
  }, [dx, dy] as const);
}

test('small phone: consent actions in view, 44 px touch targets, reading margins follow the header and dock', async ({ page }) => {
  await page.goto(`/reader#owner=${OWNER}`);
  await expect(page.locator('.r-top')).toBeVisible();

  await page.getByRole('button', { name: 'Start listening', exact: true }).click();
  const consent = page.getByRole('dialog', { name: 'Before you turn on the microphone' });
  await expect(consent).toBeVisible();
  const box = (await consent.boundingBox())!;
  expect(box.y + box.height).toBeLessThanOrEqual(568);
  for (const control of [consent.getByRole('checkbox'), consent.getByRole('button', { name: 'Keep reading' }), consent.getByRole('button', { name: 'Agree and continue' })]) {
    const b = (await control.boundingBox())!;
    expect(b.y).toBeGreaterThanOrEqual(box.y);
    expect(b.y + b.height).toBeLessThanOrEqual(box.y + box.height);
  }
  for (const name of ['Keep reading', 'Agree and continue']) expect((await consent.getByRole('button', { name }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await expect(consent.getByText('Your audio is sent to Soniox')).toBeVisible(); // the explanation scrolls above them
  await page.screenshot({ path: 'test-results/voice-consent-small-phone.png' });
  await consent.getByRole('button', { name: 'Keep reading' }).click();
  await expect(consent).toHaveCount(0);

  for (const lang of await page.locator('.r-langs button').all()) expect(await answersTouchAround(lang, null, 4.5)).toBe(true);

  const margins = () => page.evaluate(() => {
    const target = getComputedStyle(document.querySelector('.r-page button')!);
    return { pagePadding: getComputedStyle(document.documentElement).scrollPaddingTop, top: target.scrollMarginTop, bottom: target.scrollMarginBottom, header: Math.round(document.querySelector('.r-top')!.getBoundingClientRect().height), dock: Math.round(document.querySelector('.r-dock')!.getBoundingClientRect().height) };
  });
  const before = await margins();
  expect(before.pagePadding).toBe('auto');
  expect(before.top).toBe(`${before.header + 8}px`);
  expect(before.bottom).toBe(`${before.dock + 28}px`);

  // A request that finds nothing leaves its note up (it has to be closed): the dock grows, and so do the margins.
  await page.getByRole('button', { name: 'Type instead' }).click();
  await page.getByLabel('Type a request').fill('qqqq zzzz');
  await page.getByLabel('Type a request').press('Enter');
  const close = page.locator('.r-sheet .r-close');
  await expect(close).toBeVisible();
  await expect.poll(async () => (await margins()).dock).toBeGreaterThan(before.dock);
  const after = await margins();
  expect(after.bottom).toBe(`${after.dock + 28}px`);
  expect(await answersTouchAround(close, 4.5, 4.5)).toBe(true);
  await page.screenshot({ path: 'test-results/reader-sheet-small-phone.png' });
});
