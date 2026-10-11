// npm run speedlab:hosted
// Real Soniox through the hosted relay, with an existing lab WAV injected into Edge. This is
// provider/relay/accounting proof, not a physical microphone or human-reciter accuracy test.
// A fresh LOCAL pool funds 60 seconds; no payment, production state or new TTS is involved.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chromium, expect, type Browser } from '@playwright/test';
import { DatabaseSync } from 'node:sqlite';
import { CreditStore, DEFAULT_CREDITS } from '../../src/server/billing/credits';
import { assertPortFree } from './port';

const port = 4420, base = `http://127.0.0.1:${port}`;
const wav = path.resolve('data/speedlab/duha-sharh.wav');
if (!existsSync(wav)) throw new Error('Existing lab WAV missing; this check does not generate scripture audio.');
await assertPortFree(port);
const root = path.resolve('artifacts/speedlab-hosted');
mkdirSync(root, { recursive: true });
const out = mkdtempSync(path.join(root, 'run-')), state = path.join(out, 'state');
mkdirSync(state);
const credits = new CreditStore(path.join(state, 'credits.db'), DEFAULT_CREDITS);
credits.grantPool(60, 'local-test-only');
credits.close();
const server = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/server/main.ts'], {
  env: { ...process.env, PORT: String(port), QO_HOSTED: '1', QO_HOST: '127.0.0.1', QO_STATE_DIR: state,
    QO_PUBLIC_ORIGIN: base, QO_BASE_PATH: '', QO_OWNER_TOKEN: '', QO_DIAGNOSTIC_CAPTURE: '0',
    QO_OPERATING_RESERVE_CENTS: '0', QO_REQUIRE_CONTENT_SYNC: '0', STRIPE_SECRET_KEY: '', STRIPE_WEBHOOK_SECRET: '' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '', browser: Browser | undefined;
server.stdout.on('data', d => { log = (log + String(d)).slice(-16_000); });
server.stderr.on('data', () => undefined);
const started = Date.now(), errors: string[] = [], seen = new Set<string>();
try {
  while (!log.includes('Hosted mode')) {
    if (server.exitCode !== null || Date.now() - started > 20_000) throw new Error('Isolated hosted server did not start.');
    await new Promise(r => setTimeout(r, 200));
  }
  browser = await chromium.launch({ channel: 'msedge', args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${wav}%noloop`] });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const p = await ctx.newPage();
  p.on('pageerror', e => errors.push(e.message));
  p.on('websocket', ws => ws.on('framereceived', ({ payload }) => {
    try { const m = JSON.parse(String(payload)); const key = m.display?.verse?.key ?? m.state?.verse?.key; if (typeof key === 'string') seen.add(key); } catch { /* binary audio */ }
  }));
  await p.goto(`${base}/`);
  await expect(p.locator('.r-top')).toBeVisible();
  await p.getByRole('button', { name: 'Start listening', exact: true }).click();
  const consent = p.getByRole('dialog', { name: 'Before you turn on the microphone' });
  await consent.getByRole('checkbox').check();
  await consent.getByRole('button', { name: 'Agree and continue' }).click();
  await expect(p.locator('.r-status')).toContainText(/Recite|Following/, { timeout: 20_000 });
  await expect.poll(() => seen.has('93:1'), { timeout: 25_000 }).toBe(true);
  await p.screenshot({ path: path.join(out, 'following.png') });
  await expect(p.locator('.r-status')).toContainText('The sponsored hours have run out', { timeout: 85_000 });
  await expect(p.getByRole('button', { name: 'Start listening', exact: true })).toBeVisible();
  await expect(p.locator('.r-top')).toBeVisible();
  await p.screenshot({ path: path.join(out, 'pool-empty.png') });
  const db = new DatabaseSync(path.join(state, 'credits.db'), { readOnly: true });
  try {
    const holds = db.prepare('SELECT max_seconds, settled_at IS NOT NULL AS settled, free_seconds, paid_seconds, pool_seconds FROM holds').all();
    expect(holds).toEqual([{ max_seconds: 60, settled: 1, free_seconds: 0, paid_seconds: 0, pool_seconds: 60 }]);
    expect(errors).toEqual([]);
    expect(seen.size).toBeGreaterThan(1);
    const report = { kind: 'Live hosted Soniox with existing injected TTS WAV; no physical microphone or OBS proof', elapsedMs: Date.now() - started, displayed: [...seen], holds, errors };
    writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    console.log(`Evidence: ${out}`);
  } finally { db.close(); }
} finally {
  try { await browser?.close(); } finally {
    if (server.exitCode === null && server.pid) {
      if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(server.pid), '/t', '/f'], { stdio: 'ignore' });
      else server.kill();
    }
  }
}
