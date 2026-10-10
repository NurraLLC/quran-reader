import { expect, test } from '@playwright/test';

const OWNER = 'ui-test-owner-capability-0001';

for (const [surface, theme] of [['reader', 'night'], ['reader', 'paper'], ['control', 'night']] as const) {
  test(`${surface} ${theme} opens with its theme already applied to the first app content`, async ({ page }, info) => {
    if (theme === 'paper') await page.addInitScript(() => {
      localStorage.setItem('qo.reader.appearance', JSON.stringify({ theme: 'paper', scale: 1 }));
    });
    // Observe the first committed opening state, before a passive React effect can restyle it.
    await page.addInitScript(() => {
      const observer = new MutationObserver(() => {
        const opening = document.querySelector('.r-gate, .gate');
        if (!opening) return;
        const body = getComputedStyle(document.body);
        Object.assign(window, { firstOpening: {
          surface: document.documentElement.dataset.surface,
          background: body.backgroundColor,
          color: body.color,
          font: body.fontFamily,
          text: opening.textContent,
        } });
        observer.disconnect();
      });
      observer.observe(document, { childList: true, subtree: true });
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    await page.route('**/api/me', async route => {
      await gate;
      await route.continue();
    });
    try {
      await page.goto(`/${surface}#owner=${OWNER}`);
      await expect(page.locator(surface === 'reader' ? '.r-gate' : '.gate')).toBeVisible();
      const opening = await page.evaluate(() => (window as unknown as {
        firstOpening: { surface: string; background: string; color: string; font: string; text: string };
      }).firstOpening);
      expect(opening.text).toContain('Opening');
      expect(opening.surface).toBe(surface);
      expect(opening.background).toBe(theme === 'paper' ? 'rgb(246, 240, 226)' : 'rgb(10, 20, 24)');
      expect(opening.color).toBe(theme === 'paper' ? 'rgb(32, 58, 64)' : 'rgb(230, 225, 212)');
      expect(opening.font).toContain('Segoe UI');
      await page.screenshot({ path: info.outputPath(`${surface}-opening.png`) });
      release();
      await expect(page.locator(surface === 'reader' ? '.r-top' : '.topbar')).toBeVisible();
    } finally {
      release();
      await page.unrouteAll({ behavior: 'wait' });
    }
  });
}
