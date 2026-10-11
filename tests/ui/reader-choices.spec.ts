// This spec needs only static frontend assets. Every API response and session frame is local;
// use a static/Vite Playwright configuration with no app-server webServer command.
import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { DEFAULT_STYLE, type ControlClientMessage, type ControlSnapshot, type DisplayVerse } from '../../src/shared/contracts';
import { toQpcHafsEncoding } from '../../src/shared/display-encoding';

type CorpusFixture = {
  manifest: { id: string; translation: { name: string; attribution: string } };
  chapters: Array<{ number: number; nameSimple: string; nameArabic: string; verseCount: number }>;
  verses: Array<{ key: string; surah: number; ayah: number; arabicDisplay: string; english: string }>;
};
const corpus: CorpusFixture = JSON.parse(readFileSync(process.env.QO_CHOICES_CORPUS || 'data/processed/corpus.json', 'utf8'));

test.use({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });

async function mockReader(page: Page, key = '112:2') {
  const verse = corpus.verses.find((v) => v.key === key)!;
  const chapter = corpus.chapters.find((c) => c.number === verse.surah)!;
  const displayed: DisplayVerse = {
    key, surah: verse.surah, ayah: verse.ayah, arabic: verse.arabicDisplay, english: verse.english,
    surahName: chapter.nameSimple, surahNameArabic: chapter.nameArabic,
    translationName: corpus.manifest.translation.name, glosses: null,
  };
  const snapshot: ControlSnapshot = {
    v: 1, sessionEpoch: 'reader-choices-local-fixture',
    corpus: { id: corpus.manifest.id, verses: corpus.verses.length, chapters: corpus.chapters.length,
      translation: corpus.manifest.translation.name, attribution: corpus.manifest.translation.attribution },
    display: { v: 1, revision: 0, sessionEpoch: 'reader-choices-local-fixture', visible: true, verse: displayed,
      style: { ...DEFAULT_STYLE }, englishPage: null, arabicPage: null, progress: null, cursor: null },
    layout: null, trackerVerse: null, phase: 'idle', mode: 'deterministic', held: false, blanked: false,
    pinned: false, keepOnUncertain: true, startHint: null,
    capture: { phase: 'stopped', captureEpoch: 0, detail: null, since: 0 }, candidates: [], decisions: [],
    setup: { soniox: false, jev: { provider: null, configured: false, detail: 'Disabled in local fixture' }, semantic: 'Disabled', resources: [] },
    overlay: { url: '/overlay', clients: 0, lastPaintRttMs: null },
    metrics: { trackerP50Ms: null, trackerP95Ms: null, updates: 0, decisionCalls: 0,
      decisionP50Ms: null, paintRttP50Ms: null, paintRttP95Ms: null },
    notice: null, speed: null,
  };
  const messages: ControlClientMessage[] = [];
  const blocked: string[] = [];
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') await route.continue();
    else { blocked.push(url.origin); await route.abort(); }
  });
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/me') await route.fulfill({ json: { mode: 'local', owner: true } });
    else if (path === `/api/surah/${chapter.number}`) await route.fulfill({ json: {
      number: chapter.number, name: chapter.nameSimple, nameArabic: chapter.nameArabic,
      translation: corpus.manifest.translation.name, glossCredit: null,
      ayahs: corpus.verses.filter((v) => v.surah === chapter.number).map((v) => ({
        key: v.key, ayah: v.ayah, arabic: v.arabicDisplay, english: v.english, glosses: null,
      })),
    } });
    else if (path === '/api/chapters') await route.fulfill({ json: corpus.chapters });
    else { blocked.push(path); await route.abort(); }
  });
  // Never connect to a server. This fixture only echoes language choices into display snapshots.
  await page.routeWebSocket('**/*', (socket) => {
    if (!new URL(socket.url()).pathname.endsWith('/ws/control')) {
      blocked.push(socket.url());
      void socket.close();
      return;
    }
    socket.onMessage((raw) => {
      const message = JSON.parse(String(raw)) as ControlClientMessage;
      messages.push(message);
      if (message.type === 'style') {
        snapshot.display = { ...snapshot.display, revision: snapshot.display.revision + 1,
          style: { ...snapshot.display.style, ...message.patch } };
        socket.send(JSON.stringify({ type: 'display', state: snapshot.display }));
      } else blocked.push(`session:${message.type}`);
    });
    socket.send(JSON.stringify({ type: 'snapshot', snapshot }));
  });
  await page.goto('/reader'); // No owner fragment or authorization exchange.
  await expect(page.locator('.r-ayah.current')).toHaveAttribute('id', `a-${key}`);
  await page.evaluate(() => document.fonts.ready);
  return { messages, blocked, displayed };
}

async function openAppearance(page: Page) {
  await page.getByRole('button', { name: /^Menu/ }).click();
  await page.getByRole('button', { name: /^Reading appearance/ }).click();
  return page.getByRole('dialog', { name: 'Your reading page' });
}

test('language choices use one Tab stop, arrows wrap, and modifiers leave the choice alone', async ({ page }, info) => {
  const fixture = await mockReader(page);
  const group = page.getByRole('radiogroup', { name: 'Language', exact: true });
  const both = group.getByRole('radio', { name: 'Both', exact: true });
  const english = group.getByRole('radio', { name: 'English', exact: true });
  const arabic = group.getByRole('radio').nth(0);
  await expect(group.locator('[tabindex="0"]')).toHaveCount(1);
  await both.focus();
  await page.keyboard.press('ArrowRight');
  await expect(english).toBeFocused();
  await expect(english).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('ArrowDown');
  await expect(arabic).toBeFocused();
  await expect(arabic).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('End');
  await expect(english).toBeFocused();
  const count = fixture.messages.length;
  await page.keyboard.press('Control+ArrowLeft');
  await expect(english).toBeFocused();
  expect(fixture.messages).toHaveLength(count);
  await page.keyboard.press('Home');
  await expect(arabic).toBeFocused();
  await expect(arabic).toHaveAttribute('tabindex', '0');
  await page.keyboard.press('Tab');
  await expect(page.locator('.r-ayah.current .r-ayah-follow')).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(arabic).toBeFocused();
  await expect(page.locator('.r-ayah.current')).toHaveAttribute('id', 'a-112:2');
  await page.screenshot({ path: info.outputPath('language-keyboard.png') });
  expect(fixture.messages.every((message) => message.type === 'style')).toBe(true);
  expect(fixture.blocked).toEqual([]);
});

test('theme keyboard choices persist, keep the dialog focus, and leave audience style alone', async ({ page }, info) => {
  const fixture = await mockReader(page);
  const dialog = await openAppearance(page);
  const group = dialog.getByRole('radiogroup', { name: 'Reading theme' });
  const night = group.getByRole('radio', { name: /^Night/ });
  const paper = group.getByRole('radio', { name: /^Paper/ });
  await expect(dialog.getByRole('button', { name: 'Close reading appearance' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(night).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(paper).toBeFocused();
  await expect(page.locator('.reader')).toHaveAttribute('data-theme', 'paper');
  await expect(group.locator('[tabindex="0"]')).toHaveCount(1);
  await page.keyboard.press('Tab');
  await expect(dialog.getByRole('button', { name: 'Smaller reading text' })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(paper).toBeFocused();
  await page.screenshot({ path: info.outputPath('theme-keyboard.png') });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: /^Menu/ })).toBeFocused();
  expect(fixture.messages).toEqual([]);
  await page.reload();
  await expect(page.locator('.reader')).toHaveAttribute('data-theme', 'paper');
  const reopened = await openAppearance(page);
  await expect(reopened.getByRole('radio', { name: /^Paper/ })).toHaveAttribute('tabindex', '0');
  await expect(reopened.getByRole('radio', { name: /^Night/ })).toHaveAttribute('tabindex', '-1');
  expect(fixture.blocked).toEqual([]);
});

test('disabled choices are skipped and horizontal movement follows the group direction', async ({ page }) => {
  const fixture = await mockReader(page);
  const group = page.getByRole('radiogroup', { name: 'Language', exact: true });
  const both = group.getByRole('radio', { name: 'Both', exact: true });
  const arabic = group.getByRole('radio').nth(0);
  await group.getByRole('radio', { name: 'English', exact: true }).evaluate((el) => { (el as HTMLButtonElement).disabled = true; });
  await both.focus();
  await page.keyboard.press('ArrowRight');
  await expect(arabic).toBeFocused();
  await expect(arabic).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('ArrowLeft');
  await expect(both).toBeFocused();
  await expect(both).toHaveAttribute('aria-checked', 'true');
  await group.evaluate((el) => { (el as HTMLElement).dir = 'rtl'; });
  await page.keyboard.press('ArrowRight');
  await expect(arabic).toBeFocused();
  await expect(arabic).toHaveAttribute('aria-checked', 'true');
  expect(fixture.blocked).toEqual([]);
});

for (const viewport of [{ width: 320, height: 568 }, { width: 1280, height: 900 }]) {
  test.describe(`${viewport.width}px silent reading place`, () => {
    test.use({ viewport });
    test('keyboard language changes preserve browsing inside the longest ayah', async ({ page }, info) => {
      const fixture = await mockReader(page, '2:282');
      const group = page.getByRole('radiogroup', { name: 'Language', exact: true });
      await group.getByRole('radio', { name: 'Both', exact: true }).evaluate((el) => (el as HTMLElement).focus({ preventScroll: true }));
      // PageDown remains browser scrolling even when a language choice has focus. The global
      // reading watcher must record that browsing before choice arrows change the language.
      await page.keyboard.press('PageDown');
      await expect(page.getByRole('button', { name: 'Back to 2:282' })).toBeVisible();
      await page.keyboard.press('ArrowRight');
      await expect(group.getByRole('radio', { name: 'English', exact: true })).toBeFocused();
      await expect(page.getByRole('button', { name: 'Back to 2:282' })).toBeVisible();
      await expect(page.locator('.r-ayah.current')).toHaveAttribute('id', 'a-2:282');
      await page.keyboard.press('ArrowLeft');
      await expect(group.getByRole('radio', { name: 'Both', exact: true })).toBeFocused();
      await expect(page.getByRole('button', { name: 'Back to 2:282' })).toBeVisible();
      const current = page.locator('.r-ayah.current');
      expect((await current.locator('.r-word').allTextContents()).join(' ')).toBe(toQpcHafsEncoding(fixture.displayed.arabic));
      await expect(current.locator('.r-en')).toHaveText(fixture.displayed.english);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: info.outputPath('browsing-after-language.png') });
      expect(fixture.blocked).toEqual([]);
    });
  });
}
