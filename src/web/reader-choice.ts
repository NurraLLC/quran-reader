import type { KeyboardEvent } from 'react';

/** Browser page scrolling and passage arrows are hand reading; handled choice keys are not. */
export function readerHandReadingKey(e: { key: string; target: EventTarget | null; defaultPrevented: boolean }): boolean {
  if (!['PageDown', 'PageUp', 'ArrowDown', 'ArrowUp', 'Home', 'End', ' '].includes(e.key)) return false;
  const target = e.target as HTMLElement | null;
  if (target?.closest('input, textarea, select, [contenteditable="true"], dialog')) return false;
  if (e.defaultPrevented && target?.closest('[role="radiogroup"]')) return false;
  if (e.key === ' ' && target?.closest('button, a')) return false;
  return true;
}

/** Move among the enabled choices; horizontal arrows follow the group's visual direction. */
export function readerChoiceIndex(key: string, current: number, count: number, direction = 'ltr'): number | null {
  if (count === 0 || current < 0 || current >= count) return null;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  let step: number;
  if (key === 'ArrowDown') step = 1;
  else if (key === 'ArrowUp') step = -1;
  else if (key === 'ArrowRight') step = direction === 'rtl' ? -1 : 1;
  else if (key === 'ArrowLeft') step = direction === 'rtl' ? 1 : -1;
  else return null;
  return (current + step + count) % count;
}

/** Keep the existing click callback as the only selection owner, with no passage scroll on focus. */
export function onReaderChoiceKey(e: KeyboardEvent<HTMLElement>) {
  if (e.altKey || e.ctrlKey || e.metaKey) return;
  const radio = (e.target as HTMLElement).closest<HTMLButtonElement>('button[role="radio"]');
  const group = e.currentTarget;
  if (!radio || radio.closest('[role="radiogroup"]') !== group) return;
  const choices = [...group.querySelectorAll<HTMLButtonElement>('button[role="radio"]')]
    .filter((choice) => choice.closest('[role="radiogroup"]') === group && !choice.disabled && choice.getAttribute('aria-disabled') !== 'true');
  const index = readerChoiceIndex(e.key, choices.indexOf(radio), choices.length, getComputedStyle(group).direction);
  if (index === null) return;
  e.preventDefault();
  const next = choices[index];
  if (next === radio) return;
  next.focus({ preventScroll: true });
  next.click();
}
