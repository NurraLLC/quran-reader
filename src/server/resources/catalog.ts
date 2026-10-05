// The single runtime owner of Quran resource relationships. Loads verified compiled artifacts once
// (data/processed/resources, built by `npm run resources:import`) plus the complete corpus-derived
// phrase index, and serves the tracker (collision neighbours), search (topics/themes), navigation
// (juz/hizb/rub/manzil) and the control-side status report. Nothing here fetches from the network.
// A missing resource is reported as missing; it never removes the full-corpus fallbacks.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Corpus } from '../corpus/load';
import { PROCESSED_DIR, ROOT } from '../corpus/manifest';
import type { CorpusIndex } from '../tracker/index';
import { englishTerms } from '../search/lexical';
import type { Division, Imported, Phrase, SimilarEdge, Theme, Topic } from './importers';
import { buildPhraseIndex, type PhraseIndex } from './phrases';
import type { ResourceStatus } from './types';

export const RESOURCE_DIR = path.join(PROCESSED_DIR, 'resources');
export const LOCK_FILE = path.join(ROOT, 'corpus', 'resources.lock.json');
const CATALOG_FILE = path.join(ROOT, 'corpus', 'resource-catalog.json');

export type LockEntry = {
  id: string;
  category: string;
  title: string;
  kind: string;
  sourceUrl: string;
  file: string;
  sha256: string;
  bytes: number;
  downloadedAt: string;
  importedAt: string;
  format: string;
  coverage: { rows: number; verseKeys: number; rejectedRows: number };
  notes: string[];
  rightsEvidence: string | null;
};

export function artifactPath(resourceId: string) {
  return path.join(RESOURCE_DIR, `${resourceId.replace(/[^a-z0-9]+/gi, '_')}.json`);
}

function loadArtifact<T>(resourceId: string): Imported<T> | null {
  const f = artifactPath(resourceId);
  if (!existsSync(f)) return null;
  try {
    return JSON.parse(readFileSync(f, 'utf8')) as Imported<T>;
  } catch {
    return null;
  }
}

export type TopicHit = { topic: Topic; score: number };

export class ResourceCatalog {
  readonly phrases: PhraseIndex;
  readonly similar: SimilarEdge[] | null;
  readonly mutashabihat: Phrase[] | null;
  readonly topics: Topic[] | null;
  readonly themes: Theme[] | null;
  readonly divisions: Map<Division['type'], Division[]> = new Map();
  readonly lock: LockEntry[];
  private readonly consumers = new Map<string, Set<string>>();
  private readonly neighbourCache = new Map<number, number[]>();
  private readonly similarBy = new Map<number, SimilarEdge[]>();
  private readonly phrasesBy = new Map<number, Phrase[]>();
  private readonly topicTerms: Array<{ topic: Topic; terms: Set<string> }> = [];
  private readonly topicsByVerse = new Map<number, Topic[]>();
  private readonly themeByVerse = new Map<number, Theme>();
  enrichment = true;

  constructor(
    readonly corpus: Corpus,
    readonly ix: CorpusIndex,
  ) {
    this.phrases = buildPhraseIndex(ix);
    this.lock = existsSync(LOCK_FILE) ? (JSON.parse(readFileSync(LOCK_FILE, 'utf8')) as { entries: LockEntry[] }).entries : [];
    this.similar = loadArtifact<{ edges: SimilarEdge[] }>('qul:similar-ayah:74')?.data.edges ?? null;
    this.mutashabihat = loadArtifact<{ phrases: Phrase[] }>('qul:mutashabihat:73')?.data.phrases ?? null;
    this.topics = loadArtifact<{ topics: Topic[] }>('qul:ayah-topics:45')?.data.topics ?? null;
    this.themes = loadArtifact<{ themes: Theme[] }>('qul:ayah-theme:62')?.data.themes ?? null;
    for (const id of ['68', '67', '63', '66']) {
      const d = loadArtifact<{ divisions: Division[] }>(`qul:quran-metadata:${id}`)?.data.divisions;
      if (d?.length) this.divisions.set(d[0].type, d);
    }
    for (const e of this.similar ?? []) (this.similarBy.get(e.from) ?? this.similarBy.set(e.from, []).get(e.from)!).push(e);
    for (const p of this.mutashabihat ?? []) for (const o of p.occurrences) (this.phrasesBy.get(o.verse) ?? this.phrasesBy.set(o.verse, []).get(o.verse)!).push(p);
    for (const t of this.topics ?? []) {
      this.topicTerms.push({ topic: t, terms: new Set(englishTerms(`${t.name} ${t.description.split(/[.;]/)[0] ?? ''}`)) });
      for (const v of t.verses) (this.topicsByVerse.get(v) ?? this.topicsByVerse.set(v, []).get(v)!).push(t);
    }
    for (const th of this.themes ?? []) for (let i = th.firstIndex; i <= th.lastIndex; i++) this.themeByVerse.set(i, th);
  }

  /** Record that a named feature reads a resource (reported in status()). */
  consume(resourceId: string, feature: string) {
    (this.consumers.get(resourceId) ?? this.consumers.set(resourceId, new Set()).get(resourceId)!).add(feature);
  }

  /**
   * Extra candidate regions for the tracker: curated QUL near-matches (similar ayahs, mutashabihat)
   * that exact-text seeds cannot find. Exact shared phrases are deliberately excluded: the
   * full-corpus seeds already find them, and aligning them again doubled tracker compute with no
   * behavioural change (docs/BENCHMARK.md, 51 fixtures × enrichment on/off). They remain decision
   * evidence via relationSources(). Strengths are relationship strengths, never spoken probabilities.
   */
  neighbours = (verseIndex: number): readonly number[] => {
    if (!this.enrichment) return [];
    const cached = this.neighbourCache.get(verseIndex);
    if (cached) return cached;
    const score = new Map<number, number>();
    for (const e of this.similarBy.get(verseIndex) ?? []) score.set(e.to, (score.get(e.to) ?? 0) + 1 + e.score / 100);
    for (const p of this.phrasesBy.get(verseIndex) ?? []) for (const o of p.occurrences) if (o.verse !== verseIndex) score.set(o.verse, (score.get(o.verse) ?? 0) + 1);
    const out = [...score.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([v]) => v);
    this.neighbourCache.set(verseIndex, out);
    return out;
  };

  /** Which sources relate two verses (for decision evidence and the control panel). */
  relationSources(a: number, b: number): string[] {
    const out: string[] = [];
    if (this.phrases.neighbours.get(a)?.has(b)) out.push('shares exact phrases');
    if (this.similarBy.get(a)?.some((e) => e.to === b)) out.push('QUL similar ayah');
    if (this.phrasesBy.get(a)?.some((p) => p.occurrences.some((o) => o.verse === b))) out.push('QUL mutashabihat phrase');
    return out;
  }

  /** Topic retrieval over source-owned topic names; returns topics with their verse links. */
  topicCandidates(query: string, k = 5): TopicHit[] {
    if (!this.topics || !this.enrichment) return [];
    const q = new Set(englishTerms(query));
    if (!q.size) return [];
    const hits: TopicHit[] = [];
    for (const { topic, terms } of this.topicTerms) {
      let s = 0;
      for (const t of q) if (terms.has(t)) s++;
      if (s) hits.push({ topic, score: s / Math.sqrt(terms.size || 1) });
    }
    return hits.sort((a, b) => b.score - a.score || b.topic.verses.length - a.topic.verses.length).slice(0, k);
  }

  topicsForVerse(v: number) {
    return this.topicsByVerse.get(v) ?? [];
  }

  themeForVerse(v: number) {
    return this.themeByVerse.get(v) ?? null;
  }

  division(type: Division['type'], n: number): Division | null {
    return this.divisions.get(type)?.find((d) => d.number === n) ?? null;
  }

  status(): ResourceStatus[] {
    const catalog = existsSync(CATALOG_FILE) ? (JSON.parse(readFileSync(CATALOG_FILE, 'utf8')) as { resources: Array<{ category: string; initial_selection: string }> }).resources : [];
    const out: ResourceStatus[] = [];
    const lockFor = (id: string) => this.lock.find((l) => l.id === id) ?? null;
    const row = (id: string, category: string, title: string, indexed: boolean, note: string | null, evaluated: string | null = null): ResourceStatus => {
      const l = lockFor(id);
      return {
        id,
        category,
        title,
        stage: { catalogued: true, downloaded: !!l, validated: !!l, indexed, consumers: [...(this.consumers.get(id) ?? [])], evaluated },
        coverage: l?.coverage ?? null,
        sha256: l?.sha256 ?? null,
        note,
      };
    };
    // Core corpus sources (corpus/sources.json): complete, validated and in use.
    const role: Record<string, { category: string; consumers: string[]; title: string }> = {
      arabicDisplay: { category: 'quran-script', consumers: ['display'], title: 'Uthmani ayah text (display)' },
      arabicSearch: { category: 'quran-script', consumers: ['tracker', 'search'], title: 'Imlaei ayah text (recognition/search)' },
      english: { category: 'translation', consumers: ['display', 'search'], title: 'English translation' },
      chapters: { category: 'quran-metadata', consumers: ['navigation', 'display'], title: 'Surah names and verse counts' },
      font: { category: 'font', consumers: ['display'], title: 'Arabic display font' },
    };
    for (const src of this.corpus.data.manifest.sourceFiles) {
      const r = role[src.role];
      if (!r) continue;
      out.push({
        id: src.sourceResourceId ?? src.sourceUrl,
        category: r.category,
        title: `${r.title}: ${src.displayName ?? src.sourceResourceId ?? path.basename(src.path)}`,
        stage: { catalogued: true, downloaded: true, validated: true, indexed: true, consumers: r.consumers, evaluated: null },
        coverage: src.role === 'font' ? null : { rows: this.corpus.verses.length, verseKeys: this.corpus.verses.length, rejectedRows: 0 },
        sha256: src.sha256,
        note: src.role === 'arabicDisplay' ? 'Rendered through a documented re-encoding for the Hafs font; the source text is preserved.' : src.licenseStatus,
      });
    }
    out.push({
      id: this.phrases.id,
      category: 'similar-ayah',
      title: 'Exact shared phrases (derived from the full corpus)',
      stage: { catalogued: true, downloaded: true, validated: true, indexed: true, consumers: [...(this.consumers.get(this.phrases.id) ?? [])], evaluated: 'docs/BENCHMARK.md' },
      coverage: { rows: this.phrases.sharedPhrases, verseKeys: this.phrases.versesWithCollisions, rejectedRows: 0 },
      sha256: null,
      note: `Complete for exact text; ${this.phrases.versesWithCollisions} ayahs share a 4-word phrase with another ayah.`,
    });
    out.push(row('qul:similar-ayah:74', 'similar-ayah', 'Similar Ayah', !!this.similar, this.similar ? null : 'Not imported: download the json from QUL (login required) into data/inbox.'));
    out.push(row('qul:mutashabihat:73', 'mutashabihat', 'Mutashabihat phrases', !!this.mutashabihat, this.mutashabihat ? null : 'Not imported: download the json from QUL into data/inbox.'));
    out.push(row('qul:ayah-topics:45', 'ayah-topics', 'Topics', !!this.topics, this.topics ? null : 'Not imported: download the sqlite from QUL into data/inbox.'));
    out.push(row('qul:ayah-theme:62', 'ayah-theme', 'Ayah themes', !!this.themes, this.themes ? null : 'Not imported: download the sqlite from QUL into data/inbox.'));
    for (const [t, id] of [['juz', '68'], ['hizb', '67'], ['rub', '63'], ['manzil', '66']] as const) {
      out.push(row(`qul:quran-metadata:${id}`, 'quran-metadata', `${t} boundaries`, this.divisions.has(t), this.divisions.has(t) ? null : 'Not imported.'));
    }
    out.push(row('qul:quran-script:86', 'quran-script', 'QPC Hafs ayah text', existsSync(artifactPath('qul:quran-script:86')), 'Display switch requires a full rendering review; the current display uses the documented re-encoding.'));
    out.push(row('qul:quran-script:312', 'quran-script', 'QPC Hafs word text', existsSync(artifactPath('qul:quran-script:312')), 'Word coordinates for phrase ranges and future highlighting.'));
    const covered = new Set(out.filter((o) => o.stage.consumers.length || o.stage.indexed || o.note?.startsWith('Not imported')).map((o) => o.category));
    for (const c of catalog) {
      if (covered.has(c.category)) continue;
      out.push({ id: c.initial_selection, category: c.category, title: c.category, stage: { catalogued: true, downloaded: false, validated: false, indexed: false, consumers: [], evaluated: null }, coverage: null, sha256: null, note: 'Catalogued; no consumer implemented yet.' });
    }
    return out;
  }
}
