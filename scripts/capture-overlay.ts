// Visual review capture: drives the real control page (owner link) in installed Edge and
// photographs a separate overlay page at 1920×1080 for each scenario.
// Usage: tsx scripts/capture-overlay.ts "<control owner link>" <outDir> [scenario ...]
import { mkdirSync } from 'node:fs';
import { chromium, type Page } from '@playwright/test';

type Scenario = { name: string; key: string; layout?: 'fullframe' | 'lowerthird'; bg?: 'transparent' | 'scrim' | 'solid'; englishPage?: number };

const ALL: Scenario[] = [
  { name: 'short-112-1', key: '112:1' },
  { name: 'refrain-55-13', key: '55:13' },
  { name: 'ayat-2-255', key: '2:255' },
  { name: 'longest-2-282', key: '2:282' },
  { name: 'longest-2-282-translation-p2', key: '2:282', englishPage: 1 },
  { name: 'lower-1-2', key: '1:2', layout: 'lowerthird' },
  { name: 'lower-2-255-paged', key: '2:255', layout: 'lowerthird' },
  { name: 'transparent-36-1', key: '36:1', bg: 'transparent', layout: 'fullframe' },
  { name: 'solid-19-3', key: '19:3', bg: 'solid' },
];

const [ownerLink, outDir, ...only] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge' });
const control = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
await control.goto(ownerLink);
await control.waitForSelector('.topbar');
const overlayUrl = (await control.locator('.copy-row a').getAttribute('href'))!.replace('#bg=solid&', '#');
const overlay = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
await overlay.goto(overlayUrl);

async function clickSeg(page: Page, group: string, label: string) {
  await page.getByRole('radiogroup', { name: group }).getByRole('radio', { name: label }).click();
}

for (const s of ALL.filter((x) => !only.length || only.includes(x.name))) {
  await clickSeg(control, 'Layout', s.layout === 'lowerthird' ? 'Lower third' : 'Full frame');
  await clickSeg(control, 'Background', s.bg === 'transparent' ? 'Transparent' : s.bg === 'solid' ? 'Solid' : 'Shaded panel');
  const box = control.getByLabel('Reference or what the ayah says');
  await box.fill(s.key);
  await box.press('Enter');
  await overlay.waitForFunction((k) => document.querySelector('.verse')?.getAttribute('aria-label')?.endsWith(k), s.key, { timeout: 5000 });
  if (s.englishPage) {
    await control.getByText(/Translation page/).locator('button').nth(1).click();
    await overlay.waitForTimeout(300);
  }
  await overlay.waitForTimeout(400);
  await overlay.screenshot({ path: `${outDir}/${s.name}.png` });
  console.log('captured', s.name);
}
await control.screenshot({ path: `${outDir}/control.png`, fullPage: true });
await browser.close();
