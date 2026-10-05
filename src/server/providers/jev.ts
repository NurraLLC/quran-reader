// JEV Decisions client for two gateways behind one `evaluate` interface.
//   typesafe:   POST https://api.typesafe.ai/v1/systemone      model jev-1.13.0
//   openrouter: POST https://openrouter.ai/api/alpha/decisions model typesafe/jev-1.13
// Hosts/paths are constants; no caller can redirect a key. No retries (a failed optional decision
// becomes uncertainty). Error bodies are never read because they can echo private content.
// Validation is ported from Moard harbor/intelligence/openrouter_jev.py + jev_turn.py and
// Nur app/ai/jev_client.py (see docs/REUSE_NOTES.md).

export type JevGateway = 'typesafe' | 'openrouter';

export const GATEWAYS: Record<JevGateway, { url: string; model: string; responseModel: RegExp }> = {
  typesafe: {
    url: 'https://api.typesafe.ai/v1/systemone',
    model: 'jev-1.13.0',
    responseModel: /^jev-1\.13(\.\d+)?$/,
  },
  openrouter: {
    url: 'https://openrouter.ai/api/alpha/decisions',
    model: 'typesafe/jev-1.13',
    responseModel: /^typesafe\/jev-1\.13(-\d{8})?$/,
  },
};

export type ChoiceQuestion = { type: 'choice'; instructions: string; criteria: Record<string, string> };
export type NoulQuestion = { type: 'noul'; instructions: string; criteria?: { true: string; false: string } };
export type Question = ChoiceQuestion | NoulQuestion;

export type ChoiceAnswer = {
  type: 'choice';
  choice: string;
  probabilities: Readonly<Record<string, number>>;
  confidence: number;
  /** Top probability shared by more than one option: never an action. */
  tied: boolean;
};
export type NoulAnswer = { type: 'noul'; noul: number };
export type Answer = ChoiceAnswer | NoulAnswer;

export type Decision = {
  id: string | null;
  model: string;
  gateway: JevGateway;
  answers: Record<string, Answer>;
  usage: { inputTokens: number; outputTokens: number; cost: number | null };
  latencyMs: number;
};

export const JEV_ERROR_CODES = [
  'NOT_CONFIGURED',
  'AUTHENTICATION_FAILED',
  'CREDITS_EXHAUSTED',
  'RATE_LIMITED',
  'SERVICE_UNAVAILABLE',
  'REQUEST_REJECTED',
  'REDIRECT_BLOCKED',
  'TIMEOUT',
  'CANCELLED',
  'TRANSPORT_UNAVAILABLE',
  'RESPONSE_INVALID',
  'RESPONSE_TOO_LARGE',
  'REQUEST_TOO_LARGE',
] as const;
export type JevErrorCode = (typeof JEV_ERROR_CODES)[number];

export class JevError extends Error {
  constructor(
    readonly code: JevErrorCode,
    readonly retryAfterMs: number | null = null,
  ) {
    super(code);
  }
}

export const REQUEST_BUDGET_BYTES = 16_384;
const RESPONSE_LIMIT_BYTES = 32_768;
const MAX_TIMEOUT_MS = 10_000;

export type FetchLike = (
  url: string,
  init: { method: 'POST'; headers: Record<string, string>; body: string; signal: AbortSignal; redirect: 'manual' },
) => Promise<{ status: number; headers: { get(name: string): string | null }; text(): Promise<string> }>;

export type EvaluateOptions = { timeoutMs: number; signal?: AbortSignal };

export interface DecisionClient {
  readonly gateway: JevGateway;
  evaluate(state: unknown, questions: Record<string, Question>, opts: EvaluateOptions): Promise<Decision>;
}

export function encodeRequest(gateway: JevGateway, state: unknown, questions: Record<string, Question>): string {
  const body: Record<string, unknown> = { model: GATEWAYS[gateway].model, state, questions };
  // OpenRouter: pin the JEV primitive to TypeSafe with no fallback to other models and no data
  // collection. (Nur sends this pin; Moard harbor does not. Chosen here for privacy/identity.)
  if (gateway === 'openrouter') body.provider = { only: ['TypeSafe'], allow_fallbacks: false, data_collection: 'deny' };
  return JSON.stringify(body);
}

export function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

export class JevClient implements DecisionClient {
  constructor(
    readonly gateway: JevGateway,
    private readonly apiKey: string,
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike,
    private readonly now: () => number = () => performance.now(),
  ) {
    if (!apiKey || !/^[\x21-\x7e]{1,4096}$/.test(apiKey)) throw new JevError('NOT_CONFIGURED');
  }

  toJSON() {
    return { gateway: this.gateway, apiKey: '<redacted>' };
  }

  async evaluate(state: unknown, questions: Record<string, Question>, opts: EvaluateOptions): Promise<Decision> {
    const body = encodeRequest(this.gateway, state, questions);
    if (byteLength(body) > REQUEST_BUDGET_BYTES) throw new JevError('REQUEST_TOO_LARGE');
    const timeoutMs = Math.min(Math.max(opts.timeoutMs, 50), MAX_TIMEOUT_MS);
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    if (opts.signal?.aborted) throw new JevError('CANCELLED');
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, timeoutMs);
    const started = this.now();
    try {
      let res;
      try {
        res = await this.fetchImpl(GATEWAYS[this.gateway].url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body,
          signal: ctrl.signal,
          redirect: 'manual',
        });
      } catch {
        // Re-raised without the cause: the key and state must never appear in a trace.
        throw new JevError(timedOut ? 'TIMEOUT' : opts.signal?.aborted ? 'CANCELLED' : 'TRANSPORT_UNAVAILABLE');
      }
      if (res.status !== 200) throw statusError(res.status, res.headers.get('retry-after'));
      let text: string;
      try {
        text = await res.text();
      } catch {
        throw new JevError(timedOut ? 'TIMEOUT' : 'TRANSPORT_UNAVAILABLE');
      }
      if (byteLength(text) > RESPONSE_LIMIT_BYTES) throw new JevError('RESPONSE_TOO_LARGE');
      const decision = parseDecision(this.gateway, text, questions);
      return { ...decision, latencyMs: this.now() - started };
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
    }
  }
}

function statusError(status: number, retryAfter: string | null): JevError {
  if (status >= 300 && status < 400) return new JevError('REDIRECT_BLOCKED');
  if (status === 401 || status === 403) return new JevError('AUTHENTICATION_FAILED');
  if (status === 402) return new JevError('CREDITS_EXHAUSTED');
  if (status === 429) {
    const secs = retryAfter && /^\d{1,5}$/.test(retryAfter.trim()) ? Number(retryAfter) : 5;
    return new JevError('RATE_LIMITED', Math.min(secs, 300) * 1000);
  }
  if (status === 529 || status >= 500) return new JevError('SERVICE_UNAVAILABLE');
  return new JevError('REQUEST_REJECTED');
}

const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const sameKeys = (o: Record<string, unknown>, keys: Iterable<string>) => {
  const want = new Set(keys);
  const got = Object.keys(o);
  return got.length === want.size && got.every((k) => want.has(k));
};

/**
 * Provider scores are reported as-is; never renormalized (renormalizing could manufacture a
 * threshold crossing the provider never reported). Two-decimal rounding is tolerated.
 */
export function probabilitiesSumOk(values: number[]): boolean {
  const sum = values.reduce((a, b) => a + b, 0);
  if (Math.abs(sum - 1) <= 1e-6) return true;
  if (values.some((v) => Math.abs(v - Math.round(v * 100) / 100) > 1e-9)) return false;
  const lower = values.reduce((a, v) => a + Math.max(0, v - 0.005), 0);
  const upper = values.reduce((a, v) => a + Math.min(1, v + 0.005), 0);
  return lower <= 1 + 1e-9 && upper >= 1 - 1e-9;
}

export function parseDecision(
  gateway: JevGateway,
  text: string,
  questions: Record<string, Question>,
): Omit<Decision, 'latencyMs'> {
  const bad = () => new JevError('RESPONSE_INVALID');
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw bad();
  }
  if (!isObj(payload)) throw bad();
  const allowed = new Set(['model', 'answers', 'usage', 'id', 'provider']);
  if (!['model', 'answers', 'usage'].every((k) => k in payload)) throw bad();
  if (Object.keys(payload).some((k) => !allowed.has(k))) throw bad();
  const model = payload.model;
  if (typeof model !== 'string' || !GATEWAYS[gateway].responseModel.test(model)) throw bad();
  for (const k of ['id', 'provider'] as const) {
    if (k in payload && (typeof payload[k] !== 'string' || !/^[\x20-\x7e]{1,256}$/.test(payload[k] as string))) throw bad();
  }
  // An omitted optional provider keeps wrapper compatibility; a conflicting returned
  // provider contradicts the TypeSafe-only request and cannot supply a decision.
  if (gateway === 'openrouter' && typeof payload.provider === 'string' && payload.provider.toLowerCase() !== 'typesafe') throw bad();
  const answers = payload.answers;
  const usage = payload.usage;
  if (!isObj(answers) || !isObj(usage) || !sameKeys(answers, Object.keys(questions))) throw bad();
  // usage is an open set (a new metering field must not end the stream); token counts stay required.
  const tokenOk = (v: unknown) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 1_000_000;
  if (!tokenOk(usage.input_tokens) || !tokenOk(usage.output_tokens)) throw bad();
  if ('cost' in usage && usage.cost !== null && (!isNum(usage.cost) || usage.cost < 0 || usage.cost > 1_000_000)) throw bad();

  const out: Record<string, Answer> = {};
  for (const [qid, q] of Object.entries(questions)) {
    const a = answers[qid];
    if (!isObj(a) || a.type !== q.type) throw bad();
    if (q.type === 'noul') {
      if (!sameKeys(a, ['type', 'noul']) || !isNum(a.noul) || a.noul < 0 || a.noul > 1) throw bad();
      out[qid] = { type: 'noul', noul: a.noul };
      continue;
    }
    const options = Object.keys(q.criteria);
    if (!sameKeys(a, ['type', 'choice', 'probabilities', 'confidence'])) throw bad();
    const probs = a.probabilities;
    if (typeof a.choice !== 'string' || !options.includes(a.choice)) throw bad();
    if (!isObj(probs) || !sameKeys(probs, options)) throw bad();
    const values = options.map((o) => probs[o]);
    if (values.some((v) => !isNum(v) || v < 0 || v > 1)) throw bad();
    if (!probabilitiesSumOk(values as number[])) throw bad();
    if (!isNum(a.confidence) || a.confidence < 0 || a.confidence > 1) throw bad();
    const highest = Math.max(...(values as number[]));
    if ((probs[a.choice] as number) !== highest) throw bad();
    const tied = (values as number[]).filter((v) => Math.abs(v - highest) <= 1e-8).length > 1;
    out[qid] = {
      type: 'choice',
      choice: a.choice,
      probabilities: Object.freeze({ ...(probs as Record<string, number>) }),
      confidence: a.confidence,
      tied,
    };
  }
  return {
    id: typeof payload.id === 'string' ? payload.id : null,
    model,
    gateway,
    answers: out,
    usage: {
      inputTokens: usage.input_tokens as number,
      outputTokens: usage.output_tokens as number,
      cost: isNum(usage.cost) ? usage.cost : null,
    },
  };
}

/** Largest prefix of `optional` that keeps the serialized request inside the budget. */
export function fitToBudget<T>(fixed: T[], optional: T[], encode: (items: T[]) => string, budget = REQUEST_BUDGET_BYTES): { kept: T[]; truncated: boolean } {
  if (byteLength(encode(fixed)) > budget) return { kept: [], truncated: true };
  let lo = 0;
  let hi = optional.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (byteLength(encode([...fixed, ...optional.slice(0, mid)])) <= budget) lo = mid;
    else hi = mid - 1;
  }
  return { kept: [...fixed, ...optional.slice(0, lo)], truncated: lo < optional.length };
}
