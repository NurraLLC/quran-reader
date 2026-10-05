// Reciter's control page. Everything here is private to the broadcaster; only the display state
// (mirrored in the preview) reaches the audience.

import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import type { CommandResult, ControlClientMessage, ControlServerMessage, ControlSnapshot, CreditView, SearchCard, StreamSettings, StreamState } from '../shared/contracts';
import { OWN_KEY_SHAPE, ownSonioxKey, setOwnSonioxKey, SonioxCapture, type CaptureStatus } from './audio/soniox-session';
import { access, applyDisplay, applySnapshot, connect, formatListening, listeningLine, u } from './net';
import { NurraBadge } from './Nurra';
import { toQpcHafsEncoding } from '../shared/display-encoding';
import { StageFrame, VerseDisplay, useFontsReady, type LayoutInfo } from './VerseDisplay';
import { money } from './stream-format';
import { OverlayAppearance } from './OverlayAppearance';
import { REQUEST_PRIVACY } from './privacy-copy';

const StreamScene = lazy(() => import('./Stream').then((m) => ({ default: m.StreamScene })));

type ChapterRow = { number: number; nameSimple: string; nameArabic: string; verseCount: number };
type Auth = 'checking' | 'owner' | 'unauthorized';

function statusLine(s: ControlSnapshot): { tone: string; title: string; detail: string } {
  const key = s.display.verse ? `${s.display.verse.surahName} ${s.display.verse.key}` : null;
  const onScreen = key ? `${key} is on screen.` : 'The screen is empty.';
  switch (s.phase) {
    case 'idle':
      return { tone: 'idle', title: 'Not listening', detail: onScreen };
    case 'listening_unlocated':
      return { tone: 'seeking', title: 'Listening — finding your place', detail: key ? `${onScreen}` : 'Begin reciting; the ayah appears once it is recognized.' };
    case 'tracking':
      return { tone: 'following', title: `Following · ${key ?? '—'}`, detail: 'The screen moves with your recitation.' };
    case 'uncertain':
      return { tone: 'seeking', title: `Checking · holding ${key ?? '—'}`, detail: 'Recent words did not match this ayah. It stays up briefly while the place is found again.' };
    case 'held':
      return {
        tone: 'held',
        title: `Paused · screen holds ${s.display.verse?.key ?? 'nothing'}`,
        detail:
          s.trackerVerse && s.trackerVerse !== s.display.verse?.key
            ? `You seem to be at ${s.trackerVerse}. Resume following to show it.`
            : ['recording', 'starting', 'reconnecting'].includes(s.capture.phase)
              ? 'Still listening privately; the screen will not move until you resume.'
              : 'The screen will not move until you resume following.',
      };
    case 'waiting':
      return { tone: 'seeking', title: 'In line to listen', detail: `Many people are reciting right now. Listening starts by itself when it’s your turn.${key ? ` ${key} stays on screen.` : ''}` };
    case 'dozing':
      return { tone: 'following', title: 'Listening · waiting for you to recite', detail: `${key ? `${key} stays on screen. ` : ''}Nothing is sent while you are quiet; recite and it continues at once.` };
    case 'stopped':
      return { tone: 'idle', title: 'Not listening', detail: key ? `${key} stays on screen until you change it.` : 'The screen is empty.' };
    case 'disconnected':
    case 'error':
      return { tone: 'error', title: 'Listening stopped', detail: s.capture.detail ?? 'The microphone stream ended unexpectedly.' };
  }
}

export function Control() {
  const [auth, setAuth] = useState<Auth>('checking');
  const [snap, setSnap] = useState<ControlSnapshot | null>(null);
  const [conn, setConn] = useState<'connecting' | 'open' | 'closed'>('connecting');
  const [capture, setCapture] = useState<CaptureStatus>({ state: 'off', detail: null });
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState<string>('');
  const [chapters, setChapters] = useState<ChapterRow[]>([]);
  const [query, setQuery] = useState('');
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [result, setResult] = useState<{ id: string; r: CommandResult } | null>(null);
  const [copied, setCopied] = useState(false);
  /** The clipboard refused the overlay link (no permission, or not a secure page): it is shown to copy by hand. */
  const [copyFailed, setCopyFailed] = useState<false | 'first-run' | 'output'>(false);
  /** Where this page is served from: the owner's own machine, or the public site. Words differ. */
  const [mode, setMode] = useState<'local' | 'hosted' | null>(null);
  /** Listening time left (hosted service only). */
  const [credits, setCredits] = useState<CreditView | null>(null);
  const [stream, setStream] = useState<StreamState | null>(null);
  // The preview a broadcaster chose (plain overlay or charity scene) is remembered on this device: its
  // page counts drive the page buttons, so it must match what OBS shows after a reload too.
  const [previewMode, setPreviewMode] = useState<'overlay' | 'stream'>(() => {
    try { return localStorage.getItem('qo.previewMode') === 'stream' ? 'stream' : 'overlay'; } catch { return 'overlay'; }
  });
  /** The overlay link was just replaced: the new one must be pasted into OBS. */
  const [replaced, setReplaced] = useState(false);
  /** This device has seen OBS open the overlay before (the first-run steps then stay folded). */
  const [obsSeen, setObsSeen] = useState(() => { try { return localStorage.getItem('qo.obsSeen') === '1'; } catch { return false; } });
  const [firstRunDone, setFirstRunDone] = useState(false);
  const obsSeenAtLoad = useRef(obsSeen);
  const [backdrop, setBackdrop] = useState<'grid' | 'light' | 'dark'>('grid');
  const fontsReady = useFontsReady();
  const sock = useRef<ReturnType<typeof connect> | null>(null);
  const lastRequest = useRef<string | null>(null);

  const send = useCallback((m: ControlClientMessage) => sock.current?.send(m) ?? false, []);
  const captureRef = useRef<SonioxCapture | null>(null);
  // The streamer's own Soniox key, if saved in this browser, and why it was refused (then the shared hours are used).
  const [ownKey, setOwnKey] = useState(() => ownSonioxKey());
  const [ownProblem, setOwnProblem] = useState<string | null>(null);
  if (!captureRef.current) {
    captureRef.current = new SonioxCapture(
      (m) => send(m),
      (s) => setCapture(s),
      () => undefined,
    );
    captureRef.current.onOwnKeyProblem = setOwnProblem;
  }
  const cap = captureRef.current;

  // Live speed meter: how far the screen trails the voice, timed by the server against the
  // recogniser's audio clock (zero = first microphone chunk). A word is timed from when it began,
  // so a highlight that keeps pace reads near zero. Mic input, network and paint add a little.
  const [speedView, setSpeedView] = useState<{ ayah: number[]; word: number[]; last: number | null }>({ ayah: [], word: [], last: null });
  const lastSpeedRev = useRef(-1);
  // Diagnostic hook for the speed lab (scripts/speedlab): the audio clock's zero point.
  useEffect(() => {
    (window as unknown as { __qoAudioOrigin?: () => number | null }).__qoAudioOrigin = () => cap.audioOrigin;
  }, [cap]);
  const measureSpeed = useCallback((sp: ControlSnapshot['speed']) => {
    if (!sp || sp.revision === lastSpeedRev.current) return;
    lastSpeedRev.current = sp.revision;
    const lag = sp.lagMs;
    if (lag < -3000 || lag > 30000) return;
    setSpeedView((v) => ({
      ayah: sp.verseChanged ? [...v.ayah, lag].slice(-60) : v.ayah,
      word: sp.verseChanged ? v.word : [...v.word, lag].slice(-120),
      last: sp.verseChanged ? lag : v.last,
    }));
  }, []);

  useEffect(() => {
    document.documentElement.dataset.surface = 'control';
    document.title = 'Stream controls · Quran Reader';
    let cancelled = false;
    access()
      .then((s) => {
        if (cancelled) return;
        setMode(s.mode);
        if (!s.owner) return setAuth('unauthorized');
        if (s.credits) setCredits(s.credits);
        setAuth('owner');
        fetch(u('/api/chapters'), { credentials: 'same-origin' })
          .then((r) => r.json())
          .then(setChapters)
          .catch(() => undefined);
        sock.current = connect(u('/ws/control'), {
          // A reconnect is taken by the server for the page leaving: say again that it is listening.
          onOpen: () => captureRef.current?.announce(),
          onStatus: (st, code) => {
            setConn(st);
            if (code === 4401) {
              setAuth('unauthorized');
              // This page no longer controls anything: the microphone it opened closes with it.
              captureRef.current?.stop();
            }
          },
          shouldRetry: (code) => code !== 4401,
          onMessage: (data) => {
            const m = data as ControlServerMessage;
            if (m.type === 'credits') setCredits(m.credits);
            else if (m.type === 'stream') setStream(m.state);
            else if (m.type === 'listen_turn') captureRef.current?.onTurn(); // waiting in line: a place is free
            else if (m.type === 'snapshot') {
              setSnap((prev) => applySnapshot(prev, m.snapshot));
              captureRef.current?.setLive(m.snapshot.overlay.clients > 0);
              measureSpeed(m.snapshot.speed);
            } else if (m.type === 'display') setSnap((prev) => applyDisplay(prev, m.state));
            else if (m.type === 'command_pending') {
              if (m.requestId.startsWith('listen:')) { lastRequest.current = m.requestId; setResult(null); }
              if (m.requestId === lastRequest.current) setPendingId(m.requestId);
            } else if (m.type === 'command_result') {
              if (m.requestId !== lastRequest.current) return; // an older search never replaces a newer one
              setPendingId(null);
              setResult({ id: m.requestId, r: m.result });
            }
          },
        });
      })
      .catch(() => !cancelled && setAuth('unauthorized'));
    return () => {
      cancelled = true;
      sock.current?.close();
      captureRef.current?.stop();
    };
  }, []);

  const refreshDevices = useCallback(() => {
    navigator.mediaDevices
      ?.enumerateDevices()
      .then((d) => setDevices(d.filter((x) => x.kind === 'audioinput' && x.deviceId)))
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    refreshDevices();
    navigator.mediaDevices?.addEventListener('devicechange', refreshDevices);
    return () => navigator.mediaDevices?.removeEventListener('devicechange', refreshDevices);
  }, [refreshDevices]);
  useEffect(() => {
    if (capture.state === 'recording') refreshDevices();
  }, [capture.state, refreshDevices]);

  // The preview measures an ayah's pages and promotion once (not at every highlight step). The server
  // keeps a measurement only for the revision it was taken at, so it is resent, at most once per
  // revision, until the server holds it for the ayah on screen.
  const [measured, setMeasured] = useState<LayoutInfo | null>(null);
  const layoutSentAt = useRef('');
  useEffect(() => {
    if (!snap || !measured || measured.key !== snap.display.verse?.key) return;
    const held = snap.layout;
    if (held && held.key === measured.key && held.englishPages === measured.englishPages && held.arabicPages === measured.arabicPages && held.promotedToFullFrame === measured.promotedToFullFrame) return;
    const stamp = `${snap.display.revision}:${previewMode}:${measured.englishPages}:${measured.arabicPages}:${measured.promotedToFullFrame}`;
    if (layoutSentAt.current === stamp) return;
    layoutSentAt.current = stamp;
    send({ type: 'layout', revision: snap.display.revision, key: measured.key, englishPages: measured.englishPages, arabicPages: measured.arabicPages, promotedToFullFrame: measured.promotedToFullFrame });
  }, [snap, measured, previewMode, send]);

  const choosePreview = (next: 'overlay' | 'stream') => {
    if (next === previewMode) return;
    setMeasured(null);
    setPreviewMode(next);
    try { localStorage.setItem('qo.previewMode', next); } catch { /* still works for this visit */ }
    layoutSentAt.current = '';
  };

  // OBS (or a reading screen) opened the overlay: remembered, so a returning broadcaster is not shown
  // the whole first-run again.
  const overlayOpen = (snap?.overlay.clients ?? 0) > 0;
  useEffect(() => {
    if (!overlayOpen || obsSeen) return;
    setObsSeen(true);
    try { localStorage.setItem('qo.obsSeen', '1'); } catch { /* shown again next visit */ }
  }, [overlayOpen, obsSeen]);

  const copyOverlayLink = (where: 'first-run' | 'output') => {
    if (!snap) return;
    const failed = () => setCopyFailed(where);
    const done = () => {
      setCopyFailed(false);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    };
    // The clipboard needs a secure page and the browser's permission; either can be missing.
    try {
      navigator.clipboard.writeText(snap.overlay.url).then(done, failed);
    } catch {
      failed();
    }
  };
  const replaceLink = () => {
    if (!snap) return;
    const n = snap.overlay.clients;
    if (n > 0 && !window.confirm(`OBS (or a reading screen) is showing this link now${n > 1 ? ` in ${n} places` : ''}. Replacing it turns it off until you paste the new link into the Browser source. Replace it?`)) return;
    if (send({ type: 'rotate_view' })) setReplaced(true);
  };

  const runCommand = useCallback(
    (text: string, source: 'typed' | 'voice') => {
      const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      lastRequest.current = id;
      setResult(null);
      setPendingId(id);
      send({ type: 'command', requestId: id, text, source });
    },
    [send],
  );

  // Keyboard: ←/→ navigate, H pause/resume, B hide/show. Ignored while typing, and arrow keys inside
  // a choice group (language, view, look...) move between its choices instead of changing the ayah.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('input, textarea, select') || e.metaKey || e.ctrlKey || e.altKey || !snap) return;
      if (e.key.startsWith('Arrow') && t.closest('[role="radiogroup"]')) return;
      if (e.key === 'ArrowRight') send({ type: 'nav', action: 'next' });
      else if (e.key === 'ArrowLeft') send({ type: 'nav', action: 'prev' });
      else if (e.key.toLowerCase() === 'h') send({ type: 'hold', on: !snap.held });
      else if (e.key.toLowerCase() === 'b') send({ type: 'blank', on: !snap.blanked });
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [snap, send]);

  /** Radio groups: arrow keys move to the previous/next choice and choose it (the ARIA radio pattern). */
  const onRadioKeys = (e: React.KeyboardEvent) => {
    const radio = (e.target as HTMLElement).closest<HTMLElement>('[role="radio"]');
    const group = radio?.closest<HTMLElement>('[role="radiogroup"]');
    if (!radio || !group || !['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'].includes(e.key)) return;
    const choices = [...group.querySelectorAll<HTMLButtonElement>('[role="radio"]')].filter((b) => !b.disabled);
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1;
    const next = choices[(choices.indexOf(radio as HTMLButtonElement) + step + choices.length) % choices.length];
    e.preventDefault();
    next?.focus();
    next?.click();
  };

  if (auth === 'unauthorized') {
    return (
      <main className="gate">
        {mode === 'local' ? (
          <>
            <h1>Open the private control link</h1>
            <p>This page controls what your stream shows, so it only opens from the link printed in the terminal where you ran <code>npm start</code>.</p>
          </>
        ) : mode === 'hosted' ? (
          <>
            <h1>This control page couldn’t open</h1>
            <p>It controls what your stream shows, so it needs this site’s cookie to know the page is yours. Allow cookies for this site, then reload.</p>
          </>
        ) : (
          <>
            <h1>The server can’t be reached</h1>
            <p>Check your connection, then reload this page.</p>
          </>
        )}
        <p>The OBS overlay link is different and cannot control anything.</p>
      </main>
    );
  }
  if (!snap) {
    const down = mode === 'local' ? 'The overlay server is not reachable. Is it still running?' : 'The server can’t be reached right now. This page keeps trying.';
    return <main className="gate"><p>{auth === 'checking' ? 'Opening…' : conn === 'closed' ? down : 'Connecting…'}</p></main>;
  }

  const st = statusLine(snap);
  const listening = cap.listening;
  const d = snap.display;
  const lay = measured && measured.key === d.verse?.key ? measured : null;
  // The translation page the preview shows: while the broadcaster has not paged (page 1, no timer),
  // every output turns its own pages with the recitation; this is the preview's.
  const translationFollows = d.englishPage === 0 && !d.style.translationPageSeconds;
  const translationPage = (() => {
    const n = lay?.englishPages ?? 1;
    if (!translationFollows) return d.englishPage % n;
    const words = d.verse ? toQpcHafsEncoding(d.verse.arabic).split(/\s+/).filter(Boolean).length : 0;
    const at = d.cursor && words ? (d.cursor.from + 1) / words : d.progress;
    return at === null ? 0 : Math.min(n - 1, Math.floor(at * n));
  })();
  // First use: the three steps, confirmed in place when OBS opens the link (then Done). A returning
  // broadcaster sees one folded line until OBS connects, and nothing once it has.
  const showFirstRun = overlayOpen ? !obsSeenAtLoad.current && !firstRunDone : true;

  return (
    <div className="control" onKeyDown={onRadioKeys}>
      <header className="topbar">
        <div className="brand">Quran Reader<span className="brand-sub"> · Stream controls</span></div>
        <div className={`status status-${st.tone}`} role="status" aria-live="polite">
          <span className="dot" aria-hidden />
          <div>
            <div className="status-title">{st.title}</div>
            <div className="status-detail">{st.detail}</div>
          </div>
        </div>
        <div className="conn">{conn === 'open' ? `OBS/readers connected: ${snap.overlay.clients}` : `Reconnecting to the ${mode === 'local' ? 'local ' : ''}server…`}</div>
      </header>

      <main className="grid">
        <section id="audience-preview" className="monitor" tabIndex={-1} aria-label="What the audience sees">
          <div className="monitor-head">
            <span className={`onair ${d.visible ? 'live' : ''}`}>{d.visible ? 'On screen' : snap.blanked ? 'Hidden from stream' : 'Nothing on screen'}</span>
            {snap.blanked && d.verse && <span className="muted">{d.verse.key} returns when you unhide</span>}
            {lay?.promotedToFullFrame && (d.style.readingMode === 'word' ? <span className="muted">Word focus is always shown full frame</span> : <span className="warn">Too long for the lower third — shown full frame</span>)}
            <SpeedMeter view={speedView} listening={cap.listening} />
          </div>
          <div className="view-controls">
            <div className="reading-view preview-choice" role="radiogroup" aria-label="Preview output">
              {([['overlay', 'Overlay'], ['stream', 'Charity scene']] as const).map(([value, label]) => <button key={value} role="radio" aria-checked={previewMode === value} className={previewMode === value ? 'primary' : ''} onClick={() => choosePreview(value)}>{label}</button>)}
            </div>
            <div className="reading-view" role="radiogroup" aria-label="Language">
              {([['both', 'Arabic + English'], ['arabic', 'Arabic'], ['english', 'English']] as const).map(([value, label]) => <button key={value} role="radio" aria-checked={d.style.language === value} className={d.style.language === value ? 'primary' : ''} onClick={() => send({ type: 'style', patch: { language: value } })}>{label}</button>)}
            </div>
            <div className="reading-view" role="radiogroup" aria-label="Reading view">
              {([['follow', 'Follow words'], ['word', 'Word focus'], ['ayah', 'Full ayah']] as const).map(([value, label]) => <button key={value} role="radio" aria-checked={d.style.readingMode === value} className={d.style.readingMode === value ? 'primary' : ''} disabled={value === 'word' && d.style.language === 'english'} title={value === 'word' && d.style.language === 'english' ? 'Word focus shows one Arabic word' : undefined} onClick={() => send({ type: 'style', patch: { readingMode: value } })}>{label}</button>)}
            </div>
          </div>
          <div className="preview-wrap">
            <StageFrame className={`preview preview-${backdrop}`}>
              {previewMode === 'stream' ? <Suspense fallback={<div className="preview-loading">Opening the charity scene…</div>}>
                {stream && <StreamScene display={d} stream={stream} onLayout={setMeasured} />}
              </Suspense> : <VerseDisplay state={d} fontsReady={fontsReady} onLayout={setMeasured} preview />}
            </StageFrame>
            {/* An empty preview offers the first useful result (shown to OBS too, like any choice here). */}
            {previewMode === 'overlay' && !d.verse && !snap.blanked && (
              <div className="empty-guide">
                <div>
                  <h3>Nothing on screen yet</h3>
                  <p>This preview shows exactly what your stream shows. Recite, type a reference, or start with one ayah:</p>
                  <button className="primary" onClick={() => send({ type: 'goto', key: '1:1' })}>Show Al-Fatihah 1:1</button>
                </div>
              </div>
            )}
          </div>
          <div className="preview-environment" role="radiogroup" aria-label="Preview backdrop">
            <span>Check over</span>
            {([['grid', 'Transparency grid'], ['light', 'Light'], ['dark', 'Dark']] as const).map(([value, label]) => <button key={value} role="radio" aria-checked={backdrop === value} className={backdrop === value ? 'on' : ''} onClick={() => setBackdrop(value)}>{label}</button>)}
            <span className="hint">Preview only</span>
          </div>
          {previewMode === 'stream' && <p className="hint">This is the full OBS scene. Page controls match its reading panel. Layout, shading and highlight colour settings below apply to the plain overlay.</p>}

          <div className="transport">
            <button onClick={() => send({ type: 'nav', action: 'prev' })} title="Previous ayah (←)">‹ Previous ayah</button>
            <button onClick={() => send({ type: 'nav', action: 'next' })} title="Next ayah (→)">Next ayah ›</button>
            <span className="sep" />
            {snap.held ? (
              <button className="primary" onClick={() => send({ type: 'hold', on: false })} title="Resume following (H)">Resume following</button>
            ) : (
              <button onClick={() => send({ type: 'hold', on: true })} title="Pause following (H)">Pause following</button>
            )}
            <button className={snap.blanked ? 'primary' : ''} onClick={() => send({ type: 'blank', on: !snap.blanked })} title="Hide or unhide the screen (B)">
              {snap.blanked ? 'Unhide' : 'Hide from stream'}
            </button>
          </div>

          {lay && (lay.englishPages > 1 || lay.arabicPages > 1) && (
            <div className="pager">
              {lay.arabicPages > 1 && (
                <span>
                  Arabic {d.arabicPage === null ? 'follows your recitation' : `part ${d.arabicPage + 1}/${lay.arabicPages}`}
                  <button onClick={() => send({ type: 'page', region: 'arabic', page: Math.max(0, (d.arabicPage ?? 0) - 1) })}>‹</button>
                  <button onClick={() => send({ type: 'page', region: 'arabic', page: Math.min(lay.arabicPages - 1, (d.arabicPage ?? 0) + 1) })}>›</button>
                  {d.arabicPage !== null && <button onClick={() => send({ type: 'arabic_auto' })}>Follow recitation</button>}
                </span>
              )}
              {lay.englishPages > 1 && (
                <span>
                  Translation page {translationPage + 1}/{lay.englishPages}{translationFollows ? ' · follows your recitation' : ''}
                  <button title="Previous translation page" onClick={() => send({ type: 'page', region: 'english', page: (d.englishPage + lay.englishPages - 1) % lay.englishPages })}>‹</button>
                  <button title="Next translation page (after the last, back to following)" onClick={() => send({ type: 'page', region: 'english', page: (d.englishPage + 1) % lay.englishPages })}>›</button>
                  <span className="muted">{d.style.translationPageSeconds ? `turns every ${d.style.translationPageSeconds} s` : translationFollows ? '› reads ahead' : 'back to page 1 to follow again'}</span>
                </span>
              )}
            </div>
          )}

          {snap.notice && <div className="notice">{snap.notice}</div>}

        </section>

        <aside className="side">
          {showFirstRun && (
            <FirstRun
              clients={snap.overlay.clients}
              folded={obsSeen && !overlayOpen}
              copied={copied}
              copyFailed={copyFailed === 'first-run'}
              url={snap.overlay.url}
              onCopy={() => copyOverlayLink('first-run')}
              onDone={() => setFirstRunDone(true)}
            />
          )}
          <VoiceCard
            mode={mode}
            snap={snap}
            capture={capture}
            listening={listening}
            devices={devices}
            deviceId={deviceId}
            setDeviceId={setDeviceId}
            onStart={() => void cap.start(deviceId || null)}
            onStop={() => cap.stop()}
            chapters={chapters}
            send={send}
            credits={credits}
            ownKey={ownKey}
            ownProblem={ownProblem}
            onOwnKey={(key) => {
              setOwnSonioxKey(key);
              setOwnKey(key);
              cap.ownKeyChanged();
            }}
            query={query}
            setQuery={setQuery}
            pending={!!pendingId}
            result={result?.r ?? null}
            onSubmit={() => query.trim() && runCommand(query, 'typed')}
            onShow={(key) => result && send({ type: 'show_result', requestId: result.id, key })}
            onClear={() => {
              setResult(null);
              setQuery('');
              lastRequest.current = null;
            }}
          />
          {/* Developer diagnostics belong to self-hosted copies; the public page never shows them. */}
          {mode !== 'hosted' && <details className="diagnostics">
            <summary>Tracker diagnostics</summary>
            <div className="diag-grid">
              <div>
                <h4>Candidates</h4>
                <ul>{snap.candidates.map((c) => <li key={c.key}>{c.key} · {c.relation} · score {c.score} · {c.matched} matched{c.trailing ? ` · ${c.trailing} unexplained` : ''}</li>)}</ul>
              </div>
              <div>
                <h4>Decisions ({snap.mode})</h4>
                <ul>{snap.decisions.map((x, i) => <li key={i}>{x.reason}: {x.outcome} · {x.latencyMs} ms{x.truncated ? ' · shortlist truncated' : ''}{x.changedOverlay ? ' · changed screen' : ''}</li>)}</ul>
                {!snap.decisions.length && <p className="muted">No decision requests yet.</p>}
              </div>
              <div>
                <h4>Timing (this session)</h4>
                <ul>
                  <li>Tracker update p50/p95: {snap.metrics.trackerP50Ms ?? '—'} / {snap.metrics.trackerP95Ms ?? '—'} ms ({snap.metrics.updates} updates)</li>
                  <li>Commit → OBS paint ack p50/p95: {snap.metrics.paintRttP50Ms ?? '—'} / {snap.metrics.paintRttP95Ms ?? '—'} ms</li>
                  <li>Decision calls: {snap.metrics.decisionCalls}{snap.metrics.decisionP50Ms !== null ? `, p50 ${snap.metrics.decisionP50Ms} ms` : ''}</li>
                </ul>
              </div>
            </div>
            <label className="row">
              Tracker mode (experiment)
              <select value={snap.mode} onChange={(e) => send({ type: 'mode', mode: e.target.value as ControlSnapshot['mode'] })}>
                <option value="hybrid">Hybrid — JEV only when unsure</option>
                <option value="deterministic">Deterministic — no JEV</option>
                <option value="jev_required">Experimental: wait for JEV at each ayah</option>
              </select>
            </label>
          </details>}
          {mode !== 'hosted' && <details className="diagnostics">
            <summary>Quran resources ({snap.setup.resources.filter((r) => r.state === 'in use').length} in use)</summary>
            <ul className="resources">
              {snap.setup.resources.map((r) => (
                <li key={r.id}>
                  <strong>{r.title}</strong> <span className={`res-state res-${r.state.split(' ')[0]}`}>{r.state}</span>
                  {r.detail && <div className="muted">{r.detail}</div>}
                </li>
              ))}
            </ul>
          </details>}
          <OutputCard
            snap={snap}
            send={send}
            hosted={mode === 'hosted'}
            copied={copied}
            copyFailed={copyFailed === 'output'}
            onCopy={() => copyOverlayLink('output')}
            onReplace={replaceLink}
            replaced={replaced}
          />
          <CharityCard snap={snap} stream={stream} send={send} onPreview={() => { choosePreview('stream'); document.getElementById('audience-preview')?.scrollIntoView({ block: 'start' }); }} />
        </aside>
      </main>
    </div>
  );
}

type CharityForm = Record<'title' | 'partner' | 'project' | 'country' | 'about' | 'photo' | 'link' | 'goal' | 'raisedBefore' | 'currency' | 'reciter' | 'hours', string>;
const formOf = (s: StreamSettings): CharityForm => ({
  title: s.title, partner: s.partner, project: s.project, country: s.country, about: s.about, photo: s.photo, link: s.link,
  goal: s.goal ? String(s.goal) : '', raisedBefore: s.raisedBefore ? String(s.raisedBefore) : '', currency: s.currency, reciter: s.reciter, hours: String(s.hours),
});
const amountOf = (text: string) => {
  const n = Number(text.replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : 0;
};

/**
 * The charity stream scene (/stream, for OBS): what it is for, how to give, and the donations as
 * they come in. Each donation added here is announced on stream ("May Allah accept Aisha's
 * donation"); money goes to the partner's own link, never through this app.
 */
function CharityCard({ snap, stream, send, onPreview }: { snap: ControlSnapshot; stream: StreamState | null; send: (m: ControlClientMessage) => boolean; onPreview: () => void }) {
  const s = stream?.settings ?? null;
  const [form, setForm] = useState<CharityForm | null>(null);
  const [saved, setSaved] = useState(false);
  const [gift, setGift] = useState({ name: '', amount: '', message: '' });
  const [copied, setCopied] = useState<'ok' | 'failed' | null>(null);
  const settingsKey = s ? JSON.stringify(s) : '';
  // The form shows the saved settings: when they first arrive, and after each save.
  useEffect(() => {
    if (s) setForm(formOf(s));
  }, [settingsKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const streamUrl = snap.overlay.url.replace('/overlay#', '/stream#');
  if (!s || !form) return null;
  const field = (key: keyof CharityForm, label: string, opts: { wide?: boolean; placeholder?: string; inputMode?: 'decimal' | 'url' | 'numeric' } = {}) => (
    <label className={opts.wide ? 'cc-wide' : undefined}>
      <span>{label}</span>
      <input value={form[key]} placeholder={opts.placeholder} inputMode={opts.inputMode} onChange={(e) => setForm({ ...form, [key]: e.target.value })} />
    </label>
  );
  const badLink = (v: string) => v.trim() !== '' && !/^https:\/\/\S+$/.test(v.trim());
  const save = () => {
    if (badLink(form.photo) || badLink(form.link)) return;
    send({
      type: 'stream_settings',
      patch: {
        title: form.title, partner: form.partner, project: form.project, country: form.country, about: form.about,
        photo: form.photo.trim(), link: form.link.trim(), goal: amountOf(form.goal), raisedBefore: amountOf(form.raisedBefore),
        currency: form.currency || '$', reciter: form.reciter, hours: Math.min(72, Math.max(1, Math.round(Number(form.hours) || 24))),
      },
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 1800);
  };
  const addGift = () => {
    send({ type: 'donation', name: gift.name.trim(), amount: amountOf(gift.amount), message: gift.message.trim() });
    setGift({ name: '', amount: '', message: '' });
  };
  const copy = () => {
    try {
      navigator.clipboard.writeText(streamUrl).then(() => setCopied('ok'), () => setCopied('failed'));
    } catch {
      setCopied('failed');
    }
  };
  return (
    <section className="card charity-card">
      <h2>Charity stream</h2>
      <div className="cc-copy">
        <button className="primary" onClick={copy}>{copied === 'ok' ? 'Copied' : 'Copy OBS stream link'}</button>
        <a href={streamUrl} target="_blank" rel="noreferrer">Open the stream scene</a>
        <button onClick={onPreview}>Preview charity scene</button>
      </div>
      {copied === 'failed' && <input className="cc-link" readOnly value={streamUrl} aria-label="OBS stream link" autoFocus onFocus={(e) => e.currentTarget.select()} />}
      <p className="hint">In OBS: Sources → + → Browser, paste the link, set 1920 × 1080. Put your camera (or VTuber) source under it in the list and move it so you show in the arch window. Leave “Shutdown source when not visible” off.</p>

      <form className="cc-form" onSubmit={(e) => { e.preventDefault(); save(); }}>
        {field('title', 'Title', { wide: true })}
        {field('partner', 'Partner (who receives the donations)', { wide: true })}
        {field('project', 'Project')}
        {field('country', 'Where')}
        {field('about', 'What a donation provides (one line)', { wide: true })}
        {field('link', 'Donation link (their page, https://…)', { wide: true, inputMode: 'url' })}
        {badLink(form.link) && <p className="warn cc-wide">The donation link must start with https://</p>}
        {field('photo', 'Project photo link (https://…, optional)', { wide: true, inputMode: 'url' })}
        {badLink(form.photo) && <p className="warn cc-wide">The photo link must start with https://</p>}
        {field('goal', 'Goal', { inputMode: 'decimal', placeholder: '50000' })}
        {field('raisedBefore', 'Already raised elsewhere', { inputMode: 'decimal', placeholder: '0' })}
        {field('currency', 'Currency sign', { placeholder: '$' })}
        {field('reciter', 'Reciter’s name (under the camera)')}
        <label className="cc-check"><input type="checkbox" checked={s.camera} onChange={(e) => send({ type: 'stream_settings', patch: { camera: e.target.checked } })} /> Camera window in the arch</label>
        <label className="cc-check"><input type="checkbox" checked={s.showAmounts} onChange={(e) => send({ type: 'stream_settings', patch: { showAmounts: e.target.checked } })} /> Show amounts on stream</label>
        <div className="cc-wide cc-actions"><button type="submit" className="primary">{saved ? 'Saved' : 'Save'}</button></div>
      </form>

      <div className="cc-clock">
        <span>{s.startedAt !== null ? `Clock started ${new Date(s.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · ${s.hours} hours` : 'The “Hour 1 of 24” clock is not running.'}</span>
        {field('hours', 'Hours', { inputMode: 'numeric' })}
        {s.startedAt === null
          ? <button onClick={() => send({ type: 'stream_settings', patch: { startedAt: Date.now(), hours: Math.min(72, Math.max(1, Math.round(Number(form.hours) || 24))) } })}>Start the clock</button>
          : <button onClick={() => send({ type: 'stream_settings', patch: { startedAt: null } })}>Stop the clock</button>}
      </div>

      <h3 className="cc-sub">A donation came in</h3>
      <form className="cc-gift" onSubmit={(e) => { e.preventDefault(); addGift(); }}>
        <input value={gift.name} onChange={(e) => setGift({ ...gift, name: e.target.value })} placeholder="Name (empty: anonymous)" aria-label="Donor’s name" maxLength={60} />
        <input value={gift.amount} onChange={(e) => setGift({ ...gift, amount: e.target.value })} placeholder="Amount" aria-label="Amount" inputMode="decimal" />
        <input className="cc-wide" value={gift.message} onChange={(e) => setGift({ ...gift, message: e.target.value })} placeholder="Their words, optional (e.g. For my late father)" aria-label="The donor’s words" maxLength={80} />
        <button type="submit" className="primary cc-wide">Announce on stream</button>
      </form>
      <p className="hint">Shown as “May Allah accept {gift.name.trim() ? `${gift.name.trim()}’s` : 'this'} donation”, silently, without interrupting the recitation. Only share names and words with permission; leave the name empty for anonymous.</p>

      <p className="cc-total">{money(stream!.total, s.currency)} raised · {stream!.count} {stream!.count === 1 ? 'donor' : 'donors'}</p>
      {stream!.donations.length > 0 && (
        <ul className="cc-list">
          {stream!.donations.slice(0, 8).map((d) => (
            <li key={d.id}>
              <span className="cc-list-name">{d.name || 'Anonymous'}</span>
              <span className="muted">{money(d.amount, s.currency)}</span>
              <button className="cc-remove" onClick={() => send({ type: 'donation_remove', id: d.id })} aria-label={`Remove ${d.name || 'the anonymous'} donation`}>Remove</button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * One place for everything spoken or typed: listening follows recitation and also hears English
 * requests ("go to Surah Maryam, ayah three"), typing does the same without the microphone, and the
 * results of either appear right here.
 */
function VoiceCard(p: {
  mode: 'local' | 'hosted' | null;
  snap: ControlSnapshot;
  capture: CaptureStatus;
  listening: boolean;
  devices: MediaDeviceInfo[];
  deviceId: string;
  setDeviceId: (id: string) => void;
  onStart: () => void;
  onStop: () => void;
  chapters: ChapterRow[];
  send: (m: ControlClientMessage) => boolean;
  credits: CreditView | null;
  ownKey: string | null;
  ownProblem: string | null;
  onOwnKey: (key: string | null) => void;
  query: string;
  setQuery: (q: string) => void;
  pending: boolean;
  result: CommandResult | null;
  onSubmit: () => void;
  onShow: (key: string) => void;
  onClear: () => void;
}) {
  const [surah, setSurah] = useState<number | ''>(p.snap.startHint ? Number(p.snap.startHint.split(':')[0]) : '');
  const [ayah, setAyah] = useState<string>(p.snap.startHint ? p.snap.startHint.split(':')[1] : '');
  const ch = p.chapters.find((c) => c.number === surah);
  const starting = p.capture.state === 'starting' || p.capture.state === 'reconnecting';
  const r = p.result;
  // Where it is following, never the recogniser's own text (its spelling is not the Quran's).
  const following = p.snap.phase === 'tracking' && p.snap.display.verse ? `Following ${p.snap.display.verse.surahName} ${p.snap.display.verse.key}` : null;
  return (
    <section className="card voice-card">
      <h2>Recite or ask</h2>
      {!p.snap.setup.soniox && (p.mode === 'hosted'
        ? <p className="setup">Listening is unavailable right now. Typing, navigation and the overlay still work.</p>
        : <p className="setup">Listening needs a Soniox key: add <code>SONIOX_API_KEY</code> to <code>.env</code> and restart the server. Typing, navigation and the overlay work without it.</p>)}
      <div className="listen-row">
        {p.listening || starting ? (
          <button className="big stop" onClick={p.onStop}>Stop listening</button>
        ) : (
          <button className="big go" onClick={p.onStart} disabled={!p.snap.setup.soniox}>Start listening</button>
        )}
        <select aria-label="Microphone" value={p.deviceId} onChange={(e) => p.setDeviceId(e.target.value)} disabled={p.listening || starting}>
          <option value="">Default microphone</option>
          {p.devices.map((d, i) => (
            <option key={d.deviceId} value={d.deviceId}>{d.label || `Microphone ${i + 1}`}</option>
          ))}
        </select>
      </div>
      {p.listening && (
        <div className="live-status" aria-live="polite">
          <span className="live-dot" aria-hidden />
          <span className={following ? undefined : 'muted'}>{following ?? (p.capture.state === 'waiting' ? 'In line to listen…' : p.capture.state === 'reconnecting' ? 'Reconnecting…' : 'Listening…')}</span>
        </div>
      )}
      <p className="hint">
        {starting
          ? (p.capture.state === 'reconnecting' && p.capture.detail) || 'Connecting the microphone…'
          : p.capture.state === 'error' || p.capture.state === 'waiting'
            ? p.capture.detail
            : p.capture.state === 'dozing'
              ? 'Waiting for you to recite. After a long pause the microphone stays on here but nothing is sent (listening is billed while a stream is open); recite and it continues at once.'
              : p.listening
              ? p.capture.detail ?? 'Recite and the screen follows. Or just say it in English: “go to Surah Maryam, ayah three”, “show the ayah about the orphan”, or describe one to find it here privately. Other English talk never changes the screen.'
              : (p.capture.detail ??
                (p.snap.overlay.clients > 0
                  ? 'One microphone for both: recite to follow, or speak an English request. Transmission can pause after a long silence. While you’re live on stream, listening stays on through breaks and talk with your audience, with no time limit.'
                  : 'One microphone for both: recite to follow, or speak an English request. Transmission can pause after a long silence, and listening stops by itself after a while without recitation.'))}
      </p>

      {p.credits && (
        <p className={`credits-line${p.credits.available < 600 ? ' low' : ''}`}>
          {listeningLine(p.credits, p.snap.overlay.clients > 0, !!p.ownKey && !p.ownProblem)}
        </p>
      )}
      <form
        className="find"
        onSubmit={(e) => {
          e.preventDefault();
          p.onSubmit();
        }}
      >
        <input
          value={p.query}
          onChange={(e) => p.setQuery(e.target.value)}
          placeholder="Or type: 2:255, Surah Maryam ayah 3, or what it says"
          aria-label="Type a reference or what the ayah says"
          aria-describedby="control-request-privacy"
        />
        <button type="submit" disabled={!p.query.trim()}>Go</button>
      </form>

      <p className="hint" id="control-request-privacy">{REQUEST_PRIVACY} <a href={u('/privacy.html')} target="_blank" rel="noopener">Privacy</a></p>
      {p.pending && <p className="pending">Searching…</p>}
      {!p.pending && r?.kind === 'control' && <p className="ok">{r.label}</p>}
      {!p.pending && r?.kind === 'navigate' && <p className="ok">Opened {r.key}.{r.note ? ` ${r.note}` : ''} Recitation continues from there.</p>}
      {!p.pending && (r?.kind === 'no_match' || r?.kind === 'invalid_reference') && <p className="warn">{r.message}</p>}
      {!p.pending && r?.kind === 'candidates' && (
        <div className="results">
          <p className={r.refining ? 'pending' : 'hint'}>{r.status} Searches stay private until you choose Show on stream.</p>
          <ol>
            {r.cards.map((c) => (
              <ResultCard key={c.key} card={c} confirmed={c.key === r.confirmedKey} onShow={p.onShow} />
            ))}
          </ol>
          <button onClick={p.onClear}>Clear results</button>
        </div>
      )}
      {p.snap.held && (
        <button className="primary wide" onClick={() => p.send({ type: 'hold', on: false })}>Resume following from the screen</button>
      )}

      <details className="start-point">
        <summary>{p.snap.startHint ? `Starting point: near ${p.snap.startHint}` : 'Starting point (optional)'}</summary>
        <div className="start-from">
          <select aria-label="Starting surah" value={surah} onChange={(e) => setSurah(e.target.value ? Number(e.target.value) : '')}>
            <option value="">Anywhere (find automatically)</option>
            {p.chapters.map((c) => (
              <option key={c.number} value={c.number}>{c.number}. {c.nameSimple}</option>
            ))}
          </select>
          <input aria-label="Starting ayah" inputMode="numeric" placeholder="ayah" value={ayah} onChange={(e) => setAyah(e.target.value.replace(/\D/g, ''))} disabled={!surah} />
          <button onClick={() => p.send({ type: 'start_hint', key: surah ? `${surah}:${Math.min(Math.max(1, Number(ayah) || 1), ch?.verseCount ?? 1)}` : null })}>Set</button>
        </div>
        <p className="hint">Helps when several surahs open the same way; other passages are still recognized.</p>
      </details>
      {p.credits && <OwnKey saved={p.ownKey} problem={p.ownProblem} onChange={p.onOwnKey} />}
    </section>
  );
}

/** Optional own key: saved on this device and sent to the relay for each listening stream. */
function OwnKey(p: { saved: string | null; problem: string | null; onChange: (key: string | null) => void }) {
  const [draft, setDraft] = useState('');
  const valid = OWN_KEY_SHAPE.test(draft.trim());
  return (
    <details className="start-point own-key" open={p.problem ? true : undefined}>
      <summary>{p.saved ? (p.problem ? 'Your own Soniox key isn’t working' : 'Using your own Soniox key') : 'Your own Soniox key (optional)'}</summary>
      {p.saved ? (
        <div className="start-from">
          <span className="own-key-tail">Key ending …{p.saved.slice(-4)}</span>
          <button onClick={() => p.onChange(null)}>Remove</button>
        </div>
      ) : (
        <form
          className="start-from"
          onSubmit={(e) => {
            e.preventDefault();
            if (!valid) return;
            p.onChange(draft.trim());
            setDraft('');
          }}
        >
          <input type="password" autoComplete="off" spellCheck={false} aria-label="Your Soniox API key" placeholder="Your Soniox API key" value={draft} onChange={(e) => setDraft(e.target.value)} />
          <button type="submit" disabled={!valid}>Use it</button>
        </form>
      )}
      {p.problem && <p className="hint own-key-problem">{p.problem} Listening uses the shared hours meanwhile.</p>}
      <p className="hint">
        Listening is billed to your Soniox account instead of the shared hours. Your key is saved in this browser until you remove it or clear site data. Each listening stream sends it encrypted to Nurra’s server, which holds it temporarily in memory without saving it to disk. Remove affects future streams; Stop listening closes the current stream. Get a key at{' '}
        <a href="https://console.soniox.com" target="_blank" rel="noreferrer">console.soniox.com</a>.
      </p>
    </details>
  );
}

function ResultCard({ card, confirmed, onShow }: { card: SearchCard; confirmed: boolean; onShow: (key: string) => void }) {
  const [shown, setShown] = useState<SearchCard>(card);
  // Reset the context view only when the card becomes a different ayah; a refined result (e.g. JEV's
  // pick arriving) must not undo browsing the user is doing on this card.
  useEffect(() => setShown(card), [card.key]); // eslint-disable-line react-hooks/exhaustive-deps
  const go = (key: string | null) => {
    if (!key) return;
    fetch(u(`/api/verse/${key}`), { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then((c: SearchCard | null) => c && setShown(c))
      .catch(() => undefined);
  };
  const offset = shown.key === card.key ? null : shown.key === card.prevKey ? 'Previous ayah' : 'Next ayah';
  return (
    <li className={`result ${confirmed ? 'confirmed' : ''}`}>
      <div className="result-head">
        <strong>{shown.surahName} {shown.key}</strong>
        {confirmed && shown.key === card.key && <span className="badge">Best match</span>}
        {offset && <span className="muted">{offset} (context)</span>}
      </div>
      <p className="result-ar" lang="ar" dir="rtl">{toQpcHafsEncoding(shown.arabic)}</p>
      <p className="result-en">{shown.english}</p>
      {shown.key === card.key && card.foundBy.length > 0 && <p className="found-by">Found by {card.foundBy.join(' · ')}</p>}
      <div className="result-actions">
        <button className="primary" onClick={() => onShow(shown.key)}>Show on stream</button>
        <button onClick={() => go(shown.key === card.nextKey ? card.key : card.prevKey)} disabled={shown.key === card.prevKey || !card.prevKey}>Earlier</button>
        <button onClick={() => go(shown.key === card.prevKey ? card.key : card.nextKey)} disabled={shown.key === card.nextKey || !card.nextKey}>Later</button>
      </div>
    </li>
  );
}

function CopyFallback({ url }: { url: string }) {
  return (
    <div className="copy-fallback">
      <p className="warn">The link couldn’t be copied automatically. Here it is: select it and copy it.</p>
      <input readOnly value={url} aria-label="OBS overlay link" autoFocus onFocus={(e) => e.currentTarget.select()} />
    </div>
  );
}

/**
 * Getting the overlay into OBS in three steps, with step 2's live state (every open OBS source or
 * reading screen counts). Folded to one line for a broadcaster who has done it before on this device.
 */
function FirstRun({ clients, folded, copied, copyFailed, url, onCopy, onDone }: { clients: number; folded: boolean; copied: boolean; copyFailed: boolean; url: string; onCopy: () => void; onDone: () => void }) {
  const open = clients > 0;
  const copy = <button className="primary" onClick={onCopy}>{copied ? 'Copied' : 'Copy OBS overlay link'}</button>;
  if (folded) {
    return (
      <section className="card first-run folded" aria-label="Stream output">
        <div className="fr-folded">
          <span className="wait"><i aria-hidden="true" />Overlay not open in OBS yet</span>
          {copy}
        </div>
        {copyFailed && <CopyFallback url={url} />}
      </section>
    );
  }
  return (
    <section className="card first-run" aria-labelledby="fr-title">
      <h2 id="fr-title">{open ? 'Your overlay is open' : 'On your stream in three steps'}</h2>
      <ol className="steps">
        <li className={open ? 'done' : undefined}>
          <div>
            {copy}
            <p className="hint">The link can only show ayahs. Keep it private.</p>
            {copyFailed && <CopyFallback url={url} />}
          </div>
        </li>
        <li className={open ? 'done' : undefined}>
          <div>
            <p className="obs-path">In OBS: <kbd>Sources</kbd> → <kbd>+</kbd> → <kbd>Browser</kbd>, paste the link, set it to your canvas size (16:9, such as 1920 × 1080).</p>
            <p className="hint">Leave “Shutdown source when not visible” off.</p>
            <p className={`wait${open ? ' ok' : ''}`} role="status"><i aria-hidden="true" />{open ? `Open in ${clients} ${clients === 1 ? 'place' : 'places'} (OBS or a reading screen)` : 'Waiting for OBS to open the link…'}</p>
          </div>
        </li>
        <li>
          <div>
            <p className="obs-path">Recite, or type a reference below.</p>
            <p className="hint">The microphone stays on this page, not in OBS.</p>
          </div>
        </li>
      </ol>
      {open && <button className="fr-done" onClick={onDone}>Done</button>}
    </section>
  );
}

function OutputCard({ snap, send, hosted, copied, copyFailed, onCopy, onReplace, replaced }: { snap: ControlSnapshot; send: (m: ControlClientMessage) => boolean; hosted: boolean; copied: boolean; copyFailed: boolean; onCopy: () => void; onReplace: () => void; replaced: boolean }) {
  return (
    <section className="card">
      <h2>Stream output</h2>
      <div className="copy-row">
        <button className="primary" onClick={onCopy}>{copied ? 'Copied' : 'Copy OBS overlay link'}</button>
        <a href={snap.overlay.url.replace('#view=', '#bg=solid&view=')} target="_blank" rel="noreferrer">Open reading screen</a>
      </div>
      {copyFailed && <CopyFallback url={snap.overlay.url} />}
      <p className="hint">In OBS: Sources → + → Browser, paste the link, and set it to your canvas size (any 16:9 size, such as 1920 × 1080). Leave “Shutdown source when not visible” off. The link can only show ayahs.</p>
      <OverlayAppearance style={snap.display.style} sessionEpoch={snap.sessionEpoch} send={send} />
      <label className="row">
        Long translations turn pages
        <select value={snap.display.style.translationPageSeconds} onChange={(e) => send({ type: 'style', patch: { translationPageSeconds: Number(e.target.value) } })}>
          <option value={0}>with the recitation (› reads ahead)</option>
          <option value={10}>every 10 s</option>
          <option value={14}>every 14 s</option>
          <option value={20}>every 20 s</option>
        </select>
      </label>
      <label className="row">
        When recitation stops matching
        <select value={snap.keepOnUncertain ? 'keep' : 'clear'} onChange={(e) => send({ type: 'uncertain_policy', keep: e.target.value === 'keep' })}>
          <option value="keep">keep the last ayah until the new one is found</option>
          <option value="clear">clear the screen after 3 s</option>
        </select>
      </label>
      <label className="row check-row">
        <input type="checkbox" checked={snap.pinned} onChange={(e) => send({ type: 'pin', on: e.target.checked })} /> Keep the ayah up if the microphone disconnects
      </label>
      <button className="link" onClick={onReplace}>Replace overlay link (old links stop working)</button>
      {replaced && <p className="notice" role="status">New overlay link made; the old one no longer works. Copy it above and paste it into your OBS Browser source.</p>}
      <p className="fine">
        {snap.corpus.verses.toLocaleString()} ayahs · {snap.corpus.chapters} surahs · {snap.corpus.attribution}.
        {hosted ? (snap.display.verse?.glossCredit ? ` ${snap.display.verse.glossCredit}.` : '') : ` Decisions: ${snap.setup.jev.detail} Semantic search: ${snap.setup.semantic}.`}
      </p>
      <p className="fine control-brand">
        <NurraBadge /> <a href={u('/about')}>How and why</a>
      </p>
    </section>
  );
}

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
const secs = (ms: number | null) => (ms === null ? '—' : `${Math.max(0, ms / 1000).toFixed(1)} s`);

function SpeedMeter({ view, listening }: { view: { ayah: number[]; word: number[]; last: number | null }; listening: boolean }) {
  if (!listening && !view.ayah.length && !view.word.length) return null;
  return (
    <span className="speed" title="How far the screen trails your voice: a word from when you begin it, an ayah change from the last sound heard. Timed where the screen is updated; your network adds a little.">
      Behind your voice: ayah changes <strong>{secs(median(view.ayah))}</strong>
      {view.ayah.length ? ` (median of ${view.ayah.length}, last ${secs(view.last)})` : ''} · words <strong>{secs(median(view.word))}</strong>
    </span>
  );
}
