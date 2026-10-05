// Waiting in line on the phone reader, in a real browser without Soniox: while every place is
// taken the page says where the reciter stands and asks again by itself (at once when told a place
// is free); a stream refused after all keeps them in line without an error; and "It's your turn"
// appears only once the recogniser has answered, never while it may still refuse.
import { expect, test, type WebSocketRoute } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const OWNER = 'ui-test-owner-capability-0001';

/** 16 kHz mono WAV: a steady voice-like tone (the fake microphone). */
function wav(): string {
  const rate = 16_000;
  const samples = 40 * rate;
  const buf = Buffer.alloc(44 + samples * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + samples * 2, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(samples * 2, 40);
  for (let t = 0; t < samples; t++) buf.writeInt16LE(Math.round((0.3 * Math.sin((2 * Math.PI * 220 * t) / rate) + 0.1 * Math.sin((2 * Math.PI * 660 * t) / rate)) * 32767), 44 + t * 2);
  const file = path.join(tmpdir(), 'qo-listening-line.wav');
  writeFileSync(file, buf);
  return file;
}

test.use({
  launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${wav()}`, '--autoplay-policy=no-user-gesture-required'] },
  viewport: { width: 390, height: 844 },
});

test('in line: the place is shown, the turn is taken by itself, and "your turn" waits for the recogniser', async ({ page }) => {
  test.setTimeout(60_000);
  // The server's answers, in order: 2nd in line, next, a place (refused by the relay after all), a place.
  const answers: Array<{ status: number; json: object }> = [
    { status: 429, json: { error: 'LISTENING_BUSY', position: 2 } },
    { status: 429, json: { error: 'LISTENING_BUSY', position: 1 } },
    { status: 200, json: { api_key: 'ui-test-temporary-key' } },
    { status: 200, json: { api_key: 'ui-test-temporary-key' } },
  ];
  let asks = 0;
  await page.route('**/api/soniox/temporary-key', (r) => {
    const a = answers[Math.min(asks++, answers.length - 1)];
    return r.fulfill({ status: a.status, json: a.json });
  });
  const streams: WebSocketRoute[] = [];
  await page.routeWebSocket(/stt-rt\.soniox\.com/, (ws) => {
    streams.push(ws);
    // The first stream is refused as the relay does when it is full after all; the second is taken.
    if (streams.length === 1) ws.onMessage(() => ws.send(JSON.stringify({ error_code: 403, error_type: 'listening_busy', error_message: 'Many people are reciting right now.' })));
  });
  // The page's own socket, passed through; the server's "a place is free" is added by the test.
  let control: WebSocketRoute | null = null;
  await page.routeWebSocket(/\/ws\/control/, (ws) => {
    control = ws;
    ws.connectToServer();
  });
  const turn = () => control!.send(JSON.stringify({ type: 'listen_turn' }));
  const status = page.locator('.r-status > span').first();

  await page.goto(`/reader#owner=${OWNER}`);
  await expect(page.locator('.r-top')).toBeVisible();
  await page.getByRole('button', { name: 'Start listening', exact: true }).click();
  await page.getByRole('dialog', { name: 'Before you turn on the microphone' }).getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Agree and continue' }).click();

  await expect(status).toHaveText(/You’re 2nd in line, and listening starts by itself when it’s your turn\./);
  await expect(page.getByRole('button', { name: 'Stop waiting to listen' })).toBeVisible();
  await expect(page.locator('.r-mic-wrap[data-waiting]')).toHaveCount(1);
  await expect(page.locator('.r-mic-wrap[data-live]')).toHaveCount(0); // no level ring: nothing is heard yet
  await page.screenshot({ path: 'test-results/listening-line-waiting.png' });

  turn(); // a place freed (someone ahead took it first): asked at once, now next
  await expect(status).toHaveText(/You’re next, and listening starts by itself in a moment\./);
  expect(asks).toBe(2);

  turn(); // a place: the stream opens, but the relay refuses it after all
  await expect.poll(() => streams.length).toBe(1);
  await expect.poll(() => asks, { timeout: 10_000 }).toBe(4); // still in line, it asks again shortly
  await expect(status).toHaveText(/You’re next/);
  // Only the reader's own messages (the dock): the passage's translation may itself say "error" (2:16).
  await expect(page.locator('.r-dock').getByText(/error|went wrong/i)).toHaveCount(0);

  // The second stream is open, but the recogniser has not answered yet: still in line.
  await expect.poll(() => streams.length).toBe(2);
  await page.waitForTimeout(300);
  await expect(status).toHaveText(/You’re next/);
  streams[1].send(JSON.stringify({ tokens: [], final_audio_proc_ms: 0, total_audio_proc_ms: 300 }));
  await expect(status).toHaveText('It’s your turn. Recite when you’re ready.');
  await expect(page.getByRole('button', { name: 'Stop listening' })).toBeVisible();
  await expect(page.locator('.r-mic-wrap[data-live]')).toHaveCount(1);
  await page.screenshot({ path: 'test-results/listening-line-turn.png' });

  await page.getByRole('button', { name: 'Stop listening' }).click();
  await expect(page.getByRole('button', { name: 'Start listening', exact: true })).toBeVisible();
});

test('stopping while in line leaves it and says nothing alarming', async ({ page }) => {
  let asks = 0;
  await page.route('**/api/soniox/temporary-key', (r) => {
    asks++;
    return r.fulfill({ status: 429, json: { error: 'LISTENING_BUSY', position: 5 } });
  });
  await page.goto(`/reader#owner=${OWNER}`);
  await page.getByRole('button', { name: 'Start listening', exact: true }).click();
  await page.getByRole('dialog', { name: 'Before you turn on the microphone' }).getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Agree and continue' }).click();
  const status = page.locator('.r-status > span').first();
  await expect(status).toHaveText(/You’re 5th in line/);
  await page.getByRole('button', { name: 'Stop waiting to listen' }).click();
  await expect(page.getByRole('button', { name: 'Start listening', exact: true })).toBeVisible();
  await expect(status).not.toHaveText(/in line/);
  const before = asks;
  await page.waitForTimeout(13_000); // longer than the page's asking interval
  expect(asks).toBe(before); // stopped asking
});

test('the control page shows the line in its status, not "listening"', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route('**/api/soniox/temporary-key', (r) => r.fulfill({ status: 429, json: { error: 'LISTENING_BUSY', position: 3 } }));
  await page.goto(`/control#owner=${OWNER}`);
  await page.waitForSelector('.topbar');
  await page.getByRole('button', { name: 'Start listening' }).click();
  await page.getByRole('dialog', { name: 'Before you turn on the microphone' }).getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Agree and continue' }).click();
  await expect(page.getByText('You’re 3rd in line, and listening starts by itself when it’s your turn.', { exact: false }).first()).toBeVisible();
  await expect(page.locator('.live-status')).toHaveText(/In line to listen/);
  await expect(page.getByText('In line to listen', { exact: true }).first()).toBeVisible(); // the status, from the server
  await page.screenshot({ path: 'test-results/listening-line-control.png' });
  await page.getByRole('button', { name: 'Stop listening' }).click();
  await expect(page.getByRole('button', { name: 'Start listening' })).toBeVisible();
});
