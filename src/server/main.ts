// npm start — loopback server on 127.0.0.1:4317 (or PORT). Prints the owner link.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { CreditStore, DEFAULT_CREDITS } from './billing/credits';
import { SessionHub } from './billing/hub';
import { OverlayLinks } from './billing/overlay-links';
import { randomBytes } from 'node:crypto';
import { VisitorIdentity } from './billing/identity';
import { parseDonations, StripeBilling } from './billing/stripe';
import net from 'node:net';
import path from 'node:path';
import { buildApp, normalizeBase, type HostedOptions } from './app';
import { localLinks, savedSessionOptions } from './local-links';
import { CommandResolver } from './commands/reducer';
import { Corpus, loadCorpus } from './corpus/load';
import { ROOT, PROCESSED_DIR } from './corpus/manifest';
import { activeContent } from './corpus/active';
import { JevClient, type DecisionClient, type JevGateway } from './providers/jev';
import { SemanticRetriever } from './search/semantic';
import { Session } from './sessions';
import { TRACKER_MODES, type TrackerMode } from './tracker/follower';
import { buildIndex } from './tracker/index';
import { ResourceCatalog } from './resources/catalog';
import { WordGlosses } from './corpus/wbw';
import { Transliteration } from './search/transliteration';
import { LatinReader } from './tracker/latin';
import { ListeningSafety } from './billing/listening-safety';
import { recitationActivity } from './providers/recitation-activity';
import { DEFAULT_MAX_STREAMS } from './providers/hosted-speech';

function loadEnvFile() {
  const file = path.join(ROOT, '.env');
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

async function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

function decisionSetup(): { client: DecisionClient | null; provider: JevGateway | null; detail: string } {
  const provider = (process.env.JEV_PROVIDER || '').trim() as JevGateway | '';
  const keys: Record<JevGateway, string | undefined> = { typesafe: process.env.TYPESAFE_API_KEY, openrouter: process.env.OPENROUTER_API_KEY };
  const chosen: JevGateway | null = provider === 'typesafe' || provider === 'openrouter' ? provider : keys.typesafe ? 'typesafe' : keys.openrouter ? 'openrouter' : null;
  if (!chosen) return { client: null, provider: null, detail: 'No JEV key configured (set JEV_PROVIDER and TYPESAFE_API_KEY or OPENROUTER_API_KEY). Deterministic following, manual navigation and search still work.' };
  const key = keys[chosen];
  if (!key) return { client: null, provider: chosen, detail: `JEV_PROVIDER=${chosen} but ${chosen === 'typesafe' ? 'TYPESAFE_API_KEY' : 'OPENROUTER_API_KEY'} is not set.` };
  try {
    return { client: new JevClient(chosen, key), provider: chosen, detail: `JEV via ${chosen === 'typesafe' ? 'TypeSafe direct' : 'OpenRouter Decisions'}; in hybrid mode it is asked only when the tracker is unsure, and every answer is re-checked locally.` };
  } catch {
    return { client: null, provider: chosen, detail: 'JEV key has an invalid format.' };
  }
}

/**
 * Hosted service: one anonymous session per visitor, drawing from the shared sponsored pool.
 * Configured listening durations are in hours; reading and translations are always free.
 */
function hostedSetup(create: (saved: Pick<ConstructorParameters<typeof Session>[0], 'viewToken' | 'onViewToken' | 'style' | 'onStyle' | 'stream' | 'onStream'>) => Session): HostedOptions {
  const hours = (name: string, fallback: number) => Math.round((Number(process.env[name]) || fallback) * 3600);
  const stateDir = process.env.QO_STATE_DIR || path.join(ROOT, 'data', 'state');
  mkdirSync(stateDir, { recursive: true });
  const credits = new CreditStore(path.join(stateDir, 'credits.db'), {
    ...DEFAULT_CREDITS,
    costCentsPerHour: parseDonations(process.env.QO_DONATIONS, process.env.QO_SPONSOR_CENTS_PER_HOUR).centsPerHour,
    operatingReserveUsdMicros: Number(process.env.QO_OPERATING_RESERVE_CENTS ?? 0) * 10_000,
    // Public listening draws only from community funding; no personal plans or allowances.
    freeSecondsPerMonth: 0,
    ipDailyFreeSeconds: 0,
    globalDailyFreeSeconds: 0,
    poolDailySecondsPerVisitor: hours('QO_SPONSORED_HOURS_PER_VISITOR_DAY', 2),
    poolDailySecondsPerNetwork: hours('QO_SPONSORED_HOURS_PER_NETWORK_DAY', 4),
  });
  // A streamer's overlay link and look survive idle time, restarts and deploys (OBS keeps working).
  const links = new OverlayLinks(path.join(stateDir, 'overlay-links.db'));
  const session = (visitor: string) => {
    const saved = links.get(visitor);
    const view = saved?.view ?? randomBytes(18).toString('base64url');
    if (!saved) links.saveView(visitor, view);
    return create({ viewToken: view, onViewToken: (v) => links.saveView(visitor, v), style: saved?.style ?? undefined, onStyle: (st) => links.saveStyle(visitor, st),
      stream: saved?.stream ?? undefined, onStream: (st) => links.saveStream(visitor, st) });
  };
  return {
    hub: new SessionHub(session, undefined, undefined, (view) => links.visitorOf(view)),
    credits,
    safety: new ListeningSafety(path.join(stateDir, 'listening-safety.db')),
    identity: VisitorIdentity.fromFile(path.join(stateDir, 'identity.key'), process.env.QO_SECRET),
    publicOrigin: process.env.QO_PUBLIC_ORIGIN || undefined,
    trustProxy: process.env.QO_TRUST_PROXY === '1',
    // Each reciter costs tracker CPU, and the recogniser has its own limit (Soniox: 10 at once unless raised).
    maxListeners: Number(process.env.QO_MAX_LISTENERS) || undefined,
    maxReciters: Number(process.env.QO_MAX_RECITERS) || undefined,
    // Voluntary community donations only. No personal purchases or subscriptions.
    billing: process.env.STRIPE_SECRET_KEY && process.env.STRIPE_WEBHOOK_SECRET ? new StripeBilling(process.env.STRIPE_SECRET_KEY, process.env.STRIPE_WEBHOOK_SECRET, fetch, parseDonations(process.env.QO_DONATIONS, process.env.QO_SPONSOR_CENTS_PER_HOUR)) : null,
  };
}

async function main() {
  loadEnvFile();
  // `--capture` is equivalent to QO_DIAGNOSTIC_CAPTURE=1 (for launchers that cannot set env vars).
  if (process.argv.includes('--capture')) process.env.QO_DIAGNOSTIC_CAPTURE = '1';
  const t0 = performance.now();
  if(process.env.QO_REQUIRE_CONTENT_SYNC==='1') {
    if(!process.env.QO_CONTENT_STORE)throw new Error('Live reader requires QO_CONTENT_STORE');
    activeContent(process.env.QO_CONTENT_STORE);
  }
  const corpus = new Corpus(loadCorpus());
  const ix = buildIndex(corpus.verses);
  const catalog = new ResourceCatalog(corpus, ix);
  const semantic = new SemanticRetriever();
  void semantic.init();
  const jev = decisionSetup();
  const modeEnv = (process.env.TRACKER_MODE || 'hybrid') as TrackerMode;
  const mode: TrackerMode = TRACKER_MODES.includes(modeEnv) ? modeEnv : 'hybrid';
  const resolver = new CommandResolver(corpus, semantic, jev.client, catalog, Transliteration.load(corpus));

  let port = Number(process.env.PORT || 4317);
  if (!(await portFree(port))) {
    const wanted = port;
    for (port = wanted + 1; port < wanted + 20 && !(await portFree(port)); port++);
    console.log(`Port ${wanted} is in use; using ${port} instead.`);
  }
  const devOrigins = process.env.QO_DEV === '1' ? ['http://127.0.0.1:5173', 'http://localhost:5173'] : [];
  const publicOrigin = process.env.QO_DEV === '1' ? 'http://127.0.0.1:5173' : `http://127.0.0.1:${port}`;
  // Served under a path of another site, e.g. nurra.org/quran-reader (QO_BASE_PATH=/quran-reader).
  const base = normalizeBase(process.env.QO_BASE_PATH);

  const hostedMode = process.env.QO_HOSTED === '1';
  const sessionOptions = (hosted: boolean): ConstructorParameters<typeof Session>[0] => ({
    corpus,
    ix,
    resolver,
    decisionClient: jev.client,
    mode,
    setup: {
      soniox: !!process.env.SONIOX_API_KEY,
      jev: { provider: jev.provider, configured: !!jev.client, detail: jev.detail },
      semantic: () => {
        const s = semantic.status;
        return s.state === 'ready' ? `ready (${s.model}, warm-up ${s.warmupMs} ms)` : s.state === 'loading' ? 'loading' : `${s.state}: ${'reason' in s ? s.reason : ''}`;
      },
    },
    overlayUrl: (view) => `${hosted && process.env.QO_PUBLIC_ORIGIN ? process.env.QO_PUBLIC_ORIGIN : publicOrigin}${base}/overlay#view=${view}`,
    // Diagnostic transcripts are never written for visitors of the hosted service.
    captureDir: !hosted && process.env.QO_DIAGNOSTIC_CAPTURE === '1' ? path.join(ROOT, 'data', 'captures') : null,
    catalog,
    glosses,
    latin,
  });
  const glosses = WordGlosses.load();
  // Built once, in the background after start-up (a few seconds); until then Latin stays Latin.
  const latin = { reader: null as LatinReader | null, get() { return this.reader; } };
  const translitFile = path.join(PROCESSED_DIR, 'translit-en.json');
  if (existsSync(translitFile)) setTimeout(() => (latin.reader = new LatinReader(ix, corpus, JSON.parse(readFileSync(translitFile, 'utf8')).verses)), 1000);
  // Self-hosted: the control and overlay links survive restarts (OBS keeps working), and so do the
  // owner's sign-in and the ayah on stream (local-links.ts); tests pin their own.
  const links = hostedMode || process.env.QO_OWNER_TOKEN ? null : (() => {
    const dir = process.env.QO_STATE_DIR || path.join(ROOT, 'data', 'state');
    mkdirSync(dir, { recursive: true });
    return localLinks(path.join(dir, 'local-links.json'));
  })();
  // Self-hosted: a charity stream's settings and donations are kept beside the links.
  const localStream = links ? (() => {
    const file = path.join(process.env.QO_STATE_DIR || path.join(ROOT, 'data', 'state'), 'local-stream.json');
    let stream: unknown;
    try {
      stream = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined;
    } catch {
      stream = undefined;
    }
    return { stream, onStream: (st: unknown) => writeFileSync(file, JSON.stringify(st), { mode: 0o600 }) };
  })() : {};
  const session = hostedMode ? undefined : new Session({ ...sessionOptions(false), ...(links ? savedSessionOptions(links) : {}), ...localStream });
  const hosted = hostedMode ? hostedSetup((saved) => new Session({ ...sessionOptions(true), ...saved })) : undefined;
  if (hosted) {
    // Reading without a visitor cookie shares one session that never listens.
    hosted.reading = new Session(sessionOptions(true));
    const activity = recitationActivity(ix.words);
    hosted.isRecitation = (text) => {
      if (activity(text)) return true;
      // Preserve the existing plain-recitation/Latin-script recovery; it is not abuse.
      const reader = latin.get();
      if (!reader) return false;
      const words = text.trim().split(/\s+/).map((word, index) => ({ text: word, index, startMs: null, endMs: null }));
      return activity(reader.apply(words, null).map((w) => w.text).join(' '));
    };
  }
  // QO_OWNER_TOKEN exists only so automated browser tests can open the control page; self-hosted
  // runs keep a random capability and the sign-in cookie's secret in data/state (see local-links.ts).
  const { app, ownerToken } = await buildApp({ basePath: base, extraHosts: (process.env.QO_EXTRA_HOSTS ?? '').split(',').filter(Boolean), session, hosted, port, sonioxApiKey: process.env.SONIOX_API_KEY, devOrigins,
    ownerToken: process.env.QO_OWNER_TOKEN || links?.links.owner, ownerCookie: links?.links.cookie });
  // Loopback by default; a container or VM behind a reverse proxy sets QO_HOST=0.0.0.0.
  if(process.env.QO_REQUIRE_CONTENT_SYNC==='1') {
    const watch=setInterval(()=>{
      try { if(activeContent(process.env.QO_CONTENT_STORE!).id===corpus.id)return; } catch {}
      console.log('Content refresh requires a reader restart.');
      clearInterval(watch);
      const deadline=setTimeout(()=>process.exit(1),10000);deadline.unref();
      void app.close().finally(()=>process.exit(0));
    },60000);
    watch.unref();
    app.addHook('onClose',async()=>{clearInterval(watch);});
  }
  await app.listen({ host: process.env.QO_HOST || '127.0.0.1', port });
  const ms = Math.round(performance.now() - t0);
  console.log(`Quran Reader ready in ${ms} ms — corpus ${corpus.id}: ${corpus.verses.length} ayahs / ${corpus.data.chapters.length} surahs`);
  if (process.env.QO_DIAGNOSTIC_CAPTURE === '1') console.log('Diagnostic capture ON: recognized text tokens are written to data/captures/*.jsonl (no audio).');
  console.log(`Tracker mode: ${mode}. Soniox: ${process.env.SONIOX_API_KEY ? 'configured' : 'NOT configured (set SONIOX_API_KEY)'}. ${jev.detail}`);
  if (hosted) {
    const c = hosted.credits.cfg;
    const h = (sec: number) => `${+(sec / 3600).toFixed(2)} h`;
    console.log('\nHosted mode: anonymous reader sessions; listening is funded by shared sponsored hours.');
    console.log(`Sponsored listening: ${h(hosted.credits.poolSeconds())} in the pool, up to ${h(c.poolDailySecondsPerVisitor ?? 3600)} per visitor per day; donations ${hosted.billing ? 'on' : 'off'}.`);
    console.log(`Up to ${hosted.maxListeners ?? DEFAULT_MAX_STREAMS} people reciting at once (QO_MAX_LISTENERS). Keep it within your Soniox concurrency limit (10 unless raised in the Soniox Console); beyond it people wait in line. Live streams (an overlay link open in OBS) have no daily limit.`);
    console.log(`Open: ${process.env.QO_PUBLIC_ORIGIN || publicOrigin}${base}/\n`);
  } else console.log(`\nOpen the control page (keep this link private):\n  ${publicOrigin}${base}/control#owner=${ownerToken}\n`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
