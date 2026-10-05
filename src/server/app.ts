// HTTP + WebSocket server with owner and read-only viewer capabilities.
//
// Two modes. Local (default, self-hosted): one session, owned by whoever opens the printed link.
// Hosted: every visitor gets their own session through a signed anonymous cookie, and listening is
// metered against shared hours (billing/credits.ts). The server-owned audio relay reserves time,
// keeps provider keys private, and closes the provider stream before settling usage.
//
// Owner: a random capability printed by the launcher (/control#owner=…) is exchanged for an
// HttpOnly SameSite=Strict cookie. Only the owner can mint provider keys, change position or see
// transcripts. Viewer: a separate revocable token in /overlay#view=…, sent in the first WS frame
// (never in a URL the server logs). Exact Host/Origin checks; no wildcard CORS.

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { isIPv6 } from 'node:net';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import {
  ControlClientMessageSchema,
  OverlayClientMessageSchema,
  type ControlServerMessage,
  type OverlayServerMessage,
} from '../shared/contracts';
import { PROCESSED_FONT_DIR, ROOT } from './corpus/manifest';
import { mintTemporaryKey, SonioxKeyError } from './providers/soniox';
import type { Session } from './sessions';
import type { CreditStore } from './billing/credits';
import type { SessionHub } from './billing/hub';
import type { VisitorIdentity } from './billing/identity';
import type { StripeBilling } from './billing/stripe';
import type { CreditView } from '../shared/contracts';
import { HostedSpeech } from './providers/hosted-speech';
import { ListeningSafety } from './billing/listening-safety';

export type HostedOptions = {
  hub: SessionHub;
  credits: CreditStore;
  identity: VisitorIdentity;
  /** Public origin behind the reverse proxy, e.g. https://quran.example (adds its host/origin). */
  publicOrigin?: string;
  /** Take the client address from X-Forwarded-For (only behind a trusted proxy). */
  trustProxy?: boolean;
  /** Buying listening time (off unless Stripe keys are configured). */
  billing?: StripeBilling | null;
  safety?: ListeningSafety;
  isRecitation?: (text: string) => boolean;
  /** Reading needs no visitor cookie (surah text, translation, word meanings are for anyone). */
  reading?: Session;
  /** People reciting at once (QO_MAX_LISTENERS); keep it within the recogniser's own concurrency limit. */
  maxListeners?: number;
  /** Streams the server's processor carries at once, own-key streams included (QO_MAX_RECITERS). */
  maxReciters?: number;
};

export type AppOptions = {
  /**
   * Serve under a path of another site (e.g. "/quran-reader" on nurra.org). Requests with or
   * without the prefix both work (a proxy may strip it or not); every address the browser is given
   * carries it.
   */
  basePath?: string;
  /** Extra Host names to accept, e.g. the origin name a proxy in front forwards to ("reader-origin.nurra.org"). */
  extraHosts?: string[];
  /** Local mode: the one session. Not used when `hosted` is set. */
  session?: Session;
  hosted?: HostedOptions;
  port: number;
  host?: string;
  sonioxApiKey?: string;
  devOrigins?: string[];
  ownerToken?: string;
  fetchImpl?: typeof fetch;
  /** Server-owned local test provider; never set from a browser request. */
  speechEndpoint?: string;
  speechIdleMs?: number;
  /** How long a closed stream keeps its place in the waiting line (shortened in tests). */
  speechHoldMs?: number;
};

const COOKIE = 'qo_owner';

function formatPrice(cents: number, currency: string) {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency: currency.toUpperCase() }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
}
const VISITOR_COOKIE = 'qo_visitor';
const WEB_DIST = path.join(ROOT, 'dist', 'web');

function safeEqual(a: string, b: string) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function readCookie(req: FastifyRequest, name: string): string | null {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) { try { return decodeURIComponent(v.join('=')); } catch { return null; } }
  }
  return null;
}

class RateLimit {
  private hits: number[] = [];
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}
  take(now = Date.now()) {
    this.hits = this.hits.filter((t) => now - t < this.windowMs);
    if (this.hits.length >= this.max) return false;
    this.hits.push(now);
    return true;
  }
}

/** A visitor's pages share one session; more open pages than a person uses are refused. */
const MAX_CONTROL_SOCKETS = 8;
/** A page that stops reading (a stalled tab, a dead link) is let go rather than queued for without end. */
const MAX_BUFFERED = 1024 * 1024;
/** Per page: far above any real page (recogniser results arrive a few times a second, each a few KB). */
const CONTROL_MESSAGES_PER_S = 60;
const CONTROL_BYTES_PER_MS = 64;
const CONTROL_BYTES_BURST = 512 * 1024;

/** IPv4 as is (also IPv4-mapped); IPv6 by its /64, which one household or phone controls entirely. */
export function networkOf(ip: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return mapped[1];
  const addr = ip.split('%')[0].toLowerCase();
  if (!isIPv6(addr)) return ip;
  const [head, tail] = addr.split('::');
  const a = head ? head.split(':') : [];
  const b = tail ? tail.split(':') : [];
  const groups = tail === undefined ? a : [...a, ...Array(Math.max(0, 8 - a.length - b.length)).fill('0'), ...b];
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

/** One limit per key (visitor or network) instead of one for the whole server. */
class KeyedRateLimit {
  private readonly limits = new Map<string, RateLimit>();
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}
  take(key: string, now = Date.now()) {
    if (this.limits.size > 50_000) this.limits.clear(); // bounded memory; a reset only relaxes limits
    let l = this.limits.get(key);
    if (!l) this.limits.set(key, (l = new RateLimit(this.max, this.windowMs)));
    return l.take(now);
  }
}

export async function buildApp(o: AppOptions): Promise<{ app: FastifyInstance; ownerToken: string }> {
  if (!o.session && !o.hosted) throw new Error('buildApp needs a session (local mode) or hosted options');
  const local = o.session as Session;
  const ownerToken = o.ownerToken ?? randomBytes(24).toString('base64url');
  const ownerCookie = randomBytes(24).toString('base64url');
  const host = o.host ?? '127.0.0.1';
  const base = normalizeBase(o.basePath);
  const allowedHosts = new Set([`127.0.0.1:${o.port}`, `localhost:${o.port}`, `[::1]:${o.port}`]);
  const allowedOrigins = new Set([...allowedHosts].map((h) => `http://${h}`));
  for (const d of [...(o.devOrigins ?? []), ...(o.hosted?.publicOrigin ? [o.hosted.publicOrigin] : [])]) {
    allowedOrigins.add(d);
    allowedHosts.add(new URL(d).host);
  }
  for (const h of o.extraHosts ?? []) if (h.trim()) allowedHosts.add(h.trim().toLowerCase());
  const hosted = o.hosted ?? null;
  const secureCookie = !!hosted?.publicOrigin?.startsWith('https:');
  // Scoped to the app's own path: under nurra.org/quran-reader it is never sent to the rest of the site.
  const visitorCookie = (value: string) => `${VISITOR_COOKIE}=${value}; HttpOnly; SameSite=Lax; Path=${base || '/'}; Max-Age=31536000${secureCookie ? '; Secure' : ''}`;
  // Local: one owner. Hosted: per visitor, so one busy minute for others never refuses anyone's mic.
  const keyLimit = new RateLimit(10, 60_000);
  const visitorKeyLimit = new KeyedRateLimit(10, 60_000);
  const networkSpeechLimit = new KeyedRateLimit(90, 60_000);
  // New anonymous identities per network: stops a script from flooding the server with sessions.
  // A mosque's Wi-Fi or a carrier's shared address serves many phones (30 an hour turned the 31st away).
  const identityLimit = new KeyedRateLimit(200, 60 * 60_000);
  // Overlay connections per network (OBS reconnects are few; a flood of unauthenticated sockets is not).
  const overlayLimit = new KeyedRateLimit(60, 60_000);
  const controlSockets = new Map<string, number>();
  const checkoutLimit = new KeyedRateLimit(10, 10 * 60_000);
  const exchangeLimit = new RateLimit(20, 60_000);

  // Request logging stays off: URLs could carry capabilities in misconfigured clients.
  const app = Fastify({
    logger: false,
    bodyLimit: 16_384,
    rewriteUrl: base ? (req) => stripBase(req.url ?? '/', base) : undefined,
  });
  await app.register(fastifyWebsocket, { options: { maxPayload: 256 * 1024 } });

  // JSON bodies keep their exact text: the payment webhook's signature covers the raw bytes.
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    (req as FastifyRequest & { rawBody?: string }).rawBody = body as string;
    try {
      done(null, (body as string).length ? JSON.parse(body as string) : {});
    } catch (e) {
      (e as { statusCode?: number }).statusCode = 400;
      done(e as Error, undefined);
    }
  });

  let proxyWarned = false;
  app.addHook('onRequest', async (req, reply) => {
    if (!req.headers.host || !allowedHosts.has(req.headers.host)) return reply.code(421).send({ error: 'unexpected host' });
    if (o.hosted && !o.hosted.trustProxy && req.headers['x-forwarded-for'] && !proxyWarned) {
      proxyWarned = true;
      console.warn('Requests arrive through a proxy (X-Forwarded-For) but QO_TRUST_PROXY is not set: every visitor shares the proxy\'s address, so per-network limits apply to everyone at once. Set QO_TRUST_PROXY=1.');
    }
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Cache-Control', 'no-store');
  });

  const originOk = (req: FastifyRequest) => {
    const origin = req.headers.origin;
    return !!origin && allowedOrigins.has(origin);
  };
  const isOwner = (req: FastifyRequest) => {
    const c = readCookie(req, COOKIE);
    return !!c && safeEqual(c, ownerCookie);
  };
  /** Hosted: the visitor id from the signed cookie. */
  const visitor = (req: FastifyRequest) => (hosted ? hosted.identity.verify(readCookie(req, VISITOR_COOKIE)) : null);
  /** The session this request controls, if any (local: the owner's; hosted: the visitor's own). */
  const sessionFor = (req: FastifyRequest): Session | null => {
    if (!hosted) return isOwner(req) ? local : null;
    const id = visitor(req);
    return id ? hosted.hub.get(id) : null;
  };
  /** The visitor's network (see networkOf): per-network limits and tickets are keyed by it. */
  const clientIp = (req: FastifyRequest) => {
    const fwd = hosted?.trustProxy ? String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() : '';
    return networkOf(fwd || req.ip || 'unknown');
  };
  const creditView = (id: string, ip: string): CreditView => {
    const c = hosted!.credits;
    const b = c.balance(id, ip);
    return { available: b.available + b.reserved - c.openUsage(id).usedSeconds, free: b.free, paid: b.paid, sponsored: b.sponsored, pool: b.pool, freeUsedThisMonth: b.freeUsedThisMonth, freePerMonth: b.freePerMonth, freePerDay: c.cfg.ipDailyFreeSeconds, sharePerDay: b.sharePerDay, limitedBy: b.limitedBy, renewsAt: b.renewsAt, listeningSeconds: c.openUsage(id).usedSeconds };
  };
  /** Last known address per visitor (for pushing balances from the periodic sweep). */
  const lastIp = new Map<string, string>();
  const pushCredits = (id: string) => {
    const s = hosted?.hub.peek(id);
    if (s) s.notify({ type: 'credits', credits: creditView(id, lastIp.get(id) ?? 'unknown') });
  };
  const safety = hosted ? hosted.safety ?? new ListeningSafety(':memory:') : null;
  // New listening waits while the server cannot keep up (its event loop delayed): everyone already
  // reciting or reading stays responsive instead of all slowing together.
  let overloaded = false;
  const loopDelay = hosted ? monitorEventLoopDelay({ resolution: 20 }) : null;
  if (loopDelay) {
    loopDelay.enable();
    const watch = setInterval(() => {
      overloaded = loopDelay.percentile(99) > 250e6;
      loopDelay.reset();
    }, 5000);
    watch.unref?.();
    app.addHook('onClose', async () => {
      clearInterval(watch);
      loopDelay.disable();
    });
  }
  const speech = hosted ? new HostedSpeech({ credits: hosted.credits, safety: safety!, apiKey: o.sonioxApiKey, fetchImpl: o.fetchImpl,
    isRecitation: hosted.isRecitation ?? (() => false), onSettled: pushCredits, endpoint: o.speechEndpoint, idleLimitMs: o.speechIdleMs, holdMs: o.speechHoldMs,
    maxStreams: hosted.maxListeners, maxReciters: hosted.maxReciters, busy: () => overloaded,
    // The waiting line: a free place is announced on the visitor's pages, and a page still open keeps its place.
    onTurn: (id) => hosted.hub.peek(id)?.notify({ type: 'listen_turn' }), present: (id) => controlSockets.has(id),
    // Live on stream (the visitor's overlay is open in OBS or on a reading screen): no daily limit or idle stop.
    live: (id) => hosted.hub.peek(id)?.live ?? false, listeningOn: (id) => hosted.hub.peek(id)?.listeningOn ?? false }) : null;
  app.addHook('preClose', async () => speech?.close());
  app.addHook('onClose', async () => safety?.close());
  const requireOwner = (req: FastifyRequest, reply: FastifyReply) => {
    if (!originOk(req)) {
      reply.code(403).send({ error: 'origin' });
      return false;
    }
    if (!sessionFor(req)) {
      reply.code(401).send({ error: 'owner' });
      return false;
    }
    return true;
  };

  // Liveness for a process manager or load balancer (no data).
  app.get('/healthz', async () => ({ ok: true }));

  // Who am I: local mode reports ownership; hosted mode issues the visitor cookie on first visit.
  app.get('/api/me', async (req, reply) => {
    if (!hosted) return { mode: 'local', owner: isOwner(req) };
    let id = visitor(req);
    if (!id) {
      if (!identityLimit.take(clientIp(req))) return reply.code(429).send({ error: 'Too many new visitors from this network. Please try again later.' });
      const v = hosted.identity.issue();
      id = v.id;
      reply.header('Set-Cookie', visitorCookie(v.cookie));
    } else if (base) {
      // Cookies issued before the path was scoped went to all of the parent site (Path=/). The same
      // identity moves under the app's path and the site-wide copy is expired, so a returning
      // visitor keeps their place and listening share while the rest of the site stops receiving it.
      reply.header('Set-Cookie', [visitorCookie(readCookie(req, VISITOR_COOKIE)!), `${VISITOR_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secureCookie ? '; Secure' : ''}`]);
    }
    lastIp.set(id, clientIp(req));
    return {
      mode: 'hosted',
      owner: true,
      credits: creditView(id, clientIp(req)),
      // Sponsored listening so far (totals only; nothing about who gave or who recited).
      sponsored: hosted.credits.poolStats(),
      billing: hosted.billing
        ? {
            testMode: hosted.billing.testMode,
            donations: hosted.billing.donations.amountsCents.map((c) => ({ amountCents: c, price: formatPrice(c, hosted.billing!.donations.currency), hours: hosted.billing!.sponsoredHours(c) })),
          }
        : null,
    };
  });

  // The shared pool's live story (the community bar polls it). Totals only.
  app.get('/api/pool', async (_req, reply) => {
    if (!hosted) return reply.code(404).send({ error: 'not available' });
    return hosted.credits.poolStats();
  });

  // Sponsor listening for others: a Stripe-hosted checkout for a donation to the shared pool.
  app.post('/api/billing/donate', async (req, reply) => {
    if (!hosted?.billing) return reply.code(404).send({ error: 'not available' });
    if (!originOk(req)) return reply.code(403).send({ error: 'origin' });
    const id = visitor(req);
    if (!id) return reply.code(401).send({ error: 'visitor' });
    if (!checkoutLimit.take(id)) return reply.code(429).send({ error: 'Please wait a moment before trying again.' });
    const amount = Number((req.body as { amountCents?: unknown } | undefined)?.amountCents);
    if (!hosted.billing.donations.amountsCents.includes(amount)) return reply.code(400).send({ error: 'unknown amount' });
    try {
      return { url: await hosted.billing.checkoutDonation(id, amount, `${hosted.publicOrigin ?? `http://${req.headers.host}`}${base}`) };
    } catch {
      return reply.code(502).send({ error: 'The payment page could not be opened. Please try again.' });
    }
  });

  // Stripe's signed notification that a gift succeeded: fill the community pool once.
  app.post('/api/billing/webhook', { bodyLimit: 1_048_576 }, async (req, reply) => {
    if (!hosted?.billing) return reply.code(404).send({ error: 'not available' });
    const raw = (req as FastifyRequest & { rawBody?: string }).rawBody ?? '';
    const event = hosted.billing.verify(raw, req.headers['stripe-signature'] as string | undefined);
    if (!event) return reply.code(400).send({ error: 'signature' });
    const g = hosted.billing.gift(event);
    if (g) {
      try {
        const fee = await hosted.billing.feeFor(g);
        hosted.credits.grantPool(g.seconds, `stripe:${g.paymentId}`, g.amountCents, g.currency, Date.now(), fee);
      } catch {
        // Stripe retries: never silently credit gross funds when their fee is still unknown.
        return reply.code(503).send({ error: 'Payment accounting pending; retry delivery.' });
      }
    }
    return { received: true };
  });

  app.post('/api/owner/session', async (req, reply) => {
    if (hosted) return reply.code(404).send({ error: 'not available' });
    if (!originOk(req)) return reply.code(403).send({ error: 'origin' });
    const token = (req.body as { token?: unknown } | undefined)?.token;
    if (typeof token !== 'string' || !safeEqual(token, ownerToken)) {
      if (!exchangeLimit.take()) return reply.code(429).send({ error: 'rate' });
      return reply.code(401).send({ error: 'invalid owner link' });
    }
    // A proven owner can reopen reader/control pages; failed guesses cannot lock them out.
    reply.header('Set-Cookie', `${COOKIE}=${ownerCookie}; HttpOnly; SameSite=Strict; Path=${base || '/'}`);
    return { ok: true };
  });

  app.get('/api/owner/status', async (req) => ({ owner: !!sessionFor(req) }));

  app.post('/api/soniox/temporary-key', async (req, reply) => {
    if (!requireOwner(req, reply)) return;
    if (hosted ? !visitorKeyLimit.take(visitor(req)!) : !keyLimit.take()) return reply.code(429).send({ error: 'RATE_LIMITED' });
    if (!hosted) {
      try {
        const key = await mintTemporaryKey(o.sonioxApiKey, `quran-overlay:${local.sessionEpoch}`, o.fetchImpl);
        return key;
      } catch (e) {
        const code = e instanceof SonioxKeyError ? e.code : 'REQUEST_REJECTED';
        return reply.code(code === 'NOT_CONFIGURED' ? 503 : 502).send({ error: code });
      }
    }
    // Hosted clients get a single-use ticket for our relay, never a provider credential.
    const id = visitor(req)!;
    const ip = clientIp(req);
    lastIp.set(id, ip);
    // A reciter's own Soniox key (optional): given with each request, used once for that stream, never stored or logged.
    const own = (req.body as { ownKey?: unknown } | undefined)?.ownKey;
    if (own !== undefined && own !== null && (typeof own !== 'string' || !/^[A-Za-z0-9._~+/=-]{16,256}$/.test(own))) return reply.code(400).send({ error: 'OWN_KEY_INVALID' });
    const ticket = speech!.issue(id, ip, own || undefined);
    if ('error' in ticket) {
      if ('retryAfter' in ticket && ticket.retryAfter) reply.header('Retry-After', ticket.retryAfter);
      return reply.code(ticket.error === 'NO_CREDITS' ? 402 : ticket.error === 'NOT_CONFIGURED' ? 503 : 429).send(ticket);
    }
    const origin = hosted.publicOrigin ?? `http://${req.headers.host}`;
    return { ...ticket, stt_ws_url: `${origin.replace(/^http/, 'ws')}${base}/ws/speech` };
  });

  app.get('/ws/speech', { websocket: true }, (socket, req) => {
    const id = visitor(req);
    if (!speech || !id || !originOk(req)) { socket.close(4401, 'visitor required'); return; }
    const ip = clientIp(req);
    if (!networkSpeechLimit.take(ip)) { socket.close(4429, 'Please try again shortly'); return; }
    speech.accept(socket, id, ip);
  });

  // Reading: hosted visitors need no cookie (a network that reached its new-visitor limit can still
  // read); the browser may keep a surah for an hour.
  const readerFor = (req: FastifyRequest): Session | null => (hosted?.reading && !visitor(req) ? hosted.reading : sessionFor(req));
  app.get('/api/chapters', async (req, reply) => {
    const s = readerFor(req);
    if (!s) return reply.code(401).send({ error: 'owner' });
    reply.header('Cache-Control', 'private, max-age=3600');
    return s.chapters();
  });

  app.get('/api/verse/:key', async (req, reply) => {
    const session = readerFor(req);
    if (!session) return reply.code(401).send({ error: 'owner' });
    const card = session.card((req.params as { key: string }).key);
    if (card) reply.header('Cache-Control', 'private, max-age=3600');
    return card ?? reply.code(404).send({ error: 'not found' });
  });

  app.get('/api/surah/:n', async (req, reply) => {
    const session = readerFor(req);
    if (!session) return reply.code(401).send({ error: 'owner' });
    const s = session.surah(Number((req.params as { n: string }).n));
    if (s) reply.header('Cache-Control', 'private, max-age=3600');
    return s ?? reply.code(404).send({ error: 'not found' });
  });

  app.get('/fonts/:file', async (req, reply) => {
    const file = (req.params as { file: string }).file;
    if (!/^[A-Za-z0-9_.-]+\.(ttf|otf|woff2?)$/.test(file)) return reply.code(404).send();
    const full = path.join(PROCESSED_FONT_DIR, file);
    if (!existsSync(full)) return reply.code(404).send();
    reply.header('Cache-Control', 'public, max-age=86400');
    return reply.type('font/ttf').send(readFileSync(full));
  });

  // ---------- control WebSocket ----------
  app.get('/ws/control', { websocket: true }, (socket, req) => {
    const found = originOk(req) ? sessionFor(req) : null;
    if (!found) {
      socket.close(4401, 'owner required');
      return;
    }
    const s = found;
    const visitorId = visitor(req);
    if (visitorId && (controlSockets.get(visitorId) ?? 0) >= MAX_CONTROL_SOCKETS) {
      socket.close(4429, 'Too many open pages');
      return;
    }
    if (visitorId) {
      controlSockets.set(visitorId, (controlSockets.get(visitorId) ?? 0) + 1);
      lastIp.set(visitorId, clientIp(req));
    }
    const send = (m: ControlServerMessage) => {
      if (socket.readyState !== socket.OPEN) return;
      if (socket.bufferedAmount > MAX_BUFFERED) return socket.terminate();
      socket.send(JSON.stringify(m));
    };
    const off = s.onControl(send);
    s.controlConnected();
    send({ type: 'snapshot', snapshot: s.snapshot() });
    send({ type: 'stream', state: s.stream });
    if (visitorId) send({ type: 'credits', credits: creditView(visitorId, clientIp(req)) });
    // Every message runs the tracker on one shared process: a page past these budgets is closed (it
    // reconnects); requests that may ask for paid decisions are limited per page.
    const messages = new RateLimit(CONTROL_MESSAGES_PER_S, 1000);
    const commands = new RateLimit(4, 10_000);
    let bytes = 0;
    let bytesAt = Date.now();
    socket.on('message', (raw) => {
      const data = raw.toString();
      const now = Date.now();
      bytes = Math.max(0, bytes - (now - bytesAt) * CONTROL_BYTES_PER_MS) + data.length;
      bytesAt = now;
      if (!messages.take(now) || bytes > CONTROL_BYTES_BURST) return socket.close(1008, 'Too many messages');
      let parsed;
      try {
        parsed = ControlClientMessageSchema.safeParse(JSON.parse(data));
      } catch {
        return;
      }
      if (!parsed.success) return;
      const m = parsed.data;
      // The tracker mode is the owner's setting: it decides which decisions are paid for.
      if (hosted && m.type === 'mode') return;
      // Recogniser results come from the visitor's own stream through the relay: none without one.
      if (hosted && (m.type === 'transcript' || m.type === 'voice') && !(visitorId && speech?.streaming(visitorId))) return;
      if (m.type === 'command' && !commands.take(now)) {
        send({ type: 'command_result', requestId: m.requestId, result: { kind: 'no_match', message: 'That was a lot of requests at once. Please wait a moment and ask again.' } });
        return;
      }
      try {
        s.handle(m);
      } catch (e) {
        // One bad message never takes the server (and everyone's listening) down.
        console.error('Control message failed:', e instanceof Error ? e.message : e);
      }
      // Client capture messages control the display only. The audio relay owns settlement. A page
      // that stops listening leaves the waiting line at once, so the next person is not held up.
      if (visitorId && m.type === 'capture' && (m.event === 'stopped' || m.event === 'error')) speech?.leave(visitorId);
    });
    socket.on('close', () => {
      off();
      s.controlDisconnected();
      if (visitorId) {
        const n = (controlSockets.get(visitorId) ?? 1) - 1;
        if (n > 0) controlSockets.set(visitorId, n);
        else controlSockets.delete(visitorId);
      }
      // The audio connection closes independently; never refund hours on an untrusted signal.
    });
  });

  // ---------- overlay WebSocket (read-only) ----------
  app.get('/ws/overlay', { websocket: true }, (socket, req) => {
    if (!originOk(req)) {
      socket.close(4403, 'origin');
      return;
    }
    if (hosted && !overlayLimit.take(clientIp(req))) {
      socket.close(4429, 'Please try again shortly');
      return;
    }
    let s: Session = local;
    let off: (() => void) | null = null;
    let offRevoke: (() => void) | null = null;
    let role: 'overlay' | 'preview' = 'overlay';
    const send = (m: OverlayServerMessage) => {
      if (socket.readyState !== socket.OPEN) return;
      if (socket.bufferedAmount > MAX_BUFFERED) return socket.terminate();
      socket.send(JSON.stringify(m));
    };
    const authTimer = setTimeout(() => socket.close(4401, 'auth timeout'), 5000);
    socket.on('message', (raw) => {
      let parsed;
      try {
        parsed = OverlayClientMessageSchema.safeParse(JSON.parse(raw.toString()));
      } catch {
        return;
      }
      if (!parsed.success) return;
      const m = parsed.data;
      if (m.type === 'hello') {
        if (off) return;
        clearTimeout(authTimer);
        // The owner's own preview may subscribe with its cookie instead of the view token.
        const target = m.role === 'preview' ? sessionFor(req) : hosted ? hosted.hub.byView(m.view) : local.checkView(m.view) ? local : null;
        if (!target) {
          send({ type: 'denied', reason: 'invalid_view' });
          socket.close(4401, 'invalid view');
          return;
        }
        s = target;
        role = m.role;
        if (role === 'overlay') {
          s.overlayClients++;
          s.overlayChanged();
        }
        const offDisplay = s.onDisplay((state) => send({ type: 'display', state }));
        // The charity stream scene (/stream) also shows the partner, the project and the donations.
        const offStream = s.onStream((state) => send({ type: 'stream', state }));
        off = () => {
          offDisplay();
          offStream();
        };
        const revoke = () => {
          if (role !== 'overlay') return;
          send({ type: 'denied', reason: 'revoked' });
          socket.close(4401, 'revoked');
        };
        s.revokeListeners.add(revoke);
        // The session was dropped: the overlay reconnects, and its saved link finds the visitor's new one.
        const ended = () => socket.close(4410, 'session ended');
        s.endListeners.add(ended);
        offRevoke = () => {
          s.revokeListeners.delete(revoke);
          s.endListeners.delete(ended);
        };
        // Full latest state immediately on (re)connect.
        send({ type: 'display', state: s.display });
        send({ type: 'stream', state: s.stream });
      } else if (m.type === 'painted' && off && role === 'overlay') {
        s.painted(m.revision);
      }
    });
    socket.on('close', () => {
      clearTimeout(authTimer);
      if (off) {
        off();
        if (role === 'overlay') {
          s.overlayClients = Math.max(0, s.overlayClients - 1);
          s.overlayChanged();
        }
      }
      offRevoke?.();
    });
  });

  // ---------- web app ----------
  if (existsSync(WEB_DIST)) {
    await app.register(fastifyStatic, { root: WEB_DIST, prefix: '/', index: false, wildcard: true });
    // Link previews need an absolute image address: the public origin, when there is one.
    const origin = hosted?.publicOrigin?.replace(/\/+$/, '');
    const indexHtml = (route: string) => {
      let html = readFileSync(path.join(WEB_DIST, 'index.html'), 'utf8');
      // What this page is, for search and answer engines and link previews (the app itself renders
      // in the browser): its title, description, canonical address and a short static summary.
      const page = pageMeta(route);
      html = html.replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(page.title)}</title>`);
      if (page.description) html = html.replace(/<meta name="description" content="[^"]*"/, `<meta name="description" content="${escapeHtml(page.description)}"`);
      if (page.description && route !== '/' && route !== '/reader') {
        html = html
          .replace(/<meta property="og:title" content="[^"]*"/, `<meta property="og:title" content="${escapeHtml(page.title)}"`)
          .replace(/<meta property="og:description" content="[^"]*"/, `<meta property="og:description" content="${escapeHtml(page.description)}"`);
      }
      const extra = [page.robots ? `<meta name="robots" content="${page.robots}" />` : '', origin && page.canonical !== undefined ? `<link rel="canonical" href="${origin}${base}${page.canonical}" />` : ''].filter(Boolean);
      if (extra.length) html = html.replace('</head>', `  ${extra.join('\n    ')}\n  </head>`);
      // Root-relative links: anchored under the base path with every other address below.
      html = html.replace(/<!-- qo:summary[^>]*-->/, page.summary ? `<noscript>${page.summary}</noscript>` : '');
      if (origin) {
        html = html
          .replace(/content="\.?\/og\.png"/, `content="${origin}${base}/og.png"`)
          .replace('<meta property="og:type"', `<meta property="og:url" content="${origin}${base}${page.canonical ?? '/'}" /><meta property="og:type"`);
      }
      // Every page, script, font and icon address under the base path; the page learns it too.
      return html
        .replace(/(href|src|content)="\.?\//g, (_m, attr: string) => `${attr}="${base}/`)
        .replace(/url\((['"]?)\/fonts\//g, (_m, q: string) => `url(${q}${base}/fonts/`)
        .replace('<head>', `<head>\n    <meta name="qo-base" content="${base}" />`);
    };
    for (const route of ['/control', '/overlay', '/read', '/stream', '/reader', '/about']) app.get(route, (_req, reply) => reply.type('text/html').send(indexHtml(route)));
    app.get('/', (_req, reply) => (hosted ? reply.type('text/html').send(indexHtml('/')) : reply.redirect(`${base}/control`)));
    // The installable app's manifest, with its start page and icons under the base path.
    app.get('/manifest.webmanifest', (_req, reply) =>
      reply.type('application/manifest+json').send(readFileSync(path.join(WEB_DIST, 'manifest.webmanifest'), 'utf8').replace(/": "\//g, `": "${base}/`)),
    );
  } else {
    app.get('/', (_req, reply) => reply.type('text/plain').send('Frontend not built. Run `npm run build`, or use `npm run dev`.'));
  }

  if (hosted) {
    // Expired holds (streams the provider has cut) are charged; idle sessions are released.
    const sweep = setInterval(() => {
      for (const id of hosted.credits.usersWithOpenHolds()) {
        if (hosted.credits.settleExpired(id) > 0) pushCredits(id);
        else if (hosted.hub.peek(id)?.listening) pushCredits(id);
      }
      hosted.hub.sweep();
    }, 10_000);
    sweep.unref?.();
    app.addHook('onClose', async () => clearInterval(sweep));
  }

  return { app, ownerToken };
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Each route as search and answer engines, link previews and readers without JavaScript see it.
 * `canonical` is the path on the public site (start page and /reader are the same page); stream
 * outputs (overlay, reading screen, charity scene) are not pages to find, so they stay out of search.
 * Summary links are root-relative: they are anchored under the base path like every other address.
 */
export function pageMeta(route: string): { title: string; description?: string; canonical?: string; robots?: string; summary?: string } {
  const links = (...l: Array<[string, string]>) => `<p>${l.map(([href, text]) => `<a href="${href}">${text}</a>`).join(' · ')}</p>`;
  const needsApp = 'The reader needs JavaScript to run.';
  switch (route) {
    case '/':
    case '/reader':
      return {
        title: 'Quran Reader: recite, and the page follows along',
        canonical: '/',
        summary: `<h1>Recite, and the page follows along.</h1><p>Quran Reader shows the ayah you are reciting, each word lit up with its meaning, in Arabic and English, on your phone or as an OBS overlay on your stream. Reading never needs the microphone. ${needsApp}</p>${links(['/about', 'Why we built this'], ['/control', 'Stream controls'], ['/privacy.html', 'Privacy'], ['/terms.html', 'Terms'])}`,
      };
    case '/control':
      return {
        title: 'Stream controls · Quran Reader',
        description: 'Show the ayah you are reciting on your stream with OBS: an overlay that follows your recitation, with the English translation and the meaning of each word.',
        canonical: '/control',
        summary: `<h1>Stream controls</h1><p>Copy the overlay link into an OBS Browser source, then recite or type a reference: the overlay shows the ayah, its translation and the meaning of each word. ${needsApp}</p>${links(['/', 'Quran Reader'], ['/about', 'Why we built this'], ['/privacy.html', 'Privacy'])}`,
      };
    case '/about':
      return {
        title: 'Why we built this · Quran Reader',
        description: 'What Quran Reader does, where its Quran text, translation and font come from, what listening costs, and how community support keeps it free.',
        canonical: '/about',
        summary: `<h1>Why we built this</h1><p>Quran Reader listens as you recite and keeps your place, with the meaning of each word, on your phone or on your stream. It is free, made by Nurra, and never generates scripture or translations.</p><p>Arabic text, word meanings and transliteration: Quran.com (Quran Foundation). English translation: Saheeh International. Arabic font: KFGQPC HAFS Uthmanic Script, King Fahd Glorious Quran Printing Complex.</p>${links(['/', 'Open the reader'], ['/privacy.html', 'Privacy'], ['/terms.html', 'Terms'])}`,
      };
    default:
      return { title: 'Quran Reader · stream output', robots: 'noindex' };
  }
}

/** "/quran-reader" from "quran-reader/", "/quran-reader" or "" (no base). */
export function normalizeBase(p: string | undefined): string {
  const t = (p ?? '').trim().replace(/^\/*/, '/').replace(/\/+$/, '');
  return t === '/' ? '' : t;
}

/** The app's own path for a request that may or may not carry the base prefix. */
export function stripBase(url: string, base: string): string {
  if (!base) return url;
  if (url === base) return '/';
  if (url.startsWith(`${base}/`) || url.startsWith(`${base}?`) || url.startsWith(`${base}#`)) {
    const rest = url.slice(base.length);
    return rest.startsWith('/') ? rest : `/${rest}`;
  }
  return url;
}
