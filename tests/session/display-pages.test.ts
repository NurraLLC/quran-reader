import { describe, expect, it } from 'vitest';
import { DEFAULT_STYLE, type DisplayState } from '../../src/shared/contracts';
import { shownPages } from '../../src/web/display-pages';

const pages = { arabicPageWords: [10, 20, 30], englishPageWords: [5, 10, 15] };
const automatic = { arabicPage: null, englishPage: null, cursor: { from: 35, to: 35 }, progress: 0, style: DEFAULT_STYLE } satisfies Pick<DisplayState, 'arabicPage' | 'englishPage' | 'cursor' | 'progress' | 'style'>;

describe('the pages on screen are the control arrows\' starting place', () => {
  it('uses the cursor before fallback progress in both languages', () => {
    expect(shownPages(pages, automatic, 60)).toEqual({ arabic: 2, english: 2 });
    expect(shownPages(pages, { ...automatic, cursor: null, progress: 0.2 }, 60)).toEqual({ arabic: 1, english: 1 });
  });
  it('holds the first manual page even after recitation has moved ahead', () => {
    expect(shownPages(pages, { ...automatic, englishPage: 0, arabicPage: 0 }, 60)).toEqual({ arabic: 0, english: 0 });
  });
  it('turns exactly at a translation boundary without multiplication rounding it down', () => {
    expect(shownPages({ arabicPageWords: [60], englishPageWords: [63, 27] }, { ...automatic, cursor: null, progress: 0.7 }, 60).english).toBe(1);
  });
  it('clamps manual pages to each renderer\'s final page instead of wrapping the label', () => {
    expect(shownPages(pages, { ...automatic, englishPage: 20, arabicPage: 20 }, 60)).toEqual({ arabic: 2, english: 2 });
    expect(shownPages({ arabicPageWords: [60], englishPageWords: [30] }, { ...automatic, englishPage: 20, arabicPage: 20 }, 60)).toEqual({ arabic: 0, english: 0 });
  });
  it('keeps timer mode on page one until its first tick and handles missing progress', () => {
    expect(shownPages(pages, { ...automatic, style: { ...DEFAULT_STYLE, translationPageSeconds: 10 } }, 60).english).toBe(0);
    expect(shownPages(pages, { ...automatic, cursor: null, progress: null }, 60)).toEqual({ arabic: 0, english: 0 });
  });
});
