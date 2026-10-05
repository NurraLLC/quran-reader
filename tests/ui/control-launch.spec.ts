// The public stream controls (hosted, as on nurra.org/quran-reader/control): named for what they are,
// a three-step first run that confirms when OBS opens the overlay, a first result from an empty
// preview, no developer setup text, a phone layout that never widens, arrow keys that never change the
// ayah on stream from a choice group, a remembered preview choice, and a link replacement that asks
// before it turns a live overlay off.
import { expect, test, type Page } from '@playwright/test';
import { createServer } from 'node:net';
import { buildApp } from '../../src/server/app';
import { CreditStore } from '../../src/server/billing/credits';
import { SessionHub } from '../../src/server/billing/hub';
import { VisitorIdentity } from '../../src/server/billing/identity';
import { CommandResolver } from '../../src/server/commands/reducer';
import { Session } from '../../src/server/sessions';
import { fullCorpus } from '../helpers';

async function hostedServer() {
  const probe = createServer().listen(0, '127.0.0.1');
  await new Promise<void>((r) => probe.on('listening', r));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((r) => probe.close(() => r()));
  const base = `http://127.0.0.1:${port}`;
  const { corpus, ix } = fullCorpus();
  const credits = new CreditStore(':memory:', { freeSecondsPerMonth: 0, ipDailyFreeSeconds: 0, globalDailyFreeSeconds: 0, holdMaxSeconds: 1200, holdMinSeconds: 20, poolDailySecondsPerVisitor: 7200 });
  credits.grantPool(10 * 3600, 'fixture-funding');
  const resolver = new CommandResolver(corpus, null, null);
  const hub = new SessionHub(() => new Session({ corpus, ix, resolver, decisionClient: null, mode: 'deterministic', setup: { soniox: true, jev: { provider: null, configured: false, detail: 'No JEV key configured.' }, semantic: () => 'unavailable (optional: npm run search:embed)' }, overlayUrl: (v) => `${base}/quran-reader/overlay#view=${v}` }));
  const { app } = await buildApp({ port, basePath: '/quran-reader', sonioxApiKey: 'test-only', hosted: { hub, credits, identity: new VisitorIdentity(Buffer.alloc(48, 7)) } });
  await app.listen({ host: '127.0.0.1', port });
  return { base, close: async () => { await app.close(); credits.close(); } };
}

const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

test('hosted stream controls: first run, a first ayah, no developer text, and a guarded link replacement', async ({ page, context }) => {
  const server = await hostedServer();
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${server.base}/quran-reader/control`);
    await expect(page).toHaveTitle('Stream controls · Quran Reader');
    await expect(page.locator('.brand')).toHaveText('Quran Reader · Stream controls');
    for (const text of ['npm', 'JEV', 'Tracker', 'Semantic search', 'Quran resources']) await expect(page.locator('body')).not.toContainText(text);
    const firstRun = page.getByRole('region', { name: 'On your stream in three steps' });
    await expect(firstRun).toBeVisible();
    await expect(firstRun.getByRole('button', { name: 'Copy OBS overlay link' })).toBeInViewport();
    await expect(firstRun).toContainText('Waiting for OBS to open the link');
    // An empty preview offers a first result, and the audience gets it too.
    await expect(page.getByText('Nothing on screen yet')).toBeVisible();
    await page.getByRole('button', { name: 'Show Al-Fatihah 1:1' }).click();
    await expect(page.locator('.onair')).toHaveText('On screen');
    await expect(page.getByText('Nothing on screen yet')).toHaveCount(0);
    await page.screenshot({ path: 'test-results/control-launch/hosted-1440-after-first-ayah.png' });

    // OBS opens the link: step 2 confirms it.
    const url = await page.evaluate(() => new Promise<string>((resolve) => {
      const ws = new WebSocket(`ws://${location.host}${location.pathname.replace(/\/control$/, '')}/ws/control`);
      ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.type === 'snapshot' && m.snapshot.overlay?.url) { ws.close(); resolve(m.snapshot.overlay.url); } };
    }));
    const obs = await context.newPage();
    await obs.setViewportSize({ width: 1920, height: 1080 });
    await obs.goto(url);
    await expect(obs.locator('.panel-on .verse')).toHaveAttribute('aria-label', /1:1$/);
    const open = page.getByRole('region', { name: 'Your overlay is open' });
    await expect(open).toContainText('Open in 1 place');
    await page.screenshot({ path: 'test-results/control-launch/hosted-1440-overlay-open.png' });

    // Replacing the link while OBS shows it asks first; declining keeps OBS on.
    let asked = '';
    page.once('dialog', (d) => { asked = d.message(); void d.dismiss(); });
    await page.getByRole('button', { name: /Replace overlay link/ }).click();
    expect(asked).toContain('Replacing it turns it off');
    await expect(page.locator('.conn')).toHaveText('OBS/readers connected: 1');
    await open.getByRole('button', { name: 'Done' }).click();
    await expect(open).toHaveCount(0);

    // Arrow keys on a language choice change the language, never the ayah on stream.
    const arabic = page.getByRole('radiogroup', { name: 'Language' }).getByRole('radio', { name: 'Arabic', exact: true });
    await arabic.click();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('radiogroup', { name: 'Language' }).getByRole('radio', { name: 'English', exact: true })).toBeFocused();
    await expect(page.getByRole('radiogroup', { name: 'Language' }).getByRole('radio', { name: 'English', exact: true })).toHaveAttribute('aria-checked', 'true');
    await expect(obs.locator('.panel-on .verse')).toHaveAttribute('aria-label', /1:1$/);

    // The preview choice survives a reload (its page counts drive the page buttons).
    await page.getByRole('radio', { name: 'Charity scene', exact: true }).click();
    await page.reload();
    await expect(page.getByRole('radio', { name: 'Charity scene', exact: true })).toHaveAttribute('aria-checked', 'true');

    // Accepting the replacement turns the old link off and says what to do next.
    page.once('dialog', (d) => void d.accept());
    await page.getByRole('button', { name: /Replace overlay link/ }).click();
    await expect(page.getByRole('status').filter({ hasText: 'paste it into your OBS Browser source' })).toBeVisible();
    await expect(page.locator('.conn')).toHaveText('OBS/readers connected: 0');
    await obs.close();
  } finally {
    await server.close();
  }
});

for (const width of [320, 360, 375]) {
  test(`stream controls at ${width} px never widen the page`, async ({ page }) => {
    const server = await hostedServer();
    try {
      await page.setViewportSize({ width, height: 800 });
      await page.goto(`${server.base}/quran-reader/control`);
      await expect(page.locator('.topbar')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Show Al-Fatihah 1:1' })).toBeVisible();
      expect(await noOverflow(page)).toBe(true);
      await page.getByRole('button', { name: 'Show Al-Fatihah 1:1' }).click();
      await expect(page.locator('.onair')).toHaveText('On screen');
      expect(await noOverflow(page)).toBe(true);
      if (width === 375) await page.screenshot({ path: 'test-results/control-launch/hosted-375-first.png', fullPage: true });
    } finally {
      await server.close();
    }
  });
}
