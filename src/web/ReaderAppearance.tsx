import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { onReaderChoiceKey } from './reader-choice';

type Appearance = { theme: 'night' | 'paper'; scale: number };
const DEFAULT: Appearance = { theme: 'night', scale: 1 };

function load(): Appearance {
  try {
    const saved = JSON.parse(localStorage.getItem('qo.reader.appearance') ?? '{}');
    return { theme: saved.theme === 'paper' ? 'paper' : 'night',
      scale: typeof saved.scale === 'number' && saved.scale >= 0.9 && saved.scale <= 1.35 ? saved.scale : 1 };
  } catch { return DEFAULT; }
}

/** Reading comfort belongs to this browser, independently of the broadcaster's audience style. */
export function useReaderAppearance() {
  const [appearance, setAppearance] = useState(load);
  useLayoutEffect(() => {
    document.documentElement.dataset.readerTheme = appearance.theme;
    document.documentElement.style.setProperty('--reader-scale', String(appearance.scale));
    return () => {
      delete document.documentElement.dataset.readerTheme;
      document.documentElement.style.removeProperty('--reader-scale');
    };
  }, [appearance]);
  useEffect(() => {
    try { localStorage.setItem('qo.reader.appearance', JSON.stringify(appearance)); } catch { /* Reading still works without storage. */ }
  }, [appearance]);
  return [appearance, setAppearance] as const;
}

export function ReaderAppearance({ appearance, onChange, onClose }: {
  appearance: Appearance; onChange: (next: Appearance) => void; onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  const adjust = (delta: number) => onChange({ ...appearance, scale: Math.round(Math.min(1.35, Math.max(0.9, appearance.scale + delta)) * 100) / 100 });
  return (
    <dialog ref={ref} className="r-reading-dialog" aria-labelledby="reading-appearance-title" onCancel={(e) => { e.preventDefault(); onClose(); }} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="r-reading-body">
        <button className="r-close" autoFocus onClick={onClose} aria-label="Close reading appearance">×</button>
        <h2 id="reading-appearance-title">Your reading page</h2>
        <p className="hint">Saved on this device. Your stream keeps its own look.</p>
        <div className="r-reading-themes" role="radiogroup" aria-label="Reading theme" onKeyDown={onReaderChoiceKey}>
          {(['night', 'paper'] as const).map((theme) => (
            <button key={theme} className={`r-theme-choice r-theme-${theme}`} role="radio" aria-checked={appearance.theme === theme} tabIndex={appearance.theme === theme ? 0 : -1} onClick={() => onChange({ ...appearance, theme })}>
              <span className="r-theme-sample" aria-hidden="true"><i /><i /><i /></span>
              <strong>{theme === 'night' ? 'Night' : 'Paper'}</strong>
              <span>{theme === 'night' ? 'Quiet ink and gold' : 'Warm page, dark lettering'}</span>
            </button>
          ))}
        </div>
        <div className="r-reading-size">
          <span>Text size</span><output aria-label="Reading text size">{Math.round(appearance.scale * 100)}%</output>
          <button aria-label="Smaller reading text" disabled={appearance.scale <= 0.9} onClick={() => adjust(-0.05)}>A−</button>
          <button aria-label="Larger reading text" disabled={appearance.scale >= 1.35} onClick={() => adjust(0.05)}>A+</button>
        </div>
        <p className="hint">Arabic and translation resize together. All ayahs remain on the page.</p>
        <button className="r-reading-done" onClick={onClose}>Return to reading</button>
      </div>
    </dialog>
  );
}
