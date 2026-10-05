// Audience output for OBS (/overlay#view=…) or a clean reading screen (…&bg=solid).
// Read-only: it can only receive display state and acknowledge paints. No controls, no transcript.

import { useEffect, useRef, useState } from 'react';
import { DisplayStateSchema, type DisplayState, type OverlayServerMessage } from '../shared/contracts';
import { connect, u } from './net';
import { StageFrame, VerseDisplay, useFontsReady } from './VerseDisplay';

function readCapability(): { view: string | null; bg: string | null } {
  const params = new URLSearchParams(location.hash.slice(1));
  let view = params.get('view');
  const bg = params.get('bg');
  try {
    if (view) sessionStorage.setItem('qo_view', view);
    else view = sessionStorage.getItem('qo_view');
  } catch {
    /* storage unavailable: the URL fragment still works */
  }
  return { view, bg };
}

export function Overlay() {
  const [{ view, bg }] = useState(readCapability);
  const [state, setState] = useState<DisplayState | null>(null);
  const [denied, setDenied] = useState(false);
  const fontsReady = useFontsReady();
  const lastRevision = useRef(-1);
  const epoch = useRef<string | null>(null);
  const sock = useRef<ReturnType<typeof connect> | null>(null);

  useEffect(() => {
    document.documentElement.dataset.surface = 'overlay';
    // A reading screen on a display that is not 16:9 letterboxes the stage: in the stage's own colour,
    // never the page's white (OBS output, without bg, stays transparent).
    if (bg === 'solid') document.documentElement.dataset.bg = 'solid';
    if (!view) {
      setDenied(true);
      return;
    }
    sock.current = connect(u('/ws/overlay'), {
      onOpen: (send) => send({ type: 'hello', view, role: 'overlay' }),
      // 4410: the session behind this link ended (a restart, or it went idle), but the link is still
      // good. Its ayah is not left frozen on stream; the same link reconnects to whatever comes next.
      onStatus: (status, code) => {
        if (status !== 'closed' || code !== 4410) return;
        epoch.current = null;
        lastRevision.current = -1;
        setState(null);
        setDenied(false);
      },
      shouldRetry: (code) => code !== 4401,
      onMessage: (data) => {
        const m = data as OverlayServerMessage;
        if (m.type === 'denied') return setDenied(true);
        if (m.type !== 'display') return;
        const parsed = DisplayStateSchema.safeParse(m.state);
        if (!parsed.success) return;
        const s = parsed.data;
        // Old revisions are ignored; a new server session starts a new revision sequence.
        if (s.sessionEpoch === epoch.current && s.revision <= lastRevision.current) return;
        epoch.current = s.sessionEpoch;
        lastRevision.current = s.revision;
        setDenied(false); // a link that delivers a display is a working link
        setState(s);
      },
    });
    return () => sock.current?.close();
  }, [view]);

  // Acknowledge after the frame containing this revision is painted (upper bound on commit→paint).
  useEffect(() => {
    if (!state || !fontsReady) return;
    const rev = state.revision;
    requestAnimationFrame(() => setTimeout(() => sock.current?.send({ type: 'painted', revision: rev }), 0));
  }, [state, fontsReady]);

  // A refused link is the broadcaster's to fix, never the audience's to read: the stage stays empty
  // and transparent, and the reason goes to the console (OBS: Interact, or the browser's devtools).
  useEffect(() => {
    if (!denied) return;
    console.warn('Quran Overlay: this overlay link is missing or was replaced. Copy the current link from the control page (Stream output → Copy OBS overlay link).');
    document.title = 'Overlay link not valid · Quran Overlay';
  }, [denied]);

  if (denied || !state) return null;
  const shown = bg === 'solid' ? { ...state, style: { ...state.style, background: 'solid' as const } } : state;
  return (
    <StageFrame className="overlay-frame">
      <VerseDisplay state={shown} fontsReady={fontsReady} />
    </StageFrame>
  );
}
