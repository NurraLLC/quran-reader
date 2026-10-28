// The start page's example of following: Al-Fatihah 1:1-3 as the reader shows them, each word lighting
// up in turn with its meaning (word-by-word data from the server), the page moving on to the next
// ayah. It plays once when it comes into view, then rests on its last word; Pause, Next word and
// tapping a word hand control to the visitor. With reduced motion it never plays by itself.
// Every word and meaning is the product's own source data; the timing is illustrative.

import { useEffect, useRef, useState } from 'react';
import { toQpcHafsEncoding } from '../shared/display-encoding';
import { u } from './net';
import { arabicNumber } from './VerseDisplay';
import { WordMeaning, useWordHistory } from './WordMeaning';

type Ayah = { key: string; ayah: number; arabic: string; english: string; glosses: Array<string | null> | null };
type Surah = { name: string; glossCredit: string | null; ayahs: Ayah[] };
type Step = { a: number; w: number };

/** An easy reciting pace, and a breath at the end of each ayah before the page moves on. */
const WORD_MS = 1000;
const AYAH_END_MS = 1400;
const START_DELAY_MS = 600;

export function FollowDemo() {
  const [surah, setSurah] = useState<Surah | null>(null);
  const [failed, setFailed] = useState(false);
  const [i, setI] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [ended, setEnded] = useState(false);
  /** What a screen reader hears after the visitor steps or taps (never while it plays by itself). */
  const [said, setSaid] = useState('');
  const touched = useRef(false);
  const root = useRef<HTMLElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch(u('/api/surah/1'), { credentials: 'same-origin', signal: controller.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((s: Surah | null) => { if (!controller.signal.aborted) s ? setSurah(s) : setFailed(true); })
      .catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, []);

  const ayahs = surah?.ayahs.slice(0, 3) ?? [];
  const words = ayahs.map((a) => toQpcHafsEncoding(a.arabic).split(/\s+/).filter(Boolean));
  const steps: Step[] = words.flatMap((ws, a) => ws.map((_, w) => ({ a, w })));
  const step = steps[Math.min(i, steps.length - 1)];
  const recent = useWordHistory(ayahs[step?.a]?.key, step ? { from: step.w, to: step.w } : null);

  // Plays once, when most of it is on screen, unless the visitor already took control.
  useEffect(() => {
    const el = root.current;
    if (!steps.length || !el || matchMedia('(prefers-reduced-motion: reduce)').matches || typeof IntersectionObserver === 'undefined') return;
    let timer = 0;
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      io.disconnect();
      timer = window.setTimeout(() => { if (!touched.current) setPlaying(true); }, START_DELAY_MS);
    }, { threshold: 0.6 });
    io.observe(el);
    return () => { io.disconnect(); clearTimeout(timer); };
  }, [steps.length]);

  useEffect(() => {
    if (!playing || !steps.length) return;
    if (i >= steps.length - 1) {
      setPlaying(false);
      setEnded(true);
      return;
    }
    const nextAyah = steps[i + 1].a !== steps[i].a;
    const t = setTimeout(() => setI((n) => n + 1), nextAyah ? AYAH_END_MS : WORD_MS);
    return () => clearTimeout(t);
  }, [playing, i, steps.length]); // eslint-disable-line react-hooks/exhaustive-deps

  if (failed) return null;
  if (!surah || !step) return <div className="r-demo r-demo-loading" aria-hidden="true" />;

  const meaningOf = (s: Step) => ayahs[s.a].glosses?.[s.w] ?? null;
  const show = (n: number) => {
    touched.current = true;
    setPlaying(false);
    setEnded(false);
    setI(n);
    const s = steps[n];
    const m = meaningOf(s);
    setSaid(`${surah.name} ${ayahs[s.a].key}${m ? `: ${m}` : ''}`);
  };
  const toggle = () => {
    touched.current = true;
    if (playing) return setPlaying(false);
    if (ended || i >= steps.length - 1) setI(0);
    setEnded(false);
    setPlaying(true);
  };
  const first = ayahs[0];
  const last = ayahs[ayahs.length - 1];

  return (
    <figure ref={root} className="r-demo" aria-label={`Example, not live listening: ${surah.name} ${first.key}–${last.ayah}`} data-playing={playing || undefined}>
      <div className="r-demo-top">
        <span className="r-demo-badge">Example</span>
        <span className="r-demo-where" aria-hidden="true">{surah.name} {ayahs[step.a].key}</span>
      </div>
      <div className="r-demo-window">
        {/* Shared measured room: a new ayah never pushes the controls or the full translation. */}
        <div className="r-demo-pages">
          {ayahs.map((a, ai) => (
            <p key={a.key} className={`r-ar r-demo-line${ai === step.a ? ' current' : ''}`} lang="ar" dir="rtl" aria-hidden={ai !== step.a || undefined}>
              {words[ai].map((w, wi) => {
                const active = ai === step.a && wi === step.w;
                return (
                  <span key={wi}><span className="word-pair">
                    <span
                      className={`r-word${active ? ' active' : ''}${ai < step.a || (ai === step.a && wi < step.w) ? ' passed' : ''}`}
                      onClick={() => show(steps.findIndex((s) => s.a === ai && s.w === wi))}
                    >
                      {w}
                    </span>
                    <WordMeaning text={a.glosses?.[wi]} index={wi} active={active} context={ai === step.a && recent.includes(wi)} onInspect={() => show(steps.findIndex((s) => s.a === ai && s.w === wi))} />
                  </span>{wi < words[ai].length - 1 ? ' ' : null}</span>
                );
              })}
              <span className="r-mark" aria-hidden="true">{arabicNumber(a.ayah)}</span>
            </p>
          ))}
        </div>
      </div>
      <div className="r-demo-understanding">
        <div className="r-demo-translations">{ayahs.map((a, ai) => <p key={a.key} className={`r-en${ai === step.a ? ' current' : ''}`} aria-hidden={ai !== step.a || undefined}>{a.english}</p>)}</div>
      </div>
      <div className="r-demo-controls">
        <button type="button" onClick={toggle}>{playing ? 'Pause' : ended ? 'Replay' : 'Play'}</button>
        <button type="button" onClick={() => show((i + 1) % steps.length)}>Next word</button>
      </div>
      <p className="r-sr-only" aria-live="polite">{said}</p>
      {surah.glossCredit && <figcaption id="r-demo-caption" className="r-demo-caption">{surah.glossCredit}</figcaption>}
    </figure>
  );
}
