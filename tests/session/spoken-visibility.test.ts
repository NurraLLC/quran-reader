// Synthetic ASR and decision answers through the real Session and CommandResolver. No provider calls.
import { describe, expect, it } from 'vitest';
import { CommandResolver } from '../../src/server/commands/reducer';
import { Session } from '../../src/server/sessions';
import type { Decision, DecisionClient } from '../../src/server/providers/jev';
import type { CommandResult, ControlServerMessage } from '../../src/shared/contracts';
import { fullCorpus, VirtualClock } from '../helpers';

const strong = (route: string) => Object.fromEntries(['NAVIGATE', 'CONTROL', 'SHOW', 'SEARCH', 'COMMENTARY'].map(key => [key, key === route ? .98 : .005]));
const uncertainShow = { SHOW: .6, SEARCH: .35, COMMENTARY: .05, NAVIGATE: 0, CONTROL: 0 };

function setup(probabilities: Record<string, number>) {
  const { corpus, ix } = fullCorpus();
  const clock = new VirtualClock();
  const calls: string[] = [];
  const client: DecisionClient = {
    gateway: 'openrouter',
    evaluate: async (state, questions) => {
      calls.push(Object.keys(questions).join(','));
      let answers: Decision['answers'];
      if (questions.route) {
        const choice = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0][0];
        answers = { route: { type: 'choice', choice, probabilities, confidence: .99, tied: false } };
      } else {
        const passageQuestion = questions.passage;
        if (passageQuestion?.type !== 'choice' || !passageQuestion.criteria) throw new Error('Expected supplied passage choices');
        const passages = (state as { passages: Record<string, { reference: string }> }).passages;
        const choice = Object.keys(passages).find(key => passages[key].reference === '93:9') ?? Object.keys(passages)[0];
        answers = {
          passage: { type: 'choice', choice, probabilities: Object.fromEntries(Object.keys(passageQuestion.criteria).map(key => [key, key === choice ? 1 : 0])), confidence: .99, tied: false },
          relevant: { type: 'noul', noul: .99 },
        };
      }
      return { id: 'synthetic-visibility', gateway: 'openrouter', model: 'typesafe/jev-1.13', latencyMs: 0, usage: { inputTokens: 0, outputTokens: 0, cost: 0 }, answers };
    },
  };
  const session = new Session({
    corpus, ix, resolver: new CommandResolver(corpus, null, client), decisionClient: client,
    mode: 'deterministic', clock,
    setup: { soniox: true, jev: { provider: 'openrouter', configured: true, detail: 'Synthetic decisions only' }, semantic: () => '' },
    overlayUrl: view => view,
  });
  const control: ControlServerMessage[] = [];
  session.onControl(message => control.push(message));
  session.handle({ type: 'goto', key: '18:10' });
  session.handle({ type: 'capture', captureEpoch: 1, event: 'starting' });
  session.handle({ type: 'capture', captureEpoch: 1, event: 'recording' });
  const initial = session.audienceDisplay;
  async function settle() {
    for (let i = 0; i < 20; i++) {
      await clock.advance(1);
      if (control.some(message => message.type === 'command_result' && !(message.result.kind === 'candidates' && message.result.refining))) return;
    }
    throw new Error('Synthetic command did not settle');
  }
  async function speak(text: string) {
    const tokens = text.split(' ').map((word, index) => ({ text: ` ${word}`, isFinal: true, startMs: index * 200, endMs: index * 200 + 150 }));
    tokens.push({ text: '<end>', isFinal: true, startMs: tokens.length * 200, endMs: tokens.length * 200 });
    session.handle({ type: 'transcript', captureEpoch: 1, seq: 0, tokens, receivedAt: clock.now() });
    await settle();
  }
  function result(): { requestId: string; result: CommandResult } {
    const message = control.findLast(message => message.type === 'command_result');
    if (message?.type !== 'command_result') throw new Error('No command result');
    return message;
  }
  return { session, speak, settle, result, initial, calls, corpus };
}

describe('spoken private search keeps publication authority private', () => {
  it.each([
    ['uncertain show request', 'show the verse about the orphan', uncertainShow],
    ['confident find request', 'find the verse about the orphan', strong('SEARCH')],
    ['plain description', 'where Allah says do not oppress the orphan', strong('SEARCH')],
    ['locally parsed reference', 'Surah Al-Fil', strong('SEARCH')],
  ])('%s returns private cards without changing the audience', async (_scenario, text, probabilities) => {
    const h = setup(probabilities);
    try {
      await h.speak(text);
      expect(h.session.audienceDisplay.verse?.key).toBe('18:10');
      expect(h.result().result.kind).toBe('candidates');
      expect(h.session.audienceDisplay.style).toEqual(h.initial.style);
      expect(h.session.snapshot().held).toBe(false);
    } finally { h.session.dispose(); }
  });

  it.each(['English only', 'pause', 'hide'])('a private classification cannot apply "%s"', async text => {
    const h = setup(strong('SEARCH'));
    try {
      await h.speak(text);
      expect(h.session.audienceDisplay.style).toEqual(h.initial.style);
      expect(h.session.audienceDisplay.verse?.key).toBe('18:10');
      expect(h.session.audienceDisplay.visible).toBe(true);
      expect(h.session.snapshot().held).toBe(false);
      expect(h.result().result.kind).toBe('no_match');
    } finally { h.session.dispose(); }
  });

  it('Show on stream deliberately publishes a private result and pauses following', async () => {
    const h = setup(uncertainShow);
    try {
      await h.speak('show the verse about the orphan');
      const { requestId, result } = h.result();
      expect(h.session.audienceDisplay.verse?.key).toBe('18:10');
      if (result.kind !== 'candidates') throw new Error('No private cards');
      const key = result.confirmedKey!;
      expect(result.cards.some(card => card.key === key)).toBe(true);
      h.session.handle({ type: 'show_result', requestId, key });
      expect(h.session.audienceDisplay.verse?.key).toBe(key);
      expect(h.session.snapshot().held).toBe(true);
      expect(h.session.audienceDisplay.verse?.arabic).toBe(h.corpus.verse(key)!.arabicDisplay);
    } finally { h.session.dispose(); }
  });
});

describe('deliberate publication remains available', () => {
  it.each([
    ['SHOW', 'show the verse about the orphan', '93:9'],
    ['NAVIGATE', 'Surah Al-Fil', '105:1'],
  ])('%s still publishes its resolved source passage', async (route, text, key) => {
    const h = setup(strong(route));
    try {
      await h.speak(text);
      expect(h.session.audienceDisplay.verse?.key).toBe(key);
      expect(h.session.audienceDisplay.verse?.arabic).toBe(h.corpus.verse(key)!.arabicDisplay);
    } finally { h.session.dispose(); }
  });

  it('a confident CONTROL classification still changes display language', async () => {
    const h = setup(strong('CONTROL'));
    try {
      await h.speak('English only');
      expect(h.session.audienceDisplay.style.language).toBe('english');
    } finally { h.session.dispose(); }
  });

  it('typed meaning search stays private and typed exact references still navigate', async () => {
    const h = setup(strong('SEARCH'));
    try {
      h.session.handle({ type: 'command', requestId: 'typed-search', text: 'show the verse about the orphan', source: 'typed' });
      await h.settle();
      expect(h.result().result.kind).toBe('candidates');
      expect(h.session.audienceDisplay.verse?.key).toBe('18:10');
      expect(h.calls).toEqual(['passage,relevant']);
      h.session.handle({ type: 'command', requestId: 'typed-reference', text: '2:255', source: 'typed' });
      await h.settle();
      expect(h.session.audienceDisplay.verse?.key).toBe('2:255');
    } finally { h.session.dispose(); }
  });

  it('an explicit typed show request still publishes its source-owned match', async () => {
    const h = setup(strong('SEARCH'));
    try {
      h.session.handle({ type: 'command', requestId: 'reader-show', text: 'show the verse about the orphan', source: 'typed', show: true });
      await h.settle();
      expect(h.session.audienceDisplay.verse?.key).toBe('93:9');
      expect(h.calls).toEqual(['passage,relevant']);
    } finally { h.session.dispose(); }
  });
});
