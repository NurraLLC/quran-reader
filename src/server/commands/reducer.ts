// Resolve a parsed English command into a CommandResult. Exact references resolve locally and
// instantly; meaning search retrieves candidates from the full translation, then (optionally)
// JEV selects among those real passages. Results never publish by themselves.

import type { CommandResult, SearchCard } from '../../shared/contracts';
import type { Corpus } from '../corpus/load';
import { buildCommandChoice, buildSearchChoice, NO_ACTION, NO_MATCH } from '../providers/decisions';
import type { Decision, DecisionClient, Question } from '../providers/jev';
import { Bm25Index } from '../search/lexical';
import { reciprocalRankFusion } from '../search/rank';
import { ChapterNames } from '../search/references';
import type { SemanticRetriever } from '../search/semantic';
import type { ResourceCatalog } from '../resources/catalog';
import { parseIntent, type Intent } from './parse';
import type { Transliteration } from '../search/transliteration';

export const SEARCH_DEADLINE_MS = 2000;
export const HEDGE_MS = 700;
const LEXICAL_K = 30;
const SEMANTIC_K = 30;
const TO_JEV = 24;
const CARDS = 5;

export type SearchTrace = {
  lexical: number[];
  semantic: number[];
  fused: number[];
  jev: { outcome: string; latencyMs: number | null; choice: string | null };
};

/** Everyday English words: a query containing them is a meaning search, never a sound match. */
const ENGLISH_CUES = new Set(['about', 'and', 'is', 'in', 'for', 'when', 'who', 'what', 'which', 'are', 'was', 'were', 'be', 'not', 'his', 'her', 'their', 'they', 'you', 'your', 'we', 'our', 'god', 'lord', 'people', 'day', 'story', 'mercy', 'patience', 'prayer', 'says', 'said', 'tells', 'talks', 'mentions']);

export class CommandResolver {
  readonly names: ChapterNames;
  readonly bm25: Bm25Index;
  lastTrace: SearchTrace | null = null;

  constructor(
    readonly corpus: Corpus,
    private readonly semantic: SemanticRetriever | null,
    public client: DecisionClient | null,
    private readonly catalog: ResourceCatalog | null = null,
    /** Find an ayah by its sound in English letters ("inna fatahna"); optional resource. */
    private readonly sounds: Transliteration | null = null,
  ) {
    if (catalog?.topics) catalog.consume('qul:ayah-topics:45', 'search.retrieve');
    for (const [t, id] of [['juz', '68'], ['hizb', '67'], ['rub', '63'], ['manzil', '66']] as const) if (catalog?.divisions.has(t)) catalog.consume(`qul:quran-metadata:${id}`, 'navigation.divisions');
    this.names = new ChapterNames(corpus.data.chapters);
    this.bm25 = new Bm25Index(corpus.verses.map((v) => ({ verseIndex: v.index, source: 'english:primary', text: v.english })));
  }

  /**
   * User-triggered decisions only: if the first request has not answered within HEDGE_MS, send one
   * identical request; the first valid answer wins and the other is aborted. Bounded by the same
   * deadline. (OpenRouter Decisions intermittently stalled >10 s on 2026-09-28 while successful
   * calls took ~0.3 s; reproduced with curl.) Never used in the recitation loop.
   */
  private async evaluateHedged(state: unknown, questions: Record<string, Question>, signal?: AbortSignal): Promise<Decision> {
    const client = this.client!;
    const deadline = performance.now() + SEARCH_DEADLINE_MS;
    const ctrls: AbortController[] = [];
    const attempt = () => {
      const c = new AbortController();
      ctrls.push(c);
      signal?.addEventListener('abort', () => c.abort(), { once: true });
      return client.evaluate(state, questions, { timeoutMs: Math.max(50, deadline - performance.now()), signal: c.signal });
    };
    let hedge: ReturnType<typeof setTimeout> | undefined;
    let expire: ReturnType<typeof setTimeout> | undefined;
    try {
      return await new Promise<Decision>((resolve, reject) => {
        let pending = 1;
        let done = false;
        const finish = (fn: () => void) => {
          if (done) return;
          done = true;
          fn();
        };
        const settle = (p: Promise<Decision>) =>
          p.then(
            (d) => finish(() => resolve(d)),
            (e) => {
              const code = (e as { code?: string })?.code ?? '';
              // Only stalls and transient transport failures are worth a duplicate; never retry a
              // rate limit, credit, auth or validation failure.
              const transient = ['TIMEOUT', 'TRANSPORT_UNAVAILABLE', 'SERVICE_UNAVAILABLE'].includes(code);
              if (!transient) return finish(() => reject(e));
              if (--pending === 0 && !hedge) finish(() => reject(e));
            },
          );
        settle(attempt());
        hedge = setTimeout(() => {
          hedge = undefined;
          if (done) return;
          pending++;
          settle(attempt());
        }, HEDGE_MS);
        // The whole exchange is bounded here, whatever an individual client does with its timeout.
        expire = setTimeout(() => finish(() => reject(Object.assign(new Error('TIMEOUT'), { code: 'TIMEOUT' }))), Math.max(0, deadline - performance.now()));
        signal?.addEventListener('abort', () => finish(() => reject(Object.assign(new Error('CANCELLED'), { code: 'CANCELLED' }))), { once: true });
      });
    } finally {
      clearTimeout(hedge);
      clearTimeout(expire);
      for (const c of ctrls) c.abort();
    }
  }

  parse(text: string, currentSurah: number | null): Intent {
    return parseIntent(text, this.names, currentSurah);
  }

  card(index: number, foundBy: string[] = []): SearchCard {
    const v = this.corpus.at(index)!;
    return {
      key: v.key,
      surahName: this.corpus.chapter(v.surah)!.nameSimple,
      arabic: v.arabicDisplay,
      english: v.english,
      prevKey: index > 0 ? this.corpus.at(index - 1)!.key : null,
      nextKey: index < this.corpus.verses.length - 1 ? this.corpus.at(index + 1)!.key : null,
      foundBy,
    };
  }

  async resolve(text: string, currentIndex: number | null, signal?: AbortSignal, onPreliminary?: (r: CommandResult) => void): Promise<CommandResult> {
    const current = currentIndex !== null ? this.corpus.at(currentIndex)! : null;
    const intent = this.parse(text, current?.surah ?? null);
    switch (intent.kind) {
      case 'empty':
        return { kind: 'no_match', message: 'Type or say a reference (2:255, Surah Maryam ayah 3) or what the verse is about.' };
      case 'next':
      case 'previous': {
        if (currentIndex === null) return { kind: 'invalid_reference', message: 'Nothing is on screen yet, so there is no next or previous ayah.' };
        const to = currentIndex + (intent.kind === 'next' ? 1 : -1);
        const v = this.corpus.at(to);
        if (!v) return { kind: 'invalid_reference', message: intent.kind === 'next' ? 'That is the last ayah of the Quran.' : 'That is the first ayah of the Quran.' };
        return { kind: 'navigate', key: v.key, note: null };
      }
      case 'invalid_reference':
        return intent;
      case 'reference': {
        const ch = this.corpus.chapter(intent.surah)!;
        const ayah = intent.ayah ?? 1;
        const note = intent.ayah === null ? `Surah ${ch.nameSimple} starts at ${intent.surah}:1.`
          : intent.route === 'named_passage' ? `Named passage → ${intent.surah}:${ayah}.`
          : intent.route === 'position' ? `The ${intent.position ?? 'first'} ayah of Surah ${ch.nameSimple} is ${intent.surah}:${ayah}.`
          : null;
        return { kind: 'navigate', key: `${intent.surah}:${ayah}`, note };
      }
      case 'division': {
        const d = this.catalog?.division(intent.type, intent.number) ?? null;
        if (!d) {
          // The boundaries are a resource that is not imported on this server: say so plainly.
          return { kind: 'invalid_reference', message: `${intent.type[0].toUpperCase()}${intent.type.slice(1)} navigation isn’t available yet. Try a surah and ayah, like “Al-Kahf 10”.` };
        }
        const v = this.corpus.at(d.firstIndex)!;
        return { kind: 'navigate', key: v.key, note: `${intent.type[0].toUpperCase()}${intent.type.slice(1)} ${intent.number} starts at ${v.key}.` };
      }
      case 'ambiguous_chapter':
        return this.ambiguousChapter(text, intent, current?.key ?? null, signal);
      case 'search': {
        const bySound = this.byOpeningSound(intent.query);
        if (bySound) return bySound;
        if (intent.scope === 'surah') return this.surahSearch(intent.query, signal);
        return this.search(intent.query, signal, onPreliminary);
      }
      case 'control':
        return { kind: 'control', label: intent.action.label, style: intent.action.style ?? null, hold: intent.action.hold ?? null, blank: intent.action.blank ?? null };
    }
  }

  /** "Surah about X": the surahs of the best-matching ayahs, each opened at its first ayah. */
  private async surahSearch(query: string, signal?: AbortSignal): Promise<CommandResult> {
    const r = await this.search(query, signal);
    if (r.kind !== 'candidates') return r;
    // A surah named after the subject ("surah about Maryam", "... about the cave" = Al-Kahf) comes first.
    const named = this.names.match(query.replace(/^the\s+/i, '')).filter((m) => m.distance === 0).map((m) => m.number);
    const order = [...named.map((n) => `${n}:1`), ...(r.confirmedKey ? [r.confirmedKey] : []), ...r.cards.map((c) => c.key)];
    const surahs = [...new Set(order.map((k) => Number(k.split(':')[0])))].slice(0, 5);
    const cards = surahs.map((n) => this.card(this.corpus.verse(`${n}:1`)!.index, [`about ${query}`]));
    const best = named.length === 1 ? `${named[0]}:1` : r.confirmedKey ? `${r.confirmedKey.split(':')[0]}:1` : null;
    const name = best ? this.corpus.chapter(Number(best.split(':')[0]))!.nameSimple : null;
    return { ...r, query, cards, confirmedKey: best, status: name ? `Surah ${name} matches “${query}”.` : r.status };
  }

  /**
   * An ayah named by how it begins, in English letters. Only for queries that are not ordinary
   * English (a meaning search never jumps the screen). Only one exact opening navigates: a near
   * sound is a guess ("al baqarah" is a near sound of 2:256's opening), so near matches are offered.
   */
  private byOpeningSound(query: string): CommandResult | null {
    if (!this.sounds) return null;
    const words = query.toLowerCase().split(/[^a-z]+/).filter(Boolean);
    if (words.some((w) => ENGLISH_CUES.has(w))) return null;
    const m = this.sounds.match(query);
    if (!m.length) return null;
    const exact = m[0].distance === 0;
    if (exact && (m.length === 1 || m[1].distance > 0)) {
      const v = this.corpus.at(m[0].verseIndex)!;
      return { kind: 'navigate', key: v.key, note: `${v.key} begins with those words.` };
    }
    const cards = m.slice(0, 5).map((x) => this.card(x.verseIndex, ['how it sounds']));
    return { kind: 'candidates', route: 'search', query, cards, confirmedKey: null, status: exact ? 'These ayahs begin with those words.' : 'These ayahs begin with a similar sound. Choose one if it’s the one you meant.', refining: false };
  }

  private async ambiguousChapter(text: string, intent: Extract<Intent, { kind: 'ambiguous_chapter' }>, currentKey: string | null, signal?: AbortSignal): Promise<CommandResult> {
    const keys = intent.options.map((o) => {
      const count = this.corpus.chapter(o.number)!.verseCount;
      return `${o.number}:${intent.last ? count : Math.min(intent.ayah ?? 1, count)}`;
    });
    let confirmedKey: string | null = null;
    let status = 'Several surah names match; choose one.';
    if (this.client) {
      try {
        const actions = intent.options.map((o, i) => ({ id: `a${i}`, label: `Go to Surah ${o.name}`, description: `Show ${keys[i]}` }));
        const { state, questions } = buildCommandChoice(text, currentKey, actions);
        const d = await this.evaluateHedged(state, questions, signal);
        const a = d.answers.action;
        if (a?.type === 'choice' && !a.tied && a.choice !== NO_ACTION && (a.probabilities[a.choice] ?? 0) >= 0.9) {
          confirmedKey = keys[Number(a.choice.slice(1))] ?? null;
          status = 'JEV suggested one surah; confirm before showing.';
        }
      } catch {
        status = 'Several surah names match; JEV unavailable. Choose one.';
      }
    }
    const cards = keys.map((k) => this.card(this.corpus.verse(k)!.index));
    return { kind: 'candidates', route: 'chapter', query: text, cards, confirmedKey, status, refining: false };
  }

  async search(query: string, signal?: AbortSignal, onPreliminary?: (r: CommandResult) => void): Promise<CommandResult> {
    const lexical = this.bm25.search(query, LEXICAL_K);
    let semantic: Array<{ verseIndex: number }> = [];
    if (this.semantic?.ready) {
      try {
        semantic = await this.semantic.search(query, SEMANTIC_K);
      } catch {
        semantic = [];
      }
    }
    // Each retriever's best hit stays visible (an exact-wording match must not be out-voted by
    // passages both retrievers rank moderately); the rest follows reciprocal rank fusion.
    // Source-owned concepts: QUL topic names → their verse links (a third evidence channel).
    const topicHits = this.catalog?.topicCandidates(query, 3) ?? [];
    const topicVerses: Array<{ verseIndex: number }> = [];
    const topicOf = new Map<number, string>();
    for (const h of topicHits) for (const v of h.topic.verses) if (!topicOf.has(v)) {
      topicOf.set(v, h.topic.name);
      if (topicVerses.length < 30) topicVerses.push({ verseIndex: v });
    }
    const lists = [lexical, ...(semantic.length ? [semantic] : []), ...(topicVerses.length ? [topicVerses] : [])];
    const leaders = [...new Set(lists.map((l) => l[0]?.verseIndex).filter((v): v is number => v !== undefined))];
    const fused = [
      ...leaders.map((verseIndex) => ({ verseIndex, score: Infinity })),
      ...reciprocalRankFusion(lists).filter((f) => !leaders.includes(f.verseIndex)),
    ].slice(0, TO_JEV);
    const lexSet = new Set(lexical.map((h) => h.verseIndex));
    const semSet = new Set(semantic.map((h) => h.verseIndex));
    const foundBy = (v: number) => [
      ...(lexSet.has(v) ? ['translation wording'] : []),
      ...(semSet.has(v) ? ['meaning'] : []),
      ...(topicOf.has(v) ? [`topic “${topicOf.get(v)}”`] : []),
    ];
    const trace: SearchTrace = {
      lexical: lexical.map((h) => h.verseIndex),
      semantic: semantic.map((h) => h.verseIndex),
      fused: fused.map((h) => h.verseIndex),
      jev: { outcome: 'not_called', latencyMs: null, choice: null },
    };
    this.lastTrace = trace;
    if (!fused.length) return { kind: 'no_match', message: `No passages in the ${this.corpus.data.manifest.translation.name} translation matched “${query}”. Try different words or a reference.` };

    let order = fused.map((f) => f.verseIndex);
    let confirmedKey: string | null = null;
    const retrieval = [
      'translation wording',
      ...(this.semantic?.ready ? ['meaning'] : []),
      ...(this.catalog?.topics ? ['QUL topics'] : []),
    ].join(' + ') + ' retrieval' + (this.semantic?.ready ? '' : ' (semantic search not set up)');
    let status = `Unconfirmed ${retrieval}.`;
    if (this.client) {
      // Show retrieved cards immediately; JEV's choice (typically 1–2 s) refines them.
      onPreliminary?.({ kind: 'candidates', route: 'search', query, cards: order.slice(0, CARDS).map((i) => this.card(i, foundBy(i))), confirmedKey: null, status: 'Checking which passage fits best…', refining: true });
      const t0 = performance.now();
      try {
        const passages = order.map((i) => ({ key: this.corpus.at(i)!.key, english: this.corpus.at(i)!.english }));
        const { state, questions, kept } = buildSearchChoice(this.client.gateway, query, passages);
        const d = await this.evaluateHedged(state, questions, signal);
        const pick = d.answers.passage;
        const rel = d.answers.relevant;
        trace.jev = { outcome: 'answered', latencyMs: Math.round(performance.now() - t0), choice: pick?.type === 'choice' ? pick.choice : null };
        if (pick?.type === 'choice' && rel?.type === 'noul') {
          if (pick.choice === NO_MATCH || rel.noul < 0.5) {
            status = `JEV found no passage that directly matches; showing ${retrieval} results.`;
          } else if (!pick.tied) {
            const idx = order.indexOf(this.corpus.verse(kept[Number(pick.choice.slice(1))].key)!.index);
            if (idx >= 0) {
              // Keep the preliminary cards where they were (no card moves under the cursor); only a
              // choice outside the visible five is inserted at the top.
              const chosen = order[idx];
              if (!onPreliminary || idx >= CARDS) {
                order.splice(idx, 1);
                order = [chosen, ...order];
              }
              confirmedKey = this.corpus.at(chosen)!.key;
              status = `JEV selected ${confirmedKey} from ${kept.length} retrieved passages. Other passages may also be relevant.`;
            }
          }
        }
      } catch (e) {
        trace.jev = { outcome: (e as { code?: string }).code ?? 'error', latencyMs: Math.round(performance.now() - t0), choice: null };
        status = `JEV unavailable (${trace.jev.outcome}); ${status}`;
      }
    }
    return { kind: 'candidates', route: 'search', query, cards: order.slice(0, CARDS).map((i) => this.card(i, foundBy(i))), confirmedKey, status, refining: false };
  }
}
