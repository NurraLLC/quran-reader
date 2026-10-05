// Authoritative session: one reciter, one capture stream, one display state. Transport-agnostic
// (app.ts wires WebSockets; replay drives it directly with a virtual clock).
//
// Distinct actions, distinct effects:
//   Stop listening  → capture ends, the verse on screen stays (not "following").
//   Pause following → capture continues privately, the audience display is frozen.
//   Blank           → audience sees nothing; tracking continues underneath.
//   Listening lost  → (the control page gone, or its stream failed) after a grace the ayah is hidden,
//                     never cleared, and it returns by itself when listening does.
//   Manual navigation always publishes (it is explicit), and re-anchors the tracker. Presses in quick
//   succession (a burst, a held arrow key) reach the audience once, where they end (NAV_SETTLE_MS).

import { shortGroup } from './corpus/groups';
import type { WordGlosses } from './corpus/wbw';
import type { LatinReader } from './tracker/latin';
import type { Word } from '../shared/transcript';
import { randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync, statSync } from 'node:fs';
import { EOL } from 'node:os';
import path from 'node:path';
import {
  DEFAULT_STYLE,
  DisplayStyleSchema,
  DonationSchema,
  PROTOCOL_VERSION,
  StreamSettingsSchema,
  type Donation,
  type StreamSettings,
  type StreamState,
  type CapturePhase,
  type CommandResult,
  type ControlClientMessage,
  type ControlServerMessage,
  type ControlSnapshot,
  type ControlSnapshotUpdate,
  type DisplayState,
  type DisplayStyle,
  type TrackerPhase,
} from '../shared/contracts';
import { isMarker, TranscriptBuffer } from '../shared/transcript';
import type { CommandResolver } from './commands/reducer';
import type { Corpus } from './corpus/load';
import type { DecisionClient } from './providers/jev';
import { RecitationFollower, type FollowerEvent, type TrackerMode } from './tracker/follower';
import type { CorpusIndex } from './tracker/index';
import type { ResourceCatalog } from './resources/catalog';
import { realClock, type Clock } from './tracker/scheduler';
import { LiveCursor } from './tracker/live-cursor';
import { Lag, Pace, type Quiet, type Timed } from './tracker/pace';
import { mapDisplayWords, type WordSpan } from './corpus/word-map';
import { ListeningCommands } from './commands/listening';
import { ArabicSurahRequests } from './commands/arabic-request';

/** Listening lost this long hides the ayah from stream: longer than a control page takes to reload. */
export const DISCONNECT_GRACE_MS = 15_000;
/**
 * Next/Previous presses closer together than this are one burst: the first goes on stream at once,
 * the rest only on the control page, and the audience is given where they end this long after the last.
 */
export const NAV_SETTLE_MS = 300;
/** Messages the control page sends by itself (recognition, capture state, measurements): they never end a burst. */
const AUTOMATIC: ReadonlySet<ControlClientMessage['type']> = new Set(['transcript', 'voice', 'capture', 'layout']);
/** A highlight catching up passes each word between for this long (the highlight's own fade). */
const SWEEP_MS = 90;
/** Words heard in one stream beyond which its results are ignored (three hours is ~25,000). */
const MAX_STREAM_WORDS = 60_000;

export type SessionSetup = {
  soniox: boolean;
  jev: { provider: 'typesafe' | 'openrouter' | null; configured: boolean; detail: string };
  semantic: () => string;
};

/** Speech that asks to find something (as opposed to talking about it). */
const EXPLICIT_FIND = /^(please\s+)?((find|show|open|bring up|pull up|go to|take me to)\b|(the\s+|a\s+|which\s+)?(surah|sura|chapter|ayah|aya|verse)\s+(about|on|regarding|where|that|which|with|of|concerning)\b)/i;

export type SessionOptions = {
  corpus: Corpus;
  ix: CorpusIndex;
  resolver: CommandResolver;
  decisionClient: DecisionClient | null;
  mode: TrackerMode;
  setup: SessionSetup;
  overlayUrl: (viewToken: string) => string;
  /** Self-hosted: the overlay link kept from the last run, and where a replaced one is saved. */
  viewToken?: string;
  onViewToken?: (token: string) => void;
  /** Hosted: the visitor's saved look, and where a changed one is saved (overlay-links.ts). */
  style?: unknown;
  onStyle?: (style: DisplayStyle) => void;
  /** A charity stream's settings and donations as last saved, and where a change is saved. */
  stream?: unknown;
  onStream?: (saved: SavedStream) => void;
  /**
   * Self-hosted: the ayah the audience was shown before a restart (and whether it was hidden), and
   * where it is saved whenever the ayah or its hidden state changes (never per highlight step).
   */
  initialDisplay?: { key: string; hidden: boolean } | null;
  onDisplayKey?: (shown: { key: string; hidden: boolean } | null) => void;
  clock?: Clock;
  /** Explicit, bounded, local diagnostic capture of provider token events (no audio). */
  captureDir?: string | null;
  /** Resource relationships (collision neighbours, topics, divisions); optional. */
  catalog?: ResourceCatalog | null;
  /** Word-by-word English glosses (optional resource). */
  glosses?: WordGlosses | null;
  /** Reads recitation that arrives in Latin letters (optional; null until built). */
  latin?: { get(): LatinReader | null } | null;
};

const CAPTURE_MAX_BYTES = 20 * 1024 * 1024;
/** Charity stream: donations kept (newest first; the total counts every one), and how many go to pages. */
const MAX_DONATIONS = 200;
const DONATIONS_SHOWN = 20;

/** What a charity stream keeps between runs: its settings, the latest donations, their sum and count. */
export type SavedStream = { settings: StreamSettings; donations: Donation[]; total: number; count: number };

const pct = (xs: number[], p: number) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor(s.length * p))] * 100) / 100;
};

export class Session {
  readonly sessionEpoch = randomBytes(6).toString('hex');
  private viewToken: string;
  readonly follower: RecitationFollower;
  private readonly clock: Clock;

  private revision = 0;
  private lastPublishedKey = '';
  /** The latest display, as the control page has it. */
  display: DisplayState;
  /** The display as the audience (OBS, reading screens) was last sent it, and its content key. */
  private audienceState: DisplayState;
  private audienceKey = '';
  /** A Next/Previous press was made within NAV_SETTLE_MS; `navHolding`: a burst is under way. */
  private navTimer: unknown = null;
  private navHolding = false;
  /** The control page has a display the audience was not sent yet (during a burst). */
  private audienceBehind = false;
  private displayVerse: number | null = null;
  private trackerVerse: number | null = null;
  private held = false;
  private commandActive = false;
  private heldBySearch = false;
  private blanked = false;
  /** The hide came from listening being lost, not from the broadcaster: listening coming back undoes it. */
  private hiddenByOutage = false;
  /** The explanation shown with that hide (cleared with it). */
  private outageNotice: string | null = null;
  private pinned = false;
  private startHint: number | null = null;
  private style: DisplayStyle = { ...DEFAULT_STYLE };
  private englishPage: number | null = null;
  private arabicPage: number | null = null;
  private progress: number | null = null;
  private cursor: DisplayState['cursor'] = null;
  private readonly liveCursor: LiveCursor;
  /** Keeps the highlight on the word being recited, not the last one recognised (pace.ts). */
  private readonly pace: Pace;
  /** Newest evidence of the word being recited, and the word highlighted now (global positions). */
  private evidence: Timed | null = null;
  /** The evidence is a word taken from its first letters only (pace.begun). */
  private evidenceGuessed = false;
  private shownPos: number | null = null;
  /** When each word of the ayah on screen was first highlighted (audio ms), and words already timed: the speed meter. */
  private readonly shownAt = new Map<number, number>();
  private readonly measured = new Set<number>();
  /** Provider audio time minus this clock, from the control page's audio clock (per stream). */
  private audioOffset: number | null = null;
  /** Silences the control page's microphone heard in this stream (provider audio ms), newest last. */
  private quiet: Quiet[] = [];
  /** Start of the newest heard piece (provider audio ms) in this stream. */
  private heardMs = -Infinity;
  /** How late the recogniser reports speech (kept across streams: same provider and network). */
  private readonly lag = new Lag();
  private paceTimer: unknown = null;
  private liveFloor = 0;
  /** "سورة الرحمن" heard in Arabic script: requests are looked for in finals from here on. */
  private readonly arabicRequests: ArabicSurahRequests;
  private arabicScan = 0;
  private liveVerse: number | null = null;
  private readonly wordMaps = new Map<number, Array<WordSpan | null>>();
  private batchingTranscript = false;
  private readonly listeningCommands: ListeningCommands;
  private englishTail = false;
  private layout: ControlSnapshot['layout'] = null;
  private notice: string | null = null;

  private capture: ControlSnapshot['capture'] = { phase: 'off', captureEpoch: 0, detail: null, since: 0 };
  private buffer = new TranscriptBuffer();
  private lastSeq = -1;
  private captureFile: string | null = null;
  private captureStart = 0;
  private disconnectTimer: unknown = null;
  private pageTimer: unknown = null;
  private pageTimerKey = '';

  private latestCommand: { id: string; ctrl: AbortController; keys: Set<string> } | null = null;
  private readonly sentAt = new Map<number, number>();
  readonly paintRtts: number[] = [];
  private snapshotTimer: unknown = null;

  private readonly displayListeners = new Set<(s: DisplayState) => void>();
  private readonly streamListeners = new Set<(s: StreamState) => void>();
  private streamSettings: StreamSettings = StreamSettingsSchema.parse({});
  /** Newest first; the sum and count cover every donation, including ones no longer kept. */
  private donations: Donation[] = [];
  private donationSum = 0;
  private donationCount = 0;
  private readonly controlListeners = new Set<(m: ControlServerMessage) => void>();
  controlClients = 0;
  overlayClients = 0;
  readonly log: Array<{ t: number; event: string; key?: string | null; detail?: string }> = [];

  constructor(private readonly o: SessionOptions) {
    this.clock = o.clock ?? realClock;
    this.liveCursor = new LiveCursor(o.ix);
    this.pace = new Pace(o.ix, o.corpus);
    this.viewToken = o.viewToken ?? randomBytes(18).toString('base64url');
    this.arabicRequests = ArabicSurahRequests.for(o.corpus.data.chapters);
    this.listeningCommands = new ListeningCommands(o.decisionClient, this.clock, (text, id, intent) => {
      if (this.capture.phase !== 'recording' || this.commandActive) return;
      void this.command(id, text, intent === 'show');
    }, message => this.say(message));
    const saved = o.style ? DisplayStyleSchema.safeParse({ ...DEFAULT_STYLE, ...(o.style as object) }) : null;
    if (saved?.success) this.style = saved.data;
    this.restoreStream(o.stream);
    this.follower = new RecitationFollower(o.ix, o.corpus.id, this.sessionEpoch, o.decisionClient, o.mode, (e) => this.onFollower(e), this.clock);
    // When recitation stops matching (a jump to somewhere new, a pause to talk), the last ayah stays
    // up until the new place is found: a blank screen tells the audience nothing. The control page
    // can still choose to clear after 3 s.
    this.follower.engine.cfg = { ...this.follower.engine.cfg, keepOnUncertain: true };
    if (o.catalog) attachCatalog(this.follower, o.catalog);
    // After a restart the stream comes back to the ayah it showed, hidden if it was, and following
    // carries on from there (the reconnecting control page announces its stream again).
    const restored = o.initialDisplay ? o.corpus.verse(o.initialDisplay.key) : undefined;
    if (restored) {
      this.displayVerse = restored.index;
      this.trackerVerse = restored.index;
      this.follower.seek(restored.index);
      this.blanked = o.initialDisplay!.hidden;
      this.logEvent('restore', restored.key, this.blanked ? 'hidden' : undefined);
    }
    this.display = this.buildDisplay();
    this.audienceState = this.display;
    this.shownSaved = restored ? `${restored.key}|${this.blanked}` : '';
  }

  // ---------- subscriptions ----------

  onDisplay(fn: (s: DisplayState) => void) {
    this.displayListeners.add(fn);
    return () => this.displayListeners.delete(fn);
  }

  /** The charity stream's data changed (settings, or a donation added or taken back). */
  onStream(fn: (s: StreamState) => void) {
    this.streamListeners.add(fn);
    return () => this.streamListeners.delete(fn);
  }

  get stream(): StreamState {
    return { settings: this.streamSettings, donations: this.donations.slice(0, DONATIONS_SHOWN), total: Math.round((this.streamSettings.raisedBefore + this.donationSum) * 100) / 100, count: this.donationCount };
  }

  private restoreStream(raw: unknown) {
    if (!raw || typeof raw !== 'object') return;
    const r = raw as { settings?: unknown; donations?: unknown; total?: unknown; count?: unknown };
    const settings = StreamSettingsSchema.safeParse(r.settings ?? {});
    if (settings.success) this.streamSettings = settings.data;
    const donations = DonationSchema.array().max(MAX_DONATIONS).safeParse(r.donations ?? []);
    if (donations.success) this.donations = donations.data;
    const sum = this.donations.reduce((n, d) => n + d.amount, 0);
    this.donationSum = typeof r.total === 'number' && Number.isFinite(r.total) && r.total >= sum ? r.total : sum;
    this.donationCount = typeof r.count === 'number' && Number.isInteger(r.count) && r.count >= this.donations.length ? r.count : this.donations.length;
  }

  private streamChanged() {
    const s = this.stream;
    for (const fn of this.streamListeners) fn(s);
    this.emitControl({ type: 'stream', state: s });
    this.o.onStream?.({ settings: this.streamSettings, donations: this.donations, total: this.donationSum, count: this.donationCount });
  }

  onControl(fn: (m: ControlServerMessage) => void) {
    this.controlListeners.add(fn);
    return () => this.controlListeners.delete(fn);
  }

  checkView(token: string) {
    return token.length === this.viewToken.length && token === this.viewToken;
  }

  chapters() {
    return this.o.corpus.data.chapters.map((c) => ({ number: c.number, nameSimple: c.nameSimple, nameArabic: c.nameArabic, verseCount: c.verseCount }));
  }

  /** A whole surah for the reader: display Arabic, translation and word meanings per ayah. */
  surah(n: number) {
    const ch = this.o.corpus.chapter(n);
    if (!ch) return null;
    const first = this.o.corpus.verse(`${n}:1`)!.index;
    const ayahs = [];
    for (let i = first; i < first + ch.verseCount; i++) {
      const v = this.o.corpus.at(i)!;
      ayahs.push({ key: v.key, ayah: v.ayah, arabic: v.arabicDisplay, english: v.english, glosses: this.o.glosses?.get(v.key) ?? null });
    }
    return { number: ch.number, name: ch.nameSimple, nameArabic: ch.nameArabic, translation: this.o.corpus.data.manifest.translation.name, glossCredit: this.o.glosses?.attribution ?? null, ayahs };
  }

  card(key: string) {
    const v = this.o.corpus.verse(key);
    return v ? this.o.resolver.card(v.index) : null;
  }

  get overlayUrl() {
    return this.o.overlayUrl(this.viewToken);
  }

  // ---------- display ----------

  private verseLabel(i: number | null) {
    return i === null ? null : this.o.corpus.at(i)!.key;
  }

  private buildDisplay(): DisplayState {
    const v = this.displayVerse === null ? null : this.o.corpus.at(this.displayVerse)!;
    const ch = v ? this.o.corpus.chapter(v.surah)! : null;
    const grouped = v && this.style.groupShort && this.style.readingMode !== 'word' ? shortGroup(this.o.corpus, this.displayVerse!) : [];
    const group = grouped.length > 1 ? grouped.map((i) => this.o.corpus.at(i)!) : null;
    // Within a group the upcoming ayahs are already on screen; preview only what follows the group.
    const nextIndex = group ? (grouped.at(-1) === this.displayVerse ? this.displayVerse! + 1 : -1) : (this.displayVerse ?? -2) + 1;
    const n = v && this.style.showNext && this.style.readingMode !== 'word' && nextIndex >= 0 ? this.o.corpus.at(nextIndex) : undefined;
    return {
      v: PROTOCOL_VERSION,
      revision: this.revision,
      sessionEpoch: this.sessionEpoch,
      visible: !this.blanked && !!v,
      verse:
        v && ch
          ? {
              key: v.key,
              surah: v.surah,
              ayah: v.ayah,
              arabic: v.arabicDisplay,
              english: v.english,
              surahName: ch.nameSimple,
              surahNameArabic: ch.nameArabic,
              translationName: this.o.corpus.data.manifest.translation.name,
              glosses: this.o.glosses?.get(v.key) ?? null,
              glossCredit: this.o.glosses ? this.o.glosses.attribution : null,
            }
          : null,
      style: this.style,
      englishPage: this.englishPage,
      arabicPage: this.arabicPage,
      progress: this.progress,
      cursor: this.cursor,
      group: group ? group.map((g) => ({ key: g.key, ayah: g.ayah, arabic: g.arabicDisplay, english: g.english })) : null,
      next: n ? { key: n.key, surah: n.surah, ayah: n.ayah, arabic: n.arabicDisplay, english: n.english, surahName: n.surah !== v!.surah ? this.o.corpus.chapter(n.surah)!.nameSimple : null } : null,
    };
  }

  /** Publish only real changes; a repeated frame is not dispatched. */
  private publish() {
    if (this.batchingTranscript) return;
    const next = this.buildDisplay();
    const key = JSON.stringify({ ...next, revision: 0 });
    if (key !== this.lastPublishedKey) {
      this.lastPublishedKey = key;
      this.revision++;
      this.display = { ...next, revision: this.revision };
      // During a burst of Next/Previous presses only the control page follows each press; the
      // audience is sent where the presses end (endNavBurst).
      if (this.navHolding) this.audienceBehind = true;
      else this.toAudience();
      this.emitControl({ type: 'display', state: this.display });
      this.rememberShown();
      this.schedulePageTimer();
      if (this.pendingSpeed) this.speed = { revision: this.revision, ...this.pendingSpeed };
    }
    this.pendingSpeed = null;
    this.queueSnapshot();
  }

  /** What an overlay (OBS, a reading screen) is given when it connects: what the audience was last sent. */
  get audienceDisplay(): DisplayState {
    return this.audienceState;
  }

  /** Sends the latest display to the audience, unless it already has the same. */
  private toAudience() {
    this.audienceBehind = false;
    if (this.audienceKey === this.lastPublishedKey) return;
    this.audienceKey = this.lastPublishedKey;
    this.audienceState = this.display;
    this.sentAt.set(this.display.revision, this.clock.now());
    if (this.sentAt.size > 64) this.sentAt.delete(this.sentAt.keys().next().value!);
    for (const fn of this.displayListeners) fn(this.display);
  }

  /**
   * A Next/Previous press. A press soon after another starts or continues a burst: the control page
   * follows every press (the broadcaster sees where they are), and the audience is sent only where
   * the presses end, NAV_SETTLE_MS after the last, instead of each ayah between for a tenth of a second.
   */
  private navPress(to: number) {
    if (this.navTimer !== null) {
      this.clock.clearTimeout(this.navTimer);
      this.navHolding = true;
    }
    this.navTimer = this.clock.setTimeout(() => {
      this.navTimer = null;
      this.endNavBurst();
    }, NAV_SETTLE_MS);
    this.gotoIndex(to, 'manual');
  }

  /** The presses stopped: the audience is sent where they ended. */
  private endNavBurst() {
    this.releaseNav();
    this.catchUpAudience();
  }

  /** No longer a burst: the next change reaches the audience at once. */
  private releaseNav() {
    if (this.navTimer !== null) this.clock.clearTimeout(this.navTimer);
    this.navTimer = null;
    this.navHolding = false;
  }

  /** The audience is sent the control page's display if a burst left it behind. */
  private catchUpAudience() {
    if (!this.audienceBehind || this.navHolding) return;
    this.toAudience();
    this.rememberShown();
  }

  /**
   * Something the broadcaster did besides Next/Previous ends a burst: its own change (a typed
   * reference, Hide) reaches the audience at once, never the burst's last press just before it, and
   * if it changed nothing on screen the audience catches up with where the presses got to.
   */
  private settleNav(act: () => void) {
    this.releaseNav();
    act();
    this.catchUpAudience();
  }

  /** `${ayah}|${hidden}` as last saved (onDisplayKey). */
  private shownSaved = '';
  private saveWarned = false;

  /** Saves the ayah the audience was shown, and whether it is hidden, when either changes. */
  private rememberShown() {
    if (!this.o.onDisplayKey) return;
    const v = this.audienceState.verse;
    const shown = v ? { key: v.key, hidden: !this.audienceState.visible } : null;
    const key = shown ? `${shown.key}|${shown.hidden}` : '';
    if (key === this.shownSaved) return;
    this.shownSaved = key;
    try {
      this.o.onDisplayKey(shown);
    } catch (e) {
      // Best effort: the stream never waits for, or fails with, the disk.
      if (!this.saveWarned) console.warn('Could not save the ayah on screen for after a restart:', e instanceof Error ? e.message : e);
      this.saveWarned = true;
    }
  }

  private showVerse(i: number | null) {
    if (i !== this.displayVerse) {
      this.englishPage = null;
      this.arabicPage = null;
      this.progress = null;
      this.cursor = null;
      if (this.layout && this.layout.key !== this.verseLabel(i)) this.layout = null;
    }
    this.displayVerse = i;
  }

  private schedulePageTimer() {
    const secs = this.style.translationPageSeconds;
    const pages = this.layout && this.layout.key === this.verseLabel(this.displayVerse) ? this.layout.englishPages : 1;
    const key = !secs || pages <= 1 || !this.display.visible ? '' : `${this.displayVerse}|${this.englishPage}|${pages}|${secs}`;
    // Only a new ayah, page, page count or interval restarts the count: the highlight moves several
    // times a second, and restarting on every change meant the translation never turned while reciting.
    if (key === this.pageTimerKey && (!key || this.pageTimer !== null)) return;
    if (this.pageTimer !== null) this.clock.clearTimeout(this.pageTimer);
    this.pageTimer = null;
    this.pageTimerKey = key;
    if (!key) return;
    this.pageTimer = this.clock.setTimeout(() => {
      this.pageTimer = null;
      this.englishPage = ((this.englishPage ?? 0) + 1) % pages;
      this.publish();
    }, secs * 1000);
  }

  // ---------- follower events ----------

  private onFollower(e: FollowerEvent) {
    if (e.kind === 'commit') {
      this.trackerVerse = e.verseIndex;
      this.logEvent('commit', this.verseLabel(e.verseIndex), `${e.reason} via ${e.via}`);
      if (!this.held && !this.commandActive && this.liveVerse === null) this.showVerse(e.verseIndex);
      this.publish();
    } else if (e.kind === 'clear') {
      this.trackerVerse = null;
      this.liveVerse = null;
      this.resetLive();
      this.cursor = null;
      this.logEvent(e.keepDisplay ? 'lost' : 'clear', null, e.reason);
      // Kept on screen (the default): the place is forgotten, so the next one is found as quickly
      // as from a clear screen, but the audience keeps the last ayah until then.
      if (!this.held && !e.keepDisplay) this.showVerse(null);
      this.publish();
    } else if (e.kind === 'step') {
      this.candidatesView = e.step.top.slice(0, 5).map((c) => ({
        key: this.o.corpus.at(c.verseIndex)!.key,
        score: Math.round(c.score * 100) / 100,
        relation: c.relation,
        matched: c.matched,
        trailing: c.trailing,
      }));
      const p = e.step.progress;
      if (p && !this.held && !this.commandActive && this.liveVerse === null && p.verseIndex === this.displayVerse) {
        const len = this.o.ix.verseLen[p.verseIndex];
        const q = len ? Math.round((Math.min(p.word + 1, len) / len) * 20) / 20 : null;
        if (q !== this.progress) {
          this.progress = q;
          this.publish();
          return;
        }
      }
      this.queueSnapshot();
    } else {
      this.queueSnapshot();
    }
  }

  // ---------- control input ----------

  handle(msg: ControlClientMessage) {
    if (msg.type === 'nav' || AUTOMATIC.has(msg.type)) return this.apply(msg);
    this.settleNav(() => this.apply(msg));
  }

  private apply(msg: ControlClientMessage) {
    switch (msg.type) {
      case 'transcript':
        return this.onTranscript(msg);
      case 'voice':
        return this.onVoice(msg);
      case 'capture':
        return this.onCapture(msg);
      case 'nav': {
        const base = this.displayVerse ?? this.trackerVerse ?? this.startHint;
        if (base === null) return this.say('Nothing is on screen yet — pick a starting ayah or search first.');
        const to = base + (msg.action === 'next' ? 1 : -1);
        if (to < 0 || to >= this.o.corpus.verses.length) return this.say(msg.action === 'next' ? 'That is the last ayah.' : 'That is the first ayah.');
        return this.navPress(to);
      }
      case 'goto': {
        const v = this.o.corpus.verse(msg.key);
        if (!v) return this.say(`${msg.key} is not a valid reference.`);
        return this.gotoIndex(v.index, 'manual');
      }
      case 'hold':
        return msg.on ? this.hold() : this.resume();
      case 'blank':
        // Hide and Unhide are the broadcaster's: a hide they choose is never undone for them.
        this.endOutageHide();
        this.blanked = msg.on;
        this.logEvent(msg.on ? 'blank' : 'unblank', this.verseLabel(this.displayVerse));
        return this.publish();
      case 'pin':
        this.pinned = msg.on;
        return this.queueSnapshot();
      case 'style': {
        const next = DisplayStyleSchema.safeParse({ ...this.style, ...msg.patch });
        if (next.success) {
          this.style = next.data;
          this.o.onStyle?.(this.style);
        }
        return this.publish();
      }
      case 'page':
        if (msg.region === 'english') this.englishPage = msg.page;
        else this.arabicPage = msg.page;
        return this.publish();
      case 'arabic_auto':
        this.arabicPage = null;
        return this.publish();
      case 'english_auto':
        this.englishPage = null;
        return this.publish();
      case 'layout':
        if (msg.revision === this.revision && msg.key === this.verseLabel(this.displayVerse)) {
          this.layout = { key: msg.key, englishPages: msg.englishPages, arabicPages: msg.arabicPages, promotedToFullFrame: msg.promotedToFullFrame };
          this.schedulePageTimer();
          this.queueSnapshot();
        }
        return;
      case 'mode':
        this.follower.setMode(msg.mode);
        this.logEvent('mode', null, msg.mode);
        return this.queueSnapshot();
      case 'start_hint': {
        const v = msg.key ? this.o.corpus.verse(msg.key) : null;
        if (msg.key && !v) return this.say(`${msg.key} is not a valid reference.`);
        this.startHint = v ? v.index : null;
        this.follower.setPrior(this.startHint);
        return this.queueSnapshot();
      }
      case 'uncertain_policy':
        this.follower.engine.cfg = { ...this.follower.engine.cfg, keepOnUncertain: msg.keep };
        return this.queueSnapshot();
      case 'command':
        void this.command(msg.requestId, msg.text, !!msg.show);
        return;
      case 'show_result': {
        const c = this.latestCommand;
        if (!c || c.id !== msg.requestId || !c.keys.has(msg.key)) return this.say('That search result is out of date; search again.');
        const v = this.o.corpus.verse(msg.key)!;
        this.gotoIndex(v.index, 'search');
        this.held = true;
        this.heldBySearch = true;
        this.say(`Showing ${msg.key} from search. Following is paused — Resume following continues from here.`);
        return this.publish();
      }
      case 'command_capture':
        this.commandActive = msg.active;
        this.listeningCommands.cancel();
        if (msg.active) this.follower.stop();
        return this.queueSnapshot();
      case 'rotate_view':
        this.viewToken = randomBytes(18).toString('base64url');
        this.o.onViewToken?.(this.viewToken);
        this.logEvent('rotate_view', null);
        for (const fn of this.revokeListeners) fn();
        return this.queueSnapshot();
      case 'stream_settings': {
        const next = StreamSettingsSchema.safeParse({ ...this.streamSettings, ...msg.patch });
        if (!next.success) return this.say('Those stream settings were not saved. Links must start with https://.');
        this.streamSettings = next.data;
        return this.streamChanged();
      }
      case 'donation': {
        // Wall-clock time: the stream shows how long ago each one came ("4 min").
        const d: Donation = { id: randomBytes(9).toString('base64url'), name: msg.name, amount: Math.round(msg.amount * 100) / 100, message: msg.message, at: Date.now() };
        this.donations = [d, ...this.donations].slice(0, MAX_DONATIONS);
        this.donationSum = Math.round((this.donationSum + d.amount) * 100) / 100;
        this.donationCount++;
        this.logEvent('donation', null);
        return this.streamChanged();
      }
      case 'donation_remove': {
        const i = this.donations.findIndex((d) => d.id === msg.id);
        if (i < 0) return;
        const [d] = this.donations.splice(i, 1);
        this.donationSum = Math.max(0, Math.round((this.donationSum - d.amount) * 100) / 100);
        this.donationCount = Math.max(0, this.donationCount - 1);
        return this.streamChanged();
      }
    }
  }

  readonly revokeListeners = new Set<() => void>();
  /** Called when the session is dropped: open overlays reconnect (their link finds the new session). */
  readonly endListeners = new Set<() => void>();

  private say(text: string) {
    this.notice = text;
    this.queueSnapshot();
  }

  private logEvent(event: string, key?: string | null, detail?: string) {
    this.log.push({ t: this.clock.now(), event, key, detail });
    if (this.log.length > 500) this.log.shift();
  }

  gotoIndex(i: number, source: 'manual' | 'search' | 'command') {
    this.listeningCommands.cancel();
    this.resetLive();
    this.liveVerse = null;
    this.liveFloor = this.buffer.liveWords().length;
    this.cursor = null;
    this.latestCommand?.ctrl.abort();
    this.showVerse(i);
    this.trackerVerse = i;
    this.follower.seek(i);
    this.notice = null;
    this.logEvent('goto', this.verseLabel(i), source);
    this.publish();
  }

  private hold() {
    this.held = true;
    this.heldBySearch = false;
    this.logEvent('hold', this.verseLabel(this.displayVerse));
    this.publish();
  }

  private resume() {
    this.held = false;
    if (this.heldBySearch && this.displayVerse !== null) {
      // New tracking epoch at the location the broadcaster chose to show.
      this.follower.seek(this.displayVerse);
      this.trackerVerse = this.displayVerse;
    } else if (this.trackerVerse !== null && this.trackerVerse !== this.displayVerse) {
      this.showVerse(this.trackerVerse);
    }
    this.heldBySearch = false;
    this.notice = null;
    if (this.capture.phase === 'recording' && !this.commandActive && !this.englishTail) this.updateLiveCursor();
    this.logEvent('resume', this.verseLabel(this.displayVerse));
    this.publish();
  }

  private onTranscript(msg: Extract<ControlClientMessage, { type: 'transcript' }>) {
    if (msg.captureEpoch !== this.capture.captureEpoch) return; // an old stream can never apply
    if (this.capture.phase === 'stopped' || this.capture.phase === 'off' || this.capture.phase === 'dozing' || this.capture.phase === 'waiting') return; // late results after Stop
    if (msg.seq <= this.lastSeq) return; // duplicate delivery
    this.lastSeq = msg.seq;
    // Far beyond any stream (a provider stream lasts at most three hours): the page is misbehaving.
    if (this.buffer.finals.length > MAX_STREAM_WORDS) return;
    this.writeCapture(msg.tokens, msg.audioMs);
    // The audio clock: the least-delayed report gives the closest offset (delivery only adds delay).
    if (msg.audioMs !== undefined) {
      const offset = msg.audioMs - this.clock.now();
      if (this.audioOffset === null || offset > this.audioOffset) this.audioOffset = offset;
    }
    for (const t of msg.tokens) {
      if (typeof t.startMs !== 'number' || t.startMs <= this.heardMs || isMarker(t.text)) continue;
      // A newly heard piece: how late it was reported (a backlog after connecting is not typical).
      if (msg.audioMs !== undefined && msg.audioMs >= t.startMs && msg.audioMs - t.startMs < 2000) this.lag.observe(msg.audioMs - t.startMs);
      this.heardMs = t.startMs;
    }
    const r = this.buffer.apply(msg.tokens);
    // A surah named in Arabic script ("سورة الرحمن"; also English the recogniser wrote in Arabic,
    // "قولت سورة الرحمن" for "go to Surah Rahman") opens it, like the spoken English request.
    if (!this.commandActive) {
      const live = this.buffer.liveWords();
      // A request is found as soon as its words arrive: only the newest words need looking at, not
      // everything recited since the stream began (that grew with every result).
      const from = Math.max(this.liveFloor, this.arabicScan, live.length - 16);
      const req = this.arabicRequests.find(live.map((w) => w.text), from, !!live.at(-1)?.open);
      if (req) {
        this.arabicScan = req.end;
        void this.command(`listen:ar-${msg.seq}`, `surah ${req.chapter}`, true);
      }
    }
    const heard = this.buffer.heardText(1);
    const liveWords = this.readable(this.buffer.liveWords());
    const english = !this.commandActive && this.listeningCommands.observe(liveWords, this.buffer.hasProvisional, r.endpoint);
    if (english) {
      this.englishTail = true;
      this.cursor = null;
      this.resetLive();
      this.follower.stop();
      this.publish();
      return;
    }
    if (this.englishTail) {
      // Resume at Arabic after the English utterance. No English words become recitation evidence.
      const lastEnglish = liveWords.findLastIndex(w => /[A-Za-z]/.test(w.text));
      this.liveFloor = Math.max(this.liveFloor, lastEnglish + 1);
      this.follower.engine.floor = Math.max(this.follower.engine.floor, Math.min(this.buffer.evidence().length, lastEnglish + 1));
      if (this.latestCommand?.id.startsWith('listen:')) this.latestCommand.ctrl.abort();
      this.englishTail = false;
    }
    this.batchingTranscript = true;
    try {
      this.follower.onTranscript(this.readable(this.buffer.evidence()), heard.provisional, r.evidenceChanged);
      if (!this.held && !this.commandActive && (r.evidenceChanged || r.provisionalChanged)) {
        this.updateLiveCursor();
      }
    } finally { this.batchingTranscript = false; }
    this.publish();
  }

  /** The control page's voice detector: a breath is known at once, not ~0.8 s later from the recogniser. */
  private onVoice(msg: Extract<ControlClientMessage, { type: 'voice' }>) {
    if (msg.captureEpoch !== this.capture.captureEpoch || this.capture.phase !== 'recording') return;
    this.writeCaptureEvent({ type: 'voice', speaking: msg.speaking, audioMs: Math.round(msg.audioMs) });
    const open = this.quiet.at(-1);
    if (!msg.speaking) {
      if (!open || open.to !== null) this.quiet.push({ from: msg.audioMs, to: null });
      if (this.quiet.length > 12) this.quiet.shift();
      return;
    }
    if (!open || open.to !== null) return;
    open.to = Math.max(open.from, msg.audioMs);
    // The voice is back: a word that was waiting for it is being recited now.
    if (this.evidence && !this.held && !this.commandActive && !this.englishTail && this.liveVerse === this.displayVerse) {
      this.followPace(false);
      this.publish();
    }
  }

  /** Heard words with recitation that arrived in Latin letters read as the Arabic it matches. */
  private readable(words: Word[]): Word[] {
    const reader = this.o.latin?.get();
    if (!reader) return words;
    return reader.apply(words, this.displayVerse ?? this.follower.engine.anchor?.verseIndex ?? null);
  }

  private updateLiveCursor() {
    const words = this.readable(this.buffer.liveWords()).slice(this.liveFloor);
    const live = this.liveCursor.update(words, this.follower.engine.anchor, this.buffer.hasProvisional, this.follower.engine.prior, this.follower.engine.neighbours);
    if (live && (this.follower.mode !== 'jev_required' || live.verseIndex === this.trackerVerse)) {
      const verseChanged = live.verseIndex !== this.displayVerse;
      // Speed meter, ayah changes: from the newest sound heard to the change.
      const heardEndMs = words.at(-1)?.endMs ?? null;
      const now = this.audioNow();
      if (verseChanged && heardEndMs !== null && now !== null) this.pendingSpeed = { verseKey: this.o.corpus.at(live.verseIndex)!.key, verseChanged: true, lagMs: now - heardEndMs };
      this.liveVerse = live.verseIndex;
      this.showVerse(live.verseIndex);
      this.pace.learn(live.path);
      const pos = this.o.ix.verseStart[live.verseIndex] + live.word;
      const prev = this.evidence;
      const guessed = this.evidenceGuessed;
      const ev = live.startMs === null ? null : this.pace.begun({ pos, startMs: live.startMs }, live.newest);
      this.evidence = ev;
      this.evidenceGuessed = !!ev && ev.pos !== pos;
      // Evidence of an earlier word heard later (a restart after a breath) moves the highlight
      // back, as does more of a word first taken from its opening letters; a re-reading of the
      // same audio, or a prediction running ahead, never does.
      const back = verseChanged || !ev || !prev || (ev.pos < prev.pos && (ev.startMs > prev.startMs || guessed));
      if (ev) this.followPace(back);
      else {
        this.stopPace();
        this.setCursor(pos);
      }
      // Speed meter, words: from when the word began to when it was first highlighted.
      const shownAt = ev ? this.shownAt.get(ev.pos) : undefined;
      if (ev && !verseChanged && shownAt !== undefined && !this.measured.has(ev.pos)) {
        this.measured.add(ev.pos);
        this.pendingSpeed = { verseKey: this.o.corpus.at(live.verseIndex)!.key, verseChanged: false, lagMs: shownAt - ev.startMs };
      }
    } else {
      this.cursor = null;
      this.stopPace();
      // A provisional subword is frequently rewritten. Hold the source verse without an
      // active cursor while it forms; never flash an older finalized verse between updates.
    }
  }

  /** Current provider audio time, when the control page reports its audio clock. */
  private audioNow(): number | null {
    return this.audioOffset === null ? null : this.clock.now() + this.audioOffset;
  }

  /**
   * Highlight the word being recited: the newest evidence carried forward at the reciter's pace,
   * then again whenever the next word is due. Never past a pause mark or the end of the ayah.
   */
  private followPace(allowBack: boolean) {
    if (this.paceTimer !== null) this.clock.clearTimeout(this.paceTimer);
    this.paceTimer = null;
    const ev = this.evidence;
    if (!ev || this.liveVerse === null) return;
    let target = ev.pos;
    let dueIn: number | null = null;
    const now = this.audioNow();
    if (now !== null) {
      const p = this.pace.predict(ev, now, this.lag.ms, this.quiet);
      target = p.pos;
      // A word due more than a few seconds away is no pace at all (new evidence reschedules).
      if (p.nextAt !== null && p.nextAt - now <= 10_000) dueIn = Math.max(1, Math.ceil(p.nextAt - now));
    }
    const shown = !allowBack && this.shownPos !== null && this.o.ix.wordVerse[this.shownPos] === this.liveVerse ? this.shownPos : null;
    if (shown !== null && shown > target) target = shown;
    // Catching up by more than a word passes through the words between instead of jumping over them.
    if (shown !== null && target > shown + 1) {
      target = shown + 1;
      dueIn = SWEEP_MS;
    }
    // Going back (a restart): the words from there on are recited again, and timed again.
    if (this.shownPos !== null && target < this.shownPos) for (const p of [...this.shownAt.keys()]) if (p >= target) { this.shownAt.delete(p); this.measured.delete(p); }
    this.setCursor(target);
    if (dueIn !== null) {
      this.paceTimer = this.clock.setTimeout(() => {
        this.paceTimer = null;
        if (this.held || this.commandActive || this.englishTail || this.capture.phase !== 'recording' || this.liveVerse !== this.displayVerse) return;
        this.followPace(false);
        this.publish();
      }, dueIn);
    }
  }

  private setCursor(pos: number) {
    const verse = this.o.ix.wordVerse[pos];
    const word = pos - this.o.ix.verseStart[verse];
    const v = this.o.corpus.at(verse)!;
    let mapping = this.wordMaps.get(verse);
    if (!mapping) { mapping = mapDisplayWords(v.searchText, v.arabicDisplay); this.wordMaps.set(verse, mapping); }
    const span = mapping[word];
    // Only what the screen shows: whether the recogniser's words are still provisional changes nothing there.
    this.cursor = span ? { ...span } : null;
    this.progress = Math.min(1, (word + 1) / this.o.ix.verseLen[verse]);
    if (this.shownPos === null || this.o.ix.wordVerse[this.shownPos] !== verse) {
      this.shownAt.clear();
      this.measured.clear();
    }
    const now = this.audioNow();
    if (now !== null && !this.shownAt.has(pos)) this.shownAt.set(pos, now);
    this.shownPos = pos;
  }

  private stopPace() {
    if (this.paceTimer !== null) this.clock.clearTimeout(this.paceTimer);
    this.paceTimer = null;
    this.evidence = null;
    this.evidenceGuessed = false;
    this.shownPos = null;
    this.shownAt.clear();
    this.measured.clear();
  }

  private resetLive() {
    this.liveCursor.reset();
    this.stopPace();
  }

  /** No longer following (the page or its stream is gone): the ayah stays, no word claims to be recited. */
  private dropHighlight() {
    this.resetLive();
    this.liveVerse = null;
    this.cursor = null;
    this.publish();
  }

  private onCapture(msg: Extract<ControlClientMessage, { type: 'capture' }>) {
    const now = this.clock.now();
    if (msg.captureEpoch < this.capture.captureEpoch) return;
    if (msg.captureEpoch > this.capture.captureEpoch) {
      this.capture = { phase: 'starting', captureEpoch: msg.captureEpoch, detail: null, since: now };
      this.buffer = new TranscriptBuffer();
      this.listeningCommands.cancel(true);
      this.englishTail = false;
      this.resetLive();
      // Each stream has its own audio clock.
      this.audioOffset = null;
      this.quiet = [];
      this.heardMs = -Infinity;
      this.liveVerse = null;
      this.liveFloor = 0;
      this.arabicScan = 0;
      this.cursor = null;
      this.lastSeq = -1;
      this.follower.newCapture(msg.captureEpoch);
      this.openCapture(msg.captureEpoch);
      if (this.trackerVerse === null) this.follower.setPrior(this.startHint);
    }
    this.cancelDisconnect();
    const phase: CapturePhase =
      msg.event === 'starting' ? 'starting' : msg.event === 'recording' || msg.event === 'unmuted' || msg.event === 'muted' ? 'recording' : msg.event === 'reconnecting' ? 'reconnecting' : msg.event === 'dozing' ? 'dozing' : msg.event === 'waiting' ? 'waiting' : msg.event === 'stopped' ? 'stopped' : 'error';
    this.capture = { ...this.capture, phase, detail: msg.detail ?? (msg.event === 'muted' ? 'Microphone muted at the system or device level.' : null), since: now };
    this.logEvent(`capture:${msg.event}`, null, msg.detail);
    // Listening is back: an ayah hidden because it was lost returns (one the broadcaster hid does not).
    if (phase === 'recording' && this.hiddenByOutage) {
      this.endOutageHide();
      this.blanked = false;
      this.logEvent('outage_unhide', this.verseLabel(this.displayVerse));
      this.publish();
    }
    // Dozing (a long pause closed the provider stream) and waiting in line end the stream like
    // Stop, but listening is still on and the next stream continues from the same place.
    if (msg.event === 'stopped' || msg.event === 'dozing' || msg.event === 'waiting') {
      this.listeningCommands.cancel();
      if (this.latestCommand?.id.startsWith('listen:')) this.latestCommand.ctrl.abort();
      this.follower.stop();
      this.resetLive();
      this.liveVerse = null;
      this.cursor = null;
      this.publish();
    } else if (msg.event === 'error') {
      this.listeningCommands.cancel();
      this.follower.stop();
      this.dropHighlight();
      this.startDisconnectGrace();
    }
    this.queueSnapshot();
  }

  // ---------- diagnostic capture ----------

  private openCapture(epoch: number) {
    this.captureFile = null;
    if (!this.o.captureDir) return;
    mkdirSync(this.o.captureDir, { recursive: true });
    this.captureFile = path.join(this.o.captureDir, `capture-${epoch}.jsonl`);
    this.captureStart = this.clock.now();
  }

  /** Replay-format lines ({t, type:'result', tokens}); stops at the size bound. */
  private writeCapture(tokens: unknown, audioMs?: number) {
    // audioMs (the reciter's audio clock at receipt) lets replays measure lag exactly.
    this.writeCaptureEvent({ type: 'result', tokens, ...(audioMs === undefined ? {} : { audioMs: Math.round(audioMs) }) });
  }

  private writeCaptureEvent(event: Record<string, unknown>) {
    if (!this.captureFile) return;
    try {
      if ((statSync(this.captureFile, { throwIfNoEntry: false })?.size ?? 0) > CAPTURE_MAX_BYTES) {
        this.captureFile = null;
        return this.say('Diagnostic capture stopped at its 20 MB limit.');
      }
      appendFileSync(this.captureFile, JSON.stringify({ t: Math.round(this.clock.now() - this.captureStart), ...event }) + EOL);
    } catch {
      this.captureFile = null;
    }
  }

  // ---------- connection lifecycle ----------

  /** Open control pages (reader or control). */
  get controlCount() {
    return this.controlClients;
  }

  /**
   * Live on stream: an overlay (OBS, or a reading screen) shows this session. Listening then has no
   * daily limit and no idle stop, and keeps its place through breaks (hosted-speech.ts).
   */
  get live() {
    return this.overlayClients > 0;
  }

  /** Listening is on: a stream open, or none for the moment (a long pause, or waiting in line). */
  get listeningOn() {
    return ['starting', 'recording', 'reconnecting', 'dozing', 'waiting'].includes(this.capture.phase);
  }

  /** An overlay connected or left: the pages learn at once whether the session is live. */
  overlayChanged() {
    this.queueSnapshot();
  }

  /** A microphone stream is (or may be) running for this session. */
  get listening() {
    return ['starting', 'recording', 'reconnecting'].includes(this.capture.phase);
  }

  /** Release timers and listeners; the session is not used again (hosted mode evicts idle ones). */
  dispose() {
    this.listeningCommands.cancel(true);
    this.latestCommand?.ctrl.abort();
    this.follower.stop();
    this.cancelDisconnect();
    if (this.navTimer !== null) this.clock.clearTimeout(this.navTimer);
    this.navTimer = null;
    if (this.pageTimer !== null) this.clock.clearTimeout(this.pageTimer);
    this.pageTimer = null;
    if (this.snapshotTimer !== null) this.clock.clearTimeout(this.snapshotTimer);
    this.snapshotTimer = null;
    this.stopPace();
    for (const fn of this.endListeners) fn();
    this.endListeners.clear();
    this.displayListeners.clear();
    this.streamListeners.clear();
    this.controlListeners.clear();
    this.revokeListeners.clear();
  }

  controlConnected() {
    this.controlClients++;
    // A page back within the grace (a reload) leaves the stream alone: the broadcaster is here to decide.
    if (this.capture.phase === 'disconnected') this.cancelDisconnect();
    this.queueSnapshot();
  }

  controlDisconnected() {
    this.listeningCommands.cancel();
    this.controlClients = Math.max(0, this.controlClients - 1);
    if (this.controlClients === 0 && ['starting', 'recording', 'reconnecting'].includes(this.capture.phase)) {
      this.capture = { ...this.capture, phase: 'disconnected', detail: 'Control page disconnected while listening.', since: this.clock.now() };
      this.follower.stop();
      this.dropHighlight();
      this.startDisconnectGrace();
    }
  }

  /**
   * Listening was lost (the control page went away, or its stream failed). After the grace the ayah
   * is hidden from stream rather than left frozen with nobody following, and never cleared: it is
   * kept, with the place, for when listening returns (then it shows again by itself) or Unhide.
   */
  private startDisconnectGrace() {
    this.cancelDisconnect();
    this.disconnectTimer = this.clock.setTimeout(() => {
      this.disconnectTimer = null;
      // Kept up on request ("Keep the ayah up if the microphone disconnects"), nothing to hide, or the broadcaster already hid it.
      if (this.pinned || this.displayVerse === null || this.blanked) return;
      const key = this.verseLabel(this.displayVerse);
      this.blanked = true;
      this.hiddenByOutage = true;
      this.notice = this.outageNotice = `Hidden from stream: listening stopped unexpectedly. Start listening or Unhide to show ${key} again.`;
      this.logEvent('disconnect_hide', key);
      this.publish();
    }, DISCONNECT_GRACE_MS);
  }

  /** The hide that listening being lost caused is over (listening returned, or the broadcaster chose). */
  private endOutageHide() {
    this.hiddenByOutage = false;
    if (this.outageNotice !== null && this.notice === this.outageNotice) this.notice = null;
    this.outageNotice = null;
  }

  private cancelDisconnect() {
    if (this.disconnectTimer !== null) this.clock.clearTimeout(this.disconnectTimer);
    this.disconnectTimer = null;
  }

  painted(revision: number) {
    const sent = this.sentAt.get(revision);
    if (sent === undefined) return;
    this.sentAt.delete(revision);
    this.paintRtts.push(this.clock.now() - sent);
    if (this.paintRtts.length > 500) this.paintRtts.shift();
  }

  // ---------- commands ----------

  /** `show`: a spoken "show the ayah about ..." puts JEV's confirmed best match on screen. */
  private async command(requestId: string, text: string, show = false) {
    this.latestCommand?.ctrl.abort();
    const ctrl = new AbortController();
    const cmd = { id: requestId, ctrl, keys: new Set<string>() };
    this.latestCommand = cmd;
    this.emitControl({ type: 'command_pending', requestId });
    let result: CommandResult;
    try {
      result = await this.o.resolver.resolve(text, this.displayVerse ?? this.trackerVerse, ctrl.signal, (pre) => {
        if (this.latestCommand !== cmd || ctrl.signal.aborted || pre.kind !== 'candidates') return;
        for (const c of pre.cards) for (const k of [c.key, c.prevKey, c.nextKey]) if (k) cmd.keys.add(k);
        this.emitControl({ type: 'command_result', requestId, result: pre });
      });
    } catch {
      result = { kind: 'no_match', message: 'Search failed unexpectedly; exact references still work.' };
    }
    if (this.latestCommand !== cmd || ctrl.signal.aborted) return; // an old search cannot publish after a newer request
    if (result.kind === 'control') {
      if (result.style) this.handle({ type: 'style', patch: result.style });
      if (result.hold !== null) this.handle({ type: 'hold', on: result.hold });
      if (result.blank !== null) this.handle({ type: 'blank', on: result.blank });
      this.say(result.label);
    }
    if (result.kind === 'navigate') {
      this.settleNav(() => {
        this.gotoIndex(this.o.corpus.verse(result.key)!.index, 'command');
        if (requestId.startsWith('listen:')) { this.held = false; this.heldBySearch = false; this.publish(); }
      });
      this.latestCommand = cmd;
    }
    // Cards and their adjacent-ayah context (browsable in the card) may be shown.
    if (result.kind === 'candidates') for (const c of result.cards) for (const k of [c.key, c.prevKey, c.nextKey]) if (k) cmd.keys.add(k);
    // Spoken finding requests ("surah about elephants", "find the ayah about patience") show their
    // confirmed best match; plain descriptions of a verse stay private previews.
    if (!show && requestId.startsWith('listen:') && EXPLICIT_FIND.test(text.trim())) show = true;
    if (show && result.kind === 'candidates') {
      if (result.confirmedKey) {
        const key = result.confirmedKey;
        this.settleNav(() => {
          this.gotoIndex(this.o.corpus.verse(key)!.index, 'command');
          this.held = false;
          this.heldBySearch = false;
          this.say(`Showing ${key}, the best match for “${text}”. Other matches are in Recite or ask.`);
          this.publish();
        });
      } else this.say(`No single passage clearly matched “${text}”. Pick one of the matches to show it.`);
    }
    this.emitControl({ type: 'command_result', requestId, result });
  }

  /** Push a message to this session's open control pages (e.g. a credit balance update). */
  notify(m: ControlServerMessage) {
    this.emitControl(m);
  }

  private emitControl(m: ControlServerMessage) {
    for (const fn of this.controlListeners) fn(m);
  }

  // ---------- snapshot ----------

  private queueSnapshot() {
    if (this.snapshotTimer !== null) return;
    this.snapshotTimer = this.clock.setTimeout(() => {
      this.snapshotTimer = null;
      this.emitControl({ type: 'snapshot', snapshot: this.snapshotUpdate() });
    }, 30);
  }

  phase(): TrackerPhase {
    const c = this.capture.phase;
    if (c === 'error') return 'error';
    if (c === 'disconnected') return 'disconnected';
    if (this.held) return 'held';
    if (c === 'off') return 'idle';
    if (c === 'stopped') return 'stopped';
    if (c === 'dozing') return 'dozing';
    if (c === 'waiting') return 'waiting';
    if (this.liveVerse !== null && this.cursor) return 'tracking';
    const p = this.follower.engine.phase;
    return p === 'unlocated' ? 'listening_unlocated' : p;
  }

  snapshot(): ControlSnapshot {
    const st = this.follower.stats;
    const m = this.o.corpus.data.manifest;
    return {
      v: PROTOCOL_VERSION,
      sessionEpoch: this.sessionEpoch,
      corpus: { id: m.id, verses: m.verseCount, chapters: this.o.corpus.data.chapters.length, translation: m.translation.name, attribution: m.translation.attribution },
      display: this.display,
      layout: this.layout,
      trackerVerse: this.verseLabel(this.trackerVerse),
      phase: this.phase(),
      mode: this.follower.mode,
      held: this.held,
      blanked: this.blanked,
      pinned: this.pinned,
      keepOnUncertain: this.follower.engine.cfg.keepOnUncertain,
      startHint: this.verseLabel(this.startHint),
      // What the recogniser heard stays on the server: pages show the Quran's own text, not ASR spelling.
      capture: this.capture,
      candidates: this.candidatesView,
      decisions: this.follower.decisions.slice(-8).map((d) => ({
        at: d.at,
        reason: d.reason,
        outcome: d.outcome,
        detail: d.detail,
        latencyMs: Math.round(d.latencyMs),
        shortlist: d.shortlist.slice(0, 6),
        truncated: d.truncated,
        changedOverlay: d.changedOverlay,
      })),
      setup: { soniox: this.o.setup.soniox, jev: this.o.setup.jev, semantic: this.o.setup.semantic(), resources: this.resourceView() },
      overlay: { url: this.overlayUrl, clients: this.overlayClients, lastPaintRttMs: this.paintRtts.at(-1) ?? null },
      metrics: {
        trackerP50Ms: pct(this.follower.computeMs, 0.5),
        trackerP95Ms: pct(this.follower.computeMs, 0.95),
        updates: this.follower.computeMs.length,
        decisionCalls: st?.started ?? 0,
        decisionP50Ms: pct(st?.latencies ?? [], 0.5),
        paintRttP50Ms: pct(this.paintRtts, 0.5),
        paintRttP95Ms: pct(this.paintRtts, 0.95),
      },
      notice: this.notice,
      speed: this.speed,
    };
  }

  private candidatesView: ControlSnapshot['candidates'] = [];
  private pendingSpeed: { verseKey: string; verseChanged: boolean; lagMs: number } | null = null;
  private lastSetup = '';

  /**
   * The snapshot as sent after a page's first: its display travels in its own messages (publish),
   * and setup only when it changed. Reciting for half an hour sent ~75 MB of repeats to a phone.
   */
  private snapshotUpdate(): ControlSnapshotUpdate {
    const { display: _display, setup, ...update } = this.snapshot();
    const key = JSON.stringify(setup);
    if (key === this.lastSetup) return update;
    this.lastSetup = key;
    return { ...update, setup };
  }
  private speed: ControlSnapshot['speed'] = null;
  private resourceCache: ControlSnapshot['setup']['resources'] | null = null;

  private resourceView(): ControlSnapshot['setup']['resources'] {
    if (!this.o.catalog) return [];
    if (this.resourceCache) return this.resourceCache;
    this.resourceCache = this.o.catalog.status().map((r) => {
      const st = r.stage;
      const state = st.consumers.length ? 'in use' : st.indexed ? 'imported, not used yet' : st.downloaded ? 'downloaded' : 'not imported';
      const cov = r.coverage ? `${r.coverage.verseKeys.toLocaleString()} ayahs covered, ${r.coverage.rejectedRows} rejected rows. ` : '';
      const used = st.consumers.length ? `Used by: ${st.consumers.join(', ')}. ` : '';
      return { id: r.id, title: r.title, state, detail: `${cov}${used}${r.note ?? ''}`.trim() };
    });
    return this.resourceCache;
  }
}

/** Connect resource relationships to the tracker and decision evidence, recording the consumers. */
export function attachCatalog(follower: RecitationFollower, catalog: ResourceCatalog) {
  // Candidate regions only when curated near-match edges exist (see ResourceCatalog.neighbours).
  follower.engine.neighbours = catalog.similar || catalog.mutashabihat ? catalog.neighbours : null;
  follower.relate = (a, b) => catalog.relationSources(a, b);
  catalog.consume(catalog.phrases.id, 'decision.evidence');
  if (catalog.similar) {
    catalog.consume('qul:similar-ayah:74', 'tracker.candidates');
    catalog.consume('qul:similar-ayah:74', 'decision.evidence');
  }
  if (catalog.mutashabihat) {
    catalog.consume('qul:mutashabihat:73', 'tracker.candidates');
    catalog.consume('qul:mutashabihat:73', 'decision.evidence');
  }
}
