import { useRef } from 'react';

/** Keep the last two inspected/recited meanings in their own reserved word positions. */
export function useWordHistory(key: string | undefined, cursor: { from: number; to: number } | null | undefined) {
  const memory = useRef<{ key?: string; word: number | null; recent: number[] }>({ word: null, recent: [] });
  if (memory.current.key !== key) memory.current = { key, word: null, recent: [] };
  const word = cursor?.from ?? null;
  if (word !== memory.current.word) {
    const previous = memory.current.word;
    memory.current = { key, word, recent: previous === null ? memory.current.recent : [previous, ...memory.current.recent.filter((i) => i !== previous)].slice(0, 2) };
  }
  return memory.current.recent;
}

/** Source-owned English attached to exactly one Arabic display word. Never a sentence alignment. */
export function WordMeaning({ text, index, active, context, onInspect }: {
  text: string | null | undefined; index: number; active: boolean; context: boolean;
  onInspect?: () => void;
}) {
  if (!text) return null;
  return <span className={`word-meaning${active ? ' is-active' : ''}${context && !active ? ' is-context' : ''}`}
    lang="en" dir="ltr" data-meaning-index={index} aria-hidden={!active && !context || undefined}
    onClick={onInspect ? (e) => { e.stopPropagation(); onInspect(); } : undefined}>
    {text}
  </span>;
}
