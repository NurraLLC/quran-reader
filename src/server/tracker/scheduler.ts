// Single-flight decision scheduler: at most one request in flight per session, one replaceable
// newest pending snapshot, coalescing window, minimum call interval, hard deadline, negative cache
// for failures and a cooldown after rate limiting. Never a backlog, never a tight retry loop.
// Ported from Moard harbor/actions/contextual_ranking.py (see docs/REUSE_NOTES.md).
//
// Cancellation is not proof remote work stopped: completion is always re-checked by `isCurrent`
// against the binding, and late results after the deadline are dropped.

export type Clock = {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

export const realClock: Clock = {
  now: () => performance.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export type SchedulerConfig = {
  coalesceMs: number;
  minIntervalMs: number;
  deadlineMs: number;
  failureTtlMs: number;
};

export const RECITATION_SCHEDULE: SchedulerConfig = { coalesceMs: 100, minIntervalMs: 250, deadlineMs: 600, failureTtlMs: 15_000 };

export type Job<P> = { fingerprint: string; packet: P };

export type Outcome<R> =
  | { kind: 'ok'; result: R; latencyMs: number }
  | { kind: 'error'; code: string; retryAfterMs: number | null; latencyMs: number }
  | { kind: 'deadline'; latencyMs: number };

export type SchedulerStats = {
  submitted: number;
  deduplicated: number;
  negativeCached: number;
  started: number;
  completed: number;
  failed: number;
  deadline: number;
  superseded: number;
  latencies: number[];
};

export class DecisionScheduler<P, R> {
  private inflight: { job: Job<P>; ctrl: AbortController; started: number; timer: unknown } | null = null;
  private pending: Job<P> | null = null;
  private pendingTimer: unknown = null;
  private lastStart = -Infinity;
  private cooldownUntil = -Infinity;
  private failures = new Map<string, number>();
  readonly stats: SchedulerStats = {
    submitted: 0,
    deduplicated: 0,
    negativeCached: 0,
    started: 0,
    completed: 0,
    failed: 0,
    deadline: 0,
    superseded: 0,
    latencies: [],
  };

  constructor(
    private readonly cfg: SchedulerConfig,
    private readonly run: (packet: P, signal: AbortSignal, deadlineMs: number) => Promise<R>,
    private readonly onOutcome: (job: Job<P>, outcome: Outcome<R>) => void,
    private readonly clock: Clock = realClock,
    private readonly classifyError: (e: unknown) => { code: string; retryAfterMs: number | null } = (e) => ({
      code: (e as { code?: string })?.code ?? 'PROVIDER_FAILED',
      retryAfterMs: (e as { retryAfterMs?: number | null })?.retryAfterMs ?? null,
    }),
  ) {}

  get busy() {
    return !!this.inflight;
  }

  get inflightFingerprint() {
    return this.inflight?.job.fingerprint ?? null;
  }

  submit(job: Job<P>) {
    this.stats.submitted++;
    if (this.inflight?.job.fingerprint === job.fingerprint || this.pending?.fingerprint === job.fingerprint) {
      this.stats.deduplicated++;
      return;
    }
    const failedAt = this.failures.get(job.fingerprint);
    if (failedAt !== undefined && this.clock.now() - failedAt < this.cfg.failureTtlMs) {
      this.stats.negativeCached++;
      return;
    }
    if (this.pending) this.stats.superseded++;
    this.pending = job;
    this.schedule(this.cfg.coalesceMs);
  }

  /** Drop pending work and abort the in-flight request (its late result will be ignored). */
  cancelAll() {
    if (this.pendingTimer !== null) this.clock.clearTimeout(this.pendingTimer);
    this.pendingTimer = null;
    this.pending = null;
    if (this.inflight) {
      this.inflight.ctrl.abort();
      this.clock.clearTimeout(this.inflight.timer);
      this.inflight = null;
    }
  }

  private schedule(delay: number) {
    // Replacing the pending evidence must not restart its clock: a stream of material changes
    // still gets a decision within the first coalescing window (or interval/cooldown boundary).
    if (this.inflight || this.pendingTimer !== null) return; // started after completion
    const now = this.clock.now();
    const at = Math.max(now + delay, this.lastStart + this.cfg.minIntervalMs, this.cooldownUntil);
    this.pendingTimer = this.clock.setTimeout(() => {
      this.pendingTimer = null;
      this.start();
    }, Math.max(0, at - now));
  }

  private start() {
    const job = this.pending;
    if (!job || this.inflight) return;
    this.pending = null;
    const ctrl = new AbortController();
    const started = this.clock.now();
    this.lastStart = started;
    this.stats.started++;
    const finish = (outcome: Outcome<R>) => {
      if (this.inflight?.ctrl !== ctrl) return; // cancelled or superseded: late effect rejected
      this.clock.clearTimeout(this.inflight.timer);
      this.inflight = null;
      this.onOutcome(job, outcome);
      if (this.pending) this.schedule(0);
    };
    const timer = this.clock.setTimeout(() => {
      this.stats.deadline++;
      this.failures.set(job.fingerprint, this.clock.now());
      ctrl.abort();
      finish({ kind: 'deadline', latencyMs: this.clock.now() - started });
    }, this.cfg.deadlineMs);
    this.inflight = { job, ctrl, started, timer };
    this.run(job.packet, ctrl.signal, this.cfg.deadlineMs).then(
      (result) => {
        const latencyMs = this.clock.now() - started;
        if (this.inflight?.ctrl !== ctrl) return;
        this.stats.completed++;
        this.stats.latencies.push(latencyMs);
        finish({ kind: 'ok', result, latencyMs });
      },
      (e) => {
        const latencyMs = this.clock.now() - started;
        if (this.inflight?.ctrl !== ctrl) return;
        const { code, retryAfterMs } = this.classifyError(e);
        this.stats.failed++;
        this.failures.set(job.fingerprint, this.clock.now());
        if (code === 'RATE_LIMITED') this.cooldownUntil = this.clock.now() + (retryAfterMs ?? 5000);
        finish({ kind: 'error', code, retryAfterMs, latencyMs });
      },
    );
  }
}
