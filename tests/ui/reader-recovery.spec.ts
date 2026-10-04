import { expect, test } from '@playwright/test';

const OWNER = 'ui-test-owner-capability-0001';
test.use({ viewport: { width: 390, height: 844 } });

test('an initial connection failure shows recovery and opens after reconnecting', async ({ page }) => {
  let available = false;
  await page.routeWebSocket('**/ws/control', (socket) => {
    if (available) socket.connectToServer();
    else socket.close({ code: 1013, reason: 'Temporary test outage' });
  });
  await page.goto(`/reader#owner=${OWNER}`);
  await expect(page.getByRole('heading', { name: "Couldn't connect to the reader" })).toBeVisible();
  await expect(page.getByRole('status')).toContainText('reconnect automatically');
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
  available = true;
  await expect(page.locator('.r-top')).toBeVisible();
  await expect(page.locator('.r-gate')).toHaveCount(0);
});

test('an unavailable reader offers retry instead of claiming the private link is wrong', async ({ page }) => {
  await page.route('**/api/me', (route) => route.fulfill({ status: 503, body: '{}' }));
  await page.goto(`/reader#owner=${OWNER}`);
  await expect(page.getByRole('heading', { name: 'Couldn’t open the reader' })).toBeVisible();
  await page.unroute('**/api/me');
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.locator('.r-top')).toBeVisible();
});

test('a failed surah fetch can recover without losing the chosen ayah', async ({ page }) => {
  await page.route('**/api/surah/112', (route) => route.fulfill({ status: 503, body: '{}' }));
  await page.goto(`/reader#owner=${OWNER}`);
  await expect(page.locator('.r-top')).toBeVisible();
  await page.getByRole('button', { name: 'Type instead' }).click();
  await page.getByLabel('Type a request').fill('112:2');
  await page.getByLabel('Type a request').press('Enter');
  await expect(page.getByText('Couldn’t load this surah. Check your connection and try again.')).toBeVisible();
  await page.unroute('**/api/surah/112');
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.locator('.r-ayah.current')).toHaveAttribute('id', 'a-112:2');
});

test('a late surah response cannot replace a newer choice', async ({ page }) => {
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => { release = resolve; });
  let requested!: () => void;
  const started = new Promise<void>((resolve) => { requested = resolve; });
  await page.route('**/api/surah/67', async (route) => {
    const response = await route.fetch();
    requested();
    await delayed;
    await route.fulfill({ response }).catch(() => undefined); // aborted by the newer choice
  });
  await page.goto(`/reader#owner=${OWNER}`);
  await expect(page.locator('.r-top')).toBeVisible();
  const request = async (text: string) => {
    if (!await page.getByLabel('Type a request').isVisible()) await page.getByRole('button', { name: 'Type instead' }).click();
    await page.getByLabel('Type a request').fill(text);
    await page.getByLabel('Type a request').press('Enter');
  };
  try {
    await request('67:1');
    await started;
    await expect(page.getByLabel('Type a request')).not.toBeVisible();
    await request('1:1');
    await expect(page.locator('.r-ayah.current')).toHaveAttribute('id', 'a-1:1');
  } finally {
    release();
  }
  await page.unrouteAll({ behavior: 'wait' });
  await expect(page.locator('.r-ayah.current')).toHaveAttribute('id', 'a-1:1');
  await page.screenshot({ path: 'test-results/launch-reader-phone.png', fullPage: false });
});
