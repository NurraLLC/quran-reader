// Soniox Web SDK lifecycle + transcript event adapter (verified against @soniox/client 2.3.0
// declarations: SonioxClient({config}), client.realtime.record(), MicrophoneSource, finalize(),
// cancel(), session_restart). The browser never sees the long-lived key: config() fetches a
// single-use temporary key from the local server for each stream (and each reconnect).

import { SonioxClient, type AudioSource, type AudioSourceHandlers, type RealtimeResult, type Recording } from '@soniox/client';
import type { ControlClientMessage } from '../../shared/contracts';
import type { WireToken } from '../../shared/transcript';
import { TokenRouter, type CommandCapture } from './command-lane';
import { MicError, PAUSE_QUIET_MS, PCM_FORMAT, SharedMic, VOICE_ONSET_MS } from './mic';
import { u } from '../net';
import {listeningConsent} from './consent';

/** Restart before the explicit per-stream cap minted by the server (3 h), without replaying captions. */
const PROACTIVE_RESTART_MS = 175 * 60 * 1000;
const FINALIZE_WAIT_MS = 2500;

export type CaptureStatus = { state: 'off' | 'starting' | 'recording' | 'reconnecting' | 'dozing' | 'waiting' | 'error'; detail: string | null };
type CaptureEvent = Extract<ControlClientMessage, { type: 'capture' }>['event'];

/** A phone or tablet: its screen turns off, it suspends hidden pages, and it has no "computer" or other programs to close. */
function onPhone() {
  if (typeof navigator === 'undefined') return false;
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/i.test(navigator.userAgent));
}
const unavailable = () => (onPhone() ? 'This browser can’t use the microphone here. Open this page in Safari or Chrome.' : 'This browser cannot capture audio here. Use a current Chrome or Edge on this computer.');

function describeError(e: unknown): string {
  if (e instanceof MicError) {
    if (e.kind === 'permission') return 'Microphone permission was denied. Allow the microphone for this page in the browser’s site settings, then start again.';
    if (e.kind === 'device') return 'The selected microphone was not found. It may have been unplugged; pick another microphone.';
    if (e.kind === 'busy') return onPhone() ? 'Another app is using the microphone. Close it, then start again.' : 'The microphone is in use by another program or cannot be read. Close the other program or pick another microphone.';
    return unavailable();
  }
  const name = (e as { name?: string })?.name ?? '';
  const code = (e as { code?: string })?.code ?? '';
  if (name === 'AudioPermissionError' || code === 'permission_denied') return 'Microphone permission was denied. Allow the microphone for this page in the browser’s site settings, then start again.';
  if (name === 'AudioDeviceError' || code === 'device_not_found') return 'The selected microphone was not found. It may have been unplugged; pick another microphone.';
  if (name === 'AudioUnavailableError') return unavailable();
  if (code === 'auth_error') return 'Soniox rejected the temporary key. Check SONIOX_API_KEY permissions.';
  if (code === 'quota_exceeded') return 'Soniox quota or rate limit reached.';
  if (code === 'network_error' || code === 'connection_error') return 'Lost the connection to Soniox.';
  const msg = e instanceof Error ? e.message : String(e);
  return msg.slice(0, 200) || 'Listening stopped because of an unexpected error.';
}

/**
 * Lab-only recognition tuning from the page URL (`?stt={"timeslice":20,...}`), used by the speed
 * lab to A/B provider settings on identical audio. Only these known keys are read. `pcm: true`
 * sends 16 kHz PCM even where WebM/Opus recording works: the path Safari before 18.4 takes.
 */
type SttTuning = { hints?: string[]; timeslice?: number; max_endpoint_delay_ms?: number; endpoint_sensitivity?: number; endpoint_latency_adjustment_level?: number; language_hints_strict?: boolean; pcm?: boolean };
function sttTuning(): SttTuning {
  try {
    const raw = JSON.parse(new URLSearchParams(location.search).get('stt') ?? '{}') as Record<string, unknown>;
    const num = (k: string, lo: number, hi: number) => (typeof raw[k] === 'number' && (raw[k] as number) >= lo && (raw[k] as number) <= hi ? (raw[k] as number) : undefined);
    return {
      hints: Array.isArray(raw.hints) && raw.hints.every((h) => typeof h === 'string') ? (raw.hints as string[]).slice(0, 4) : undefined,
      timeslice: num('timeslice', 10, 250),
      max_endpoint_delay_ms: num('max_endpoint_delay_ms', 500, 3000),
      endpoint_sensitivity: num('endpoint_sensitivity', -1, 1),
      endpoint_latency_adjustment_level: num('endpoint_latency_adjustment_level', 0, 3),
      language_hints_strict: typeof raw.language_hints_strict === 'boolean' ? raw.language_hints_strict : undefined,
      pcm: raw.pcm === true || undefined,
    };
  } catch {
    return {};
  }
}
const TUNING = sttTuning();
const TIMESLICE_MS = TUNING.timeslice ?? 60;

/**
 * Pass-through microphone source that records when audio starts flowing. Soniox token times are
 * relative to the first audio of the stream, so this is the zero point for the live speed meter.
 * restart() (SDK reconnect) starts a new stream and a new zero point. Both sources (WebM recorder,
 * audio-thread PCM) deliver chunks of TIMESLICE_MS, so the first chunk marks the zero the same way.
 */
class TimedSource implements AudioSource {
  firstChunkAt: number | null = null;
  constructor(private readonly inner: AudioSource) {}
  async start(handlers: AudioSourceHandlers) {
    await this.inner.start({
      ...handlers,
      onData: (chunk) => {
        if (this.firstChunkAt === null) this.firstChunkAt = performance.now();
        handlers.onData(chunk);
      },
    });
  }
  stop() {
    this.inner.stop();
  }
  pause() {
    this.inner.pause?.();
  }
  resume() {
    this.inner.resume?.();
  }
  restart() {
    this.firstChunkAt = null;
    this.inner.restart?.();
  }
  /** performance.now() of provider audio time 0 (first chunk carries TIMESLICE_MS of audio). */
  get audioOrigin(): number | null {
    return this.firstChunkAt === null ? null : this.firstChunkAt - TIMESLICE_MS;
  }
}

/** Said while listening goes on after a phone suspended it (screen off, another app, a call). */
const BACK_ON_SCREEN = 'Listening paused while the screen was off. Recite to continue.';
/** Listening is full (here or at the recogniser): a wait, not a failure; the server says the same. */
const BUSY = 'Many people are reciting right now, so listening is full for the moment. Please try again in a minute. Reading, word meanings and translations work as usual.';
/** iOS can keep the audio thread suspended until the next touch; nothing is heard until then. */
const TAP_TO_CONTINUE = 'Listening paused while the screen was off. Tap anywhere to continue.';
const TAP_TO_LISTEN = 'Tap anywhere to start listening.';
const STOPPED_OFF_SCREEN = 'Listening stopped while the screen was off. Start again when you are ready.';
/**
 * Waiting in line (every place to listen is taken): the page asks again this often, and at once
 * when the server says a place is free. An ask with no answer this long is dropped and made again.
 */
const LINE_ASK_MS = 12_000;
const LINE_ASK_TIMEOUT_MS = 20_000;
const YOUR_TURN = 'It’s your turn. Recite when you’re ready.';
/** Live on stream, the connection lost (the network, the server restarting): retried at these delays, then every 15 s. */
const LIVE_RETRY_MS = [2_000, 5_000, 10_000];
/** Still live this long after the overlay goes: OBS reconnects after a restart later than this page may. */
const LIVE_GRACE_MS = 60_000;
export const LIVE_RECONNECTING = 'The connection was lost. Reconnecting by itself…';
/** The listening library's own brief reconnect (a phone reader does not show it). */
export const RECONNECTING = 'Reconnecting to Soniox…';

/**
 * A reciter's own Soniox key (hosted site): saved in this browser and sent with each listening
 * request so their account pays. The relay holds it temporarily in memory, never on server disk.
 */
const OWN_KEY_STORAGE = 'qo.ownSonioxKey';
export const OWN_KEY_SHAPE = /^[A-Za-z0-9._~+/=-]{16,256}$/;
export function ownSonioxKey(): string | null {
  try {
    return localStorage.getItem(OWN_KEY_STORAGE) || null;
  } catch {
    return null;
  }
}
export function setOwnSonioxKey(key: string | null) {
  try {
    if (key) localStorage.setItem(OWN_KEY_STORAGE, key);
    else localStorage.removeItem(OWN_KEY_STORAGE);
  } catch {
    /* storage blocked: nothing is kept */
  }
}

/** A lost or failed connection, as opposed to a refusal, a microphone problem or a bad request. */
function lostConnection(e: unknown) {
  const { name, code, message, raw } = (e ?? {}) as { name?: string; code?: string; message?: string; raw?: { error_type?: unknown } };
  if (name === 'ConnectionError' || name === 'NetworkError' || code === 'connection_error' || code === 'network_error') return true;
  // The relay could not reach the recogniser, or the connection was too slow for it.
  return raw?.error_type === 'listening_paused' && /could not connect|too slow|start listening again/i.test(message ?? '');
}

function ordinal(n: number) {
  const tens = n % 100;
  return `${n}${tens >= 11 && tens <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th')}`;
}

/** Said while waiting in line: where the reciter stands, and that listening starts by itself. */
export function lineText(position: number | null) {
  if (position === 1) return 'Many people are reciting right now. You’re next, and listening starts by itself in a moment.';
  const place = position === null ? 'You’re in line' : `You’re ${ordinal(position)} in line`;
  return `Many people are reciting right now. ${place}, and listening starts by itself when it’s your turn.`;
}
/** How long a notice stays (it also clears once recitation is heard again). */
const NOTICE_MS = 8_000;
/**
 * Away this long, a phone has usually suspended the page and its sockets: a provider stream that
 * has not answered since may be dead without saying so, and is restarted.
 */
const STALE_AFTER_MS = 5_000;
const LIVE_STATES = new Set(['starting', 'connecting', 'recording', 'paused', 'reconnecting']);

/**
 * Listening stops by itself after this long without Arabic recitation (silence, noise or only
 * English talk): audio is billed while it streams, so an idle microphone must not stay open.
 */
export const IDLE_STOP_MS = 60_000;

/**
 * The silence skipper. Soniox bills a stream for as long as it is open, pauses included, so after
 * this long without voice the stream is closed ("dozing") and a new one opens the moment the voice
 * returns. The microphone stays open locally meanwhile and nothing is sent. Breaths and the pauses
 * between ayahs are far shorter, so ordinary following is untouched; after a long pause the first
 * words take about half a second longer (a new connection). Measured on recorded sessions, pauses
 * this long are about 11% of listening time, plus the silent tail before the idle stop.
 */
export const DOZE_AFTER_MS = 8_000;
/** While dozing nothing is billed, so a longer break is allowed before listening stops. */
export const DOZE_IDLE_STOP_MS = 3 * 60_000;
const ARABIC = /[ء-ي]/;

/**
 * After English speech the recogniser tends to stay in English and writes the following recitation
 * in Latin letters ("Inna fatahna ... Bismillahirrahmanirrahim"), which nothing can follow. A fresh
 * stream starts without that bias, so English speech ending, or recitation arriving in Latin
 * letters, restarts the stream (the display and tracker keep their place).
 */
const LATIN = /[A-Za-z]/;
const TRANSLITERATED = /^(bismillah\w*|allah\w*|alhamd\w*|rahman\w*|rahim\w*|ar-?rahman\w*|inna|qul|subhan\w*|ya-?ayyuha\w*|ayyuha\w*|lillah\w*)$/i;
/** At most one language reset per this long, so a stubborn case can never loop restarts. */
const RESET_MIN_GAP_MS = 15_000;

export class SonioxCapture {
  private timed: TimedSource | null = null;
  /** The microphone for the whole listening session (open while listening, dozing included). */
  private mic: SharedMic | null = null;
  /** Listening is on (the user's choice); a provider stream may be open or dozing. */
  private active = false;
  /** Stop invalidates pending microphone work; provider restarts keep this session identity. */
  private captureGeneration = 0;
  private consentRequest: AbortController | null = null;
  private dozing = false;
  /** Microphone input level 0..1 while listening (0 when not listening). */
  level(): number {
    return this.active ? (this.mic?.level() ?? 0) : 0;
  }

  /** performance.now() corresponding to Soniox audio time 0 of the current stream, if known. */
  get audioOrigin(): number | null {
    return this.timed?.audioOrigin ?? null;
  }

  private recording: Recording | null = null;
  private epoch = 0;
  private seq = 0;
  private stopping = false;
  private startedAt = 0;
  private lastProcMs = 0;
  private lastResultAt = 0;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setInterval> | null = null;
  /** performance.now() of the last recognised Arabic (kept across proactive restarts). */
  private lastArabicAt = 0;
  /** The newest recognised words are English (Latin script). */
  private latinTail = false;
  private lastResetAt = 0;
  /** Set when the server refused a key for lack of listening time (a clean stop, not a failure). */
  private noCredits: string | null = null;
  private resetting = false;
  /** Resets triggered by recitation in Latin letters this session (the server can read those too). */
  private latinResets = 0;
  private deviceId: string | null = null;
  private commandOnly = false;
  readonly router = new TokenRouter();
  private finalizeWaiter: ((timedOut: boolean) => void) | null = null;
  status: CaptureStatus = { state: 'off', detail: null };
  /** The latest capture event for the server, resent by announce(). */
  private lastCapture: { captureEpoch: number; event: CaptureEvent; detail?: string } | null = null;
  private wakeLock: WakeLockSentinel | null = null;
  private wakeLockPending = false;
  /** Since when the phone has kept this page from listening (off screen, audio thread suspended). */
  private awaySince: number | null = null;
  private recovering = false;
  /** Removes the listener waiting for a touch to resume the audio thread. */
  private tapWaiter: (() => void) | null = null;
  /** A short explanation shown while listening goes on (e.g. after the screen was off). */
  private notice: string | null = null;
  private noticeTimer: ReturnType<typeof setTimeout> | null = null;
  /** Waiting in line for a place to listen: where (null: not yet known). */
  private line: { position: number | null } | null = null;
  private lineTimer: ReturnType<typeof setTimeout> | null = null;
  /** The server's answer to this ask was "in line" (at this place); read by the stream's error. */
  private lineAnswer: number | null | undefined = undefined;
  /** Told a place is free while an ask was under way: ask again right after its answer. */
  private turnPending = false;
  /** Live on stream (an overlay shows this session) until then: listening never stops for lack of recitation. */
  private liveUntil = 0;
  /** The key request got no answer, or the server's error page: a lost connection. */
  private unreachable = false;
  /** The key was refused because the sponsored hours ran out (for everyone). */
  private poolEmpty = false;
  /** Why the reciter's own key was refused (read by the stream's error); until changed, the shared hours are used. */
  private ownRefused: string | null = null;
  private ownKeyFailed = false;
  /** Told when the reciter's own key is refused (why), or changed (null). */
  onOwnKeyProblem: ((problem: string | null) => void) | null = null;
  private liveRetries = 0;
  private liveRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private askedAt = 0;

  constructor(
    private readonly send: (m: ControlClientMessage) => void,
    private readonly onStatus: (s: CaptureStatus) => void,
    private readonly onHearing: (text: string) => void,
  ) {}

  /** Current capture epoch (matches the server's speed evidence). */
  get captureEpoch() {
    return this.epoch;
  }

  get listening() {
    return this.active && !this.commandOnly;
  }

  private setStatus(s: CaptureStatus) {
    this.status = s;
    this.onStatus(s);
  }

  /** Tells the server about this page's stream, and remembers it for announce(). */
  private capture(captureEpoch: number, event: CaptureEvent, detail?: string) {
    this.lastCapture = { captureEpoch, event, ...(detail ? { detail: detail.slice(0, 240) } : {}) };
    this.send({ type: 'capture', ...this.lastCapture });
  }

  /**
   * Resends the latest capture state. Call it when the control socket reconnects: the server took
   * the drop for the page leaving (it clears the display after a few seconds), and it ignores the
   * transcripts of a stream whose start it never heard (sent while the socket was down).
   */
  announce() {
    if (this.lastCapture) this.send({ type: 'capture', ...this.lastCapture });
  }

  private nextEpoch() {
    this.epoch = Math.max(this.epoch + 1, Date.now());
    this.seq = 0;
    return this.epoch;
  }

  private client() {
    return new SonioxClient({
      config: async () => {
        let res: Response;
        const own = this.ownKeyFailed || this.commandOnly ? null : ownSonioxKey();
        try {
          res = await fetch(u('/api/soniox/temporary-key'), { method: 'POST', credentials: 'same-origin', ...(own ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ownKey: own }) } : {}) });
        } catch (e) {
          this.unreachable = true;
          throw e;
        }
        if (!res.ok) {
          if (res.status >= 500) this.unreachable = true; // the server restarting, or a proxy's error page
          const body = (await res.json().catch(() => ({}))) as { error?: string; limitedBy?: string | null; renewsAt?: number; retryAfter?: number; position?: number };
          if (body.error === 'OWN_KEY_INVALID') {
            this.ownRefused = 'Your own Soniox key doesn’t look right. Check it, or remove it.';
            throw new Error(this.ownRefused);
          }
          // Every place to listen is taken: wait in line. (A spoken request, or a line too long to
          // join, is asked to try again later.)
          if (body.error === 'LISTENING_BUSY' && typeof body.position === 'number' && !this.commandOnly) {
            this.lineAnswer = body.position;
            throw new Error('In line to listen');
          }
          // Asked too often while waiting (a few asks a minute are allowed): the place stays.
          if (body.error === 'RATE_LIMITED' && this.line) {
            this.lineAnswer = this.line.position;
            throw new Error('In line to listen');
          }
          if (body.error === 'LISTENING_BUSY') {
            this.noCredits = BUSY;
            throw new Error(this.noCredits);
          }
          if (body.error === 'LISTENING_COOLDOWN') {
            this.noCredits = `Listening is taking a short break. Please try again in ${Math.max(1, Math.ceil((body.retryAfter ?? 300) / 60))} minutes. Reading and translations are still available.`;
            throw new Error(this.noCredits);
          }
          if (body.error === 'NO_CREDITS') {
            this.poolEmpty = body.limitedBy === 'pool';
            const renews = body.renewsAt ? new Date(body.renewsAt).toLocaleDateString(undefined, { month: 'long', day: 'numeric', timeZone: 'UTC' }) : 'next month';
            this.noCredits =
              body.limitedBy === 'pool'
                ? 'The sponsored hours have run out for now. You can still read and search, and listening comes back as soon as someone gives.'
                : body.limitedBy === 'share'
                  ? "You've used today's hours. They're back tomorrow, so there's enough for everyone."
                  : body.limitedBy === 'network'
                ? "Today's free listening on this network is used up. It comes back tomorrow."
                : body.limitedBy === 'service'
                  ? "Today's free listening for everyone is used up. It comes back tomorrow."
                  : `This month's free listening is used up. It renews on ${renews}.`;
            throw new Error(this.noCredits);
          }
          throw new Error(body.error === 'NOT_CONFIGURED' ? 'Soniox is not set up: add SONIOX_API_KEY to .env and restart the server.' : `Could not get a Soniox key (${body.error ?? res.status}).`);
        }
        const { api_key, stt_ws_url } = (await res.json()) as { api_key: string; stt_ws_url?: string };
        return { api_key, ...(stt_ws_url ? { stt_ws_url } : {}) };
      },
    });
  }

  /** Estimated provider audio clock now (ms since the stream's audio start). */
  audioNowMs(): number {
    if (this.lastResultAt) return this.lastProcMs + (performance.now() - this.lastResultAt);
    return performance.now() - this.startedAt;
  }

  async start(deviceId: string | null, opts: { commandOnly?: boolean } = {}) {
    if (this.active || this.consentRequest) return;
    const consent=new AbortController();this.consentRequest=consent;
    const agreed=await listeningConsent(consent.signal);
    if(this.consentRequest===consent)this.consentRequest=null;
    if(!agreed||consent.signal.aborted)return;
    this.active = true;
    this.deviceId = deviceId;
    this.commandOnly = !!opts.commandOnly;
    this.stopping = false;
    this.dozing = false;
    const generation = ++this.captureGeneration;
    const epoch = this.nextEpoch();
    if (!this.commandOnly) {
      this.capture(epoch, 'starting');
      // Straight after the tap and consent: the reciter then holds the phone without touching it.
      void this.keepScreenOn();
      document.addEventListener('visibilitychange', this.onVisibility);
    }
    this.setStatus({ state: 'starting', detail: null });
    let mic: SharedMic;
    try {
      mic = await this.openMic(generation);
    } catch (e) {
      if (!this.active || generation !== this.captureGeneration) return;
      const detail = describeError(e);
      this.teardown();
      this.setStatus({ state: 'error', detail });
      if (!this.commandOnly) this.capture(epoch, 'error', detail);
      return;
    }
    if (!this.active || generation !== this.captureGeneration) return mic.close();
    this.mic = mic;
    this.openStream(epoch);
    if (!this.commandOnly) {
      // An audio thread that starts suspended would send no PCM and never hear the voice return.
      if (mic.suspended) void this.recover();
      if (!this.lastArabicAt) this.lastArabicAt = performance.now();
      this.idleTimer = setInterval(() => {
        if (this.recovering) return;
        // Back on screen but not yet recovered (the event can come after overdue timers): recover
        // first, since the time away is not the reciter's silence.
        if (this.awaySince !== null && !this.tapWaiter && document.visibilityState === 'visible') return void this.recover();
        if (this.line) return; // not listened to yet: the idle clock starts with the stream
        // Live on stream: breaks and talk with the audience never stop listening (silence costs
        // nothing: the stream dozes). Once the stream ends, the idle clock starts from then.
        if (this.live) return void (this.lastArabicAt = performance.now());
        const limit = this.dozing ? DOZE_IDLE_STOP_MS : IDLE_STOP_MS;
        if (performance.now() - this.lastArabicAt < limit) return;
        const offScreen = this.awaySince !== null;
        this.stop();
        const minutes = Math.round(limit / 60_000);
        this.setStatus({ state: 'off', detail: offScreen ? STOPPED_OFF_SCREEN : `Stopped listening after ${minutes} ${minutes === 1 ? 'minute' : 'minutes'} without recitation. Start again when you are ready.` });
      }, 2000);
    }
  }

  private async openMic(generation: number) {
    let ownedMic: SharedMic | null = null;
    const current = () => this.active && generation === this.captureGeneration && ownedMic !== null && this.mic === ownedMic;
    const mic = await SharedMic.open(
      {
        ...(this.deviceId ? { deviceId: { exact: this.deviceId } } : {}),
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
      },
      DOZE_AFTER_MS,
      (e) => { if (current()) this.onVoice(e); },
      (speaking) => { if (current()) this.onPause(speaking); },
      () => { if (current()) this.onMicChange(); },
    );
    ownedMic = mic;
    return mic;
  }

  // ---------- screen off, backgrounding ----------

  /** Keeps the screen on while listening: the reciter holds the phone without touching it for minutes. */
  private async keepScreenOn() {
    if (this.wakeLock || this.wakeLockPending || !this.listening || document.visibilityState !== 'visible' || !navigator.wakeLock) return;
    this.wakeLockPending = true;
    try {
      const lock = await navigator.wakeLock.request('screen');
      if (!this.listening) return void lock.release().catch(() => undefined);
      this.wakeLock = lock;
      // Released by the browser when the page is hidden; taken again when it is back.
      lock.addEventListener('release', () => {
        if (this.wakeLock === lock) this.wakeLock = null;
      });
    } catch {
      /* refused (battery saver, policy, iOS home-screen apps before 18.4): the screen may lock; recover() handles the return */
    } finally {
      this.wakeLockPending = false;
    }
  }

  private letScreenSleep() {
    const lock = this.wakeLock;
    this.wakeLock = null;
    void lock?.release().catch(() => undefined);
  }

  private onVisibility = () => {
    if (!this.listening) return;
    if (document.visibilityState === 'hidden') {
      // A phone suspends hidden pages; a desktop background tab (a streamer's control page) keeps listening.
      if (onPhone()) this.awaySince ??= performance.now();
      return;
    }
    void this.keepScreenOn();
    void this.recover();
  };

  /** The system ended the microphone, or suspended or resumed the audio thread. */
  private onMicChange() {
    const mic = this.mic;
    if (!this.listening || !mic) return;
    if (!mic.live || mic.suspended) this.awaySince ??= performance.now();
    if (document.visibilityState === 'visible') void this.recover();
  }

  /**
   * Back on screen, or the audio thread came back. A phone may have ended the microphone, suspended
   * the audio thread or dropped the provider connection while the screen was off, and the time away
   * was not a silence to hold against the reciter. What did not survive is restarted on the
   * existing paths, and the person is told why.
   */
  private async recover() {
    if (!this.listening || !this.mic || this.recovering || document.visibilityState !== 'visible') return;
    const generation = this.captureGeneration;
    const previousMic = this.mic;
    let ownedMic = previousMic;
    const current = () => this.listening && generation === this.captureGeneration && this.mic === ownedMic;
    this.recovering = true;
    try {
      const away = this.awaySince === null ? 0 : performance.now() - this.awaySince;
      // Only a suspension is forgiven: a desktop tab that was merely hidden kept listening (and its idle clock).
      if (this.awaySince !== null) this.lastArabicAt = Math.max(this.lastArabicAt, performance.now());
      if (!previousMic.live) {
        const mic = await this.openMic(generation);
        if (!current()) return mic.close();
        previousMic.close();
        this.mic = mic;
        ownedMic = mic;
        this.awaySince = null;
        if (this.line) return this.askAgain();
        if (!this.dozing) void this.restart();
        return this.tell(BACK_ON_SCREEN);
      }
      const resumed = await previousMic.resume();
      if (!current()) return;
      if (!resumed) {
        this.waitForTap();
        return this.tell(this.awaySince !== null ? TAP_TO_CONTINUE : TAP_TO_LISTEN, true);
      }
      if (!this.listening) return;
      this.awaySince = null;
      if (this.notice === TAP_TO_CONTINUE || this.notice === TAP_TO_LISTEN) this.clearNotice();
      if (this.line) return this.askAgain(); // waiting in line: the place may have come meanwhile
      if (this.dozing) return; // nothing was streaming; the voice detector hears the voice return
      const rec = this.recording;
      const answered = this.lastResultAt > 0 && performance.now() - this.lastResultAt < 2_000;
      if (rec && LIVE_STATES.has(rec.state) && (away < STALE_AFTER_MS || answered)) return;
      void this.restart();
      this.tell(BACK_ON_SCREEN);
    } catch (e) {
      if (!current()) return;
      const detail = describeError(e);
      const epoch = this.epoch;
      this.teardown();
      this.setStatus({ state: 'error', detail });
      this.capture(epoch, 'error', detail);
    } finally {
      if (generation === this.captureGeneration) this.recovering = false;
    }
  }

  /** Resumes the audio thread on the next touch (on iOS a touch lets a page start audio again). */
  private waitForTap() {
    if (this.tapWaiter) return;
    const onTap = () => {
      this.tapWaiter?.();
      void this.mic?.resume(); // inside the touch, where iOS allows it
      void this.recover();
    };
    document.addEventListener('pointerup', onTap, true);
    document.addEventListener('keydown', onTap, true);
    this.tapWaiter = () => {
      document.removeEventListener('pointerup', onTap, true);
      document.removeEventListener('keydown', onTap, true);
      this.tapWaiter = null;
    };
  }

  /** Shows `text` while listening goes on; a sticky notice stays until what it asks for is done. */
  private tell(text: string, sticky = false) {
    this.notice = text;
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    this.noticeTimer = sticky ? null : setTimeout(() => this.clearNotice(), NOTICE_MS);
    if (this.active) this.setStatus({ ...this.status, detail: text });
  }

  private clearNotice() {
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    this.noticeTimer = null;
    const text = this.notice;
    this.notice = null;
    if (this.active && text && this.status.detail === text) this.setStatus({ ...this.status, detail: this.line ? lineText(this.line.position) : null });
  }

  /** A provider stream on the open microphone (its own key and container header). */
  private openStream(epoch: number) {
    const mic = this.mic;
    if (!mic) return;
    this.startedAt = performance.now();
    this.lastResultAt = 0;
    this.lastProcMs = 0;
    const { source: audio, pcm } = mic.streamSource(TIMESLICE_MS, TUNING.pcm);
    const source = new TimedSource(audio);
    this.timed = source;
    const rec = this.client().realtime.record({
      model: 'stt-rt-v5',
      // WebM/Opus is recognised by its header; raw PCM (Safari before 18.4) has to be described.
      ...(pcm ? PCM_FORMAT : {}),
      // Arabic only: with English also hinted, plainly read (unmelodic) recitation is often written
      // in Latin letters. English requests are still transcribed as English (measured in the lab).
      language_hints: TUNING.hints ?? ['ar'],
      enable_endpoint_detection: true,
      ...(TUNING.max_endpoint_delay_ms !== undefined ? { max_endpoint_delay_ms: TUNING.max_endpoint_delay_ms } : {}),
      ...(TUNING.endpoint_sensitivity !== undefined ? { endpoint_sensitivity: TUNING.endpoint_sensitivity } : {}),
      ...(TUNING.endpoint_latency_adjustment_level !== undefined ? { endpoint_latency_adjustment_level: TUNING.endpoint_latency_adjustment_level } : {}),
      ...(TUNING.language_hints_strict !== undefined ? { language_hints_strict: TUNING.language_hints_strict } : {}),
      context: {
        general: [
          { key: 'domain', value: 'Quran recitation in Arabic (Hafs)' },
          { key: 'also', value: 'occasional short English navigation requests' },
        ],
      },
      source,
      auto_reconnect: true,
      max_reconnect_attempts: 3,
      reset_transcript_on_reconnect: true,
    });
    this.recording = rec;
    rec.on('result', (r) => {
      if (this.recording === rec) this.onResult(r, this.epoch);
    });
    rec.on('finalized', () => {
      this.finalizeWaiter?.(false);
    });
    rec.on('session_restart', () => {
      // Provider coordinates reset on reconnect: bind a new epoch so old offsets never apply.
      if (this.recording !== rec || this.commandOnly) return;
      const e = this.nextEpoch();
      this.capture(e, 'recording');
      this.lastResultAt = 0;
      this.startedAt = performance.now();
    });
    rec.on('state_change', ({ new_state }) => {
      if (this.recording !== rec || this.stopping) return;
      if (new_state === 'recording') {
        // "Recording" here only means the socket opened: out of the line once the recogniser
        // answers (it may still refuse the stream), or after a moment without a refusal.
        if (this.line) return this.confirmTurn(rec);
        this.setStatus({ state: 'recording', detail: this.notice });
        if (!this.commandOnly) this.capture(this.epoch, 'recording');
      } else if (new_state === 'reconnecting') {
        this.setStatus({ state: 'reconnecting', detail: RECONNECTING });
        if (!this.commandOnly) this.capture(this.epoch, 'reconnecting');
      }
    });
    rec.on('source_muted', () => !this.commandOnly && this.capture(this.epoch, 'muted'));
    rec.on('source_unmuted', () => !this.commandOnly && this.capture(this.epoch, 'unmuted'));
    rec.on('error', (e) => {
      if (this.recording !== rec || this.stopping) return;
      // Every place taken: wait in line. Refused by the relay itself (let in, then full after all),
      // this page is first in line: it asks again shortly to learn so.
      const refusal = (e as { raw?: { error_type?: unknown } })?.raw?.error_type;
      if (this.lineAnswer !== undefined || (refusal === 'listening_busy' && !this.commandOnly)) {
        const answered = this.lineAnswer !== undefined;
        const position = this.lineAnswer ?? null;
        this.lineAnswer = undefined;
        this.waitInLine(position, answered ? LINE_ASK_MS : 2_000);
        return;
      }
      // The reciter's own key refused (not accepted, or its account's limit or balance): listening
      // carries on at once with the shared hours, and says why. The key is tried again once changed.
      const ownRefused = this.ownRefused ?? (refusal === 'own_key_refused' && e instanceof Error ? e.message : null);
      this.ownRefused = null;
      if (ownRefused && !this.commandOnly) {
        this.ownKeyFailed = true;
        this.onOwnKeyProblem?.(ownRefused);
        this.tell(`${ownRefused} Listening continues on the shared hours.`);
        void this.restart();
        return;
      }
      // Out of listening time: stop cleanly (the page keeps its place) and say why.
      // The relay's own refusals (listening full, or unavailable) are a clean stop with its words.
      if (!this.noCredits && (refusal === 'listening_busy' || refusal === 'listening_unavailable')) this.noCredits = e instanceof Error ? e.message : BUSY;
      // Live on stream: nothing that can pass by itself stops the broadcast's listening (the
      // connection or the server back, hours added, the overlay reconnected after a restart). It is
      // tried again shortly, saying why only when it is not the connection.
      const unreachable = this.unreachable;
      this.unreachable = false;
      const passing = this.noCredits || unreachable || lostConnection(e) || refusal === 'listening_cooldown' || refusal === 'listening_paused';
      if (this.live && !this.commandOnly && passing) {
        const why = this.poolEmpty || refusal === 'listening_unavailable' ? this.noCredits : null;
        this.noCredits = null;
        return this.reconnectLive(why);
      }
      if (this.noCredits) {
        const detail = this.noCredits;
        this.noCredits = null;
        this.stop();
        this.setStatus({ state: 'off', detail });
        return;
      }
      // Each provider key has a maximum length (hosted: at most the time left, and 20 min per key).
      // Reaching it is not a failure: continue on a fresh key, which the server grants only if time
      // remains.
      const msg = e instanceof Error ? e.message : String(e);
      if (!this.commandOnly && /session duration limit/i.test(msg) && performance.now() - this.startedAt > 10_000) {
        void this.restart();
        return;
      }
      const detail = describeError(e);
      this.teardown();
      this.setStatus({ state: 'error', detail });
      if (!this.commandOnly) this.capture(this.epoch, 'error', detail);
      this.finalizeWaiter?.(true);
    });
    if (!this.commandOnly) this.restartTimer = setTimeout(() => void this.restart(), PROACTIVE_RESTART_MS);
    void epoch;
  }

  // ---------- waiting in line ----------

  /**
   * Every place to listen is taken: wait in line. The microphone stays open and nothing is sent;
   * the page asks again every LINE_ASK_MS (the answer says where it stands) and at once when the
   * server says a place is free, and listening then starts by itself.
   */
  private waitInLine(position: number | null, askInMs: number) {
    const entering = !this.line;
    this.endStream();
    this.dozing = false;
    this.line = { position: position ?? this.line?.position ?? null };
    this.setStatus({ state: 'waiting', detail: lineText(this.line.position) });
    if (entering) this.capture(this.epoch, 'waiting');
    if (this.lineTimer) clearTimeout(this.lineTimer);
    const soon = this.turnPending;
    this.turnPending = false;
    this.lineTimer = setTimeout(() => this.askAgain(), soon ? 250 : askInMs);
  }

  /** Asks for a place: listening starts if one is free; otherwise the answer updates the place in line. */
  private askAgain() {
    if (!this.line || !this.listening || !this.mic) return;
    if (this.recording && performance.now() - this.askedAt < LINE_ASK_TIMEOUT_MS) {
      this.turnPending = true; // an ask is under way: ask again right after its answer
      return;
    }
    if (this.lineTimer) clearTimeout(this.lineTimer);
    this.endStream(); // an ask lost while the phone was asleep, if any
    this.askedAt = performance.now();
    this.nextEpoch(); // a stream of its own, announced to the server once it is open
    this.openStream(this.epoch);
    this.lineTimer = setTimeout(() => this.askAgain(), LINE_ASK_TIMEOUT_MS);
  }

  /** The reciter saved or removed their own key: the next stream uses it (or the shared hours). */
  ownKeyChanged() {
    this.ownKeyFailed = false;
    this.onOwnKeyProblem?.(null);
  }

  /** Whether the session is live on stream (from the server's snapshots). */
  setLive(on: boolean) {
    if (on) this.liveUntil = Infinity;
    else if (this.liveUntil === Infinity) this.liveUntil = performance.now() + LIVE_GRACE_MS;
  }

  private get live() {
    return performance.now() < this.liveUntil;
  }

  /** Live on stream and no stream for now: listening stays on and a new one is tried shortly. */
  private reconnectLive(why: string | null = null) {
    this.endStream();
    this.dozing = false;
    const delay = LIVE_RETRY_MS[this.liveRetries] ?? 15_000;
    this.liveRetries++;
    this.setStatus({ state: 'reconnecting', detail: why ? `${why} Trying again by itself…` : LIVE_RECONNECTING });
    this.capture(this.epoch, 'reconnecting');
    if (this.liveRetryTimer) clearTimeout(this.liveRetryTimer);
    this.liveRetryTimer = setTimeout(() => {
      this.liveRetryTimer = null;
      if (!this.listening || !this.mic || this.recording || this.line) return;
      const epoch = this.nextEpoch();
      this.capture(epoch, 'starting');
      this.openStream(epoch);
    }, delay);
  }

  /** The server says a place is free for this page, which is waiting in line. */
  onTurn() {
    if (this.line) this.askAgain();
  }

  private confirmTurn(rec: Recording) {
    if (this.lineTimer) clearTimeout(this.lineTimer);
    this.lineTimer = setTimeout(() => {
      if (this.recording === rec) this.leaveLine();
    }, 2000);
  }

  /** A place was free and the recogniser took the stream: listening starts, and the reciter is told. */
  private leaveLine() {
    this.line = null;
    if (this.lineTimer) clearTimeout(this.lineTimer);
    this.lineTimer = null;
    this.turnPending = false;
    this.lastArabicAt = performance.now();
    this.capture(this.epoch, 'starting');
    this.capture(this.epoch, 'recording');
    this.setStatus({ state: 'recording', detail: this.notice });
    this.tell(YOUR_TURN);
  }

  // ---------- silence skipper ----------

  private onVoice(e: 'voice' | 'quiet') {
    if (!this.active || this.commandOnly || this.stopping) return;
    if (e === 'quiet') this.doze();
    else if (this.dozing) this.wake();
  }

  /**
   * Breaths between words, for keeping the highlight in step (the server's pace.ts): sent when the
   * voice stops or returns, stamped with the provider audio time it happened.
   */
  private onPause(speaking: boolean) {
    const origin = this.timed?.audioOrigin;
    if (!this.active || this.commandOnly || this.dozing || !this.recording || origin === null || origin === undefined) return;
    const audioMs = Math.max(0, performance.now() - origin - (speaking ? VOICE_ONSET_MS : PAUSE_QUIET_MS));
    this.send({ type: 'voice', captureEpoch: this.epoch, speaking, audioMs });
  }

  /** Close the provider stream during a long pause; listening stays on. */
  private doze() {
    if (!this.recording || this.dozing || this.resetting || this.router.active || this.status.state !== 'recording') return;
    const epoch = this.epoch;
    this.dozing = true;
    this.endStream();
    this.setStatus({ state: 'dozing', detail: this.notice });
    this.capture(epoch, 'dozing');
  }

  /** The voice is back: a new stream, sent the audio from this moment on (buffered while it connects). */
  private wake() {
    if (!this.dozing || !this.mic) return;
    this.dozing = false;
    const epoch = this.nextEpoch();
    this.capture(epoch, 'starting');
    this.setStatus({ state: 'starting', detail: this.notice });
    this.openStream(epoch);
  }

  private onResult(r: RealtimeResult, epoch: number) {
    if (this.stopping || epoch !== this.epoch) return; // late results after Stop never resume the overlay
    if (this.line) this.leaveLine(); // the recogniser answered: the place is ours
    this.lastProcMs = r.total_audio_proc_ms;
    this.liveRetries = 0; // the recogniser answers: connected again
    this.poolEmpty = false;
    this.lastResultAt = performance.now();
    const tokens: WireToken[] = r.tokens.map((t) => ({
      text: t.text,
      isFinal: t.is_final,
      startMs: t.start_ms,
      endMs: t.end_ms,
      confidence: t.confidence,
    }));
    if (tokens.some((t) => ARABIC.test(t.text))) {
      this.lastArabicAt = performance.now();
      if (this.notice === BACK_ON_SCREEN) this.clearNotice(); // recitation is followed again
    }
    if (!this.commandOnly) this.watchLanguage(tokens);
    const { recitation, finalized } = this.router.route(tokens);
    if (this.router.active) this.onHearing(this.router.hearing());
    if (finalized) this.finalizeWaiter?.(false);
    if (this.commandOnly || !recitation.length) return;
    const now = performance.now();
    const origin = this.timed?.audioOrigin;
    // Where the reciter is now in the provider's audio clock (the tokens say where they were).
    const audioMs = origin === null || origin === undefined ? undefined : Math.max(0, now - origin);
    this.send({ type: 'transcript', captureEpoch: epoch, seq: this.seq++, tokens: recitation, receivedAt: now, ...(audioMs === undefined ? {} : { audioMs }) });
  }

  private watchLanguage(tokens: WireToken[]) {
    let endpoint = false;
    let transliterated = 0;
    let latinWords = 0;
    for (const t of tokens) {
      const text = t.text.trim();
      if (text === '<end>' || text === '<fin>') endpoint = true;
      else if (ARABIC.test(text)) this.latinTail = false;
      else if (LATIN.test(text)) {
        this.latinTail = true;
        for (const w of text.split(/[^A-Za-z-]+/).filter(Boolean)) {
          latinWords++;
          if (TRANSLITERATED.test(w)) transliterated++;
        }
      }
    }
    // Recitation in Latin letters: reset now. English that just ended: reset before recitation resumes.
    // (An English request that mentions "Allah" is mostly other words; recitation is mostly these.)
    const recitingInLatin = transliterated >= 2 && transliterated * 2 >= latinWords;
    // A plain (unmelodic) reader may always be written in Latin letters; the server reads those, so
    // stop spending audio on restarts after two tries. English speech ending still resets.
    if (recitingInLatin && this.latinResets < 2) {
      this.latinResets++;
      void this.resetLanguage();
    } else if (endpoint && this.latinTail && !recitingInLatin) void this.resetLanguage();
  }

  /** Restart the stream so the recogniser starts without an English bias; keeps the idle clock. */
  private async resetLanguage() {
    const now = performance.now();
    if (this.resetting || now - this.lastResetAt < RESET_MIN_GAP_MS) return;
    this.resetting = true;
    this.lastResetAt = now;
    this.latinTail = false;
    try {
      await this.restart();
    } finally {
      this.resetting = false;
    }
  }

  /** Close the provider stream; the microphone stays open. */
  private endStream() {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    const rec = this.recording;
    this.recording = null;
    this.timed = null;
    try {
      rec?.cancel();
    } catch {
      /* already closed */
    }
  }

  private teardown() {
    this.captureGeneration++;
    this.recovering = false;
    this.endStream();
    if (this.liveRetryTimer) clearTimeout(this.liveRetryTimer);
    this.liveRetryTimer = null;
    this.liveRetries = 0;
    this.unreachable = false;
    if (this.idleTimer) clearInterval(this.idleTimer);
    this.idleTimer = null;
    this.mic?.close();
    this.mic = null;
    this.active = false;
    this.dozing = false;
    this.line = null;
    if (this.lineTimer) clearTimeout(this.lineTimer);
    this.lineTimer = null;
    this.lineAnswer = undefined;
    this.turnPending = false;
    this.awaySince = null;
    this.tapWaiter?.();
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    this.noticeTimer = null;
    this.notice = null;
    this.letScreenSleep();
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.onVisibility);
  }

  /** Stop listening: close the microphone and the connection immediately; ignore anything after. */
  stop() {
    this.consentRequest?.abort();this.consentRequest=null;
    if (!this.active) return;
    this.stopping = true;
    const epoch = this.epoch;
    const wasCommandOnly = this.commandOnly;
    this.teardown();
    this.router.cancel();
    this.lastArabicAt = 0;
    if (!this.resetting) this.latinResets = 0;
    this.setStatus({ state: 'off', detail: null });
    if (!wasCommandOnly) this.capture(epoch, 'stopped');
  }

  private async restart() {
    if (!this.active || !this.mic) return;
    // A new stream on the same microphone: the display and tracker keep their place, and a
    // reconnect is not new speech (the idle clock keeps running).
    const old = this.epoch;
    this.endStream();
    this.dozing = false;
    if (!this.commandOnly) this.capture(old, 'stopped');
    const epoch = this.nextEpoch();
    if (!this.commandOnly) this.capture(epoch, 'starting');
    this.setStatus({ state: 'starting', detail: this.notice });
    this.openStream(epoch);
  }

  // ---------- push-to-talk ----------

  async beginCommand(deviceId: string | null): Promise<void> {
    this.send({ type: 'command_capture', active: true });
    if (!this.active) await this.start(deviceId, { commandOnly: true });
    else if (this.dozing) this.wake();
    this.router.begin(this.audioNowMs());
    this.onHearing('');
  }

  async endCommand(): Promise<CommandCapture> {
    const rec = this.recording;
    this.router.release(this.audioNowMs());
    let result: CommandCapture;
    if (!rec) {
      result = this.router.finish(true);
    } else {
      // Manual finalize is right here: the user explicitly ended the command.
      const timedOut = await new Promise<boolean>((resolve) => {
        const t = setTimeout(() => resolve(true), FINALIZE_WAIT_MS);
        this.finalizeWaiter = (to) => {
          clearTimeout(t);
          resolve(to);
        };
        try {
          rec.finalize();
        } catch {
          clearTimeout(t);
          resolve(true);
        }
      });
      this.finalizeWaiter = null;
      result = this.router.finish(timedOut);
    }
    if (this.commandOnly) this.stop();
    this.send({ type: 'command_capture', active: false });
    return result;
  }
}
