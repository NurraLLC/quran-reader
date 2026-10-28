// Listening credits for the hosted service. One credit is one second of live listening, the only
// unit used for listening admission (the provider invoice itself is token-based). Additional
// recorded project costs reduce the same pool through an explicit USD-to-hours conversion.
//
// Hosted audio goes through a server-owned relay. Each provider key has a time reservation and
// a provider-enforced maximum. The relay closes the upstream before settling elapsed time;
// client capture/stop messages never release these reservations. Holds surviving a process crash
// are charged at their maximum once expired. The ledger also understands legacy overlapping holds.
//
// Pools: a monthly free allowance is used first, then purchased time, then sponsored time. Free
// time is further capped per network per day (clearing cookies does not mint new free time) and per
// service per day (the owner's spending ceiling). Purchased time is not subject to those caps.
// Sponsored time is one shared pool that donations fill ("sponsor listening for others"); anyone
// whose own time has run out draws from it, up to a daily amount each, so no one can drain it.
// A live stream (an overlay shows the reciter's session, e.g. a 24-hour charity stream in OBS)
// draws on the pool with no daily amount: `stream` holds.

import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export type CreditConfig = {
  /** Display conversion for operating costs, in USD cents per equivalent listening hour. */
  costCentsPerHour?: number;
  /** Unspent operating buffer protected from listening, in integer USD microdollars. */
  operatingReserveUsdMicros?: number;
  /** Free listening per visitor per calendar month (UTC). */
  freeSecondsPerMonth: number;
  /** Free listening per network (IP) per UTC day, across all visitors on it. */
  ipDailyFreeSeconds: number;
  /** Free listening across the whole service per UTC day (spending ceiling). */
  globalDailyFreeSeconds: number;
  /** Longest single provider key; a longer session simply reconnects with a new hold. */
  holdMaxSeconds: number;
  /** A key shorter than this is not worth minting. */
  holdMinSeconds: number;
  /** Sponsored time one visitor may use per UTC day (default one hour). */
  poolDailySecondsPerVisitor?: number;
  /** Sponsored time one network may use per UTC day, across visitors (clearing cookies is not a new share). */
  poolDailySecondsPerNetwork?: number;
};

export const DEFAULT_CREDITS: CreditConfig = {
  freeSecondsPerMonth: 10 * 3600,
  ipDailyFreeSeconds: 2 * 3600,
  globalDailyFreeSeconds: 200 * 3600,
  holdMaxSeconds: 20 * 60,
  holdMinSeconds: 20,
  poolDailySecondsPerVisitor: 3600,
};

export type Balance = {
  /** Free seconds the visitor could still use now (monthly, network and service caps applied). */
  free: number;
  /** Purchased seconds. */
  paid: number;
  /** Sponsored seconds this visitor may still use today (after their own time). */
  sponsored: number;
  /** Seconds left in the shared sponsored pool. */
  pool: number;
  /** Seconds reserved by open streams. */
  reserved: number;
  /** What a new stream may use. */
  available: number;
  /** Free seconds used this month and the monthly allowance. */
  freeUsedThisMonth: number;
  freePerMonth: number;
  /**
   * Why nothing is available right now, if so: the free allowance's month, network or service
   * cap, the shared pool being empty, or this visitor's (or network's) daily share of it used.
   */
  limitedBy: 'month' | 'network' | 'service' | 'pool' | 'share' | null;
  /** Shared (pool) time this visitor may use per day. */
  sharePerDay: number;
  /** When the monthly allowance renews (ms since epoch). */
  renewsAt: number;
};

export type Hold = { id: string; maxSeconds: number };

const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const monthOf = (ms: number) => new Date(ms).toISOString().slice(0, 7);
const nextMonth = (ms: number) => {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
};

type HoldRow = { id: string; user_id: string; ip: string; minted_at: number; max_seconds: number; stream: number };

export class CreditStore {
  private readonly db: DatabaseSync;

  constructor(
    file: string,
    readonly cfg: CreditConfig = DEFAULT_CREDITS,
  ) {
    const reserve = cfg.operatingReserveUsdMicros ?? 0;
    if (!Number.isSafeInteger(reserve) || reserve < 0 || reserve > 1e12 || !Number.isFinite(cfg.costCentsPerHour ?? 13) || (cfg.costCentsPerHour ?? 13) < 1) throw new Error('Invalid operating reserve or conversion rate');
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, paid_seconds INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS holds (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, ip TEXT NOT NULL,
        minted_at INTEGER NOT NULL, max_seconds INTEGER NOT NULL,
        settled_at INTEGER, free_seconds INTEGER, paid_seconds INTEGER, day TEXT, month TEXT
      );
      CREATE INDEX IF NOT EXISTS holds_open ON holds (user_id) WHERE settled_at IS NULL;
      CREATE INDEX IF NOT EXISTS holds_month ON holds (user_id, month);
      CREATE INDEX IF NOT EXISTS holds_ip_day ON holds (ip, day);
      CREATE INDEX IF NOT EXISTS holds_day ON holds (day);
      CREATE TABLE IF NOT EXISTS grants (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, seconds INTEGER NOT NULL, reason TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS pool (id INTEGER PRIMARY KEY CHECK (id = 1), seconds INTEGER NOT NULL);
      INSERT OR IGNORE INTO pool (id, seconds) VALUES (1, 0);
      CREATE TABLE IF NOT EXISTS pool_gifts (id TEXT PRIMARY KEY, seconds INTEGER NOT NULL, amount_cents INTEGER, currency TEXT, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS pool_costs (id TEXT PRIMARY KEY, category TEXT NOT NULL, usd_micros INTEGER NOT NULL, seconds INTEGER NOT NULL, at INTEGER NOT NULL);
    `);
    // Ledgers from before sponsored time gain the column (existing rows drew nothing from the pool).
    const cols = this.db.prepare('PRAGMA table_info(holds)').all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'pool_seconds')) this.db.exec('ALTER TABLE holds ADD COLUMN pool_seconds INTEGER');
    if (!cols.some((c) => c.name === 'stream')) this.db.exec('ALTER TABLE holds ADD COLUMN stream INTEGER NOT NULL DEFAULT 0');
  }

  private get poolPerVisitorDay() {
    return this.cfg.poolDailySecondsPerVisitor ?? 3600;
  }

  private operatingReserveSeconds(): number {
    return Math.ceil((this.cfg.operatingReserveUsdMicros ?? 0) * 3600 / ((this.cfg.costCentsPerHour ?? 13) * 10_000));
  }

  /** Spendable seconds after protecting the unspent operating buffer. */
  poolSeconds(): number {
    return this.num('SELECT seconds AS n FROM pool WHERE id = 1') - this.operatingReserveSeconds();
  }

  /** Record an additional project expense once. Receipt corrections replace, rather than repeat, it.
   * Recognition already deducted by listening settlement must not be entered here a second time.
   * Private receipt IDs never appear in public totals. Negative balances remain visible.
   */
  recordCost(id: string, category: 'hosting' | 'payment_fees' | 'ai' | 'other', usdMicros: number, now = Date.now()): boolean {
    if (!id.trim() || id.length > 200 || !['hosting', 'payment_fees', 'ai', 'other'].includes(category) || !Number.isSafeInteger(usdMicros) || usdMicros < 0 || usdMicros > 1e12) throw new Error('Invalid project expense');
    const rate = this.cfg.costCentsPerHour ?? 13;
    if (!Number.isFinite(rate) || rate < 1) throw new Error('Invalid hour conversion rate');
    const seconds = Math.ceil(usdMicros * 3600 / (rate * 10_000));
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const old = this.db.prepare('SELECT category, usd_micros, seconds FROM pool_costs WHERE id = ?').get(id) as { category: string; usd_micros: number; seconds: number } | undefined;
      if (old && old.category !== category) throw new Error('Receipt category cannot change');
      const changed = !old || old.usd_micros !== usdMicros;
      if (changed) {
        this.db.prepare('INSERT INTO pool_costs VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET usd_micros=excluded.usd_micros, seconds=excluded.seconds, at=excluded.at').run(id, category, usdMicros, seconds, now);
        this.db.prepare('UPDATE pool SET seconds = seconds - ? WHERE id = 1').run(seconds - (old?.seconds ?? 0));
      }
      this.db.exec('COMMIT');
      return changed;
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }

  /**
   * Sponsored time added to the shared pool (a donation, or the owner). With an `id` (the payment's
   * id) a repeated delivery adds nothing; returns whether time was added.
   */
  grantPool(seconds: number, id: string, amountCents: number | null = null, currency: string | null = null, now = Date.now(), fee?: { id: string; usdMicros: number }): boolean {
    const rate = this.cfg.costCentsPerHour ?? 13;
    if (fee && (!fee.id || !Number.isSafeInteger(fee.usdMicros) || fee.usdMicros < 0 || fee.usdMicros > 1e12 || !Number.isFinite(rate) || rate < 1)) throw new Error('Invalid payment fee');
    this.db.exec('BEGIN');
    try {
      const added = this.db.prepare('INSERT OR IGNORE INTO pool_gifts (id, seconds, amount_cents, currency, at) VALUES (?, ?, ?, ?, ?)').run(id, Math.round(seconds), amountCents, currency, now).changes > 0;
      if (added) this.db.prepare('UPDATE pool SET seconds = seconds + ? WHERE id = 1').run(Math.round(seconds));
      // Funding and its cost become visible together. A retry repairs a fee missing on an older
      // grant without repeating the grant; an operator-imported matching receipt is not doubled.
      if (fee) {
        const old = this.db.prepare('SELECT category, seconds FROM pool_costs WHERE id = ?').get(fee.id) as { category: string; seconds: number } | undefined;
        if (old && old.category !== 'payment_fees') throw new Error('Receipt category cannot change');
        const costSeconds = Math.ceil(fee.usdMicros * 3600 / (rate * 10_000));
        this.db.prepare("INSERT INTO pool_costs VALUES (?, 'payment_fees', ?, ?, ?) ON CONFLICT(id) DO UPDATE SET usd_micros=excluded.usd_micros, seconds=excluded.seconds, at=excluded.at").run(fee.id, fee.usdMicros, costSeconds, now);
        this.db.prepare('UPDATE pool SET seconds = seconds - ? WHERE id = 1').run(costSeconds - (old?.seconds ?? 0));
      }
      this.db.exec('COMMIT');
      return added;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  private sponsoredFor(userId: string, ip: string, day: string, includeReservations = false, stream = false): { seconds: number; by: 'pool' | 'share' | null } {
    // Before admitting another stream, protect other visitors' outstanding keys. Reserving
    // their full maximum is conservative when they also have personal credits, but prevents
    // the same shared second (or network share) from being promised to several people.
    // Our own holds are subtracted once by balance(). Settlement uses actual usage instead.
    const reserved = includeReservations ? this.num('SELECT SUM(max_seconds) AS n FROM holds WHERE settled_at IS NULL AND user_id != ?', userId) : 0;
    const networkReserved = includeReservations ? this.num('SELECT SUM(max_seconds) AS n FROM holds WHERE settled_at IS NULL AND user_id != ? AND ip = ?', userId, ip) : 0;
    const left = Math.max(0, this.poolSeconds() - reserved);
    const usedToday = this.num('SELECT SUM(pool_seconds) AS n FROM holds WHERE user_id = ? AND day = ?', userId, day);
    const ipToday = this.num('SELECT SUM(pool_seconds) AS n FROM holds WHERE ip = ? AND day = ?', ip, day);
    const share = stream ? Infinity : Math.min(this.poolPerVisitorDay - usedToday, (this.cfg.poolDailySecondsPerNetwork ?? Infinity) - ipToday - networkReserved);
    const seconds = Math.max(0, Math.min(left, share));
    return { seconds, by: seconds > 0 ? null : left <= 0 ? 'pool' : 'share' };
  }

  /**
   * Lifetime community totals. No monthly targets, donor identities or leaderboards.
   */
  contributionConfirmed(checkoutId: string): boolean {
    return this.num('SELECT COUNT(*) AS n FROM pool_gifts WHERE id = ?', `stripe:${checkoutId}`) > 0;
  }

  poolStats(now = Date.now()) {
    const costs = this.num('SELECT SUM(seconds) AS n FROM pool_costs');
    return {
      given: this.num('SELECT SUM(seconds) AS n FROM pool_gifts'),
      used: this.num('SELECT SUM(pool_seconds) AS n FROM holds'),
      left: this.poolSeconds(),
      costs,
      operatingReserve: this.operatingReserveSeconds(),
      operatingReserveUsdMicros: this.cfg.operatingReserveUsdMicros ?? 0,
      costUsdMicros: this.num('SELECT SUM(usd_micros) AS n FROM pool_costs'),
      centsPerHour: this.cfg.costCentsPerHour ?? 13,
    };
  }

  close() {
    this.db.close();
  }

  private ensureUser(userId: string, now: number) {
    this.db.prepare('INSERT OR IGNORE INTO users (id, created_at) VALUES (?, ?)').run(userId, now);
  }

  private num(sql: string, ...args: Array<string | number>): number {
    const row = this.db.prepare(sql).get(...args) as { n: number | null } | undefined;
    return Number(row?.n ?? 0);
  }

  private openHolds(userId: string): HoldRow[] {
    return this.db.prepare('SELECT id, user_id, ip, minted_at, max_seconds, stream FROM holds WHERE user_id = ? AND settled_at IS NULL ORDER BY minted_at').all(userId) as HoldRow[];
  }

  /** What `userId` may use now; `stream`: live on stream, so no daily share of the pool applies. */
  balance(userId: string, ip: string, now = Date.now(), stream = false): Balance {
    this.ensureUser(userId, now);
    this.settleExpired(userId, now);
    const month = monthOf(now);
    const day = dayOf(now);
    const usedMonth = this.num('SELECT SUM(free_seconds) AS n FROM holds WHERE user_id = ? AND month = ?', userId, month);
    const usedIpDay = this.num('SELECT SUM(free_seconds) AS n FROM holds WHERE ip = ? AND day = ?', ip, day);
    const usedDay = this.num('SELECT SUM(free_seconds) AS n FROM holds WHERE day = ?', day);
    // Streams other visitors have open count against the shared caps now, not only once settled:
    // otherwise several cookies on one network could run parallel streams past the daily cap.
    const openIpOthers = this.num('SELECT SUM(max_seconds) AS n FROM holds WHERE settled_at IS NULL AND ip = ? AND user_id != ?', ip, userId);
    const openOthers = this.num('SELECT SUM(max_seconds) AS n FROM holds WHERE settled_at IS NULL AND user_id != ?', userId);
    const byMonth = Math.max(0, this.cfg.freeSecondsPerMonth - usedMonth);
    const byIp = Math.max(0, this.cfg.ipDailyFreeSeconds - usedIpDay - openIpOthers);
    const byService = Math.max(0, this.cfg.globalDailyFreeSeconds - usedDay - openOthers);
    const free = Math.min(byMonth, byIp, byService);
    const paid = this.num('SELECT paid_seconds AS n FROM users WHERE id = ?', userId);
    const pool = this.sponsoredFor(userId, ip, day, true, stream);
    const sponsored = pool.seconds;
    // Why nothing is available (reported only then): with a free allowance configured, its cap; else the pool.
    const freeBy = byMonth === 0 ? 'month' : byIp === 0 ? 'network' : 'service';
    const limitedBy = free + paid + sponsored > 0 ? null : this.cfg.freeSecondsPerMonth > 0 && pool.by === 'pool' ? freeBy : pool.by;
    const reserved = this.openHolds(userId).reduce((n, h) => n + h.max_seconds, 0);
    return {
      free,
      paid,
      sponsored,
      pool: this.poolSeconds(),
      reserved,
      available: Math.max(0, free + paid + sponsored - reserved),
      freeUsedThisMonth: usedMonth,
      freePerMonth: this.cfg.freeSecondsPerMonth,
      limitedBy,
      sharePerDay: this.poolPerVisitorDay,
      renewsAt: nextMonth(now),
    };
  }

  /** Reserve time for one provider stream, or say why not. */
  reserve(userId: string, ip: string, now = Date.now(), stream = false): Hold | { error: 'no_credits'; balance: Balance } {
    const b = this.balance(userId, ip, now, stream);
    const maxSeconds = Math.min(this.cfg.holdMaxSeconds, Math.floor(b.available));
    if (maxSeconds < this.cfg.holdMinSeconds) return { error: 'no_credits', balance: b };
    const id = randomBytes(12).toString('base64url');
    this.db.prepare('INSERT INTO holds (id, user_id, ip, minted_at, max_seconds, stream) VALUES (?, ?, ?, ?, ?, ?)').run(id, userId, ip, now, maxSeconds, stream ? 1 : 0);
    return { id, maxSeconds };
  }

  /** An open hold's stream went live (its overlay connected after it started): no daily share applies to it. */
  markStream(holdId: string) {
    this.db.prepare('UPDATE holds SET stream = 1 WHERE id = ? AND settled_at IS NULL').run(holdId);
  }

  /** A hold whose key could not be minted is dropped without charge. */
  release(holdId: string) {
    this.db.prepare('DELETE FROM holds WHERE id = ? AND settled_at IS NULL').run(holdId);
  }

  /** Streams ended (stop, error, page closed): charge the time actually used. Returns seconds charged. */
  settle(userId: string, now = Date.now()): number {
    return this.settleWhere(this.openHolds(userId), now);
  }

  /** Holds past their maximum were cut by the provider; charge them in full. */
  settleExpired(userId: string, now = Date.now()): number {
    const expired = this.openHolds(userId).filter((h) => h.minted_at + h.max_seconds * 1000 <= now);
    return expired.length ? this.settleWhere(expired, now) : 0;
  }

  /** Users with an open hold (for the periodic sweep). */
  usersWithOpenHolds(): string[] {
    return (this.db.prepare('SELECT DISTINCT user_id FROM holds WHERE settled_at IS NULL').all() as Array<{ user_id: string }>).map((r) => r.user_id);
  }

  /** Seconds used so far by the user's open streams, and when the last of them must end. */
  openUsage(userId: string, now = Date.now()): { usedSeconds: number; endsAt: number | null } {
    const holds = this.openHolds(userId);
    return { usedSeconds: union(holds, now), endsAt: holds.length ? Math.max(...holds.map((h) => h.minted_at + h.max_seconds * 1000)) : null };
  }

  /**
   * Purchased or sponsored time. With an `id` (e.g. the payment's id) a repeated delivery of the same
   * payment grants nothing; returns whether time was added.
   */
  grant(userId: string, seconds: number, reason: string, now = Date.now(), id = randomBytes(12).toString('base64url')): boolean {
    this.ensureUser(userId, now);
    this.db.exec('BEGIN');
    try {
      const added = this.db.prepare('INSERT OR IGNORE INTO grants (id, user_id, seconds, reason, at) VALUES (?, ?, ?, ?, ?)').run(id, userId, Math.round(seconds), reason, now).changes > 0;
      if (added) this.db.prepare('UPDATE users SET paid_seconds = paid_seconds + ? WHERE id = ?').run(Math.round(seconds), userId);
      this.db.exec('COMMIT');
      return added;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  private settleWhere(holds: HoldRow[], now: number): number {
    if (!holds.length) return 0;
    const userId = holds[0].user_id;
    const used = Math.ceil(union(holds, now));
    // Free first (within today's caps as they stand), then purchased time.
    const settledIds = new Set(holds.map((h) => h.id));
    const month = monthOf(now);
    const day = dayOf(now);
    const ip = holds[0].ip;
    const usedMonth = this.num('SELECT SUM(free_seconds) AS n FROM holds WHERE user_id = ? AND month = ?', userId, month);
    const usedIpDay = this.num('SELECT SUM(free_seconds) AS n FROM holds WHERE ip = ? AND day = ?', ip, day);
    const usedDay = this.num('SELECT SUM(free_seconds) AS n FROM holds WHERE day = ?', day);
    const freeLeft = Math.max(0, Math.min(this.cfg.freeSecondsPerMonth - usedMonth, this.cfg.ipDailyFreeSeconds - usedIpDay, this.cfg.globalDailyFreeSeconds - usedDay));
    const free = Math.min(used, freeLeft);
    const paidOwed = used - free;
    const paidHave = this.num('SELECT paid_seconds AS n FROM users WHERE id = ?', userId);
    const paid = Math.min(paidOwed, paidHave);
    // Then sponsored time (never below zero: a rare overlap of visitors drawing at once is absorbed).
    const pooled = Math.min(paidOwed - paid, this.sponsoredFor(userId, ip, day, false, holds.some((h) => h.stream)).seconds);
    this.db.exec('BEGIN');
    try {
      const upd = this.db.prepare('UPDATE holds SET settled_at = ?, free_seconds = ?, paid_seconds = ?, pool_seconds = ?, day = ?, month = ? WHERE id = ?');
      // The whole charge is recorded on the first hold; the rest settle at zero (union already counted).
      let first = true;
      for (const id of settledIds) {
        upd.run(now, first ? free : 0, first ? paid : 0, first ? pooled : 0, day, month, id);
        first = false;
      }
      if (paid) this.db.prepare('UPDATE users SET paid_seconds = paid_seconds - ? WHERE id = ?').run(paid, userId);
      if (pooled) this.db.prepare('UPDATE pool SET seconds = seconds - ? WHERE id = 1').run(pooled);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return used;
  }
}

/** Total seconds covered by the holds' intervals [minted, min(now, minted + max)], overlaps once. */
function union(holds: HoldRow[], now: number): number {
  const spans = holds
    .map((h) => [h.minted_at, Math.min(now, h.minted_at + h.max_seconds * 1000)] as const)
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0]);
  let total = 0;
  let cs = -1;
  let ce = -1;
  for (const [a, b] of spans) {
    if (a > ce) {
      if (ce > cs) total += ce - cs;
      cs = a;
      ce = b;
    } else ce = Math.max(ce, b);
  }
  if (ce > cs) total += ce - cs;
  return total / 1000;
}
