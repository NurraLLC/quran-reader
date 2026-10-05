// Audience output fixes from the OBS audit (A10): the reading screen letterboxes in the stage colour on
// non-16:9 displays, hide/unhide fades in every reading mode (cuts under reduced motion), the shaded look
// gives text its own dark edge over bright footage, and the operator is told when Transparent will not
// read on a bright camera (with a pure-white preview backdrop to check it). Contrast itself is measured
// on rendered frames (evidence/a10-02-legibility); these assertions keep the rules in place.
import { expect, test, type Page } from '@playwright/test';

const OWNER = 'ui-test-owner-capability-0001';

async function controlWithOverlayLink(page: Page) {
  await page.goto(`/control#owner=${OWNER}`);
  await expect(page.locator('.topbar')).toBeVisible();
  const url: string = await page.evaluate(() => new Promise((resolve) => {
    const ws = new WebSocket(`ws://${location.host}/ws/control`);
    ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.type === 'snapshot' && m.snapshot.overlay?.url) { ws.close(); resolve(m.snapshot.overlay.url); } };
  }));
  return url.replace(/^https?:\/\/[^/]+/, '');
}

test('reading screen, hide fade, shaded text edge and the transparent hint', async ({ page, browser }) => {
  const link = await controlWithOverlayLink(page);
  await page.getByLabel('Type a reference or what the ayah says').fill('67:2');
  await page.getByLabel('Type a reference or what the ayah says').press('Enter');
  await expect(page.locator('.onair')).toHaveText('On screen');

  // A 4:3 display: no white around the stage.
  const screen = await browser.newPage({ viewport: { width: 1024, height: 768 } });
  await screen.goto(link.replace('#view=', '#bg=solid&view='));
  await expect(screen.locator('.panel-on .verse')).toBeVisible();
  expect(await screen.evaluate(() => [getComputedStyle(document.documentElement).backgroundColor, getComputedStyle(document.body).backgroundColor])).toEqual(['rgb(8, 17, 21)', 'rgb(8, 17, 21)']);
  await screen.screenshot({ path: 'test-results/overlay-launch/reading-screen-1024x768.png' });
  await screen.close();

  // OBS output: transparent page; hide fades in Follow words too.
  const obs = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await obs.goto(link);
  await expect(obs.locator('.panel-on .verse')).toBeVisible();
  expect(await obs.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
  await page.getByRole('radiogroup', { name: 'Reading view' }).getByRole('radio', { name: 'Follow words' }).click();
  await expect(obs.locator('.stage')).toHaveAttribute('data-reading', 'follow');
  expect(await obs.locator('.panel').evaluate((el) => [getComputedStyle(el).transitionProperty, getComputedStyle(el).transitionDuration])).toEqual(['opacity', '0.22s']);
  await obs.emulateMedia({ reducedMotion: 'reduce' });
  expect(await obs.locator('.panel').evaluate((el) => getComputedStyle(el).transitionDuration)).toBe('0s');

  // Shaded panel: the text carries its own dark edge.
  await page.getByRole('radiogroup', { name: 'Background' }).getByRole('radio', { name: 'Shaded panel' }).click();
  await expect(obs.locator('.stage')).toHaveAttribute('data-bg', 'scrim');
  expect(await obs.locator('.verse').evaluate((el) => getComputedStyle(el).textShadow)).toContain('rgba(9, 19, 23, 0.9) 0px 0px 2px');
  await page.getByRole('radiogroup', { name: 'Background' }).getByRole('radio', { name: 'Transparent' }).click();
  await expect(page.getByText('Transparent suits dark or mid-tone footage')).toBeVisible();
  await page.getByRole('radiogroup', { name: 'Preview backdrop' }).getByRole('radio', { name: 'White' }).click();
  expect(await page.locator('.preview').evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgb(255, 255, 255)');
  await page.getByRole('radiogroup', { name: 'Background' }).getByRole('radio', { name: 'Shaded panel' }).click();
  await obs.close();
});
