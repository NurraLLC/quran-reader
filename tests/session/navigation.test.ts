// Rapid Next/Previous presses (a burst, or a held arrow key): the control page follows every press,
// the audience is shown where the presses end instead of every ayah between for a tenth of a second.
// A single press, a typed reference and Hide reach the stream at once.
import { describe, expect, it } from 'vitest';
import { CommandResolver } from '../../src/server/commands/reducer';
import { NAV_SETTLE_MS, Session } from '../../src/server/sessions';
import { fullCorpus, VirtualClock } from '../helpers';

function setup() {
  const { corpus, ix } = fullCorpus();
  const clock = new VirtualClock();
  const saved: Array<string | null> = [];
  const s = new Session({
    corpus,
    ix,
    resolver: new CommandResolver(corpus, null, null),
    decisionClient: null,
    mode: 'deterministic',
    setup: { soniox: true, jev: { provider: null, configured: false, detail: '' }, semantic: () => '' },
    overlayUrl: (v) => v,
    clock,
    onDisplayKey: (d) => saved.push(d ? `${d.key}${d.hidden ? ' hidden' : ''}` : null),
  });
  /** What OBS was sent: the ayah, or "hidden". */
  const audience: string[] = [];
  s.onDisplay((d) => audience.push(d.visible ? d.verse!.key : 'hidden'));
  /** What the control page was sent. */
  const control: string[] = [];
  s.onControl((m) => m.type === 'display' && control.push(m.state.visible ? m.state.verse!.key : 'hidden'));
  s.handle({ type: 'goto', key: '2:26' });
  audience.length = 0;
  control.length = 0;
  saved.length = 0;
  return { s, clock, audience, control, saved };
}

const next = { type: 'nav', action: 'next' } as const;

describe('rapid Next presses', () => {
  it('a single press goes on stream at once', async () => {
    const { s, clock, audience, control } = setup();
    s.handle(next);
    expect(audience).toEqual(['2:27']);
    expect(control).toEqual(['2:27']);
    await clock.advance(2000);
    expect(audience).toEqual(['2:27']);
  });

  it('8 presses 100 ms apart show the first at once and the last when the presses stop', async () => {
    const { s, clock, audience, control, saved } = setup();
    for (let i = 0; i < 8; i++) {
      if (i) await clock.advance(100);
      s.handle(next);
    }
    expect(audience).toEqual(['2:27']);
    // The control page follows every press, so the broadcaster sees where they are.
    expect(control).toEqual(['2:27', '2:28', '2:29', '2:30', '2:31', '2:32', '2:33', '2:34']);
    expect(s.display.verse?.key).toBe('2:34');
    expect(s.audienceDisplay.verse?.key).toBe('2:27'); // what an OBS source connecting now is given
    await clock.advance(NAV_SETTLE_MS - 1);
    expect(audience).toEqual(['2:27']);
    await clock.advance(1);
    expect(NAV_SETTLE_MS).toBe(300);
    expect(audience).toEqual(['2:27', '2:34']);
    expect(s.audienceDisplay.verse?.key).toBe('2:34');
    // What is saved for a restart is what the audience saw.
    expect(saved).toEqual(['2:27', '2:34']);
    // Revisions only increase for the audience.
    await clock.advance(1000);
    s.handle(next);
    expect(audience).toEqual(['2:27', '2:34', '2:35']);
  });

  it('presses further apart than the window each go on stream at once', async () => {
    const { s, clock, audience } = setup();
    s.handle(next);
    await clock.advance(NAV_SETTLE_MS + 50);
    s.handle(next);
    await clock.advance(NAV_SETTLE_MS + 50);
    s.handle({ type: 'nav', action: 'prev' });
    expect(audience).toEqual(['2:27', '2:28', '2:27']);
  });

  it('a typed reference or Hide during a burst reaches the stream at once, and the burst never overrides it', async () => {
    const { s, clock, audience } = setup();
    s.handle(next);
    await clock.advance(100);
    s.handle(next);
    await clock.advance(100);
    s.handle({ type: 'goto', key: '18:10' });
    expect(audience).toEqual(['2:27', '18:10']);
    await clock.advance(2000);
    expect(audience).toEqual(['2:27', '18:10']);

    s.handle(next);
    await clock.advance(100);
    s.handle(next);
    s.handle({ type: 'blank', on: true });
    expect(audience).toEqual(['2:27', '18:10', '18:11', 'hidden']);
    await clock.advance(2000);
    expect(audience).toEqual(['2:27', '18:10', '18:11', 'hidden']);
    expect(s.display.verse?.key).toBe('18:12');
  });

  it('another action that changes nothing on screen lets the audience catch up at once', async () => {
    const { s, clock, audience } = setup();
    s.handle(next);
    await clock.advance(100);
    s.handle(next);
    s.handle({ type: 'pin', on: true });
    expect(audience).toEqual(['2:27', '2:28']);
    await clock.advance(1000);
    expect(audience).toEqual(['2:27', '2:28']);
  });

  it('a burst that ends where the stream already is sends nothing more', async () => {
    const { s, clock, audience } = setup();
    s.handle(next);
    await clock.advance(100);
    s.handle(next);
    await clock.advance(100);
    s.handle({ type: 'nav', action: 'prev' });
    await clock.advance(1000);
    expect(audience).toEqual(['2:27']);
  });
});
