// Reconnecting WebSocket with bounded backoff. The server sends a full state on every (re)connect,
// so a reconnect never needs local replay.

export type Socket = {
  send(msg: unknown): boolean;
  close(): void;
};

/**
 * The path the app is served under ("" at a site's root, "/quran-reader" on nurra.org), as the
 * server tells the page. Every request and link goes through u().
 */
export const BASE = (typeof document !== 'undefined' ? document.querySelector<HTMLMetaElement>('meta[name="qo-base"]')?.content ?? '' : '').replace(/\/+$/, '');
export const u = (path: string) => `${BASE}${path}`;

type Snapshot = import('../shared/contracts').ControlSnapshot;
type Display = import('../shared/contracts').DisplayState;
/** `a` is an earlier or the same display state as `b` of the same session. */
const stale = (a: Display, b: Display) => a.sessionEpoch === b.sessionEpoch && a.revision <= b.revision;

/**
 * Control-channel state as a page keeps it: after the first full snapshot, updates leave out the
 * display (sent at once in its own messages) and unchanged setup; an older display never wins.
 */
export function applySnapshot(prev: Snapshot | null, next: import('../shared/contracts').ControlSnapshotUpdate): Snapshot | null {
  const display = next.display && !(prev && stale(next.display, prev.display)) ? next.display : prev?.display;
  const setup = next.setup ?? prev?.setup;
  return display && setup ? { ...next, display, setup } : prev;
}

export function applyDisplay(prev: Snapshot | null, display: Display): Snapshot | null {
  return prev && !stale(display, prev.display) ? { ...prev, display } : prev;
}

export function connect(
  path: string,
  handlers: {
    onOpen?: (send: (m: unknown) => boolean) => void;
    onMessage: (data: unknown) => void;
    onStatus?: (s: 'connecting' | 'open' | 'closed', code?: number) => void;
    /** Return false to stop reconnecting after a close code (e.g. auth failure). */
    shouldRetry?: (code: number) => boolean;
  },
): Socket {
  let ws: WebSocket | null = null;
  let closed = false;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${path}`;
  const send = (m: unknown) => {
    if (closed || ws?.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(m));
    return true;
  };
  const open = () => {
    if (closed) return;
    handlers.onStatus?.('connecting');
    const socket = new WebSocket(url);
    ws = socket;
    const current = () => !closed && ws === socket;
    socket.onopen = () => {
      if (!current()) return;
      attempt = 0;
      handlers.onStatus?.('open');
      handlers.onOpen?.(send);
    };
    socket.onmessage = (ev) => {
      if (!current()) return;
      try {
        handlers.onMessage(JSON.parse(String(ev.data)));
      } catch {
        /* malformed frame ignored */
      }
    };
    socket.onclose = (ev) => {
      if (!current()) return;
      ws = null;
      handlers.onStatus?.('closed', ev.code);
      if (closed || (handlers.shouldRetry && !handlers.shouldRetry(ev.code))) return;
      const delay = Math.min(5000, 250 * 2 ** attempt++);
      timer = setTimeout(open, delay);
    };
  };
  open();
  return {
    send,
    close() {
      if (closed) return;
      closed = true;
      if (timer) clearTimeout(timer);
      timer = null;
      const socket = ws;
      ws = null;
      socket?.close();
    },
  };
}

/** Trade a one-time owner link (#owner=…) for the session cookie, and clear it from the address bar. */
export async function exchangeOwner(): Promise<void> {
  const params = new URLSearchParams(location.hash.slice(1));
  const token = params.get('owner');
  if (!token) return;
  history.replaceState(null, '', location.pathname); // capability leaves the address bar immediately
  await fetch(u('/api/owner/session'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
    credentials: 'same-origin',
  }).catch(() => undefined);
}

export type PoolStats = {
  given: number;
  used: number;
  left: number;
  costs?: number;
  costUsdMicros?: number;
  operatingReserve?: number;
  operatingReserveUsdMicros?: number;
  centsPerHour?: number;
};
/** A donation to the shared sponsored-listening pool, and the hours it adds. */
export type Donation = { amountCents: number; price: string; hours: number };
export type Access = {
  mode: 'local' | 'hosted';
  owner: boolean;
  credits?: import('../shared/contracts').CreditView;
  /** Hosted with donations enabled: gifts to the community pool. */
  billing?: { donations?: Donation[]; testMode?: boolean } | null;
  /** Hosted: the shared pool's story (seconds, counts; totals only). */
  sponsored?: PoolStats;
};

/** Local: trade the owner link for the cookie. Hosted: get (or be issued) this visitor's identity. */
export async function access(): Promise<Access> {
  await exchangeOwner();
  const r = await fetch(u('/api/me'), { credentials: 'same-origin' });
  if (!r.ok) throw new Error('Reader unavailable');
  return (await r.json()) as Access;
}

/** The one-line listening status: free and shared, or the personal allowance when one is configured. */
/** The listening time line; `live`: the session is live on stream; `own`: the reciter's own Soniox key pays (no daily limit applies either way). */
export function listeningLine(c: import('../shared/contracts').CreditView, live = false, own = false): string {
  if (own) return 'Your own Soniox key · no time limit';
  if (c.freePerMonth > 0) return c.available > 0 ? `${formatListening(c.available)} of listening left` : 'No listening time left';
  if (c.limitedBy === 'pool') return 'Shared listening hours are unavailable · reading stays free';
  if (live) return 'Live on stream · no time limit';
  if (c.limitedBy === 'share') return 'You’ve used today’s hours · back tomorrow';
  return `Free · ${Math.round(c.pool / 3600).toLocaleString()} hours sponsored`;
}

/** "9 h 41 min", "12 min", "under a minute". */
export function formatListening(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return 'under a minute';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h} h${m ? ` ${m} min` : ''}` : `${m} min`;
}
