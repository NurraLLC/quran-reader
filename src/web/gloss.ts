/**
 * A word's meaning label is centred under its word but never leaves the column the word is in: under
 * a word at either end of a line a long meaning moves inward, and one wider than the column wraps
 * (the overlay keeps its meanings inside the panel the same way, in VerseDisplay). Call after layout,
 * before paint (a layout effect): it measures, then sets --gloss-max and --gloss-shift on each label.
 */
export function keepMeaningsInside(root: ParentNode, columnOf: (gloss: HTMLElement) => HTMLElement | null, pad = 8) {
  for (const gloss of root.querySelectorAll<HTMLElement>('.r-gloss')) {
    const word = gloss.parentElement;
    const column = columnOf(gloss);
    if (!word || !column) continue;
    const c = column.getBoundingClientRect();
    gloss.style.setProperty('--gloss-max', `${Math.max(0, Math.floor(c.width - 2 * pad))}px`);
    const w = word.getBoundingClientRect();
    const width = gloss.offsetWidth; // layout width: the label's own transform is not included
    const left = w.left + w.width / 2 - width / 2;
    const shift = Math.max(0, c.left + pad - left) - Math.max(0, left + width - (c.right - pad));
    gloss.style.setProperty('--gloss-shift', `${Math.round(shift)}px`);
  }
}
