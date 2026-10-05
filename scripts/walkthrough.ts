// Broadcaster walkthrough in installed Edge: control page + separate reading screen.
// Captures each intermediate state for review and asserts privacy/ordering along the way.
// Usage: tsx scripts/walkthrough.ts "<control owner link>" <outDir>
import { mkdirSync } from 'node:fs';
import { chromium } from '@playwright/test';

const [ownerLink, out = 'artifacts/tmp/walk'] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const b = await chromium.launch({ channel: 'msedge' });
const c = await b.newPage({ viewport: { width: 1440, height: 900 } });
const problems: string[] = [];
const check = (ok: boolean, what: string) => {
  if (!ok) problems.push(what);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
};
let n = 0;
const shot = async (name: string) => {
  n++;
  await c.screenshot({ path: `${out}/${String(n).padStart(2, '0')}-control-${name}.png` });
  await r.screenshot({ path: `${out}/${String(n).padStart(2, '0')}-reading-${name}.png` });
};
const readingKey = () => r.evaluate(() => document.querySelector('.panel-on .verse')?.getAttribute('aria-label') ?? null);

await c.goto(ownerLink);
await c.waitForSelector('.topbar');
check(!c.url().includes('owner='), 'owner capability removed from the address bar');
const readingUrl = await c.locator('.copy-row a').getAttribute('href');
const r = await b.newPage({ viewport: { width: 1920, height: 1080 } });
await r.goto(readingUrl!);
await r.waitForTimeout(800);
await shot('start');
const initial = await readingKey();

const find = c.getByLabel('Reference or what the ayah says');
await find.fill('be good to your parents');
await find.press('Enter');
await c.waitForSelector('.results .result');
await shot('search-results');
check((await readingKey()) === initial, 'search results stay private (reading screen unchanged)');

const firstKey = (await c.locator('.result strong').first().innerText()).split(' ').at(-1)!;
await c.locator('.result').first().getByRole('button', { name: 'Earlier' }).click();
await c.waitForTimeout(300);
await shot('context-earlier');
check((await readingKey()) === initial, 'browsing context stays private');
await c.locator('.result').first().getByRole('button', { name: 'Later' }).click();
await c.waitForTimeout(300);
await c.locator('.result').first().getByRole('button', { name: 'Show on stream' }).click();
await r.waitForFunction((k) => document.querySelector('.panel-on .verse')?.getAttribute('aria-label')?.endsWith(k), firstKey);
await c.waitForTimeout(200);
await shot('shown-from-search');
check((await c.locator('.status-title').innerText()).startsWith('Paused'), 'status says following is paused after Show on stream');

await c.getByRole('button', { name: 'Resume following' }).first().click();
await c.waitForTimeout(250);
await shot('resumed');
check(!(await c.locator('.status-title').innerText()).startsWith('Paused'), 'resume clears the paused state');

await find.fill('surah maryam ayah 3');
await find.press('Enter');
await r.waitForFunction(() => document.querySelector('.panel-on .verse')?.getAttribute('aria-label')?.endsWith('19:3'));
await shot('typed-reference');

await c.getByRole('button', { name: 'Next ayah ›' }).click();
await r.waitForFunction(() => document.querySelector('.panel-on .verse')?.getAttribute('aria-label')?.endsWith('19:4'));
await c.keyboard.press('ArrowLeft');
await r.waitForFunction(() => document.querySelector('.panel-on .verse')?.getAttribute('aria-label')?.endsWith('19:3'));
check(true, 'next button and ← key navigate');

await c.getByRole('button', { name: 'Hide from stream' }).click();
await r.waitForFunction(() => !document.querySelector('.panel-on'));
await r.waitForTimeout(300);
await shot('hidden');
await c.getByRole('button', { name: 'Unhide' }).click();
await r.waitForFunction(() => !!document.querySelector('.panel-on'));

await c.getByRole('radiogroup', { name: 'Layout' }).getByRole('radio', { name: 'Lower third' }).click();
await r.waitForTimeout(400);
await shot('lower-third');

await find.fill('2:282');
await find.press('Enter');
await r.waitForFunction(() => document.querySelector('.panel-on .verse')?.getAttribute('aria-label')?.endsWith('2:282'));
await c.waitForSelector('.pager');
await r.waitForTimeout(300);
await shot('long-verse-paged-in-captions');
check(!(await c.locator('.warn', { hasText: 'Too long for the lower third' }).isVisible()), 'a long ayah pages inside the captions (no full-frame takeover)');
await c.locator('.pager span', { hasText: 'Translation page' }).getByRole('button', { name: '›' }).click();
await r.waitForTimeout(400);
await shot('long-verse-translation-page-2');
check(((await r.locator('.english .cont').innerText()) ?? '').includes('2/'), 'reading screen shows translation page 2');

await find.fill('surah 200');
await find.press('Enter');
await c.waitForSelector('.warn');
await shot('invalid-reference');

await r.reload();
await r.waitForSelector('.panel-on .verse');
check((await readingKey())?.endsWith('2:282') ?? false, 'reading screen reload restores the full current state');

await b.close();
console.log(problems.length ? `\n${problems.length} problem(s)` : '\nall walkthrough checks passed');
process.exit(problems.length ? 1 : 0);
