import { describe, expect, it } from 'vitest';
import { CommandResolver } from '../../src/server/commands/reducer';
import { parseNumberAt } from '../../src/server/search/references';
import { Transliteration } from '../../src/server/search/transliteration';
import { fullCorpus } from '../helpers';

const resolver = () => new CommandResolver(fullCorpus().corpus, null, null);

describe('English numbers', () => {
  it.each([
    ['two hundred fifty five', 255],
    ['two hundred and fifty five', 255],
    ['two fifty five', 255],
    ['one hundred', 100],
    ['forty two', 42],
    ['third', 3],
    ['286', 286],
  ])('%s → %i', (text, n) => {
    expect(parseNumberAt(text.split(' '), 0)?.value).toBe(n);
  });
});

describe('command intents (local, deterministic)', () => {
  const r = resolver();
  const cases: Array<[string, string, number | null]> = [
    ['2:255', 'reference', null],
    ['surah two verse two hundred fifty-five', 'reference', null],
    ['Surah Maryam ayah 3', 'reference', null],
    ['go to surah yaseen', 'reference', null],
    ['al kahf verse 10', 'reference', null],
    ['baqarah 255', 'reference', null],
    ['chapter 36', 'reference', null],
    ['ayat al kursi', 'reference', null],
    ['next', 'next', null],
    ['go back', 'previous', null],
    ['verse 5', 'reference', 19],
    ['surah 115', 'invalid_reference', null],
    ['surah al fatihah verse 9', 'invalid_reference', null],
    ['verse 5', 'invalid_reference', null],
    ['be kind to your parents', 'search', null],
    ['let us pause and reflect on this for a moment', 'search', null],
  ];
  it.each(cases)('%s → %s', (text, kind, current) => {
    expect(r.parse(text, current).kind).toBe(kind);
  });

  it('resolves names and numbers to the exact validated reference', async () => {
    const want: Array<[string, string]> = [
      ['surah two verse two hundred fifty-five', '2:255'],
      ['Surah Maryam ayah 3', '19:3'],
      ['go to surah yaseen', '36:1'],
      ['al kahf verse 10', '18:10'],
      ['baqarah two eight two', '2:282'],
      ['ayatul kursi', '2:255'],
    ];
    for (const [text, key] of want) {
      const res = await r.resolve(text, null);
      expect(res, text).toMatchObject({ kind: 'navigate', key });
    }
    expect(await r.resolve('surah yaseen', null)).toMatchObject({ note: expect.stringContaining('starts at 36:1') });
  });

  it('next/previous cross chapter boundaries in canonical order', async () => {
    const { corpus } = fullCorpus();
    expect(await r.resolve('next', corpus.verse('1:7')!.index)).toMatchObject({ key: '2:1' });
    expect(await r.resolve('previous', corpus.verse('2:1')!.index)).toMatchObject({ key: '1:7' });
    expect(await r.resolve('next', corpus.verse('114:6')!.index)).toMatchObject({ kind: 'invalid_reference' });
  });

  it('meaning search returns corpus-owned cards (never a navigation) and stays unconfirmed without JEV', async () => {
    const res = await r.resolve('no soul is burdened beyond its capacity', null);
    expect(res.kind).toBe('candidates');
    if (res.kind !== 'candidates') return;
    expect(res.confirmedKey).toBeNull();
    expect(res.cards.length).toBeGreaterThan(0);
    expect(res.cards.map((c) => c.key)).toContain('2:286');
    const { corpus } = fullCorpus();
    for (const c of res.cards) expect(c.english).toBe(corpus.verse(c.key)!.english);
  });
});

describe('a surah name followed by an ayah number opens that ayah', () => {
  const r = resolver();
  it.each([
    ['Kahf 10', '18:10'],
    ['Al-Kahf 10', '18:10'],
    ['Maryam 3', '19:3'],
    ['Baqarah 286', '2:286'],
    ['baqarah 255', '2:255'],
    ['Rahman 13', '55:13'],
    ['Ya-Sin 12', '36:12'],
    ['Al Imran 190', '3:190'],
    ['al kahf verse 10', '18:10'],
    ['kahf ten', '18:10'],
  ])('%s → %s', async (text, key) => {
    expect(await r.resolve(text, null)).toMatchObject({ kind: 'navigate', key, note: null });
  });

  it('a name alone opens the surah and says where it starts', async () => {
    expect(await r.resolve('yaseen', null)).toMatchObject({ kind: 'navigate', key: '36:1', note: 'Surah Ya-Sin starts at 36:1.' });
  });
});

describe('the first or last ayah of a surah', () => {
  const { corpus } = fullCorpus();
  const r = new CommandResolver(corpus, null, null, null, Transliteration.load(corpus));
  it.each([
    ['last ayah of Al-Baqarah', '2:286'],
    ['the last verse of surah baqarah', '2:286'],
    ['go to the final ayah of al kahf', '18:110'],
    ['end of surah Al-Kahf', '18:110'],
    ['first ayah of Al-Mulk', '67:1'],
    ['beginning of Maryam', '19:1'],
  ])('%s → %s', async (text, key) => {
    expect(await r.resolve(text, null)).toMatchObject({ kind: 'navigate', key });
  });

  it('says what it understood', async () => {
    expect(await r.resolve('last ayah of Al-Baqarah', null)).toMatchObject({ note: 'The last ayah of Surah Al-Baqarah is 2:286.' });
    expect(await r.resolve('verse of al baqarah', null)).toMatchObject({ kind: 'navigate', key: '2:1', note: 'Surah Al-Baqarah starts at 2:1.' });
  });

  it('offers each surah when the name is unclear, at its last ayah', async () => {
    const res = await r.resolve('last ayah of surah fatih', null);
    expect(res.kind).toBe('candidates');
    if (res.kind === 'candidates') expect(res.cards.map((c) => c.key).sort()).toEqual(['1:7', '35:45', '48:29']);
  });
});

describe.skipIf(!Transliteration.load(fullCorpus().corpus))('ayahs named by how they sound', () => {
  const { corpus } = fullCorpus();
  const r = new CommandResolver(corpus, null, null, null, Transliteration.load(corpus));
  it('jumps only on an exact opening; a near sound is offered as a choice, never shown on its own', async () => {
    expect(await r.resolve('go to inna fatahna', null)).toMatchObject({ kind: 'navigate', key: '48:1' });
    expect(await r.resolve('Bismillahirrahmanirrahim', null)).toMatchObject({ kind: 'navigate', key: '1:1' });
    // "al baqarah" sounds like the opening of 2:256 (lā ikrāha) to the consonant matcher: one near match.
    const near = await r.resolve('ayah about al baqarah', null);
    expect(near.kind).toBe('candidates');
    if (near.kind === 'candidates') {
      expect(near.confirmedKey).toBeNull();
      expect(near.status).not.toContain('begins with those words');
    }
  });
});

describe('spoken requests from real sessions', () => {
  const r = resolver();
  const intent = (text: string) => r.parse(text, null);

  it('turns display requests into settings, and only those', () => {
    expect(intent('Go full English only mode')).toMatchObject({ kind: 'control', action: { style: { language: 'english' } } });
    expect(intent('arabic only mode')).toMatchObject({ kind: 'control', action: { style: { language: 'arabic' } } });
    expect(intent('switch to arabic and english')).toMatchObject({ kind: 'control', action: { style: { language: 'both' } } });
    expect(intent('hide the translation')).toMatchObject({ kind: 'control', action: { style: { language: 'arabic' } } });
    expect(intent('word by word')).toMatchObject({ kind: 'control', action: { style: { readingMode: 'word' } } });
    expect(intent('full ayah')).toMatchObject({ kind: 'control', action: { style: { readingMode: 'ayah' } } });
    expect(intent('pause')).toMatchObject({ kind: 'control', action: { hold: true } });
    expect(intent('hide')).toMatchObject({ kind: 'control', action: { blank: true } });
    expect(intent('the ayah about english speakers').kind).toBe('search');
    expect(intent('show me the verse about hiding').kind).toBe('search');
  });

  it('treats "surah about ..." / "ayah about ..." as finding a surah / an ayah, not a surah name', () => {
    expect(intent('Surah about patience')).toEqual({ kind: 'search', query: 'patience', scope: 'surah' });
    expect(intent('the surah about elephants')).toEqual({ kind: 'search', query: 'elephants', scope: 'surah' });
    expect(intent('ayah about the orphan')).toEqual({ kind: 'search', query: 'the orphan', scope: 'ayah' });
  });

  it('never guesses between close surah names ("Fatih": Al-Fath, Fatir, Al-Fatihah)', () => {
    const i = intent('Go to Surah Fatih.');
    expect(i.kind).toBe('ambiguous_chapter');
    if (i.kind === 'ambiguous_chapter') expect(i.options.map((o) => o.number).sort((a, b) => a - b)).toEqual([1, 35, 48]);
    expect(intent('Go to Surah Fath')).toMatchObject({ kind: 'reference', surah: 48 });
    expect(intent('surah Yaseen')).toMatchObject({ kind: 'reference', surah: 36 });
  });
});
