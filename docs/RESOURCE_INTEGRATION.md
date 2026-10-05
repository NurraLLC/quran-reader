# Resource integration correction — Quran Overlay

Owner direction, 2026-09-28: organize QUL's data into capabilities the product actually consumes. The previous handoff described useful enrichment but made too much of its integration optional. A resource list, download folder or generic model adapter is not the completed data foundation.

This document updates the resource-integration part of the implementation brief. It does not replace the existing corpus, app, Moard lessons, or live-validation requirements. This is an audited specification, not a claim that the missing runtime paths have been built.

## Current evidence

Inspected application HEAD: `7227503ce7c4dafe8564bd4c53f52431cfde9f35` in `C:\QuranOverlay`. The working tree's pre-existing untracked AGENTS.md, CLAUDE.md and outputs/ are not task-owned staging targets.

The actual `corpus/sources.json` imports five inputs: Quran.com display text, search text, Saheeh English, QUL-derived chapter metadata and a QUL font. `CommandResolver` constructs BM25 from the primary English translation only. The tracker builds its own full-corpus word/bigram index. There is no runtime importer or lookup for QUL similar-ayah, mutashabihat, topics or themes. Local MiniLM retrieval is active but does not substitute for those authored relationships.

`RESOURCE_CAPABILITY_CATALOG.json` / `RESOURCE_CAPABILITY_MATRIX.csv` record all 14 categories, current source availability, runtime use, owning code and proof required. Homepage figures have different units: topic/phrase/word records are not counts of downloadable packages. They are separate from the 544 resource-detail pages archived earlier. [Current QUL catalog](https://qul.tarteel.ai/resources).

The current text corpus contains all 6,236 ayahs. Additional resources have independent coverage; a missing annotation must never make an ayah disappear or imply that its subject is absent from the Quran.

## The required foundation

Build one resource owner under `src/server/resources/`. It loads verified compiled artifacts once, handles joins and provenance internally, and serves the tracker, search and display. Avoid copying QUL's Rails CMS, introducing a graph database, or putting raw multi-megabyte resources in each JEV request.

Use a manifest for each selected resource version:

```ts
type ResourceVersion = {
  id: string;                 // e.g. qul:similar-ayah:74
  category: string;
  sourceUrl: string;
  downloadedAt: string;
  sha256: string;
  format: 'json' | 'sqlite' | 'csv' | 'font' | 'audio';
  narration: string | null;
  script: string | null;
  language: string | null;
  attribution: string;
  rightsEvidence: string | null;
  coverage: { rows: number; verseKeys: number; rejectedRows: number };
};
```

Track separate facts, not one ambiguous `ready` flag: catalogued, downloaded, validated, indexed, consumed by a named feature, and evaluated. Each stage needs an artifact or evidence path. A download does not prove compatibility; an index not read by a feature is not integration. Missing resources have a useful explicit status, not an empty successful response that hides the gap.

Canonical identity is `surah:ayah` for all 6,236 verses. A word identity also includes script/version and position; positions across Imlaei/QPC/Uthmani must not be assumed equal. Range records preserve source identity and all spans. Recording timestamps additionally require recording identity/version. Topic IDs, phrase IDs and Quran.com/QUL resource IDs remain separate namespaces.

Normalize JSON/SQLite/CSV imports into typed tables or compact JSON artifacts: verses, words, translations, phrase occurrences, similar-verse edges, topics, topic edges, topic-to-verse links, theme ranges, morphology, layouts and recording segments. Only build the tables for actual selected inputs. Reject invalid keys, dangling joins, impossible ranges, unknown narratives, mixed coordinate systems and malformed values; write a rejection/coverage report. Keep original downloaded bytes unchanged for reproduction.

The runtime interface should be small:

- `contextForVerse(key, purpose)` returns the source-owned data relevant to tracking, display or deliberate context lookup.
- `retrieve(query, scope)` returns candidates with the evidence/source that found each one.
- `status()` reports available coverage, input hashes and feature consumers.

Compile expensive indexes before the session. In-memory maps over this corpus are sufficient until measurement shows otherwise. Resource versions bind cache keys, tracker decisions and replay artifacts. No network fetch belongs in the live recitation loop.

## First integration: display integrity

Obtain full QPC-Hafs ayah text (initial selection QUL 86), matching word text (312) and the intended font (245), or another verified compatible complete pair. Source availability and current IDs must be checked at download time. Validate all 6,236 keys against the existing complete corpus before switching display sources.

Preserve the original Quran.com corpus as its own source, not a silently rewritten export. Validate semantic script correspondence separately from Unicode byte equality. The display conversion is a compatibility layer; a font's character coverage alone does not prove shaping. The former 52:37 placeholder circle is corrected by the native QPC-Hafs U+06DC plus fatha encoding, verified against Quran.com's public word and the actual loaded font (2026-10-05). Inspect all distinct Quranic marks in real words using that font, plus long-ayah pagination, basmala and disjoint letters. Retire the conversion only after the replacement is proven. Do not guess missing marks or choose a source merely because a filename looks compatible.

Word highlighting remains disabled where search-to-display mapping is unverified. Nevertheless, index verified word identities now so phrase ranges and future highlighting can use the same mapping owner.

## Second integration: ambiguity-aware following

Obtain the published [similar-ayah export](https://qul.tarteel.ai/resources/similar-ayah/74) and [mutashabihat export](https://qul.tarteel.ai/resources/mutashabihat/73). Import both, supplementing the complete corpus-derived collision map. The selected published release is preferable to rebuilding a release from old raw tables.

The inspected exporters matter:

- Similar-ayah JSON uses `verse_key -> entries[]`, including `matched_ayah_key`, counts, coverage, score and `match_words`. Ranges can be disjoint or singleton. SQLite encodes ranges in `match_words_range`.
- The phrase exporter writes `phrases.json` and `ayah-phrases.json`; tutorial filenames also use `phrase_verses.json`. Validate actual content rather than one hardcoded filename. Phrase objects contain `source` and an `ayah` map of word ranges.
- The raw CSV is not equivalent to the current published export. QUL's inspected exporter selects approved/new phrases, a minimum phrase length, multiple occurrences/verses, approved mappings, and additional parent/duplicate filtering. In the downloaded CSV 1,352 rows are both approved and `review_status=new` before the remaining filters. Do not simply load all 16,164 raw phrases or copy their word positions onto Imlaei tokens.

Build the following indexes once:

1. Complete exact phrase occurrences derived from the full normalized corpus, preserving all collisions and the normalization version.
2. Curated near-match edges and phrase occurrences from validated QUL resources, with source/version and coordinate mapping.
3. For a set of competing occurrences, the differing words/ranges and observed continuation required to separate them. This is conditional on the hypotheses: an unseen jump can always introduce another candidate.

Integrate in `tracker/candidates.ts` before shortlist truncation: consider neighbors of the confirmed/current candidate and of strong global candidates. The local path, best global hypothesis and plausible twins must remain represented. Keep a bounded compute budget and report truncation; the absence of a twin from a capped shortlist is not proof of uniqueness. Do not let semantic similarity alone authorize a recitation transition.

Then repair `TrackerEngine.revalidate` coherently with `decide`. It currently rebuilds around a proposed pseudo-anchor and rejects a competing textual/score twin. It must consider the real confirmed/manual anchor, recent evidence, capture epoch and fresh evidence supporting a jump. A decision cannot resolve truly indistinguishable unknown-start audio; supported continuity can distinguish paths. Use the same rule for deterministic and JEV-assisted decisions so one mode does not discard context another mode trusts.

Give JEV compact evidence: observed tokens, validated recent location, competing source texts, matched/differing spans, relevant chronology and WAIT. Do not treat a QUL similarity score as ASR confidence or the probability that an ayah was spoken. Do not ask the model to invent missing location information.

Required comparisons: unknown start with a common opening; repeated 55:13 refrain with and without an anchor; 3:2 versus the shared opening of 2:255; near-identical passages with one distinguishing word; deliberate distant jumps; self-correction; ASR deleting that distinguishing word; and old model answers arriving after manual navigation. Add resource-derived cases beyond the hand-picked existing 19 fixtures.

Report wrong displays, verses shown/missed, time uncertain, recovery, candidate recall, calls and compute cost. Zero wrong displays with more missed ayahs is a tradeoff, not an automatic improvement. Run with enrichment off/on using the same streams, then repeat on real speech. Do not silently relax thresholds to make a resource look useful.

## Third integration: English and Arabic discovery

Import the [topic taxonomy](https://qul.tarteel.ai/resources/ayah-topics/45) and [theme ranges](https://qul.tarteel.ai/resources/ayah-theme/62), then a deliberate selection of compatible morphology, alternative English translation and word-translation data. These are required resource integration tasks for the richer search feature; they are not just an ideas backlog.

Topic export details from source: `topic_id`, English/Arabic names, descriptions, parent/thematic/ontology parents, related topics and ayah references. Some serialized fields are comma-separated. Parse to typed edges and validate every join; do not flatten parent/child/related links into equivalent meanings. Theme entries describe ayah ranges. An internal verse ID from a raw table must have a verified ID-to-key mapping; never assume it is an ayah number.

Search combines four evidence channels: exact references/names; translation wording; source-owned concepts/entities and their verse links; and optional semantic retrieval. Roots/lemmas/word glosses can expand candidate retrieval but are not interchangeable words in the live follower. Alternative translations index under the same canonical verse key while display uses the selected source.

JEV can select a topic among a short retrieved set, or rerank resulting source passages. Do not add a mandatory serial topic call for exact references or obvious lexical results. Compare direct retrieval versus topic-assisted routing on latency and relevance. Keep the full-corpus lexical/semantic fallback because QUL annotation coverage is not necessarily exhaustive.

Use illustrative cases such as English/Arabic names of prophets, everyday wording for parents/kindness, patience, and similar vocabulary with different moral context. Measure which channel supplied the right candidate; specifically test cases where word overlap retrieves a verse that mentions parents but is not about treating them kindly. Candidate recall alone is not visible-card relevance. Freeze a new untouched evaluation set because the previous held-out split influenced the fusion rule.

The 50-topic/five-theme dev sample is unsuitable for claiming full topic integration. If the published exports are unavailable, ship the importer and fixture proof, mark that input missing, and preserve current search. Do not silently replace resource data with generated topical claims.

## Remaining categories have explicit jobs

| Resource | Consumer | Execution rule |
|---|---|---|
| Juz/hizb/rub/manzil metadata | Structured navigation and confirmed session markers | Code resolves boundaries from selected metadata; JEV may interpret a bounded request. |
| Surah information | Alias lookup and broadcaster-requested chapter context | Preserve language/source and distinguish names from descriptive content. |
| Transliteration | Remembered Latin-script Arabic search and optional reading assistance | Separate retrieval evidence from acoustic evidence. |
| Mushaf layouts | Optional page-faithful renderer | Use approved layout plus the exact compatible script/font; no forced complexity in the overlay. |
| Recitations/segments | Known-recording playback and labeled test material | Bind timestamps to recording hash and actual playback clock; no reuse for an unknown live voice. |
| Tafsir | Deliberate context view or audience companion | Correct author, reference/range and excerpt boundaries; never automatic commentary over recitation. |
| Additional languages | Audience translation selection | Import complete selected corpora, deduplicate identities and keep Arabic reference fixed. |

Account for every category in the catalog now; activate it when its consumer is implemented and verified. This preserves the simple audience surface while making the underlying data reusable. It does not require downloading every audio file, loading every language into RAM or exposing every resource as a button.

## Implementation order and closure

1. Add resource manifests/import validation and an inspectable coverage report. Include source hashes and current active versions.
2. Complete the compatible Arabic text/font path and word-coordinate owner.
3. Import phrase/similar resources, connect candidate generation and contextual revalidation, and evaluate both missed and wrong transitions.
4. Import concept/theme/search enrichments, connect them to real retrieval and compare against the existing baseline.
5. Add selected optional display/playback/context consumers without burdening the recitation loop.

For each completed slice, record **input → validated coverage → built index → actual caller → changed behavior → measured result** in `docs/REUSE_NOTES.md` or the owning evaluation. Add resource capability status to the control-side setup report, not the audience overlay. The absence of an optional source should be visible to the developer/broadcaster without misrepresenting the complete Quran text as incomplete.

Do not close this work with a manifest and unused loader. A source is integrated only when a real feature consumes it and an appropriate behavioral check proves the connection. Conversely, do not call every resource indispensable to every request. Source relationships improve the choices available to the product; they do not remove the need for sufficient spoken evidence.

Moard remains the procedural foundation: bounded typed decisions, relevant executable candidates, current context, immutable evidence binding, no redundant network work, and honest source/provider/rendered proof. Retain the existing `MOARD_REUSE_GUIDE.md` route. No new generative model or graph infrastructure is implied by this correction.
