// Real capture owner and browser audio, with held permission answers, a synthetic microphone,
// and local provider stand-ins. No device permissions or speech-provider requests are used.
import { expect, test } from '@playwright/test';

const OWNER = 'ui-test-owner-capability-0001';
type MicHarness = { calls: number; streams: Array<{ kind: 'old' | 'current'; stream: MediaStream }>; answerOld: ((answer: 'grant' | 'denial') => Promise<void>) | null };
type TestWindow = Window & { permissionHarness: MicHarness };

test.use({
  viewport: { width: 390, height: 844 },
  launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] },
});

for (const answer of ['grant', 'denial'] as const) {
  test(`a late microphone ${answer} after Stop cannot disturb the reader's retry`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    const streams: Array<{ closed: boolean }> = [];
    await page.route('**/api/soniox/temporary-key', route => route.fulfill({ json: { api_key: 'ui-test-temporary-key' } }));
    await page.routeWebSocket(/stt-rt\.soniox\.com/, ws => {
      const stream = { closed: false };
      streams.push(stream);
      ws.onClose(() => { stream.closed = true; });
    });
    await page.addInitScript(() => {
      const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      const state: MicHarness = { calls: 0, streams: [], answerOld: null };
      (window as unknown as TestWindow).permissionHarness = state;
      navigator.mediaDevices.getUserMedia = async constraints => {
        if (++state.calls === 1) return new Promise<MediaStream>((resolve, reject) => {
          state.answerOld = async answer => {
            if (answer === 'denial') reject(new DOMException('Cancelled permission request denied', 'NotAllowedError'));
            else {
              const stream = await original(constraints);
              state.streams.push({ kind: 'old', stream });
              resolve(stream);
            }
          };
        });
        const stream = await original(constraints);
        state.streams.push({ kind: 'current', stream });
        return stream;
      };
    });
    await page.goto(`/reader#owner=${OWNER}`);
    await expect(page.locator('.r-top')).toBeVisible();
    await page.getByRole('radio', { name: 'Both', exact: true }).click();
    await page.getByRole('button', { name: 'Type instead' }).click();
    await page.getByLabel('Type a request').fill('112:2');
    await page.getByLabel('Type a request').press('Enter');
    await expect(page.locator('.r-ayah.current')).toHaveAttribute('id', 'a-112:2');
    const scripture = await page.locator('.r-ayah.current .r-en').textContent();

    await page.getByRole('button', { name: 'Start listening', exact: true }).click();
    await page.getByRole('dialog', { name: 'Before you turn on the microphone' }).getByRole('checkbox').check();
    await page.getByRole('button', { name: 'Agree and continue' }).click();
    await expect.poll(() => page.evaluate(() => (window as unknown as TestWindow).permissionHarness.calls)).toBe(1);
    await page.getByRole('button', { name: 'Stop listening', exact: true }).click();
    await page.getByRole('button', { name: 'Start listening', exact: true }).click();
    await expect(page.locator('.r-mic.live')).toBeVisible();
    await expect.poll(() => streams.length).toBe(1);

    await page.evaluate(answer => (window as unknown as TestWindow).permissionHarness.answerOld!(answer), answer);
    if (answer === 'grant') {
      await expect.poll(() => page.evaluate(() => {
        const old = (window as unknown as TestWindow).permissionHarness.streams.filter(s => s.kind === 'old');
        return { count: old.length, ended: old.every(s => s.stream.getTracks().every(t => t.readyState === 'ended')) };
      })).toEqual({ count: 1, ended: true });
    }
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(page.locator('.r-mic.live')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Stop listening', exact: true })).toBeVisible();
    await expect(page.locator('.r-status')).not.toContainText('permission was denied');
    expect(streams).toHaveLength(1);
    await expect(page.locator('.r-ayah.current')).toHaveAttribute('id', 'a-112:2');
    await expect(page.locator('.r-ayah.current .r-en')).toHaveText(scripture!);
    await page.screenshot({ path: `test-results/reader-permission-${answer}-retry.png` });

    await page.getByRole('button', { name: 'Stop listening', exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as unknown as TestWindow).permissionHarness.streams
      .every(s => s.stream.getTracks().every(t => t.readyState === 'ended')))).toBe(true);
    await expect.poll(() => streams[0].closed).toBe(true);
    await expect(page.getByRole('button', { name: 'Start listening', exact: true })).toBeVisible();
    await expect(page.locator('.r-status')).toContainText('Tap the microphone and recite, or ask in English.');
    await expect(page.locator('.r-mic-ring')).toHaveCSS('opacity', '0');
    await expect(page.locator('.r-ayah.current')).toHaveAttribute('id', 'a-112:2');
    expect(errors).toEqual([]);
    await page.screenshot({ path: `test-results/reader-permission-${answer}-stopped.png` });
  });
}
