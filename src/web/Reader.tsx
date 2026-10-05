// Personal reader, phone first. The whole surah scrolls like a mushaf page; the ayah being recited
// is highlighted word by word (with that word's meaning) and the page keeps it in view. Speak to
// move ("go to Surah Maryam", "show the ayah about the orphan", "English only") or type. It shares
// the control page's session, so a stream overlay, if open, follows along too.

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FocusEvent as ReactFocusEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import type { CommandResult, ControlClientMessage, ControlServerMessage, ControlSnapshot, CreditView } from '../shared/contracts';
import { ownSonioxKey, RECONNECTING, SonioxCapture, type CaptureStatus } from './audio/soniox-session';
import { access, applyDisplay, applySnapshot, connect, listeningLine, type Access, u } from './net';
import { toQpcHafsEncoding } from '../shared/display-encoding';
import { arabicNumber } from './VerseDisplay';
import { NurraBadge } from './Nurra';
import { SharedHours } from './Sponsor';
import { ReaderAppearance, useReaderAppearance } from './ReaderAppearance';
import { audioRoute, transcriptUse, SILENCE_CONTROL, REQUEST_PRIVACY } from './privacy-copy';
import { FollowDemo } from './FollowDemo';
import { keepMeaningsInside } from './gloss';

type Ayah = { key: string; ayah: number; arabic: string; english: string; glosses: Array<string | null> | null };
type Surah = { number: number; name: string; nameArabic: string; translation: string; glossCredit: string | null; ayahs: Ayah[] };
type Auth = 'checking' | 'owner' | 'unauthorized' | 'unavailable';

/** Binds the ayah-end ornament to the last word so a line never starts with it. */
const NBSP = String.fromCharCode(0xa0);
/** Room under the recited word for its meaning label (it hangs about 22 px below the word). */
const MEANING_ROOM = 28;

/** The same anchor governs automatic following and whether hand scrolling has left it behind. */
function readingAnchor(key: string, availableHeight: number) {
  const ayah = document.getElementById(`a-${key}`);
  const active = ayah?.querySelector<HTMLElement>('.r-word.active');
  const long = !!ayah && ayah.getBoundingClientRect().height > availableHeight;
  const opening = ayah?.querySelector<HTMLElement>('.r-word') ?? ayah?.querySelector<HTMLElement>('.r-en');
  return {
    element: active ?? (long ? opening : ayah),
    block: !active && long ? 'start' as const : 'center' as const,
  };
}

/** `fraction`: how much of that ayah was already above the reading band (reading inside a long one). */
type Place = { key: string; name: string; at: number; fraction?: number };
/**
 * Per-device memory: the last place and language, and today's recited ayahs. Never required.
 * `key` is the ayah last chosen or recited (`chosenAt`); `read` is where the reader got to by reading
 * on silently (scrolling), which can be further along. The newer of the two is where to continue.
 */
type Saved ={ key?: string; name?: string; chosenAt?: number; read?: Place; lang?: 'both' | 'arabic' | 'english'; day?: string; recited?: string[] };
/** The silent reading place, when it is newer than the last chosen or recited ayah. */
const readOn = (s: Saved): Place | null => (s.read && s.read.at > (s.chosenAt ?? 0) ? s.read : null);
const surahOf = (key: string) => Number(key.split(':')[0]);
const today = () => new Date().toLocaleDateString('en-CA');
function loadSaved(): Saved {
  try {
    const s = JSON.parse(localStorage.getItem('qo.reader') ?? '{}') as Saved;
    return s.day === today() ? s : { ...s, day: today(), recited: [] };
  } catch {
    return {};
  }
}
function save(patch: Saved) {
  try {
    localStorage.setItem('qo.reader', JSON.stringify({ ...loadSaved(), ...patch }));
  } catch {
    /* storage unavailable (private window): nothing is remembered */
  }
}

/** Requests shown on the welcome: tapping one runs it, which also teaches what can be said. */
const TRY = ['Surah Al-Mulk', 'Surah about elephants', 'Ayat al-Kursi', 'Al-Fatihah'];

const QUICK = [
  { n: 1, name: 'Al-Fatihah' },
  { n: 36, name: 'Ya-Sin' },
  { n: 18, name: 'Al-Kahf' },
  { n: 55, name: 'Ar-Rahman' },
  { n: 67, name: 'Al-Mulk' },
  { n: 112, name: 'Al-Ikhlas' },
];

const Mic = () => (
  <svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true">
    <path fill="currentColor" d="M12 14a3 3 0 0 0 3-3V5a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2Z" />
  </svg>
);
const Stop = () => (
  <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">
    <rect x="6" y="6" width="12" height="12" rx="2.5" fill="currentColor" />
  </svg>
);
const MenuIcon = () => (
  <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
    <path fill="currentColor" d="M4 6.5h16v2H4v-2Zm0 4.5h16v2H4v-2Zm0 4.5h10v2H4v-2Z" />
  </svg>
);
const Keys = () => (
  <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
    <path fill="currentColor" d="M4 6h16a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2Zm0 2v8h16V8H4Zm2 1h2v2H6V9Zm3 0h2v2H9V9Zm3 0h2v2h-2V9Zm3 0h3v2h-3V9ZM6 12h2v2H6v-2Zm3 0h6v2H9v-2Zm7 0h2v2h-2v-2Z" />
  </svg>
);

export function Reader() {
  const [auth, setAuth] = useState<Auth>('checking');
  const [mode, setMode] = useState<Access['mode'] | null>(null);
  const [snap, setSnap] = useState<ControlSnapshot | null>(null);
  const [connection, setConnection] = useState<'connecting' | 'open' | 'closed'>('connecting');
  const [connectionFailed, setConnectionFailed] = useState(false);
  const [surahFailed, setSurahFailed] = useState(false);
  const [surahRetry, setSurahRetry] = useState(0);
  const [capture, setCapture] = useState<CaptureStatus>({ state: 'off', detail: null });
  const [surah, setSurah] = useState<Surah | null>(null);
  const [typing, setTyping] = useState(false);
  const [query, setQuery] = useState('');
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<{ id: string; r: CommandResult } | null>(null);
  const [follow, setFollow] = useState(true);
  const [reveal, setReveal] = useState(0);
  /** The start page, opened from the menu while a surah is up (recitation or a request leaves it). */
  const [home, setHome] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [appearance, setAppearance] = useReaderAppearance();
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  /** When the reader last scrolled by hand (wheel, touch). */
  const lastScroll = useRef(-Infinity);
  const curKey = useRef<string | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  // Confirmations ("Opened 55:13.", "Showing Arabic only.") fade on their own; choices stay.
  useEffect(() => {
    const k = result?.r.kind;
    if (k !== 'navigate' && k !== 'control' && !(k === 'candidates' && result!.r.kind === 'candidates' && result!.r.confirmedKey && !moreOpen)) return;
    const t = setTimeout(() => setResult(null), 4000);
    return () => clearTimeout(t);
  }, [result, moreOpen]);
  /**
   * A word the reader tapped to see its meaning (clears itself after a few seconds), or reached with
   * the keyboard (`held`: shown while the word has focus).
   */
  const [peek, setPeek] = useState<{ key: string; i: number; held?: boolean } | null>(null);
  useEffect(() => {
    if (!peek || peek.held) return;
    const t = setTimeout(() => setPeek(null), 4000);
    return () => clearTimeout(t);
  }, [peek]);
  /** The keyboard's place in the passage (one Tab stop; arrow keys move it). Null: the current ayah. */
  const [rove, setRove] = useState<{ key: string; i: number | null } | null>(null);
  /** What a screen reader hears when a word's meaning is shown from the keyboard. */
  const [said, setSaid] = useState('');
  /** Listening time left (hosted service only). */
  const [credits, setCredits] = useState<CreditView | null>(null);
  const micWrap = useRef<HTMLDivElement>(null);
  const [funding, setFunding] = useState<Pick<Access, 'billing' | 'sponsored'>>({});
  const [timeOpen, setTimeOpen] = useState<false | 'time' | 'sponsor'>(false);
  // Back from Stripe's checkout page.
  const [donated, setDonated] = useState(() => new URLSearchParams(location.search).has('donated'));
  const showSupportThanks = donated && !!credits;
  useEffect(() => {
    if (!showSupportThanks) return;
    const timer = setTimeout(() => setDonated(false), 8000);
    return () => clearTimeout(timer);
  }, [showSupportThanks]);
  const sock = useRef<ReturnType<typeof connect> | null>(null);
  const lastRequest = useRef<string | null>(null);
  const send = useCallback((m: ControlClientMessage) => sock.current?.send(m) ?? false, []);
  const capRef = useRef<SonioxCapture | null>(null);
  // A Soniox key of the reciter's own, saved in this browser from the control page, pays for listening here too.
  const [ownProblem, setOwnProblem] = useState<string | null>(null);
  if (!capRef.current) {
    capRef.current = new SonioxCapture((m) => send(m), (s) => setCapture(s), () => undefined);
    capRef.current.onOwnKeyProblem = setOwnProblem;
  }
  const cap = capRef.current;
  const ownKey = !!ownSonioxKey() && !ownProblem;

  useEffect(() => {
    document.documentElement.dataset.surface = 'reader';
    let cancelled = false;
    access()
      .then((s) => {
        if (cancelled) return;
        if (!s.owner) return setAuth('unauthorized');
        setMode(s.mode);
        if (s.credits) setCredits(s.credits);
        setFunding({ billing: s.billing, sponsored: s.sponsored });
        if (new URLSearchParams(location.search).has('donated') || new URLSearchParams(location.search).has('canceled')) history.replaceState(null, '', location.pathname);
        setAuth('owner');
        sock.current = connect(u('/ws/control'), {
          // A reconnect while listening: the server must hear again that this page's stream is live.
          onOpen: () => capRef.current?.announce(),
          onStatus: (st, code) => {
            setConnection(st);
            if (st === 'closed') setConnectionFailed(true);
            if (code === 4401) setAuth('unauthorized');
            if (st !== 'open') setPending(false);
          },
          shouldRetry: (code) => code !== 4401,
          onMessage: (data) => {
            const m = data as ControlServerMessage;
            // Display changes arrive on their own, at once; batched snapshots carry the rest.
            if (m.type === 'snapshot') {
              setSnap((prev) => applySnapshot(prev, m.snapshot));
              capRef.current?.setLive(m.snapshot.overlay.clients > 0);
            }
            else if (m.type === 'display') setSnap((prev) => applyDisplay(prev, m.state));
            else if (m.type === 'credits') setCredits(m.credits);
            else if (m.type === 'listen_turn') capRef.current?.onTurn(); // waiting in line: a place is free
            else if (m.type === 'command_pending') {
              if (m.requestId.startsWith('listen:')) lastRequest.current = m.requestId;
              if (m.requestId === lastRequest.current) {
                setPending(true);
                setResult(null);
              }
            } else if (m.type === 'command_result' && m.requestId === lastRequest.current) {
              setPending(false);
              setResult({ id: m.requestId, r: m.result });
              setMoreOpen(false);
              // Typed searches explicitly show their best match. A spoken description can instead
              // be a private preview; it must not leave Home as if that result were on the page.
              if (m.result.kind === 'navigate' || (m.result.kind === 'candidates' && m.result.confirmedKey && !m.requestId.startsWith('listen:'))) {
                setHome(false);
                setReveal((n) => n + 1);
              }
              if (m.result.kind !== 'candidates' || !m.result.refining) setTyping(false);
            }
          },
        });
      })
      .catch(() => !cancelled && setAuth('unavailable'));
    return () => {
      cancelled = true;
      sock.current?.close();
      capRef.current?.stop();
    };
  }, []);

  const d = snap?.display;
  const cur = d?.verse ?? null;
  const lang = d?.style.language ?? 'both';
  const [saved, setSaved] = useState<Saved>(loadSaved);
  /** A silent reading place to return to once its surah is on the page (from a reload, or Continue). */
  const resumeRead = useRef<Place | null>(null);
  const resumeChecked = useRef(false);

  // Remember the place and language on this device. Finding the same ayah as last time (a reload,
  // or the same session in another page) is not a new choice: a newer silent reading place wins.
  useEffect(() => {
    if (!cur) return;
    const s = loadSaved();
    if (!resumeChecked.current) {
      resumeChecked.current = true;
      const r = readOn(s);
      if (r && s.key === cur.key && r.key !== cur.key && surahOf(r.key) === cur.surah) resumeRead.current = r;
    }
    if (s.key === cur.key) return;
    save({ key: cur.key, name: cur.surahName, chosenAt: Date.now() });
    setSaved(loadSaved());
  }, [cur?.key]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (snap) save({ lang });
  }, [lang]); // eslint-disable-line react-hooks/exhaustive-deps
  // A fresh session starts in the language this device last used.
  const langRestored = useRef(false);
  useEffect(() => {
    if (!snap || langRestored.current) return;
    langRestored.current = true;
    if (!snap.display.verse && saved.lang && saved.lang !== snap.display.style.language) send({ type: 'style', patch: { language: saved.lang } });
  }, [snap]); // eslint-disable-line react-hooks/exhaustive-deps
  // Today's progress: ayahs the tracker followed while this device was listening.
  useEffect(() => {
    if (!cur || !cap.listening || snap?.phase !== 'tracking') return;
    const s = loadSaved();
    if (s.recited?.includes(cur.key)) return;
    const recited = [...(s.recited ?? []), cur.key].slice(-2000);
    save({ recited, day: today() });
    setSaved({ ...s, recited });
  }, [cur?.key, snap?.phase]); // eslint-disable-line react-hooks/exhaustive-deps

  // The surah being read, fetched once per surah.
  useEffect(() => {
    if (!cur || surah?.number === cur.surah) return;
    const controller = new AbortController();
    setSurahFailed(false);
    fetch(u(`/api/surah/${cur.surah}`), { credentials: 'same-origin', signal: controller.signal })
      .then((r) => {
        if (!r.ok) throw new Error('Surah unavailable');
        return r.json();
      })
      .then((s: Surah) => { if (!controller.signal.aborted) setSurah(s); })
      .catch(() => { if (!controller.signal.aborted) setSurahFailed(true); });
    return () => controller.abort();
  }, [cur?.surah, surahRetry]); // eslint-disable-line react-hooks/exhaustive-deps

  // Microphone level -> ring (a CSS variable, no re-render per frame).
  const isListening = cap.listening;
  useEffect(() => {
    if (!isListening) {
      micWrap.current?.style.setProperty('--level', '0');
      return;
    }
    let raf = 0;
    let smooth = 0;
    const tick = () => {
      const l = cap.level();
      smooth = l > smooth ? smooth + (l - smooth) * 0.5 : smooth + (l - smooth) * 0.12;
      micWrap.current?.style.setProperty('--level', smooth.toFixed(3));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [isListening, cap]);

  curKey.current = cur?.key ?? null;
  const curName = useRef<string>('');
  curName.current = cur?.surahName ?? '';
  useEffect(() => {
    if (!follow && performance.now() - lastScroll.current > 3000) setFollow(true);
  }, [cur?.key, d?.cursor?.from]);
  const prevKey = useRef<string | null>(null);
  useEffect(() => {
    if (cur?.key && prevKey.current && cur.key !== prevKey.current) setHome(false);
    prevKey.current = cur?.key ?? null;
  }, [cur?.key]);

  // The sticky header and the dock, measured: they change with the title's wrapping, the phone's
  // status bar and home indicator, the result sheet and the typing field. The recited word counts
  // as in view only between them (with room under it for its meaning), and scrolling to it
  // centres it in that space (scroll-margin on the reading targets in app.css; nothing is set on
  // the page itself, so focusing the header or the dock never scrolls the passage).
  const bars = useRef({ top: 96, bottom: 150 });
  const measureBars = useCallback(() => {
    const top = document.querySelector<HTMLElement>('.r-top');
    const dock = document.querySelector<HTMLElement>('.r-dock');
    if (!top || !dock) return;
    const t = top.getBoundingClientRect().height;
    const b = dock.getBoundingClientRect().height;
    bars.current = { top: t + 8, bottom: b + MEANING_ROOM };
    document.documentElement.style.setProperty('--r-top-h', `${Math.round(t)}px`);
    document.documentElement.style.setProperty('--r-dock-h', `${Math.round(b)}px`);
  }, []);
  const hasSnap = !!snap;
  useEffect(() => {
    const top = document.querySelector<HTMLElement>('.r-top');
    const dock = document.querySelector<HTMLElement>('.r-dock');
    if (!top || !dock || typeof ResizeObserver === 'undefined') return;
    const root = document.documentElement;
    const ro = new ResizeObserver(measureBars);
    ro.observe(top);
    ro.observe(dock);
    measureBars();
    return () => {
      ro.disconnect();
      root.style.removeProperty('--r-top-h');
      root.style.removeProperty('--r-dock-h');
    };
  }, [hasSnap, measureBars]);

  /**
   * Where the reader is in the passage: the ayah at the top of the reading band and how far into it
   * (a gap above it, or a fraction of its height already above the band). Ayahs are in page order.
   */
  const readPlace = useCallback((): { key: string; gap: number; fraction: number } | null => {
    const list = document.querySelectorAll<HTMLElement>('.r-page .r-ayah');
    const top = bars.current.top;
    let lo = 0;
    let hi = list.length - 1;
    let found: HTMLElement | null = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid].getBoundingClientRect().bottom > top + 1) {
        found = list[mid];
        hi = mid - 1;
      } else lo = mid + 1;
    }
    if (!found) return null;
    const r = found.getBoundingClientRect();
    return { key: found.id.slice(2), gap: r.top - top, fraction: r.top >= top ? 0 : (top - r.top) / r.height };
  }, []);
  const place = useRef<ReturnType<typeof readPlace>>(null);

  // A language or text-size change reflows every ayah. While following, the recited ayah is brought
  // back below (the effect after this one); while reading on by hand, the ayah being read stays where
  // it was on the screen, at the same point in it. Applied before paint.
  const lastLayout = useRef<{ lang: string; scale: number } | null>(null);
  useLayoutEffect(() => {
    const prev = lastLayout.current;
    lastLayout.current = { lang, scale: appearance.scale };
    if (!prev || (prev.lang === lang && prev.scale === appearance.scale)) return;
    const p = place.current;
    if (follow || home || !p) return;
    measureBars();
    const el = document.getElementById(`a-${p.key}`);
    if (!el) return;
    const r = el.getBoundingClientRect();
    const top = bars.current.top;
    const want = p.gap >= 0 ? top + p.gap : top - p.fraction * r.height;
    if (Math.abs(r.top - want) > 0.5) window.scrollBy(0, r.top - want);
    place.current = readPlace();
  }, [lang, appearance.scale]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the recited word (or the new ayah) in view, unless the reader scrolled away on purpose.
  useEffect(() => {
    if (!follow || !cur || home) return;
    // Home, language and confirmation changes can resize the bars in this render, before
    // ResizeObserver delivers its next callback. Scroll against their current dimensions.
    measureBars();
    // Back where this device was reading on silently (newer than the chosen ayah): that place, with
    // following paused; the Back pill still returns to the chosen ayah.
    const back = resumeRead.current;
    if (back && surah?.number === surahOf(back.key)) {
      const target = document.getElementById(`a-${back.key}`);
      resumeRead.current = null;
      if (target) {
        target.scrollIntoView({ block: 'start' });
        if (back.fraction) window.scrollBy(0, back.fraction * target.getBoundingClientRect().height);
        place.current = readPlace();
        setFollow(false);
        return;
      }
    }
    // A long ayah begins at its first word/text when chosen by hand; centering its whole
    // section would skip the opening. During recitation, keep following the active word.
    const { element: el, block } = readingAnchor(cur.key, window.innerHeight - bars.current.top - bars.current.bottom);
    if (!el) return;
    const r = el.getBoundingClientRect();
    // Following glides a short way; a jump across the surah (a request, a newly opened surah) lands
    // at once instead of sweeping through pages of text.
    const far = Math.abs(r.top - window.innerHeight / 2) > window.innerHeight * 1.5;
    if (r.top < bars.current.top || r.bottom > window.innerHeight - bars.current.bottom) el.scrollIntoView({ block, behavior: far || matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }, [cur?.key, d?.cursor?.from, surah?.number, follow, appearance.scale, lang, home, reveal, measureBars]);

  // Scrolling by hand pauses following only once the recited ayah is out of view (a nudge, or
  // scrolling back to it, keeps following). The next word recited after a few still seconds brings
  // the page back; just browsing without reciting leaves it where the reader put it.
  useEffect(() => {
    let t = 0;
    let frame = 0;
    const check = () => {
      if (!curKey.current) return;
      const { element: el, block } = readingAnchor(curKey.current, window.innerHeight - bars.current.top - bars.current.bottom);
      if (!el) return;
      const r = el.getBoundingClientRect();
      // A long translation is one paragraph: only its opening line keeps following on.
      const bottom = block === 'start' ? r.top + Math.min(r.height, parseFloat(getComputedStyle(el).lineHeight) || r.height) : r.bottom;
      const following = bottom > bars.current.top && r.top < window.innerHeight - bars.current.bottom;
      setFollow(following);
      // Reading on silently: remember where, on this device, so coming back continues there (back at
      // the chosen ayah, that is the place). While listening, the recitation is the place: it moves
      // the chosen ayah itself.
      if (capRef.current?.listening) return;
      const p = following ? null : readPlace();
      if (following) save({ read: { key: curKey.current, name: curName.current, at: Date.now() } });
      else if (p && surahOf(p.key) === surahOf(curKey.current)) save({ read: { key: p.key, name: curName.current, at: Date.now(), fraction: Math.round(p.fraction * 1000) / 1000 } });
    };
    const byHand = () => {
      lastScroll.current = performance.now();
      clearTimeout(t);
      t = window.setTimeout(check, 250);
    };
    // Momentum keeps scrolling after the finger lifts: keep checking while it settles.
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => { place.current = readPlace(); });
      if (performance.now() - lastScroll.current < 1500) byHand();
    };
    // Keyboard scrolling (and moving through the passage with the arrow keys) is reading by hand too.
    const onKey = (e: KeyboardEvent) => {
      if (!['PageDown', 'PageUp', 'ArrowDown', 'ArrowUp', 'Home', 'End', ' '].includes(e.key)) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"], dialog')) return;
      if (e.key === ' ' && target?.closest('button, a')) return;
      byHand();
    };
    window.addEventListener('wheel', byHand, { passive: true });
    window.addEventListener('touchmove', byHand, { passive: true });
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(t);
      cancelAnimationFrame(frame);
      window.removeEventListener('wheel', byHand);
      window.removeEventListener('touchmove', byHand);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('keydown', onKey);
    };
  }, [readPlace]);

  // Meanings stay inside the column (after every render, and when the window changes size).
  useLayoutEffect(() => {
    const page = document.querySelector('.reader .r-page');
    if (page) keepMeaningsInside(page, (g) => g.closest<HTMLElement>('.r-ayah'));
  });
  useEffect(() => {
    const again = () => {
      const page = document.querySelector('.reader .r-page');
      if (page) keepMeaningsInside(page, (g) => g.closest<HTMLElement>('.r-ayah'));
    };
    window.addEventListener('resize', again);
    return () => window.removeEventListener('resize', again);
  }, []);

  const run = (text: string) => {
    const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    lastRequest.current = id;
    setPending(true);
    setResult(null);
    if (!send({ type: 'command', requestId: id, text, source: 'typed', show: true })) setPending(false);
    setFollow(true);
  };
  const goto = (key: string) => {
    if (!send({ type: 'goto', key })) return;
    // Choosing the ayah already chosen makes it the place again (newer than any silent reading).
    if (key === cur?.key) save({ chosenAt: Date.now() });
    setFollow(true);
    setHome(false);
    if (key === cur?.key) setReveal((n) => n + 1);
  };
  /** Language and text size reflow the page: note the place first (it is also kept on scroll). */
  const chooseLanguage = (language: 'arabic' | 'both' | 'english') => {
    place.current = readPlace();
    send({ type: 'style', patch: { language } });
  };
  const changeAppearance = (next: typeof appearance) => {
    place.current = readPlace();
    setAppearance(next);
  };

  /**
   * The passage is one Tab stop. Up/Down move between ayahs (their numbers), Left/Right between the
   * words of an ayah in reading order (right to left in Arabic) and its number; Home/End go to the
   * first and last ayah. A word reached this way shows its meaning; Enter or Space on a number
   * follows from that ayah, on a word shows or hides its meaning.
   */
  const onPassageKey = (e: ReactKeyboardEvent<HTMLElement>) => {
    const item = (e.target as HTMLElement).closest<HTMLElement>('[data-rove]');
    const ayah = item?.closest<HTMLElement>('.r-ayah');
    if (!item || !ayah || e.altKey || e.ctrlKey || e.metaKey) return;
    let next: HTMLElement | null | undefined;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      let sib: Element | null = ayah;
      do sib = e.key === 'ArrowDown' ? sib.nextElementSibling : sib.previousElementSibling;
      while (sib && !sib.classList.contains('r-ayah'));
      next = sib?.querySelector<HTMLElement>('.r-ayah-follow');
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const items = [...ayah.querySelectorAll<HTMLElement>('[data-rove]')];
      const forward = (e.key === 'ArrowLeft') === !!item.closest('.r-ar');
      next = items[items.indexOf(item) + (forward ? 1 : -1)];
    } else if (e.key === 'Home' || e.key === 'End') {
      const all = ayah.parentElement?.querySelectorAll<HTMLElement>('.r-ayah .r-ayah-follow');
      next = all?.[e.key === 'Home' ? 0 : all.length - 1];
    } else if ((e.key === 'Enter' || e.key === ' ') && item.classList.contains('r-word')) {
      e.preventDefault();
      const k = ayah.id.slice(2);
      const i = Number(item.dataset.rove);
      setPeek((p) => (p?.key === k && p.i === i ? null : { key: k, i, held: true }));
      return;
    } else return;
    e.preventDefault();
    next?.focus();
  };
  /** The keyboard's place follows focus; a word reached from the keyboard shows (and says) its meaning. */
  const onPassageFocus = (e: ReactFocusEvent<HTMLElement>) => {
    const item = (e.target as HTMLElement).closest<HTMLElement>('[data-rove]');
    const ayah = item?.closest<HTMLElement>('.r-ayah');
    if (!item || !ayah) return;
    const k = ayah.id.slice(2);
    const word = item.classList.contains('r-word') ? Number(item.dataset.rove) : null;
    setRove({ key: k, i: word });
    if (word === null) {
      setPeek((p) => (p?.held ? null : p));
      return;
    }
    // A pointer tap focuses the word too; its click shows the meaning (and a second tap hides it).
    if (!item.matches(':focus-visible')) return;
    setPeek({ key: k, i: word, held: true });
    const meaning = surah?.ayahs.find((a) => a.key === k)?.glosses?.[word];
    if (meaning) setSaid(meaning);
  };
  const onPassageBlur = (e: ReactFocusEvent<HTMLElement>) => {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setPeek((p) => (p?.held ? null : p));
  };

  if (auth === 'unavailable') {
    return <main className="r-gate"><h1>Couldn’t open the reader</h1><p>Check your connection, then try again.</p><button onClick={() => location.reload()}>Try again</button></main>;
  }
  if (auth === 'unauthorized') {
    return (
      <main className="r-gate">
        <h1>Open your private link</h1>
        <p>This reader uses the link printed where the app was started (the same one as the control page).</p>
      </main>
    );
  }
  if (!snap) return <main className="r-gate">{connectionFailed ? <>
    <h1>Couldn't connect to the reader</h1>
    <p role="status">Check your connection. The reader will reconnect automatically.</p>
    <button onClick={() => location.reload()}>Try again</button>
  </> : <p role="status">Opening…</p>}</main>;

  const listening = cap.listening;
  const starting = capture.state === 'starting' || capture.state === 'reconnecting';
  // In line for a place to listen: the microphone is open but nothing is heard yet, so no level ring.
  const waiting = capture.state === 'waiting';
  const r = result?.r ?? null;
  const shownSurah = surah && cur && surah.number === cur.surah ? surah : null;
  const shownSurahForBar = shownSurah;
  const listeningElsewhere = !listening && ['recording', 'starting', 'reconnecting'].includes(snap.capture.phase);
  const status = connection !== 'open'
    ? 'Reconnecting… your place is saved. Please wait before choosing another ayah.'
    : !snap.setup.soniox
    ? 'Listening is unavailable right now. You can still read or type a request.'
    : listeningElsewhere
    ? 'Listening from another page. The reader follows along.'
    : !listening
    ? capture.state === 'error'
      ? capture.detail
      : (capture.detail ?? 'Tap the microphone and recite, or ask in English.')
    : capture.detail && !(capture.state === 'reconnecting' && capture.detail === RECONNECTING)
      ? capture.detail // e.g. "Listening paused while the screen was off. Recite to continue."
    : capture.state === 'dozing'
      ? 'Listening… take your time. Nothing is sent while you’re quiet.'
      : snap.held
      ? 'Paused. The page stays here.'
      : snap.phase === 'tracking'
        ? `Following · ${cur?.key ?? ''}`
        : 'Listening… recite, or say “go to Surah Yaseen”.';

  // The outcome of a request that needs no choice is said in the dock's status line, so the passage
  // stays clear (the header already shows the ayah). Result cards, errors and "Not it?" choices use
  // the sheet above the dock. The resolver's note says how a request was understood.
  const confirmedHere = !pending && r?.kind === 'candidates' && !!r.confirmedKey && r.confirmedKey === cur?.key && !moreOpen;
  const notice = pending
    ? 'Finding it…'
    : r?.kind === 'navigate'
      ? (r.note ? `Opened ${r.key} · ${r.note}` : `Opened ${r.key}.`)
      : r?.kind === 'control'
        ? r.label
        : confirmedHere && r?.kind === 'candidates'
          ? `Opened ${r.cards.find((c) => c.key === r.confirmedKey)?.surahName ?? ''} ${r.confirmedKey}.`
          : null;
  const sheetOpen = !pending && !!r && !notice;
  const resume = !cur || home ? readOn(loadSaved()) : null;
  // Where Continue goes: the silent reading place when it is newer, else the chosen ayah.
  const continueAt = cur && home
    ? (resume && surahOf(resume.key) === cur.surah ? resume : { key: cur.key, name: cur.surahName, at: 0 })
    : resume ?? (saved.key ? { key: saved.key, name: saved.name ?? '', at: 0 } : null);
  // The keyboard's single stop in the passage: the last place it was in this surah, else the current ayah.
  const roveKey = rove && shownSurah?.ayahs.some((a) => a.key === rove.key) ? rove.key : cur?.key ?? null;
  const roveWord = rove && rove.key === roveKey && lang !== 'english' ? rove.i : null;

  return (
    <div className="reader" data-lang={lang} data-theme={appearance.theme}>
      {/* The passage can be long: one step to the microphone and typing. */}
      <a className="r-skip" href="#r-controls" onClick={(e) => { e.preventDefault(); document.querySelector<HTMLElement>('#r-controls button:not(:disabled)')?.focus({ preventScroll: true }); }}>
        Skip to reading controls
      </a>
      <header className="r-top">
        <button className="r-menu-btn" onClick={() => setMenuOpen(true)} aria-label="Menu: home, surahs, listening time" aria-haspopup="dialog">
          <MenuIcon />
        </button>
        <div className="r-title">
          {cur && !home ? (
            <>
              <span className="r-name">{cur.surahName}</span>
              <span className="r-name-ar" lang="ar">{cur.surahNameArabic}</span>
              <span className="r-key">{cur.key}</span>
            </>
          ) : (
            <span className="r-name">Quran Reader</span>
          )}
        </div>
        <div className="r-langs" role="radiogroup" aria-label="Language">
          {([['arabic', 'عربي'], ['both', 'Both'], ['english', 'English']] as const).map(([v, label]) => (
            <button key={v} role="radio" aria-checked={lang === v} className={lang === v ? 'on' : ''} lang={v === 'arabic' ? 'ar' : 'en'} onClick={() => chooseLanguage(v)}>
              {label}
            </button>
          ))}
        </div>
        {shownSurahForBar && cur && !home && (
          // Where in the surah: a hairline that fills as the recitation moves through it.
          <div className="r-progress" role="progressbar" aria-label="Position in the surah" aria-valuemin={1} aria-valuemax={shownSurahForBar.ayahs.length} aria-valuenow={cur.ayah}>
            <span style={{ transform: `scaleX(${cur.ayah / shownSurahForBar.ayahs.length})` }} />
          </div>
        )}
      </header>

      <main className="r-page">
        {cur && !home && !shownSurah && <div className="r-note" role="status">
          {surahFailed ? <><p>Couldn’t load this surah. Check your connection and try again.</p><button onClick={() => setSurahRetry((n) => n + 1)}>Try again</button></> : <p>Opening {cur.surahName}…</p>}
        </div>}
        {(!cur || home) && (
          <section className="r-welcome">
            <figure className="r-iqra-figure">
              <p className="r-iqra" lang="ar" dir="rtl">{toQpcHafsEncoding('ٱقۡرَأۡ')}</p>
              <figcaption className="r-iqra-meaning">
                <span className="r-iqra-en">Recite</span>
                <span className="r-iqra-ref">The first word revealed to the Prophet <bdi className="r-salutation" lang="ar">ﷺ</bdi> (96:1)</span>
              </figcaption>
            </figure>
            <h1>Recite, and the page follows{NBSP}along.</h1>
            <p className="r-sub">Each word you recite lights up with its meaning, on your phone or on your stream.</p>
            <FollowDemo />
            {continueAt && (
              <button
                className="r-continue"
                onClick={() => {
                  if (cur && home) {
                    // Back to the passage: where this device was reading on, or the chosen ayah.
                    resumeRead.current = continueAt.key !== cur.key ? continueAt : null;
                    setHome(false);
                    setFollow(true);
                  } else goto(continueAt.key);
                }}
              >
                Continue at {continueAt.name ? `${continueAt.name} ` : ''}
                {continueAt.key}
              </button>
            )}
            {!!saved.recited?.length && <p className="r-today">Today: {saved.recited.length} {saved.recited.length === 1 ? 'ayah' : 'ayahs'} recited</p>}
            <div className="r-try">
              <p className="r-try-label">Start reciting, or ask for a surah</p>
              <div className="r-quick">
                {TRY.map((t) => (
                  <button key={t} onClick={() => run(t)}>“{t}”</button>
                ))}
              </div>
            </div>
            <details className="r-privacy">
              <summary>How your voice is used</summary>
              <p>{audioRoute(mode)} {transcriptUse(mode)} {SILENCE_CONTROL} Reading never needs the microphone. <a href={u('/privacy.html')}>Privacy details</a></p>
            </details>
            {credits && <SharedHours stats={funding.sponsored} donations={funding.billing?.donations ?? []} testMode={funding.billing?.testMode} />}
            {/* Streamers: the same following, as a broadcast overlay driven from the control page. */}
            <a className="r-stream" href={u('/control')}>
              <span className="r-stream-k">Streaming?</span> Show the ayah you’re reciting on your stream with OBS
              <span aria-hidden="true"> →</span>
            </a>
            <SurahIndex onOpen={(n) => goto(`${n}:1`)} />
            <footer className="r-brand">
              <NurraBadge />
              <a href={u('/about')}>Why we built this</a>
            </footer>
          </section>
        )}
        {shownSurah && !home && (
          <>
            <header className="r-surah">
              <div className="r-surah-frame">
                <span className="r-surah-ar" lang="ar" dir="rtl">سورة {shownSurah.nameArabic}</span>
              </div>
              <p className="r-surah-en">
                {shownSurah.name} · {shownSurah.ayahs.length} {shownSurah.ayahs.length === 1 ? 'ayah' : 'ayahs'}
              </p>
            </header>
            {shownSurah.number !== 1 && shownSurah.number !== 9 && (
              <p className="r-basmala" lang="ar" dir="rtl">{toQpcHafsEncoding('بِسۡمِ ٱللَّهِ ٱلرَّحۡمَٰنِ ٱلرَّحِيمِ')}</p>
            )}
            <p id="r-keys-hint" className="r-sr-only">Arrow keys move between ayahs and words. Enter on an ayah number follows from there; on a word, shows its meaning.</p>
            <div className="r-passage" onKeyDown={onPassageKey} onFocus={onPassageFocus} onBlur={onPassageBlur}>
            {shownSurah.ayahs.map((a) => {
              const isCur = a.key === cur!.key;
              const cursor = isCur ? d!.cursor : null;
              const words = toQpcHafsEncoding(a.arabic).split(/\s+/).filter(Boolean);
              const markerStop = a.key === roveKey && roveWord === null;
              return (
                <section
                  key={a.key}
                  id={`a-${a.key}`}
                  className={`r-ayah${isCur ? ' current' : ''}`}
                  onClick={() => goto(a.key)}
                  role="group"
                  aria-label={`${shownSurah.name} ${a.key}`}
                  aria-current={isCur ? 'true' : undefined}
                >
                  {lang !== 'english' && (
                    <p className="r-ar" lang="ar" dir="rtl">
                      {words.map((w, i) => {
                        const active = !!cursor && i >= cursor.from && i <= cursor.to;
                        const passed = !!cursor && i < cursor.from;
                        const peeked = peek?.key === a.key && peek.i === i;
                        const gloss = peeked
                          ? (a.glosses?.[i] ?? null)
                          : active && lang === 'both' && i === cursor!.from
                            ? a.glosses?.slice(cursor!.from, cursor!.to + 1).filter(Boolean).join(' ') || null
                            : null;
                        const hasMeaning = !!a.glosses?.[i];
                        return (
                          // The last word and the ayah number stay on one line (the number is a button,
                          // and a no-break space alone does not hold an inline-block to the word).
                          <span key={i} className={i === words.length - 1 ? 'r-ayah-end' : undefined}>
                            <span
                              className={`r-word${active ? ' active' : ''}${passed ? ' passed' : ''}${peeked ? ' peeked' : ''}`}
                              // Tapping a word shows its meaning; tapping elsewhere in the ayah follows from it.
                              onClick={hasMeaning ? (e) => { e.stopPropagation(); setPeek(peeked ? null : { key: a.key, i }); } : undefined}
                              // The keyboard reaches each word that has a meaning (arrow keys, from the ayah number).
                              {...(hasMeaning ? { role: 'button', tabIndex: a.key === roveKey && roveWord === i ? 0 : -1, 'data-rove': i } : {})}
                            >
                              {w}
                              {gloss && <span className="r-gloss" lang="en" dir="ltr">{gloss}</span>}
                            </span>
                            {i < words.length - 1 ? ' ' : <>{NBSP}<button className="r-mark r-ayah-follow" lang="en" data-rove="n" tabIndex={markerStop ? 0 : -1} aria-describedby={markerStop ? 'r-keys-hint' : undefined} aria-label={`Follow from ${shownSurah.name} ${a.key}`} aria-current={isCur ? 'true' : undefined} onClick={(e) => { e.stopPropagation(); goto(a.key); }}><span aria-hidden="true" lang="ar">{arabicNumber(a.ayah)}</span></button></>}
                          </span>
                        );
                      })}
                    </p>
                  )}
                  {lang !== 'arabic' && (
                    <p className="r-en" lang="en">
                      {lang === 'english' && <button className="r-num r-ayah-follow" data-rove="n" tabIndex={markerStop ? 0 : -1} aria-describedby={markerStop ? 'r-keys-hint' : undefined} aria-label={`Follow from ${shownSurah.name} ${a.key}`} aria-current={isCur ? 'true' : undefined} onClick={(e) => { e.stopPropagation(); goto(a.key); }}><span aria-hidden="true">{a.ayah}</span></button>}
                      {a.english}
                    </p>
                  )}
                </section>
              );
            })}
            </div>
            <p className="r-sr-only" aria-live="polite">{said}</p>
            <p className="r-credit">
              {shownSurah.translation}
              {shownSurah.glossCredit ? ` · ${shownSurah.glossCredit}` : ''}
            </p>
            {/* Support lives below the reading, never above the surah. */}
            {credits && <p className="r-credit r-credit-support"><button className="r-quiet-link" onClick={() => setTimeOpen('sponsor')}>Support Quran Reader</button></p>}
          </>
        )}
      </main>

      {showSupportThanks && <div className="r-toast" role="status"><span>JazakAllahu khayran for supporting Quran Reader. Shared hours are added after Stripe confirms payment.</span><button aria-label="Dismiss thank-you message" onClick={() => setDonated(false)}>×</button></div>}
      {menuOpen && (
        <ReaderModal label="Menu" onClose={() => setMenuOpen(false)}>
          <nav className="r-time r-menu" onClick={(e) => e.stopPropagation()}>
            <button className="r-close" onClick={() => setMenuOpen(false)} aria-label="Close">×</button>
            <button className="r-menu-item" autoFocus onClick={() => { setHome(true); setMenuOpen(false); window.scrollTo(0, 0); }}>
              Home<span>{cur ? `Start page, with a way back to ${cur.surahName} ${cur.key}` : 'Start page'}</span>
            </button>
            <button className="r-menu-item" onClick={() => { setHome(true); setMenuOpen(false); requestAnimationFrame(() => document.getElementById('r-surahs')?.scrollIntoView({ block: 'start' })); }}>
              All surahs<span>Open any of the 114, by name or number</span>
            </button>
            <button className="r-menu-item" onClick={() => { setMenuOpen(false); setAppearanceOpen(true); }}>
              Reading appearance<span>{appearance.theme === 'paper' ? 'Paper' : 'Night'} · text at {Math.round(appearance.scale * 100)}%</span>
            </button>
            {credits ? (
              <button className="r-menu-item" onClick={() => { setMenuOpen(false); setTimeOpen('time'); }}>
                Listening<span>{listeningLine(credits, snap.overlay.clients > 0, ownKey)}</span>
              </button>
            ) : (
              <p className="r-menu-item r-menu-static">Listening time<span>Unlimited: this reader runs on your own computer, with your own key</span></p>
            )}
            {credits && (
              <button className="r-menu-item" onClick={() => { setMenuOpen(false); setTimeOpen('sponsor'); }}>
                Support Quran Reader<span>Help cover shared listening hours</span>
              </button>
            )}
            <a className="r-menu-item" href={u('/control')}>
              Put it on your stream<span>OBS overlay and stream controls</span>
            </a>
            <a className="r-menu-item" href={u('/about')}>
              Why we built this<span>Our purpose, the overlay, and community support</span>
            </a>
            <a className="r-menu-item" href={u('/privacy.html')}>Privacy and your data</a>
            <a className="r-menu-item" href="https://github.com/NurraLLC/quran-reader/issues" target="_blank" rel="noopener">Help or report a problem</a>
            <a className="r-menu-item" href={u('/terms.html')}>Terms of use</a>
            <div className="r-menu-brand">
              <NurraBadge />
            </div>
          </nav>
        </ReaderModal>
      )}
      {timeOpen && credits && <ListeningTime credits={credits} funding={funding} focus={timeOpen} onClose={() => setTimeOpen(false)} />}
      {appearanceOpen && <ReaderAppearance appearance={appearance} onChange={changeAppearance} onClose={() => { setAppearanceOpen(false); requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('.r-menu-btn')?.focus({ preventScroll: true })); }} />}

      {!follow && cur && !home && (
        <button className="r-back" onClick={() => setFollow(true)}>
          Back to {cur.key}
        </button>
      )}

      <footer className="r-dock">
        {sheetOpen && r && (
          <div className="r-sheet" role="status">
            {(r.kind === 'no_match' || r.kind === 'invalid_reference') && <p className="r-note warn">{r.message}</p>}
            {r.kind === 'candidates' && (
              <ul className="r-results">
                {r.cards.slice(0, 4).map((c) => (
                  <li key={c.key}>
                    <button
                      onClick={() => {
                        send({ type: 'show_result', requestId: result!.id, key: c.key });
                        send({ type: 'hold', on: false });
                        setResult(null);
                        setFollow(true);
                        setHome(false);
                      }}
                    >
                      <span className="r-res-key">{c.surahName} {c.key}{c.key === r.confirmedKey ? ' · best match' : ''}</span>
                      <span className="r-res-en">{c.english}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <button className="r-close" onClick={() => setResult(null)} aria-label="Close">
              ×
            </button>
          </div>
        )}
        {typing && (
          <form
            className="r-type"
            onSubmit={(e) => {
              e.preventDefault();
              if (query.trim()) run(query.trim());
            }}
          >
            <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Surah Maryam 3, or what the ayah says" aria-label="Type a request" aria-describedby="reader-request-privacy" enterKeyHint="go" />
            <button type="submit" disabled={!query.trim()}>Go</button>
            <p id="reader-request-privacy" className="r-request-privacy">{REQUEST_PRIVACY} <a href={u('/privacy.html')} target="_blank" rel="noopener">Privacy</a></p>
          </form>
        )}
        <div className="r-controls" id="r-controls">
          <button className="r-kbd" onClick={() => setTyping((t) => !t)} aria-pressed={typing} aria-label="Type instead">
            <Keys />
          </button>
          <div className="r-mic-wrap" ref={micWrap} data-live={(listening && !waiting) || undefined} data-waiting={waiting || undefined}>
            {/* The ring follows the microphone level: proof that it hears you, before any word appears. */}
            <span className="r-mic-ring" aria-hidden="true" />
            <button
              className={`r-mic${listening && !waiting ? ' live' : ''}${starting ? ' starting' : ''}${waiting ? ' waiting' : ''}`}
              onClick={() => (listening || starting ? cap.stop() : void cap.start(null))}
              disabled={!listening && !starting && (!snap.setup.soniox || connection !== 'open')}
              aria-label={waiting ? 'Stop waiting to listen' : listening || starting ? 'Stop listening' : 'Start listening'}
            >
              {listening || starting ? <Stop /> : <Mic />}
            </button>
          </div>
          <div className="r-status" aria-live="polite">
            {/* What the recogniser heard is never shown: its spelling is not the Quran's, and the
                page itself (the highlighted word) is the proof that listening works. */}
            {notice ? (
              <span className={pending ? undefined : 'ok'}>
                {notice}
                {confirmedHere && r?.kind === 'candidates' && r.cards.length > 1 && (
                  <>
                    {' '}
                    <button className="r-more" onClick={() => setMoreOpen(true)}>
                      Not it? {r.cards.length - 1} more
                    </button>
                  </>
                )}
              </span>
            ) : <span>{status}</span>}
            {credits && (
              <button className={`r-credits${credits.available < 600 ? ' low' : ''}`} onClick={() => setTimeOpen('time')}>
                {listeningLine(credits, snap.overlay.clients > 0, ownKey)}
              </button>
            )}
            {snap.held && (
              <button className="r-resume" onClick={() => send({ type: 'hold', on: false })}>
                Follow my recitation
              </button>
            )}
          </div>
        </div>
      </footer>
    </div>
  );
}

/** Native modal semantics contain keyboard focus and make the reading page behind the sheet inert. */
function ReaderModal({ label, onClose, children }: { label: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const returnFocus = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    return () => {
      dialog.close();
      // React removes the sheet before passive cleanup, so native close alone cannot always
      // restore its opener. Leave focus in a newly opened dialog when moving between sheets.
      const opener = returnFocus.current?.isConnected ? returnFocus.current : document.querySelector<HTMLElement>('.r-menu-btn');
      // The opener is in view (the header or the dock): returning focus must not move the passage.
      if (document.activeElement === document.body || dialog.contains(document.activeElement)) opener?.focus({ preventScroll: true });
    };
  }, []);
  return (
    <dialog ref={ref} className="r-modal" aria-label={label} onCancel={(e) => { e.preventDefault(); onClose(); }} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      {children}
    </dialog>
  );
}

/** Community-funded listening, without accounts or personal purchases. */
function ListeningTime({ credits, funding, focus, onClose }: { credits: CreditView; funding: Pick<Access, 'billing' | 'sponsored'>; focus: 'time' | 'sponsor'; onClose: () => void }) {
  return (
    <ReaderModal label={focus === 'sponsor' ? 'Support Quran Reader' : 'Listening'} onClose={onClose}>
      <section className="r-time" onClick={(e) => e.stopPropagation()}>
        <button className="r-close" onClick={onClose} aria-label="Close" autoFocus>×</button>
        <h2>{focus === 'sponsor' ? 'Support Quran Reader' : 'Free for everyone'}</h2>
        <p className="r-time-detail">Help someone else recite. Community contributions cover one shared pool of listening hours.</p>
        <SharedHours stats={funding.sponsored} donations={funding.billing?.donations ?? []} testMode={funding.billing?.testMode} defaultOpen />
        <p className="r-time-free">Reading, word meanings and translations are always free.</p>
        <p className="r-time-detail">
          {credits.limitedBy === 'pool' ? 'Shared listening hours are unavailable right now.' : credits.limitedBy === 'share'
            ? 'Today’s fair-use limit has been reached. Listening will be available again tomorrow.'
            : 'Daily listening limits help everyone share the available hours.'}
        </p>
      </section>
    </ReaderModal>
  );
}

type ChapterRow = { number: number; nameSimple: string; nameArabic: string; verseCount: number };

/** Every surah, findable by English name, Arabic name or number. */
function SurahIndex({ onOpen }: { onOpen: (n: number) => void }) {
  const [list, setList] = useState<ChapterRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const [q, setQ] = useState('');
  const [all, setAll] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setFailed(false);
    fetch(u('/api/chapters'), { credentials: 'same-origin', signal: controller.signal })
      .then((r) => { if (!r.ok) throw new Error('Surahs unavailable'); return r.json(); })
      .then((l: ChapterRow[]) => { if (!controller.signal.aborted) setList(l); })
      .catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [retry]);
  const flat = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, '');
  const t = q.trim();
  const matches = t ? (list ?? []).filter((c) => String(c.number) === t || (flat(t) && flat(c.nameSimple).includes(flat(t))) || c.nameArabic.includes(t)) : (list ?? []);
  const shown = t || all ? matches : matches.slice(0, 12);
  return (
    <section className="r-index" id="r-surahs" aria-label="All surahs">
      <h2>All surahs</h2>
      {!list ? <div className="r-index-state" role="status">
        <p>{failed ? "Couldn't load the surahs." : 'Opening surahs.'}</p>
        {failed && <button className="r-index-more" onClick={() => setRetry((n) => n + 1)}>Try again</button>}
      </div> : <>
      <input className="r-index-find" type="search" placeholder="Find a surah by name or number" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Find a surah" />
      <ol className="r-index-list">
        {shown.map((c) => (
          <li key={c.number}>
            <button onClick={() => onOpen(c.number)} aria-label={`${c.number}. ${c.nameSimple}, ${c.verseCount} ayahs`}>
              <span className="r-index-n">{c.number}</span>
              <span className="r-index-en">
                {c.nameSimple}
                <small>{c.verseCount} ayahs</small>
              </span>
              <span className="r-index-ar" lang="ar" dir="rtl">{c.nameArabic}</span>
            </button>
          </li>
        ))}
      </ol>
      {!shown.length && <p className="r-index-none">No surah matches “{t}”.</p>}
      {!t && !all && (
        <button className="r-index-more" onClick={() => setAll(true)}>
          Show all 114 surahs
        </button>
      )}
      </>}
    </section>
  );
}
