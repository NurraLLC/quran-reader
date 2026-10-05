// One renderer for the OBS overlay, the reading screen, the control preview and the charity stream's
// panel. It lays out a fixed 1920×1080 stage (or, for the stream scene, a panel of a given size),
// measures real line boxes with the loaded fonts, and either fits the verse or pages it deliberately
// (with visible continuation), never clipping or shrinking below the legibility floor. Arabic,
// translation and reference change together in one commit.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { DisplayState } from '../shared/contracts';
import { toQpcHafsEncoding } from '../shared/display-encoding';
import { NurraWordmark } from './Nurra';

type Rgb = [number, number, number];
const WHITE: Rgb = [255, 255, 255];
/** What the recited word sits on: the shaded panel over mid-tone footage (on transparent, its own backing). */
const PANEL: Rgb = [22, 33, 38];
const mixRgb = (c: Rgb, t: Rgb, w: number) => c.map((x, i) => Math.round(x + (t[i] - x) * w)) as Rgb;
const luminance = (c: Rgb) => {
  const [r, g, b] = c.map((x) => (x / 255 <= 0.03928 ? x / 255 / 12.92 : ((x / 255 + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: Rgb, b: Rgb) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05);
/** The colour lightened toward white just enough to stand `min`:1 against the panel. */
const lift = (c: Rgb, min: number): Rgb => {
  for (let w = 0; w < 1; w += 0.05) if (contrast(mixRgb(c, WHITE, w), PANEL) >= min) return mixRgb(c, WHITE, w);
  return WHITE;
};
const rgba = (c: Rgb, a = 1) => `rgba(${c.join(', ')}, ${a})`;

/**
 * The stream's highlight colour as CSS variables for the stage: the colour (the recited word's
 * underline, the progress line), a brighter tint for the recited word and its meaning, and a soft
 * wash. A dark custom colour would vanish on the panel, so the mark is kept at 3:1 and the text at
 * 4.5:1 against it. Only the highlight follows the colour: surah banner, ayah ornaments, reference
 * and hairlines are the page's frame and stay gold. Gold (the default) keeps the stylesheet's values.
 */
function accentVars(hex: string | undefined): Record<string, string> {
  if (!hex || hex.toLowerCase() === '#cfaa62') return {};
  const n = parseInt(hex.slice(1), 16);
  const rgb: Rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const mark = lift(rgb, 3);
  return {
    '--accent': rgba(mark),
    '--accent-bright': rgba(lift(mixRgb(rgb, WHITE, 0.5), 4.5)),
    '--accent-soft': rgba(mark, 0.16),
  };
}

export const STAGE_W = 1920;
export const STAGE_H = 1080;

export const ARABIC_FONT = "'Uthmanic Hafs', serif";
export const ENGLISH_FONT = "'Charter', 'Iowan Old Style', 'Palatino Linotype', 'Book Antiqua', Palatino, Georgia, serif";
/** The charity stream's translation face (bundled Cormorant Garamond), measured at its weight. */
export const NURRA_ENGLISH_FONT = "'Cormorant Garamond', 'Palatino Linotype', Georgia, serif";
export const NURRA_ENGLISH_WEIGHT = 500;

export type LayoutInfo = {
  key: string;
  englishPages: number;
  arabicPages: number;
  promotedToFullFrame: boolean;
  arabicPx: number;
  englishPx: number;
};

type Lines = string[][];

let measureRoot: HTMLDivElement | null = null;

function root(): HTMLDivElement {
  if (!measureRoot) {
    measureRoot = document.createElement('div');
    measureRoot.setAttribute('aria-hidden', 'true');
    Object.assign(measureRoot.style, { position: 'absolute', left: '-40000px', top: '0', visibility: 'hidden', whiteSpace: 'normal', pointerEvents: 'none' });
    document.body.appendChild(measureRoot);
  }
  return measureRoot;
}

function measureLines(words: string[], font: string, px: number, lineHeight: number, width: number, rtl: boolean, weight = 400): Lines {
  const r = root();
  r.style.width = `${width}px`;
  r.style.fontFamily = font;
  r.style.fontWeight = String(weight);
  r.style.fontSize = `${px}px`;
  r.style.lineHeight = String(lineHeight);
  r.style.direction = rtl ? 'rtl' : 'ltr';
  r.lang = rtl ? 'ar' : 'en';
  r.textContent = '';
  const spans: HTMLSpanElement[] = [];
  words.forEach((w, i) => {
    const s = document.createElement('span');
    s.textContent = w;
    r.appendChild(s);
    spans.push(s);
    if (i < words.length - 1) r.appendChild(document.createTextNode(' '));
  });
  const lines: Lines = [];
  let lastTop = -Infinity;
  for (let i = 0; i < spans.length; i++) {
    const top = spans[i].offsetTop;
    if (top > lastTop + px * 0.3) {
      lines.push([]);
      lastTop = top;
    }
    lines[lines.length - 1].push(words[i]);
  }
  return lines;
}

function chunk<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += Math.max(1, n)) out.push(xs.slice(i, i + Math.max(1, n)));
  return out.length ? out : [[]];
}

/**
 * The translation page holding the recitation's place `at` (the share of the ayah's words recited):
 * a page is shown once the recitation reaches the share of the translation that comes before it. The
 * translation is not aligned with the Arabic word for word, so this follows the recitation's progress.
 */
function pageAt(pages: Lines[], at: number): number {
  const words = pages.map((p) => p.reduce((n, l) => n + l.length, 0));
  const total = words.reduce((a, b) => a + b, 0) || 1;
  let page = 0;
  for (let i = 1, before = words[0]; i < pages.length; before += words[i], i++) if (before / total <= at) page = i;
  return page;
}

/**
 * The Arabic and translation page a renderer shows. Each renderer pages by its own count (the overlay,
 * the reading screen and the charity panel can differ from the preview the broadcaster pages by), so a
 * chosen page past the last one holds the last. The Arabic follows the recited word unless a part was
 * chosen; the translation follows the recitation's place while nobody has paged it (page 1 and no page
 * timer), in every language that shows it. `words` is the ayah's number of display words.
 */
function shownPages(plan: Plan, state: DisplayState, words: number): { arabic: number; english: number } {
  let arabic = 0;
  const nA = plan.arabicPages.length;
  if (state.arabicPage !== null) arabic = Math.min(state.arabicPage, nA - 1);
  else if (state.cursor && nA > 1) {
    for (let i = 0; i < nA; i++) if (plan.arabicPageWordStarts[i] <= state.cursor.from) arabic = i;
  } else if (state.progress !== null && nA > 1) {
    const total = plan.arabicPageWordStarts[nA - 1] + plan.arabicPages[nA - 1].reduce((n, l) => n + l.length, 0);
    const word = Math.floor(state.progress * total);
    for (let i = 0; i < nA; i++) if (plan.arabicPageWordStarts[i] <= word) arabic = i;
  }
  const nE = plan.englishPages.length;
  let english = Math.min(state.englishPage, nE - 1);
  const at = state.cursor && words ? (state.cursor.from + 1) / words : state.progress;
  if (state.style.language !== 'arabic' && nE > 1 && state.englishPage === 0 && !state.style.translationPageSeconds && at !== null)
    english = pageAt(plan.englishPages, at);
  return { arabic, english };
}

/** No-break space: binds an ayah-end ornament to the word before it. */
const NBSP = String.fromCharCode(0xa0);
const AR_LH = 1.95;
const EN_LH = 1.42;

let arabicBox = 0;
/** An Arabic word's own box (the font's ascent + descent) per px of size: the meaning hangs below it. */
function arabicBoxRatio(): number {
  if (!arabicBox) {
    const s = document.createElement('span');
    Object.assign(s.style, { fontFamily: ARABIC_FONT, fontSize: '100px', lineHeight: String(AR_LH) });
    s.textContent = 'بسم';
    const r = root();
    r.textContent = '';
    r.appendChild(s);
    arabicBox = s.getBoundingClientRect().height / 100 || 1.7;
  }
  return arabicBox;
}

/**
 * Space between Arabic lines for the recited word's meaning (a pill hung under the word, sized as
 * in .gloss): enough that it clears the words of the line below instead of covering their tops.
 */
function meaningBand(a: number): number {
  const g = Math.max(26, 0.3 * a);
  return Math.max(0, Math.ceil(arabicBoxRatio() * a + g * (0.06 + 1.15 + 0.24) + 4 - AR_LH * a));
}

/** Measured fits by their inputs: a passage is re-planned at each of its ayahs with the same answer. */
const fits = new Map<string, unknown>();
function remember<T>(key: string, run: () => T): T {
  if (fits.has(key)) return fits.get(key) as T;
  const out = run();
  if (fits.size >= 64) fits.delete(fits.keys().next().value!);
  fits.set(key, out);
  return out;
}

/** The next-ayah preview's own height (padding, the "Next surah" row, one line) when its room is kept. */
const NEXT_LABEL_H = 27;
const nextRoomH = (px: number, lineHeight: number) => 20 + NEXT_LABEL_H + Math.ceil(px * lineHeight);

type Plan = {
  layout: 'fullframe' | 'lowerthird';
  promoted: boolean;
  arabicPx: number;
  englishPx: number;
  arabicPages: Lines[];
  englishPages: Lines[];
  arabicPageWordStarts: number[];
  /** The dimmed next-ayah line: its first measured line, and whether the ayah continues past it. */
  next: { px: number; words: string[]; cut: boolean; lang: 'ar' | 'en' } | null;
  /** A passage keeps the preview's room from its first ayah (the preview arrives with its last), so
   *  nothing moves when it arrives: that room's height. null = the preview takes its natural height. */
  nextRoom: number | null;
  /** A passage's translation box keeps the height of its longest translation (each ayah shows its own);
   *  a paged translation keeps the height of its fullest page, so turning a page never moves the Arabic. */
  englishMinH: number | null;
  /** Paged in the caption band: the Arabic keeps the height of its fullest page (null = natural). */
  arabicMinH: number | null;
  /** Paged in the caption band: the Arabic marker's top margin (it sits below the room kept for the
   *  recited word's meaning) and the translation's top margin. null = the stylesheet's. */
  arabicMarkTop: number | null;
  englishTop: number | null;
  /** Space between Arabic lines for the recited word's meaning (0 when no meaning is shown). */
  band: number;
  /** Short-ayah passage: for each Arabic word, which grouped ayah it belongs to, its index in that
   *  ayah, and (on an ayah's last word) the end ornament bound to it. null = the current ayah alone. */
  wordMeta: Array<{ ayah: number; index: number; mark?: string }> | null;
  /** English-only: for each English word, its grouped ayah and (on the last word) its ornament. */
  enMeta: Array<{ ayah: number; mark?: string }> | null;
  /** Several short ayahs share the screen (Arabic or English). */
  passage: boolean;
  /** A surah's opening screen: a framed surah-name banner above the text. */
  banner: boolean;
};

type Geometry = { width: number; height: number; refH: number; gap: number };

/**
 * Where a verse is laid out and at what sizes: the full-frame stage (DEFAULT_GEO, below) or a panel
 * of the charity stream scene (panelGeo). Sizes are px at arabicScale 1.
 */
type Geo = {
  full: Geometry;
  /** The lower third, where there is one. */
  lower: Geometry | null;
  nextW: number;
  nextH: number;
  bannerH: number;
  /** Arabic: largest, smallest alone, smallest with a preview or in a passage, and when paging. */
  ar: { max: number; min: number; minWide: number; page: number };
  en: { max: number; min: number; page: number };
  nextPx: [number, number];
  /** English only: largest, smallest, smallest in a passage, smallest with a preview. */
  enOnly: { max: number; min: number; minGroup: number; minNext: number };
  enOnlyNextPx: [number, number];
  englishFont: string;
  englishWeight: number;
};

/** The stream panel's padding around the verse (matches .stage[data-layout='panel'] .verse). */
const PANEL_PAD = { x: 30, top: 24, bottom: 20 };

/** A panel of the charity stream scene: the same rules at sizes for a smaller frame. */
function panelGeo(frame: { width: number; height: number }, theme: 'nurra' | undefined): Geo {
  const width = frame.width - 2 * PANEL_PAD.x;
  return {
    // The Nurra reference is a framed pill with the credit under it; paged ayahs add their markers.
    full: { width, height: frame.height - PANEL_PAD.top - PANEL_PAD.bottom, refH: theme === 'nurra' ? 140 : 72, gap: 24 },
    lower: null,
    nextW: width - 40,
    nextH: 128,
    bannerH: 96,
    ar: { max: 86, min: 46, minWide: 54, page: 48 },
    en: { max: 38, min: 26, page: 28 },
    nextPx: [30, 40],
    enOnly: { max: 58, min: 30, minGroup: 36, minNext: 34 },
    enOnlyNextPx: [24, 32],
    englishFont: theme === 'nurra' ? NURRA_ENGLISH_FONT : ENGLISH_FONT,
    englishWeight: theme === 'nurra' ? NURRA_ENGLISH_WEIGHT : 400,
  };
}

const FULL: Geometry = { width: 1560, height: 812, refH: 64, gap: 34 };
const LOWER: Geometry = { width: 1600, height: 318, refH: 48, gap: 16 };
/** A continuation marker (.cont): its 6px top margin, then its 19px line at 1.2. */
const MARK_TOP = 6;
const MARK_H = MARK_TOP + 23;
/**
 * Paging inside the caption band (lower third), in the stylesheet's px: the verse's content height
 * (.panel 398 less its 26 + 18 padding), the reference row (22 margin + 44), the translation's top
 * margin (and the 44 that keeps room for the recited word's meaning above it), and the paging sizes at
 * scale 1, above the band's smallest fitted sizes (Arabic 46, English 26, English only 30).
 */
const BAND = { height: 354, refH: 66, gap: 16, meaningGap: 44, ar: 50, en: 28, enOnly: 32 };
/** Height kept for the next-ayah preview (hairline, optional surah label, one Arabic line). */
const NEXT_H = 160;
/** Height the surah banner takes on a surah's opening screen (full frame only). */
const BANNER_H = 118;

/** The screen that opens a surah (its first ayah, or a passage that starts there). */
const opensSurah = (state: DisplayState, group: boolean) => (group && state.group ? state.group[0].ayah : state.verse!.ayah) === 1;
const NEXT_W = 1480;

function planFor(state: DisplayState, useGroup = true, geo: Geo = DEFAULT_GEO): Plan | null {
  const v = state.verse;
  if (!v) return null;
  if (state.style.language === 'english') return planEnglish(state, useGroup, geo);
  // A panel has no lower third: the streamer's layout choice is for the full-frame overlay.
  const lowerWanted = !!geo.lower && state.style.layout === 'lowerthird';
  const scale = state.style.arabicScale;
  const group = useGroup && state.group && state.group.length > 1 && state.style.readingMode !== 'word' ? state.group : null;
  let arWords = toQpcHafsEncoding(v.arabic).split(/\s+/).filter(Boolean);
  let wordMeta: Plan['wordMeta'] = null;
  if (group) {
    // One continuous passage, each ayah closed by its numbered ornament, as on a mushaf line.
    arWords = [];
    wordMeta = [];
    // The ornament is bound to the ayah's last word (no-break space) so a line never starts with it.
    group.forEach((g, gi) => {
      const ws = toQpcHafsEncoding(g.arabic).split(/\s+/).filter(Boolean);
      ws.forEach((w, wi) => {
        const mark = wi === ws.length - 1 ? arabicNumber(g.ayah) : undefined;
        arWords.push(mark ? `${w}${NBSP}${mark}` : w);
        wordMeta!.push({ ayah: gi, index: wi, mark });
      });
    });
  }
  // A passage is sized once for all of its ayahs (its longest translation), so moving through it never
  // changes the text's size or line breaks; each ayah's own translation is shown under it.
  const enSets = state.style.language === 'both' ? (group ?? [v]).map((g) => g.english.split(/\s+/).filter(Boolean)) : [];
  const current = group ? Math.max(0, group.findIndex((g) => g.key === v.key)) : 0;
  const following = state.style.language === 'both' && (state.style.readingMode ?? 'follow') === 'follow';
  const band = (a: number) => (following ? meaningBand(a) : 0);
  const arH = (lines: number, a: number) => lines * a * AR_LH + Math.max(0, lines - 1) * band(a);

  const banner = opensSurah(state, !!group) && !(lowerWanted && state.style.readingMode !== 'word') && state.style.readingMode !== 'word';
  const FULLB: Geometry = banner ? { ...geo.full, height: geo.full.height - geo.bannerH } : geo.full;
  type Fit = { a: number; e: number; al: Lines; els: Lines[]; enLines: number };
  const tryFit = (g: Geometry, arMax: number, arMin: number, enMax: number, enMin: number) =>
    remember(`ar|${g.width}x${g.height}/${g.gap}/${g.refH}|${arMax}-${arMin}|${enMax}-${enMin}/${state.style.englishScale}|${following}|${geo.englishFont}/${geo.englishWeight}|${arWords.join(' ')}|${enSets.map((ws) => ws.join(' ')).join('\n')}`, (): Fit | null => {
      for (let a = arMax; a >= arMin; a -= 2) {
        const e = Math.max(enMin, Math.min(enMax, Math.round(a * 0.5 * state.style.englishScale)));
        const al = measureLines(arWords, ARABIC_FONT, a, AR_LH, g.width, true);
        const els = enSets.map((ws) => measureLines(ws, geo.englishFont, e, EN_LH, g.width, false, geo.englishWeight));
        const enLines = Math.max(0, ...els.map((l) => l.length));
        if (arH(al.length, a) + (enLines ? g.gap + enLines * e * EN_LH : 0) + g.refH <= g.height) return { a, e, al, els, enLines };
      }
      return null;
    });
  const nextPx = (a: number) => Math.max(geo.nextPx[0], Math.min(geo.nextPx[1], Math.round(a * 0.52)));
  const nextLine = (a: number): Plan['next'] => {
    const n = state.next;
    if (!n) return null;
    const px = nextPx(a);
    // The end-of-ayah ornament closes the preview when the whole ayah fits on the line.
    const words = [...toQpcHafsEncoding(n.arabic).split(/\s+/).filter(Boolean), arabicNumber(n.ayah)];
    const lines = measureLines(words, ARABIC_FONT, px, AR_LH, geo.nextW, true);
    return { px, words: lines[0] ?? [], cut: lines.length > 1, lang: 'ar' };
  };
  const single = (fit: Fit, layout: Plan['layout'], promoted: boolean, next: Plan['next'] = null, room = false): Plan => ({
    layout,
    promoted,
    arabicPx: fit.a,
    englishPx: fit.e,
    arabicPages: [fit.al],
    englishPages: [fit.els[current] ?? []],
    arabicPageWordStarts: [0],
    next,
    nextRoom: room ? nextRoomH(nextPx(fit.a), AR_LH) : null,
    englishMinH: group && fit.enLines ? Math.ceil(fit.enLines * fit.e * EN_LH) : null,
    arabicMinH: null,
    arabicMarkTop: null,
    englishTop: null,
    band: band(fit.a),
    wordMeta,
    enMeta: null,
    passage: !!wordMeta,
    banner: banner && layout === 'fullframe',
  });
  const wordStarts = (pages: Lines[]) => {
    const starts: number[] = [];
    let count = 0;
    for (const p of pages) {
      starts.push(count);
      count += p.reduce((n, l) => n + l.length, 0);
    }
    return starts;
  };

  if (lowerWanted && geo.lower && state.style.readingMode !== 'word') {
    if (group) return planFor(state, false, geo);
    const fit = tryFit(geo.lower, Math.round(62 * scale), Math.round(46 * scale), Math.round(30 * state.style.englishScale), Math.round(26 * state.style.englishScale));
    if (fit) return single(fit, 'lowerthird', false);
    // Too long for the band at its smallest sizes: it pages inside the band, so the camera stays in
    // view. With a translation, one Arabic line per page (turned by the recitation, as on the full
    // frame) over as many translation lines as the band holds; Arabic alone takes as many lines as fit.
    const a = Math.round(BAND.ar * scale);
    const e = Math.round(BAND.en * state.style.englishScale);
    const b = band(a);
    const al = measureLines(arWords, ARABIC_FONT, a, AR_LH, geo.lower.width, true);
    const el = enSets.length ? measureLines(enSets[0], geo.englishFont, e, EN_LH, geo.lower.width, false, geo.englishWeight) : [];
    const body = BAND.height - BAND.refH;
    const arLinesPerPage = el.length ? 1 : Math.max(1, Math.floor((body - MARK_H + b) / (a * AR_LH + b)));
    const arabicPages = chunk(al, arLinesPerPage);
    const marked = arabicPages.length > 1;
    // The recited word's meaning hangs under its line: the marker sits below the room kept for it.
    const arabicMarkTop = marked ? MARK_TOP + b : null;
    const arabicH = arH(Math.min(al.length, arLinesPerPage), a) + (marked ? b + MARK_H : 0);
    // Under the marker the translation needs only the band's gap; else it keeps the meaning's room.
    const englishTop = marked || !following ? BAND.gap : BAND.meaningGap;
    const room = body - arabicH - englishTop;
    const enLinesPerPage = el.length * e * EN_LH <= room ? Math.max(1, el.length) : Math.max(1, Math.floor((room - MARK_H) / (e * EN_LH)));
    const englishPages = el.length ? chunk(el, enLinesPerPage) : [[]];
    return {
      layout: 'lowerthird',
      promoted: false,
      arabicPx: a,
      englishPx: e,
      arabicPages,
      englishPages,
      arabicPageWordStarts: wordStarts(arabicPages),
      next: null,
      nextRoom: null,
      englishMinH: englishPages.length > 1 ? Math.ceil(enLinesPerPage * e * EN_LH) + MARK_H : null,
      arabicMinH: marked ? Math.ceil(arH(arLinesPerPage, a) + b) + MARK_H : null,
      arabicMarkTop,
      englishTop: el.length ? englishTop : null,
      band: b,
      wordMeta: null,
      enMeta: null,
      passage: false,
      banner: false,
    };
  }
  // Only Word focus leaves the lower third (its one large word needs the frame); the control page says so.
  const promoted = lowerWanted;
  // The preview only takes space the current ayah can spare at a comfortable size. A passage keeps
  // that room from its first ayah, though the server sends the preview only with its last.
  const room = !!group && state.style.showNext !== false;
  if ((state.next || room) && state.style.readingMode !== 'word') {
    const withNext = tryFit({ ...FULLB, height: FULLB.height - geo.nextH }, Math.round(geo.ar.max * scale), Math.round(geo.ar.minWide * scale), geo.en.max, geo.en.min);
    if (withNext) return single(withNext, 'fullframe', promoted, nextLine(withNext.a), room);
  }
  // A passage of short ayahs is only worth it at a comfortable size; otherwise show the ayah alone.
  const fit = tryFit(FULLB, Math.round(geo.ar.max * scale), Math.round((group ? geo.ar.minWide : geo.ar.min) * scale), geo.en.max, geo.en.min);
  if (fit) return single(fit, 'fullframe', promoted);
  if (group) return planFor(state, false, geo);

  // Deliberate paging: fixed comfortable sizes; Arabic and translation page independently.
  const a = Math.round(geo.ar.page * scale);
  const e = geo.en.page;
  const b = band(a);
  const al = measureLines(arWords, ARABIC_FONT, a, AR_LH, geo.full.width, true);
  const el = enSets.length ? measureLines(enSets[0], geo.englishFont, e, EN_LH, geo.full.width, false, geo.englishWeight) : [];
  const body = geo.full.height - geo.full.refH - (el.length ? geo.full.gap : 0);
  const arShare = el.length ? 0.54 : 1;
  // Lines per Arabic page as without meanings (page turns follow the recitation; fewer lines would
  // turn them more often); the room kept for the meaning comes out of the translation's share.
  const arLinesPerPage = Math.max(1, Math.floor((body * arShare) / (a * AR_LH)));
  const enLinesPerPage = Math.max(1, Math.floor((body - arH(Math.min(al.length, arLinesPerPage), a)) / (e * EN_LH)));
  const arabicPages = chunk(al, arLinesPerPage);
  const englishPages = el.length ? chunk(el, enLinesPerPage) : [[]];
  return {
    layout: 'fullframe',
    promoted,
    arabicPx: a,
    englishPx: e,
    arabicPages,
    englishPages,
    arabicPageWordStarts: wordStarts(arabicPages),
    next: null,
    nextRoom: null,
    // The translation turns with the recitation: a shorter last page keeps the full page's height.
    englishMinH: englishPages.length > 1 ? Math.ceil(enLinesPerPage * e * EN_LH) + MARK_H : null,
    arabicMinH: null,
    arabicMarkTop: null,
    englishTop: null,
    band: b,
    wordMeta: null,
    enMeta: null,
    passage: false,
    banner: false,
  };
}

const EN_ONLY_MAX = 76;
const EN_ONLY_MIN = 40;

/** The full-frame stage (the overlay, reading screen and preview). */
const DEFAULT_GEO: Geo = {
  full: FULL,
  lower: LOWER,
  nextW: NEXT_W,
  nextH: NEXT_H,
  bannerH: BANNER_H,
  ar: { max: 108, min: 54, minWide: 64, page: 58 },
  en: { max: 44, min: 31, page: 32 },
  nextPx: [40, 54],
  enOnly: { max: EN_ONLY_MAX, min: EN_ONLY_MIN, minGroup: 48, minNext: 44 },
  enOnlyNextPx: [28, 40],
  englishFont: ENGLISH_FONT,
  englishWeight: 400,
};

/**
 * English only: the translation is the text being read, so it gets the stage. Short ayahs share the
 * screen as in Arabic, each closed by its numbered ornament.
 */
function planEnglish(state: DisplayState, useGroup: boolean, geo: Geo): Plan {
  const v = state.verse!;
  const group = useGroup && state.group && state.group.length > 1 ? state.group : null;
  const measureWords: string[] = [];
  const enMeta: NonNullable<Plan['enMeta']> = [];
  (group ?? [{ key: v.key, ayah: v.ayah, arabic: v.arabic, english: v.english }]).forEach((g, gi) => {
    const ws = g.english.split(/\s+/).filter(Boolean);
    ws.forEach((w, wi) => {
      const mark = group && wi === ws.length - 1 ? arabicNumber(g.ayah) : undefined;
      // The ornament is drawn by the Arabic font and is about two letters wide.
      measureWords.push(mark ? `${w}${NBSP}MM` : w);
      enMeta.push({ ayah: gi, mark });
    });
  });
  const lower = !!geo.lower && state.style.layout === 'lowerthird';
  const banner = !lower && opensSurah(state, !!group);
  const bannerH = banner ? geo.bannerH : 0;
  const fit = (g: Geometry, height: number, max: number, min: number) =>
    remember(`en|${g.width}/${g.refH}|${height}|${max}-${min}|${geo.englishFont}/${geo.englishWeight}|${measureWords.join(' ')}`, () => {
      for (let e = max; e >= min; e -= 2) {
        const lines = measureLines(measureWords, geo.englishFont, e, EN_LH, g.width, false, geo.englishWeight);
        if (lines.length * e * EN_LH + g.refH <= height) return { e, lines };
      }
      return null;
    });
  const nextPx = (e: number) => Math.max(geo.enOnlyNextPx[0], Math.min(geo.enOnlyNextPx[1], Math.round(e * 0.6)));
  const nextLine = (e: number): Plan['next'] => {
    const n = state.next;
    if (!n) return null;
    const px = nextPx(e);
    const lines = measureLines(n.english.split(/\s+/).filter(Boolean), geo.englishFont, px, EN_LH, geo.nextW, false, geo.englishWeight);
    return { px, words: lines[0] ?? [], cut: lines.length > 1, lang: 'en' };
  };
  const plan = (layout: Plan['layout'], e: number, pages: Lines[], next: Plan['next'], room = false): Plan => ({
    layout,
    promoted: lower && layout === 'fullframe',
    arabicPx: 0,
    englishPx: e,
    arabicPages: [[]],
    englishPages: pages,
    arabicPageWordStarts: [0],
    next,
    nextRoom: room ? nextRoomH(nextPx(e), EN_LH) : null,
    englishMinH: null,
    arabicMinH: null,
    arabicMarkTop: null,
    englishTop: null,
    band: 0,
    wordMeta: null,
    enMeta,
    passage: !!group,
    banner: banner && layout === 'fullframe',
  });
  if (lower && geo.lower && !group) {
    const f = fit(geo.lower, geo.lower.height, Math.round(44 * state.style.englishScale), Math.round(30 * state.style.englishScale));
    if (f) return plan('lowerthird', f.e, [f.lines], null);
    // Too long for the band: it pages inside it (the camera stays in view), each page the same height.
    const e = Math.round(BAND.enOnly * state.style.englishScale);
    const lines = measureLines(measureWords, geo.englishFont, e, EN_LH, geo.lower.width, false, geo.englishWeight);
    const perPage = Math.max(1, Math.floor((BAND.height - BAND.refH - BAND.gap - MARK_H) / (e * EN_LH)));
    const pages = chunk(lines, perPage);
    return { ...plan('lowerthird', e, pages, null), englishMinH: pages.length > 1 ? Math.ceil(perPage * e * EN_LH) + MARK_H : null, englishTop: BAND.gap };
  }
  if (lower && group) return planEnglish(state, false, geo);
  // As in Arabic, a passage keeps the preview's room from its first ayah.
  const room = !!group && state.style.showNext !== false;
  if (state.next || room) {
    const f = fit(geo.full, geo.full.height - geo.nextH - bannerH, geo.enOnly.max, group ? geo.enOnly.minGroup : geo.enOnly.minNext);
    if (f) return plan('fullframe', f.e, [f.lines], nextLine(f.e), room);
  }
  const f = fit(geo.full, geo.full.height - bannerH, geo.enOnly.max, group ? geo.enOnly.minGroup : geo.enOnly.min);
  if (f) return plan('fullframe', f.e, [f.lines], null);
  if (group) return planEnglish(state, false, geo);
  const lines = measureLines(measureWords, geo.englishFont, geo.enOnly.min, EN_LH, geo.full.width, false, geo.englishWeight);
  const perPage = Math.max(1, Math.floor((geo.full.height - geo.full.refH) / (geo.enOnly.min * EN_LH)));
  return plan('fullframe', geo.enOnly.min, chunk(lines, perPage), null);
}

const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';
export const arabicNumber = (n: number) => String(n).replace(/\d/g, (d) => AR_DIGITS[Number(d)]);

export function useFontsReady(englishFont: string = ENGLISH_FONT, englishWeight = 400): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let alive = true;
    Promise.all([document.fonts.load(`64px ${ARABIC_FONT}`, 'بسم'), document.fonts.load(`${englishWeight} 32px ${englishFont}`, 'In the name')])
      .catch(() => undefined)
      .then(() => document.fonts.ready)
      .then(() => alive && setReady(true));
    return () => {
      alive = false;
    };
  }, []);
  return ready;
}

export function VerseDisplay({
  state,
  fontsReady,
  onLayout,
  preview = false,
  frame,
  theme,
}: {
  state: DisplayState;
  fontsReady: boolean;
  onLayout?: (info: LayoutInfo) => void;
  preview?: boolean;
  /** Lay the verse out in a panel of this size (the charity stream scene) instead of the full frame. */
  frame?: { width: number; height: number };
  /** The charity stream's colours and type (Nurra royal blue and gold). */
  theme?: 'nurra';
}) {
  const v = state.verse;
  const fw = frame?.width ?? 0;
  const fh = frame?.height ?? 0;
  const geo = useMemo(() => {
    const base = fw && fh ? panelGeo({ width: fw, height: fh }, theme) : DEFAULT_GEO;
    const scale = state.style.englishScale;
    const sizes = <T extends Record<string, number>>(values: T): T => Object.fromEntries(Object.entries(values).map(([k, v]) => [k, Math.round(v * scale)])) as T;
    return { ...base, en: sizes(base.en), enOnly: sizes(base.enOnly),
      enOnlyNextPx: base.enOnlyNextPx.map((n) => Math.round(n * scale)) as [number, number] };
  }, [fw, fh, theme, state.style.englishScale]);
  const lastFocus = useRef<{ key: string; text: string } | null>(null);
  useLayoutEffect(() => {
    if (v && state.cursor) lastFocus.current = { key: v.key, text: toQpcHafsEncoding(v.arabic).split(/\s+/).filter(Boolean).slice(state.cursor.from, state.cursor.to + 1).join(' ') };
  }, [v?.key, state.cursor?.from, state.cursor?.to]);
  const planKey = v ? `${v.key}|${state.group?.map((g) => g.key).join(',')}|${state.next?.key}|${state.style.layout}|${state.style.readingMode}|${state.style.arabicScale}|${state.style.englishScale}|${state.style.language}|${state.style.showNext}|${fw}x${fh}|${theme ?? ''}` : '';
  // Layout is computed synchronously from measured line boxes before paint.
  const plan = useMemo(() => (fontsReady && v ? planFor(state, true, geo) : null), [planKey, fontsReady]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep a passage mounted while its highlight moves. New ayahs appear together at the measured
  // reading size; scripture never shrinks or moves through an entrance transition.
  const articleKey = plan?.passage && state.group ? `group:${state.group[0].key}` : (v?.key ?? null);

  // Reported when the measured layout changes (not with every highlight step); the control page
  // resends until the server holds it.
  const lastReported = useRef('');
  useLayoutEffect(() => {
    if (!plan || !v || !onLayout) return;
    const info: LayoutInfo = {
      key: v.key,
      englishPages: plan.englishPages.length,
      arabicPages: plan.arabicPages.length,
      promotedToFullFrame: plan.promoted,
      arabicPx: plan.arabicPx,
      englishPx: plan.englishPx,
    };
    const k = JSON.stringify(info);
    if (k !== lastReported.current) {
      lastReported.current = k;
      onLayout(info);
    }
  });

  // The meaning is centred under its word but never leaves the panel: under a word at the end of a
  // line, a long meaning is moved inward. Layout offsets ignore the stage's scale; measured after
  // layout, applied before paint.
  const stageRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const g = stageRef.current?.querySelector<HTMLElement>('.gloss');
    const panel = g?.closest<HTMLElement>('.panel');
    if (!g || !panel) return;
    let x = g.offsetLeft - g.offsetWidth / 2;
    for (let el = g.offsetParent as HTMLElement | null; el && el !== panel; el = el.offsetParent as HTMLElement | null) x += el.offsetLeft;
    const pad = 12;
    const shift = Math.max(0, pad - x) - Math.max(0, x + g.offsetWidth - (panel.offsetWidth - pad));
    g.style.setProperty('--gloss-shift', `${Math.round(shift)}px`);
  });

  const panelSize = frame ? { width: frame.width, height: frame.height } : undefined;
  if (!fontsReady) return <div className="stage" data-bg={frame ? 'panel' : state.style.background} data-layout={frame ? 'panel' : undefined} data-theme={theme} data-empty="true" style={panelSize} />;
  const visible = state.visible && !!plan && !!v;
  const lang = state.style.language;
  const displayWords = v ? toQpcHafsEncoding(v.arabic).split(/\s+/).filter(Boolean) : [];
  const { arabic: arabicPage, english: englishPage } = plan && v ? shownPages(plan, state, displayWords.length) : { arabic: 0, english: 0 };

  const layout = plan?.layout ?? state.style.layout;
  // Word focus shows one Arabic word; with English only it reads as follow.
  const mode = lang === 'english' && state.style.readingMode === 'word' ? 'follow' : (state.style.readingMode ?? 'follow');
  const currentInGroup = plan?.passage && state.group && v ? state.group.findIndex((g) => g.key === v.key) : 0;
  const relOf = (ayah: number) => (ayah < currentInGroup ? 'past' : ayah > currentInGroup ? 'future' : 'current');
  // The reciter has reached the last word: what comes next brightens (preview line or next ayah in the passage).
  const anticipating = !!state.cursor && state.cursor.to >= displayWords.length - 1;
  // Meaning of the word being recited (word-by-word data), in Arabic + English only.
  const gloss = lang === 'both' && state.cursor && v?.glosses ? v.glosses.slice(state.cursor.from, state.cursor.to + 1).filter(Boolean).join(' ') || null : null;
  // Word focus between words keeps the last recited word; before an ayah's first word is placed it
  // shows that first word, dimmed (never a status line: the audience reads this screen).
  const heldText = lastFocus.current?.key === v?.key ? lastFocus.current?.text : null;
  const focusText = state.cursor ? displayWords.slice(state.cursor.from, state.cursor.to + 1).join(' ') : (heldText ?? displayWords[0] ?? '');
  return (
    <div ref={stageRef} className="stage" data-bg={frame ? 'panel' : state.style.background} data-layout={frame ? 'panel' : layout} data-position={state.style.captionPosition} data-theme={theme} data-reading={mode} data-lang={lang} data-preview={preview || undefined} style={{ ...panelSize, ...(!frame ? accentVars(state.style.accent) : {}), '--caption-inset': `${state.style.captionInset}px`, '--panel-opacity': state.style.panelOpacity } as React.CSSProperties}>
      {/* Small, quiet credit while an ayah is up (the broadcaster can turn it off; the stream scene credits Nurra itself).
          Hiding fades it with the ayah instead of cutting it a frame early. */}
      {!!plan && !!v && state.style.credit !== false && !frame && (
        <div className={`stage-credit${visible ? '' : ' stage-credit-off'}`} aria-label="Quran Overlay by Nurra" aria-hidden={!visible || undefined}>
          <span>Quran Overlay by</span>
          <span className="stage-credit-mark">
            <NurraWordmark height={15} />
          </span>
        </div>
      )}
      {/* Hidden from stream keeps the ayah mounted under a transparent panel, so unhiding shows it
          where it was. */}
      <div className={`panel ${visible ? 'panel-on' : 'panel-off'}`} aria-hidden={!visible}>
        {plan && v && (
          <article className={`verse${plan.passage ? ' passage' : ''}`} key={articleKey ?? v.key} aria-label={`${v.surahName} ${v.key}`}>
            {plan.banner && (
              <header className="surah-banner" aria-label={`Surah ${v.surahName}`}>
                <span className="sb-frame">
                  <span className="sb-ar" lang="ar" dir="rtl">سورة {v.surahNameArabic}</span>
                </span>
                <span className="sb-en">{v.surahName}</span>
              </header>
            )}
            {lang !== 'english' && <div className={`arabic ${mode === 'word' ? 'word-focus' : ''}`} lang="ar" dir="rtl" style={{ fontSize: mode === 'word' ? (frame ? 96 : 128) * state.style.arabicScale : plan.arabicPx, width: frame ? geo.full.width : undefined, minHeight: mode === 'word' ? undefined : (plan.arabicMinH ?? undefined), '--meaning-band': plan.band ? `${plan.band}px` : undefined } as React.CSSProperties}>
              {mode === 'word' ? (
                <div className="focus-word" data-active={!!state.cursor} data-waiting={(!state.cursor && !heldText) || undefined}>
                  {focusText}
                  {/* The meaning's line is always there with both languages, so the stack never jumps. */}
                  {lang === 'both' && <div className="focus-gloss" lang="en" dir="ltr" aria-hidden={!gloss || undefined}>{gloss ?? NBSP}</div>}
                </div>
              ) : plan.arabicPages[arabicPage].map((line, i) => (
                <div className="line" key={i}>
                  {line.map((word, j) => {
                    const index = plan.arabicPageWordStarts[arabicPage] + plan.arabicPages[arabicPage].slice(0, i).reduce((n, l) => n + l.length, 0) + j;
                    const meta = plan.wordMeta?.[index];
                    const rel = !meta ? 'current' : meta.ayah < currentInGroup ? 'past' : meta.ayah > currentInGroup ? 'future' : 'current';
                    const w = meta ? meta.index : index;
                    const active = mode === 'follow' && rel === 'current' && w >= 0 && !!state.cursor && w >= state.cursor.from && w <= state.cursor.to;
                    const passed = mode === 'follow' && rel === 'current' && w >= 0 && !!state.cursor && w < state.cursor.from;
                    const upNext = anticipating && !!meta && meta.ayah === currentInGroup + 1;
                    const cls = `quran-word${meta ? ` ayah-${rel}${upNext ? ' ayah-upnext' : ''}` : ''}${active ? ' active-word' : ''}${passed ? ' passed-word' : ''}`;
                    const text = meta?.mark ? word.slice(0, word.length - meta.mark.length - 1) : word;
                    return (
                      <span key={index}>
                        <span className={`${cls}${gloss && active && w === state.cursor!.from ? ' has-gloss' : ''}`} data-word-index={w} aria-current={active ? 'true' : undefined}>
                          {text}
                          {gloss && active && w === state.cursor!.from && <span className="gloss" lang="en" dir="ltr">{gloss}</span>}
                        </span>
                        {meta?.mark && <>{NBSP}<span className={`quran-word ayah-${rel}${upNext ? ' ayah-upnext' : ''} ayah-mark`}>{meta.mark}</span></>}
                        {j < line.length - 1 ? ' ' : ''}
                      </span>
                    );
                  })}
                </div>
              ))}
              {mode !== 'word' && plan.arabicPages.length > 1 && (
                <div className="cont cont-ar" style={plan.arabicMarkTop !== null ? { marginTop: plan.arabicMarkTop } : undefined} aria-label={`Arabic part ${arabicPage + 1} of ${plan.arabicPages.length}`}>
                  {arabicPage < plan.arabicPages.length - 1 ? 'continues' : 'end of ayah'} · {arabicPage + 1}/{plan.arabicPages.length}
                </div>
              )}
            </div>}
            {lang !== 'arabic' && plan.englishPages[englishPage].length > 0 && (
              <div className={`english${lang === 'english' ? ' english-only' : ''}`} lang="en" style={{ fontSize: plan.englishPx, minHeight: plan.englishMinH ?? undefined, marginTop: plan.englishTop ?? undefined, width: frame ? geo.full.width : undefined }}>
                {mode === 'word' && <div className="translation-label">Ayah translation</div>}
                {plan.englishPages[englishPage].map((line, i) => {
                  if (!plan.enMeta) return <div className="line" key={i}>{line.join(' ')}</div>;
                  const start = plan.englishPages.slice(0, englishPage).reduce((n, pg) => n + pg.reduce((m, l) => m + l.length, 0), 0) + plan.englishPages[englishPage].slice(0, i).reduce((n, l) => n + l.length, 0);
                  return (
                    <div className="line" key={i}>
                      {line.map((word, j) => {
                        const meta = plan.enMeta![start + j];
                        const rel = plan.passage ? relOf(meta.ayah) : 'current';
                        const upNext = anticipating && plan.passage && meta.ayah === currentInGroup + 1;
                        const cls = `en-word ayah-${rel}${upNext ? ' ayah-upnext' : ''}`;
                        return (
                          <span key={j}>
                            <span className={cls}>{meta.mark ? word.split(NBSP)[0] : word}</span>
                            {meta.mark && <>{NBSP}<span className={`${cls} ayah-mark en-mark`} lang="ar">{meta.mark}</span></>}
                            {j < line.length - 1 ? ' ' : ''}
                          </span>
                        );
                      })}
                    </div>
                  );
                })}
                {lang === 'english' && mode === 'follow' && state.progress !== null && !!state.cursor && (
                  // How far through the current ayah the recitation is; not a word-for-word claim.
                  <div className="en-progress" aria-hidden><span style={{ transform: `scaleX(${state.progress})` }} /></div>
                )}
                {plan.englishPages.length > 1 && (
                  <div className="cont">
                    Translation {englishPage + 1}/{plan.englishPages.length}
                    {englishPage < plan.englishPages.length - 1 ? ' · continues' : ''}
                  </div>
                )}
              </div>
            )}
            {state.style.showReference && (
              <footer className="reference">
                <span className="ref-names">
                  <span className="ref-ar" lang="ar" dir="rtl">
                    <span className="ref-surah">{v.surahNameArabic}</span>
                    {/* This Hafs font draws the end-of-ayah ornament around Arabic-Indic digits itself;
                        prefixing U+06DD would render a second, empty ornament. */}
                    <span className="ref-mark">{arabicNumber(v.ayah)}</span>
                  </span>
                  <span className="ref-en">
                    <span className="ref-name">{v.surahName}</span>
                    <span className="ref-key">{v.key}</span>
                  </span>
                </span>
                {lang !== 'arabic' && <span className="ref-credit">{v.translationName}{lang === 'both' && v.glosses && v.glossCredit ? ` · ${v.glossCredit}` : ''}</span>}
              </footer>
            )}
            {plan.nextRoom !== null && !(plan.next && state.next) && <div className="next-room" style={{ height: plan.nextRoom }} aria-hidden />}
            {plan.next && state.next && (
              <aside
                className="next-ayah"
                aria-label={`Next: ${state.next.key}`}
                // The reciter has reached the last word: what comes next brightens, without moving.
                data-anticipate={anticipating || undefined}
                style={plan.nextRoom !== null || frame ? { height: plan.nextRoom ?? undefined, width: frame ? geo.nextW : undefined } : undefined}
              >
                {state.next.surahName && <div className="next-label">Next surah · {state.next.surahName}</div>}
                <div className={`next-line${plan.next.lang === 'en' ? ' next-en' : ''}${plan.next.cut ? ' next-cut' : ''}`} lang={plan.next.lang} dir={plan.next.lang === 'en' ? 'ltr' : 'rtl'} style={{ fontSize: plan.next.px }}>
                  {plan.next.words.join(' ')}
                </div>
              </aside>
            )}
          </article>
        )}
      </div>
    </div>
  );
}

/** Scales the fixed stage to fit its container (preview) or the window (overlay). */
export function StageFrame({ children, className }: { children: React.ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setScale(Math.min(el.clientWidth / STAGE_W, el.clientHeight / STAGE_H) || 1);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div ref={ref} className={`stage-frame ${className ?? ''}`}>
      <div className="stage-scaler" style={{ transform: `scale(${scale})` }}>
        {children}
      </div>
    </div>
  );
}
