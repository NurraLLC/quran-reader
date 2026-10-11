// npm run speedlab -- --name duha [--port 4398] [--mode hybrid] [--stt '{"timeslice":20}'] [--label x] [--shot card.png] [--idle-check] [--frames dir] [--reader dir]
// End-to-end speed and correctness through the real pipeline: WAV (see make-audio.ts) as Edge's
// microphone -> Soniox (live) -> server -> screen. Records every screen change against the audio
// clock and reports, per ayah, "ayah starts in the audio -> on screen", plus wrong and missed ayahs.
// Real network, real Soniox, TTS voice (not a human reciter). Needs SONIOX_API_KEY in .env.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { assertPortFree } from './port';

const arg = (n: string, d: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const name = arg('name', 'duha');
const port = Number(arg('port', '4398'));
const mode = arg('mode', 'hybrid');
const stt = arg('stt', '');
const label = arg('label', stt || 'default');
const owner = 'speedlab-owner-capability-7f3a';
const wav = path.resolve('data', 'speedlab', `${name}.wav`);
const truth = JSON.parse(readFileSync(path.join('data', 'speedlab', `${name}.json`), 'utf8')) as {
  durationMs: number;
  segments: Array<{ key: string; startMs: number; endMs: number }>;
};

// A server left on the port (e.g. from an interrupted run) would silently serve stale code.
await assertPortFree(port);

const server = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/server/main.ts', '--capture'], {
  env: { ...process.env, PORT: String(port), QO_OWNER_TOKEN: owner, TRACKER_MODE: mode },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', () => undefined);
server.stderr.on('data', (d) => process.stderr.write(d));
const base = `http://127.0.0.1:${port}`;
for (let i = 0; i < 100; i++) {
  try {
    if ((await fetch(`${base}/api/owner/status`)).ok) break;
  } catch {
    /* starting */
  }
  await new Promise((r) => setTimeout(r, 200));
}

let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  browser = await chromium.launch({
    channel: 'msedge',
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${wav}%noloop`],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`${base}/control${stt ? `?stt=${encodeURIComponent(stt)}` : ''}#owner=${owner}`);
  await page.waitForSelector('.topbar');
  // Record every change of the previewed ayah at frame resolution.
  await page.evaluate(`(() => {
    window.__qoLog = [];
    window.__qoAntLog = [];
    window.__qoAnt = false;
    let last;
    const tick = () => {
      const el = document.querySelector('.panel-on .verse');
      const label = el ? el.getAttribute('aria-label') : null;
      const key = label ? label.split(' ').pop() : null;
      if (key !== last) { window.__qoLog.push({ t: performance.now(), key }); last = key; }
      const ant = !!document.querySelector('.panel-on .next-ayah[data-anticipate], .panel-on .ayah-upnext');
      if (ant !== window.__qoAnt) { window.__qoAnt = ant; if (ant) window.__qoAntLog.push({ t: performance.now(), key }); }
      requestAnimationFrame(tick);
    };
    tick();
  })()`);
  await page.getByRole('button', { name: 'Start listening' }).click();
  // The input is the explicitly selected, existing lab WAV, not a person's live microphone.
  const consent = page.getByRole('dialog', { name: 'Before you turn on the microphone' });
  await consent.getByRole('checkbox').check();
  await consent.getByRole('button', { name: 'Agree and continue' }).click();
  await page.waitForFunction(() => (window as unknown as { __qoAudioOrigin?: () => number | null }).__qoAudioOrigin?.() != null, undefined, { timeout: 20000 });
  const frames = arg('frames', '');
  if (frames) {
    // Design review: the audience reading screen, one frame every ~2.5 s of the run.
    const href = await page.locator('a[href*="/overlay#"]').first().getAttribute('href');
    const reader = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    await reader.goto(new URL(href!, base).toString());
    let n = 0;
    const timer = setInterval(() => void reader.screenshot({ path: path.join(frames, `frame-${String(n++).padStart(3, '0')}.png`) }).catch(() => undefined), 2500);
    setTimeout(() => clearInterval(timer), truth.durationMs + 2000);
  }
  const readerDir = arg('reader', '');
  if (readerDir) {
    // Design review: the phone reader (same session) during the run, one frame every ~2.5 s.
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const reader = await phone.newPage();
    await reader.goto(`${base}/reader#owner=${owner}`);
    let n = 0;
    const timer = setInterval(() => void reader.screenshot({ path: path.join(readerDir, `reader-${String(n++).padStart(3, '0')}.png`) }).catch(() => undefined), 2500);
    setTimeout(() => clearInterval(timer), truth.durationMs + 2000);
  }
  const shot = arg('shot', '');
  if (shot) {
    // Mid-run picture of the control card while listening (design review).
    await page.waitForTimeout(truth.durationMs / 2);
    await page.locator('.voice-card').screenshot({ path: shot });
    await page.waitForTimeout(truth.durationMs / 2 + 2500);
  } else await page.waitForTimeout(truth.durationMs + 2500);
  const origin = await page.evaluate(() => (window as unknown as { __qoAudioOrigin: () => number }).__qoAudioOrigin());
  const log = await page.evaluate(() => (window as unknown as { __qoLog: Array<{ t: number; key: string | null }> }).__qoLog);
  const antLog = await page.evaluate(() => (window as unknown as { __qoAntLog: Array<{ t: number; key: string | null }> }).__qoAntLog);
  const meter = await page.locator('.speed').innerText().catch(() => '');
  if (process.argv.includes('--idle-check')) {
    // After the recitation ends the fake microphone is silent: listening must stop by itself.
    const t0 = Date.now();
    const stopped = await page
      .getByRole('button', { name: 'Start listening' })
      .waitFor({ timeout: 80_000 })
      .then(() => true, () => false);
    const note = await page.locator('.voice-card .hint').first().innerText().catch(() => '');
    console.log(`idle check: ${stopped ? `stopped by itself ${((Date.now() - t0) / 1000).toFixed(0)} s after the audio ended (+2.5 s)` : 'STILL LISTENING after 80 s'} — "${note.slice(0, 90)}"`);
    if (!stopped) process.exitCode = 1;
  }
  await page.getByRole('button', { name: 'Stop listening' }).click().catch(() => undefined);

  // Audio time of each screen change.
  const changes = log.map((l) => ({ audio: l.t - origin, key: l.key })).filter((c) => c.audio > -2000);
  const rows: string[] = [];
  const lat: number[] = [];
  let wrong = 0;
  let late = 0;
  for (const c of changes) {
    if (!c.key) continue;
    const seg = truth.segments.find((s) => s.key === c.key);
    const current = truth.segments.filter((s) => s.startMs <= c.audio).at(-1);
    const wrongVerse = !seg || seg.startMs > c.audio + 50;
    const stale = !wrongVerse && !!current && truth.segments.indexOf(current) - truth.segments.indexOf(seg!) > 1;
    if (wrongVerse) wrong++;
    if (stale) late++;
    if (seg) lat.push(c.audio - seg.startMs);
    rows.push(`  ${c.key.padEnd(7)} on screen ${(c.audio / 1000).toFixed(2).padStart(6)} s audio | ayah began ${seg ? (seg.startMs / 1000).toFixed(2) : '—'} s | ${seg ? `+${((c.audio - seg.startMs) / 1000).toFixed(2)} s after ayah start` : ''}${wrongVerse ? '  WRONG VERSE' : stale ? '  LATE (more than one ayah behind)' : ''}`);
  }
  const shown = new Set(changes.map((c) => c.key));
  const missed = truth.segments.filter((s) => !shown.has(s.key)).map((s) => s.key);
  const s = [...lat].sort((a, b) => a - b);
  const q = (p: number) => (s.length ? (s[Math.min(s.length - 1, Math.floor(s.length * p))] / 1000).toFixed(2) : '—');
  console.log(rows.join('\n'));
  console.log(`\n${name} (${mode}, ${label}): ${truth.segments.length} ayahs, shown ${truth.segments.length - missed.length}, missed ${missed.length}${missed.length ? ` (${missed.join(' ')})` : ''}, wrong ${wrong}, late ${late}`);
  const reportDir = path.resolve('artifacts/speedlab');
  mkdirSync(reportDir, { recursive: true });
  const reportFile = path.join(reportDir, `run-${Date.now()}.json`);
  writeFileSync(reportFile, JSON.stringify({ kind: 'Live Soniox with existing injected TTS WAV; not a physical microphone or human-reciter accuracy test', name, mode, label, wavSha256: createHash('sha256').update(readFileSync(wav)).digest('hex'), changes, truth: truth.segments, missed, wrong, late, onsetToPaintMs: lat }, null, 2));
  console.log(`Evidence: ${reportFile}`);
  // A measured failure remains a failure; cleanup must never turn it into exit 0.
  if (wrong || late || missed.length) process.exitCode = 1;
  console.log(`ayah starts in audio -> on screen: p50 ${q(0.5)} s, p90 ${q(0.9)} s, best ${q(0)} s`);
  console.log(`control-page meter: ${meter}`);
  // Anticipation: the next-ayah preview brightened (last word reached) before the ayah changed.
  const leads: number[] = [];
  for (let i = 1; i < log.length; i++) {
    const prev = log[i - 1];
    const a = antLog.filter((x) => x.key === prev.key && x.t >= prev.t && x.t <= log[i].t).at(0);
    if (a && prev.key && log[i].key) leads.push(log[i].t - a.t);
  }
  const ls = [...leads].sort((a, b) => a - b);
  console.log(`next-ayah preview brightened before ${leads.length} of ${Math.max(0, log.filter((l) => l.key).length - 1)} changes${ls.length ? `, lead p50 ${(ls[Math.floor(ls.length / 2)] / 1000).toFixed(2)} s` : ''}`);
} finally {
  try { await browser?.close(); } finally {
    if (process.platform === 'win32' && server.pid) spawnSync('taskkill', ['/pid', String(server.pid), '/t', '/f'], { stdio: 'ignore' });
    else server.kill();
  }
}
