import { useLayoutEffect, useRef, useState } from 'react';
import { DEFAULT_STYLE, type ControlClientMessage, type DisplayStyle, type StylePatch } from '../shared/contracts';

const ACCENTS = [
  ['#cfaa62', 'Gold'], ['#5fbf98', 'Emerald'], ['#7fb2e5', 'Sky'],
  ['#e39aa8', 'Rose'], ['#b99be6', 'Lavender'], ['#e8e3d6', 'Pearl'],
] as const;

// Looks change the composition in one server message. Page timing remains the broadcaster's choice.
const { translationPageSeconds: _timing, ...DEFAULT_LOOK } = DEFAULT_STYLE;
const LOOKS: Array<{ name: string; detail: string; picture: string; patch: StylePatch }> = [
  { name: 'Reading', detail: 'Arabic + English · full frame', picture: 'reading', patch: DEFAULT_LOOK },
  { name: 'Stream captions', detail: 'Arabic + English · lower third', picture: 'captions',
    patch: { ...DEFAULT_LOOK, layout: 'lowerthird', groupShort: false, showNext: false } },
  { name: 'Arabic only', detail: 'Arabic · transparent full frame', picture: 'arabic',
    patch: { ...DEFAULT_LOOK, language: 'arabic', background: 'transparent' } },
];

type SizeField = 'arabicScale' | 'englishScale' | 'panelOpacity' | 'captionInset';

/** Keep the thumb at the latest local choice while earlier server echoes arrive during a drag. */
function AppearanceSlider({ label, field, value, min, max, step, disabled, change }: {
  label: string; field: SizeField; value: number; min: number; max: number; step: number; disabled: boolean;
  change: (patch: StylePatch) => boolean;
}) {
  const [draft, setDraft] = useState(value);
  const pending = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (pending.current === null || value === pending.current) {
      pending.current = null;
      setDraft(value);
    }
  });
  return (
    <label className="appearance-slider">
      <span>{label}</span>
      <output>{field === 'captionInset' ? `${draft} px` : `${Math.round(draft * 100)}%`}</output>
      <input aria-label={label} type="range" min={min} max={max} step={step} value={draft} disabled={disabled} onChange={(e) => {
        const next = Number(e.target.value);
        if (change({ [field]: next })) { pending.current = next; setDraft(next); }
      }} />
    </label>
  );
}

export function OverlayAppearance({ style: s, sessionEpoch, send }: { style: DisplayStyle; sessionEpoch: string; send: (m: ControlClientMessage) => boolean }) {
  const change = (patch: StylePatch) => send({ type: 'style', patch });
  const [lookRevision, setLookRevision] = useState(0);
  const applyLook = (patch: StylePatch) => { if (change(patch)) setLookRevision((n) => n + 1); };
  const active = LOOKS.find((look) => Object.entries(look.patch).every(([k, v]) => s[k as keyof DisplayStyle] === v));
  const seg = <T extends string>(label: string, value: T, options: Array<[T, string]>, onPick: (v: T) => void) => (
    <div className="seg" role="radiogroup" aria-label={label}>
      <span className="seg-label">{label}</span>
      {options.map(([v, text]) => <button key={v} role="radio" aria-checked={value === v} className={value === v ? 'on' : ''} onClick={() => onPick(v)}>{text}</button>)}
    </div>
  );
  const slider = (label: string, field: SizeField, min: number, max: number, step: number, disabled = false) =>
    <AppearanceSlider key={`${sessionEpoch}:${lookRevision}:${field}`} label={label} field={field} value={s[field]} min={min} max={max} step={step} disabled={disabled} change={change} />;
  return (
    <div className="overlay-appearance">
      <div className="look-heading"><span>Choose a look</span><span>{active?.name ?? 'Custom look'}</span></div>
      <div className="overlay-looks">
        {LOOKS.map((look) => (
          <button key={look.name} className={`overlay-look${active === look ? ' on' : ''}`} aria-pressed={active === look} onClick={() => applyLook(look.patch)}>
            <span className={`look-picture look-${look.picture}`} aria-hidden="true"><i /><i /><i /></span>
            <strong>{look.name}</strong><span>{look.detail}</span>
          </button>
        ))}
      </div>
      <p className="hint">Changes appear on stream immediately. The audience preview shows the same look.</p>
      <a className="appearance-preview" href="#audience-preview">See audience preview</a>
      {seg('Layout', s.layout, [['fullframe', 'Full frame'], ['lowerthird', 'Lower third']], (layout) => change({ layout }))}
      {s.layout === 'lowerthird' && <>
        {seg('Caption position', s.captionPosition, [['bottom', 'Bottom'], ['top', 'Top']], (captionPosition) => change({ captionPosition }))}
        {slider('Distance from edge', 'captionInset', 24, 160, 8)}
        <p className="hint">Long ayahs use the full frame so no words are cut off.</p>
      </>}
      {seg('Background', s.background, [['transparent', 'Transparent'], ['scrim', 'Shaded panel'], ['solid', 'Solid']], (background) => change({ background }))}
      {s.background === 'scrim' && slider('Panel shading', 'panelOpacity', 0.2, 1, 0.04)}
      {s.background === 'transparent' && <p className="hint">Transparent suits dark or mid-tone footage. Over a bright camera (a white wall, a window, daylight), choose Shaded panel: transparent text cannot stay readable on white.</p>}
      <details className="appearance-details">
        <summary>Text size, colour and details</summary>
        {slider('Arabic size', 'arabicScale', 0.8, 1.25, 0.05, s.language === 'english')}
        {slider('English size', 'englishScale', 0.8, 1.4, 0.05, s.language === 'arabic')}
        <p className="hint">Sizes are relative to the fitted text. Long ayahs turn pages at a readable size.</p>
        <div className="seg accent-row" role="radiogroup" aria-label="Colour">
          <span className="seg-label">Highlight colour</span>
          {ACCENTS.map(([hex, name]) => <button key={hex} role="radio" aria-checked={s.accent.toLowerCase() === hex} aria-label={name} title={name} className={`swatch${s.accent.toLowerCase() === hex ? ' on' : ''}`} style={{ background: hex }} onClick={() => change({ accent: hex })} />)}
          <label className={`swatch custom${ACCENTS.some(([h]) => h === s.accent.toLowerCase()) ? '' : ' on'}`} title="Your own colour">
            <input type="color" value={s.accent} aria-label="Your own colour" onChange={(e) => change({ accent: e.target.value })} />
          </label>
        </div>
        <label className="row check-row"><input type="checkbox" checked={s.credit} onChange={(e) => change({ credit: e.target.checked })} /> Show a small “Quran Overlay by Nurra” in the corner</label>
        <label className="row check-row"><input type="checkbox" checked={s.showReference} onChange={(e) => change({ showReference: e.target.checked })} /> Show surah and ayah number</label>
        <label className="row check-row"><input type="checkbox" checked={s.showNext} disabled={s.layout === 'lowerthird' || s.readingMode === 'word'} onChange={(e) => change({ showNext: e.target.checked })} /> Show the next ayah, dimmed (full frame)</label>
        <label className="row check-row"><input type="checkbox" checked={s.groupShort} disabled={s.layout === 'lowerthird' || s.readingMode === 'word'} onChange={(e) => change({ groupShort: e.target.checked })} /> Show short ayahs together (full frame)</label>
        <button className="link restore-look" onClick={() => applyLook(DEFAULT_LOOK)}>Restore default look</button>
      </details>
    </div>
  );
}
