// The one contract owner for control ⇄ server ⇄ overlay messages. Every producer and consumer
// imports from here; there is no second display truth (Moard cross-runtime-integrity rule).

import { z } from 'zod';

export const PROTOCOL_VERSION = 1;

export const LayoutSchema = z.enum(['fullframe', 'lowerthird']);
export const BackgroundSchema = z.enum(['transparent', 'scrim', 'solid']);

export const DisplayStyleSchema = z.object({
  readingMode: z.enum(['follow', 'ayah', 'word']).default('follow'),
  layout: LayoutSchema,
  background: BackgroundSchema,
  /** What the audience reads: Arabic with the translation, Arabic alone, or the translation alone. */
  language: z.enum(['both', 'arabic', 'english']).default('both'),
  showReference: z.boolean(),
  /** The following ayah, dimmed under the current one, so readers see what comes next. */
  showNext: z.boolean().default(true),
  /** Short consecutive ayahs share the screen as one passage (the current one highlighted). */
  groupShort: z.boolean().default(true),
  arabicScale: z.number().min(0.8).max(1.25),
  /** Translation size, measured before pagination rather than stretching the finished text. */
  englishScale: z.number().min(0.8).max(1.4).default(1),
  /** Placement applies to the lower third; long ayahs page inside it (only Word focus uses the full frame). */
  captionPosition: z.enum(['top', 'bottom']).default('bottom'),
  captionInset: z.number().int().min(24).max(160).default(56),
  /** Shading behind text only; the text itself stays opaque. */
  panelOpacity: z.number().min(0.2).max(1).default(0.72),
  /** Seconds per translation page when a translation overflows; 0 = broadcaster pages manually. */
  translationPageSeconds: z.number().int().min(0).max(60),
  /** Highlight colour of the stream (the recited word, meanings, ornaments); gold by default. */
  accent: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#cfaa62'),
  /** A small "Quran Overlay by Nurra" credit on the stream while an ayah is shown. */
  credit: z.boolean().default(true),
});
export type DisplayStyle = z.infer<typeof DisplayStyleSchema>;

export const DEFAULT_STYLE: DisplayStyle = {
  readingMode: 'follow',
  layout: 'fullframe',
  background: 'scrim',
  language: 'both',
  showReference: true,
  showNext: true,
  groupShort: true,
  arabicScale: 1,
  englishScale: 1,
  captionPosition: 'bottom',
  captionInset: 56,
  panelOpacity: 0.72,
  translationPageSeconds: 0,
  accent: '#cfaa62',
  credit: true,
};

export const DisplayVerseSchema = z.object({
  key: z.string().regex(/^\d{1,3}:\d{1,3}$/),
  surah: z.number().int().min(1).max(114),
  ayah: z.number().int().min(1).max(286),
  arabic: z.string().min(1),
  english: z.string().min(1),
  surahName: z.string(),
  surahNameArabic: z.string(),
  translationName: z.string(),
  /** Word-by-word English, one entry per display token (null for a pause mark); absent if unavailable. */
  glosses: z.array(z.string().nullable()).nullable().optional(),
  glossCredit: z.string().nullable().optional(),
});
export type DisplayVerse = z.infer<typeof DisplayVerseSchema>;

export const DisplayStateSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  revision: z.number().int().nonnegative(),
  sessionEpoch: z.string(),
  visible: z.boolean(),
  verse: DisplayVerseSchema.nullable(),
  style: DisplayStyleSchema,
  englishPage: z.number().int().nonnegative(),
  /** null = follow recitation progress (when available), number = broadcaster-chosen page. */
  arabicPage: z.number().int().nonnegative().nullable(),
  /** Recited position within the verse as a fraction of its words, only for paging long verses. */
  progress: z.number().min(0).max(1).nullable(),
  /** Display-word coordinates, validated against the selected display script. */
  cursor: z.object({ from: z.number().int().nonnegative(), to: z.number().int().nonnegative() }).nullable().optional(),
  /** Short ayahs shown together with the current one, in order (it is among them); null = alone. */
  group: z
    .array(z.object({ key: z.string().regex(/^\d{1,3}:\d{1,3}$/), ayah: z.number().int().min(1).max(286), arabic: z.string().min(1), english: z.string().min(1) }))
    .nullable()
    .optional(),
  /** The ayah after the current one (a preview, never a claim about where the reciter is). */
  next: z
    .object({
      key: z.string().regex(/^\d{1,3}:\d{1,3}$/),
      surah: z.number().int().min(1).max(114),
      ayah: z.number().int().min(1).max(286),
      arabic: z.string().min(1),
      english: z.string().min(1),
      /** Set only when the next ayah opens a new surah. */
      surahName: z.string().nullable(),
    })
    .nullable()
    .optional(),
});
export type DisplayState = z.infer<typeof DisplayStateSchema>;

// ---------- overlay channel ----------

export const OverlayClientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello'), view: z.string().min(8).max(128), role: z.enum(['overlay', 'preview']) }),
  z.object({ type: z.literal('painted'), revision: z.number().int().nonnegative() }),
]);
export type OverlayClientMessage = z.infer<typeof OverlayClientMessageSchema>;

export type OverlayServerMessage =
  | { type: 'display'; state: DisplayState }
  | { type: 'stream'; state: StreamState }
  | { type: 'denied'; reason: 'invalid_view' | 'revoked' };

// ---------- charity stream (the /stream scene around the reader) ----------

/** An address the stream shows or encodes: https only, no spaces or markup characters. */
const StreamUrl = z.union([z.literal(''), z.string().max(500).regex(/^https:\/\/[^\s"'<>`]+$/)]);
const StreamText = (max: number) => z.string().max(max).transform((s) => s.replace(/[\u0000-\u001f\u007f]/g, '').trim());

/** What the streamer sets for a charity stream: the partner, the project, the goal and how to give. */
export const StreamSettingsSchema = z.object({
  title: StreamText(60).default('Twenty-four hours of Quran'),
  partner: StreamText(60).default(''),
  project: StreamText(80).default(''),
  country: StreamText(40).default(''),
  /** One line on what a donation provides. */
  about: StreamText(140).default(''),
  /** A photo of the project (the partner's own), shown on the stream. */
  photo: StreamUrl.default(''),
  /** Where to give (the partner's own donation page): shown and encoded in the QR code. */
  link: StreamUrl.default(''),
  goal: z.number().finite().min(0).max(1e9).default(0),
  /** Given before this page counted (offline gifts, a match): added to the total. */
  raisedBefore: z.number().finite().min(0).max(1e9).default(0),
  currency: StreamText(4).default('$'),
  reciter: StreamText(40).default(''),
  /** Leave a window in the arch for the camera (or VTuber) source placed under the stream in OBS. */
  camera: z.boolean().default(true),
  showAmounts: z.boolean().default(false),
  /** When the stream's clock started ("Hour 3 of 24"), or null when it is not shown. */
  startedAt: z.number().int().min(0).nullable().default(null),
  hours: z.number().int().min(1).max(72).default(24),
});
export type StreamSettings = z.infer<typeof StreamSettingsSchema>;
export const StreamSettingsPatchSchema = z.object({
  title: StreamText(60), partner: StreamText(60), project: StreamText(80), country: StreamText(40), about: StreamText(140),
  photo: StreamUrl, link: StreamUrl, goal: z.number().finite().min(0).max(1e9), raisedBefore: z.number().finite().min(0).max(1e9),
  currency: StreamText(4), reciter: StreamText(40), camera: z.boolean(), showAmounts: z.boolean(),
  startedAt: z.number().int().min(0).nullable(), hours: z.number().int().min(1).max(72),
}).partial();

/** One donation as the stream shows it ("May Allah accept Aisha's donation"); an empty name is anonymous. */
export const DonationSchema = z.object({
  id: z.string().max(40),
  name: StreamText(60),
  amount: z.number().finite().min(0).max(1e8),
  /** The donor's own words, e.g. "For my late father". */
  message: StreamText(80),
  at: z.number().int().min(0),
});
export type Donation = z.infer<typeof DonationSchema>;

/** The stream scene's data: settings, the latest donations (newest first), the total and how many gave. */
export type StreamState = { settings: StreamSettings; donations: Donation[]; total: number; count: number };

// ---------- control channel ----------

/** Provider audio times are within one stream, which lasts at most three hours. */
const AudioMs = z.number().finite().min(0).max(6 * 3600_000);

export const WireTokenSchema = z.object({
  text: z.string().max(200),
  isFinal: z.boolean(),
  startMs: AudioMs.optional(),
  endMs: AudioMs.optional(),
  confidence: z.number().finite().optional(),
});

export const TrackerModeSchema = z.enum(['deterministic', 'hybrid', 'jev_required']);

// Defaults belong to full snapshots and saved records. A partial update must contain only the
// fields the broadcaster changed; otherwise changing a colour resets language, size and layout.
const styleFields = DisplayStyleSchema.shape;
const patchFields = Object.fromEntries(Object.entries(styleFields).map(([key, schema]) =>
  [key, schema instanceof z.ZodDefault ? schema.removeDefault() : schema],
)) as { [K in keyof typeof styleFields]: typeof styleFields[K] extends z.ZodDefault<infer T> ? T : typeof styleFields[K] };
export const StylePatchSchema = z.object(patchFields).partial();
export type StylePatch = z.infer<typeof StylePatchSchema>;

export const ControlClientMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('transcript'),
    captureEpoch: z.number().int().positive(),
    seq: z.number().int().nonnegative(),
    tokens: z.array(WireTokenSchema).max(600),
    /** Control browser monotonic ms at receipt from the provider (trace only; clocks are not mixed). */
    receivedAt: z.number().finite(),
    /**
     * Provider audio time (ms since this stream's first audio) at that receipt: where the reciter
     * is now, while the tokens describe where they were. Keeps the highlight in step (pace.ts).
     */
    audioMs: AudioMs.optional(),
  }),
  z.object({
    type: z.literal('voice'),
    captureEpoch: z.number().int().positive(),
    /**
     * The control page's microphone heard the voice start (true) or go quiet (false) at `audioMs`
     * (provider audio time). Heard at once, where the recogniser reports ~0.8 s late: the paced
     * highlight waits during a breath and moves on when the voice returns.
     */
    speaking: z.boolean(),
    audioMs: AudioMs,
  }),
  z.object({
    type: z.literal('capture'),
    captureEpoch: z.number().int().positive(),
    // 'dozing': the silence skipper closed the provider stream during a long pause; listening is on.
    // 'waiting': every place to listen is taken; the page is in line and starts by itself.
    event: z.enum(['starting', 'recording', 'reconnecting', 'dozing', 'waiting', 'stopped', 'error', 'muted', 'unmuted']),
    detail: z.string().max(240).optional(),
  }),
  z.object({ type: z.literal('nav'), action: z.enum(['next', 'prev']) }),
  z.object({ type: z.literal('goto'), key: z.string().max(8) }),
  z.object({ type: z.literal('hold'), on: z.boolean() }),
  z.object({ type: z.literal('blank'), on: z.boolean() }),
  z.object({ type: z.literal('pin'), on: z.boolean() }),
  z.object({ type: z.literal('style'), patch: StylePatchSchema }),
  z.object({ type: z.literal('page'), region: z.enum(['english', 'arabic']), page: z.number().int().min(0).max(200) }),
  /** Page counts measured by the control's same-size preview for the displayed revision. */
  z.object({
    type: z.literal('layout'),
    revision: z.number().int().nonnegative(),
    key: z.string().max(8),
    englishPages: z.number().int().min(1).max(200),
    arabicPages: z.number().int().min(1).max(200),
    promotedToFullFrame: z.boolean(),
  }),
  z.object({ type: z.literal('arabic_auto') }),
  z.object({ type: z.literal('mode'), mode: TrackerModeSchema }),
  z.object({ type: z.literal('start_hint'), key: z.string().max(8).nullable() }),
  z.object({ type: z.literal('uncertain_policy'), keep: z.boolean() }),
  z.object({ type: z.literal('command'), requestId: z.string().min(1).max(64), text: z.string().max(300), source: z.enum(['typed', 'voice']), show: z.boolean().optional() }),
  z.object({ type: z.literal('show_result'), requestId: z.string().min(1).max(64), key: z.string().max(8) }),
  z.object({ type: z.literal('rotate_view') }),
  /** Push-to-talk held: recitation publication pauses and in-flight location decisions are dropped. */
  z.object({ type: z.literal('command_capture'), active: z.boolean() }),
  /** Charity stream: change its settings, add a donation (it is announced on stream), or take one back. */
  z.object({ type: z.literal('stream_settings'), patch: StreamSettingsPatchSchema }),
  z.object({ type: z.literal('donation'), name: StreamText(60), amount: z.number().finite().min(0).max(1e8), message: StreamText(80).default('') }),
  z.object({ type: z.literal('donation_remove'), id: z.string().max(40) }),
]);
export type ControlClientMessage = z.infer<typeof ControlClientMessageSchema>;

export type SearchCard = {
  key: string;
  surahName: string;
  arabic: string;
  english: string;
  prevKey: string | null;
  nextKey: string | null;
  /** Which retrieval channels found this passage (translation wording, meaning, QUL topic, reference). */
  foundBy: string[];
};

export type CommandResult =
  | { kind: 'navigate'; key: string; note: string | null }
  | {
      kind: 'candidates';
      route: 'search' | 'chapter';
      query: string;
      cards: SearchCard[];
      /** Key JEV selected among the retrieved cards, if any. */
      confirmedKey: string | null;
      status: string;
      /** Preliminary cards shown while JEV is still choosing; a final result follows. */
      refining: boolean;
    }
  | { kind: 'no_match'; message: string }
  | { kind: 'invalid_reference'; message: string }
  /** A display/following setting requested by voice or typing. */
  | { kind: 'control'; label: string; style: StylePatch | null; hold: boolean | null; blank: boolean | null };

/** Listening time left (hosted service only; a self-hosted server has no credits). */
export type CreditView = {
  /** Seconds a new stream may use now. */
  available: number;
  free: number;
  paid: number;
  /** Sponsored seconds this visitor may use today once their own time is gone. */
  sponsored: number;
  /** Seconds left in the shared sponsored pool (donations). */
  pool: number;
  freeUsedThisMonth: number;
  freePerMonth: number;
  /** Free listening allowed per day (per network). */
  freePerDay: number;
  limitedBy: 'month' | 'network' | 'service' | 'pool' | 'share' | null;
  /** Shared (pool) time one visitor may use per day. */
  sharePerDay: number;
  /** When the monthly free allowance renews (ms since epoch). */
  renewsAt: number;
  /** Seconds used by the stream in progress, if listening. */
  listeningSeconds: number;
};

export type CapturePhase = 'off' | 'starting' | 'recording' | 'reconnecting' | 'dozing' | 'waiting' | 'stopped' | 'error' | 'disconnected';
export type TrackerPhase = 'idle' | 'listening_unlocated' | 'tracking' | 'uncertain' | 'dozing' | 'waiting' | 'held' | 'stopped' | 'disconnected' | 'error';

export type CandidateView = { key: string; score: number; relation: string; matched: number; trailing: number };

export type DecisionView = {
  at: number;
  reason: string;
  outcome: string;
  detail: string;
  latencyMs: number;
  shortlist: string[];
  truncated: boolean;
  changedOverlay: boolean;
};

export type ControlSnapshot = {
  v: typeof PROTOCOL_VERSION;
  sessionEpoch: string;
  corpus: { id: string; verses: number; chapters: number; translation: string; attribution: string };
  display: DisplayState;
  layout: { key: string; englishPages: number; arabicPages: number; promotedToFullFrame: boolean } | null;
  /** Where the tracker currently believes the reciter is (may differ from display while held). */
  trackerVerse: string | null;
  phase: TrackerPhase;
  mode: z.infer<typeof TrackerModeSchema>;
  held: boolean;
  blanked: boolean;
  pinned: boolean;
  keepOnUncertain: boolean;
  startHint: string | null;
  capture: { phase: CapturePhase; captureEpoch: number; detail: string | null; since: number };
  candidates: CandidateView[];
  decisions: DecisionView[];
  setup: {
    soniox: boolean;
    jev: { provider: 'typesafe' | 'openrouter' | null; configured: boolean; detail: string };
    semantic: string;
    /** Resource capability status for the broadcaster/developer (never shown on the overlay). */
    resources: Array<{ id: string; title: string; state: string; detail: string }>;
  };
  overlay: { url: string; clients: number; lastPaintRttMs: number | null };
  metrics: {
    trackerP50Ms: number | null;
    trackerP95Ms: number | null;
    updates: number;
    decisionCalls: number;
    decisionP50Ms: number | null;
    paintRttP50Ms: number | null;
    paintRttP95Ms: number | null;
  };
  notice: string | null;
  /**
   * The control-side speed meter's latest reading, in the reciter's audio time where the screen is
   * updated (network and painting add a little). A word: from when it began to when it was first
   * highlighted (negative: highlighted early). An ayah change: from the newest sound heard.
   */
  speed: { revision: number; verseKey: string; verseChanged: boolean; lagMs: number } | null;
};

/**
 * A snapshot as sent after the first: the display travels in its own messages, and setup only
 * when it changed, so a phone reciting for half an hour is not sent the same data over and over.
 */
export type ControlSnapshotUpdate = Omit<ControlSnapshot, 'display' | 'setup'> & Partial<Pick<ControlSnapshot, 'display' | 'setup'>>;

export type ControlServerMessage =
  | { type: 'snapshot'; snapshot: ControlSnapshotUpdate }
  /** Each display change at once (snapshots are batched): the phone reader's highlight keeps pace. */
  | { type: 'display'; state: DisplayState }
  | { type: 'command_pending'; requestId: string }
  | { type: 'command_result'; requestId: string; result: CommandResult }
  | { type: 'credits'; credits: CreditView }
  /** This page is waiting in line to listen and a place is free for it now. */
  | { type: 'listen_turn' }
  | { type: 'stream'; state: StreamState };
