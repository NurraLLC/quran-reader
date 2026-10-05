# Quran Reader

<a href="https://nurra.org"><img src="docs/nurra-badge.svg" height="22" alt="Nurra"></a> A [Nurra](https://nurra.org) project.

**Recite, and the page follows along.** Open it, tap the microphone and recite any surah: the ayah you are reciting appears in large Uthmani script with the English translation, the word you are on lights up with its meaning underneath, and the page moves with you. Talk to it in plain English: "go to Surah Maryam, ayah three", "surah about elephants", "show the ayah about the orphan", "English only".

It works as a personal reader on your phone or computer, and as an OBS/Twitch overlay for streamed recitation. All **6,236 ayahs in all 114 surahs**, validated against the Hafs verse map. It never generates scripture, translation or commentary.

<p>
  <img src="docs/screenshots/overlay-passage-word-meaning.webp" width="62%" alt="Short ayahs of Ad-Duha shown together as one passage, the recited word highlighted with its meaning 'than' underneath">
  <img src="docs/screenshots/reader-phone-following.webp" width="21%" alt="The phone reader following Al-Mulk, the recited word 'fatigued' labelled under the Arabic">
</p>

## What it does

- **Follows recitation as you read.** Word-by-word highlighting, a heads-up at the end of an ayah, and the next ayah waiting dimmed below. The existing replay covers 805 ayahs with zero wrong displays. Within an ayah the highlight keeps pace with you rather than trailing the recogniser: replaying recorded owner sessions, a word lights up a median 0.1 s after it begins (it was 0.9 s), and it waits while you take a breath. Earlier direct-stream microphone tests measured a median 0.9–1.0 s from ayah start to display; the new hosted relay still needs its own live latency measurement.
- **Understands how people actually recite.** Going back a few words after a breath, speech-recognition word splits ("ولا الآخرة" for "وللآخرة"), a basmala before a surah, one-word openings ("والضحى", "يس"), plainly read (unmelodic) recitation, and ayahs named by their sound in English letters ("go to inna fatahna").
- **Talk to it.** English requests are recognised while you recite and never disturb following: references, surah names (asking when names are close, never guessing), natural-language finding ("surah about elephants" opens Al-Fil), and display commands ("Arabic only", "word by word", "pause", "hide").
- **Reads beautifully.** Short ayahs share the screen as one mushaf-style passage; long ayahs are paged, never shrunk; Arabic + English, Arabic only, or English only; word-by-word meanings; ornaments, reduced-motion support; legible over dark and mid-tone stream footage, and over bright footage with the shaded panel (transparent text cannot stay readable on white).
- **Free for everyone, through sadaqah.** On the hosted site (nurra.org/quran-reader) listening is paid for by a pool of sponsored hours that donations fill, shown live on the start page; reading and search are always free, and *Why we built this* (`/about`) explains the costs and where sadaqah goes. Run it yourself with your own keys, unlimited (see [docs/DEPLOY.md](docs/DEPLOY.md)).
- **Made for streams.** Choose a reading, stream-caption or Arabic-only look, then adjust Arabic and English sizes separately, put captions at the top or bottom, move them away from the edge, and adjust the panel shading. Transparent, shaded or solid backgrounds, your own highlight colour, and an optional "Quran Overlay by Nurra" credit. Preview and OBS share the same renderer; hosted and self-hosted looks survive server restarts.
- **Charity streams.** A full stream scene in Nurra's colours: the reader in a framed panel, a window for your camera (or VTuber), what the donations are for, the total raised, a QR code to give, and each donation announced on stream: "May Allah accept Aisha's donation".

<p>
  <img src="docs/screenshots/overlay-english-passage.webp" width="49%" alt="English-only mode: Al-Ikhlas as an English passage with ayah ornaments, the current ayah bright">
  <img src="docs/screenshots/overlay-transparent-over-footage.webp" width="49%" alt="Transparent overlay over bright stream footage, with the next ayah previewed below">
</p>

## Run it yourself

Requires Node 22.13+ (developed on Node 24) and Chrome or Edge.

```bash
npm install
```

```bash
npm run corpus:fetch
```

```bash
npm run corpus:import -- --manifest corpus/sources.json
```

```bash
npm run wbw:import
```

```bash
npm run build
```

```bash
npm start
```

`corpus:fetch` downloads the Quran text, translation, chapter table and font from their public sources and refuses any file that does not match the SHA-256 pinned in `corpus/sources.json`; `corpus:import` builds and validates the corpus (25 checks); `wbw:import` adds word-by-word meanings and transliterations (Quran.com). Nothing licensed is committed to this repository.

`npm start` serves on `http://127.0.0.1:4317` and prints a **private control link**. Open it in Chrome or Edge, or change `/control` to `/reader` in that link for the phone-friendly reader. Copy `.env.example` to `.env` and add `SONIOX_API_KEY` to follow recitation (and `OPENROUTER_API_KEY` for spoken requests and meaning search); without keys, reading, navigation, search and the overlay all work.

To host it for others, see [docs/DEPLOY.md](docs/DEPLOY.md) (Docker, HTTPS proxy, sponsored hours, optional donations, costs) and the short path in [docs/LAUNCH.md](docs/LAUNCH.md).

## Use it in your own app

The follower and the finder are plain TypeScript with no server or keys required. [examples/follow.ts](examples/follow.ts) shows both, after the corpus steps above:

```bash
npx tsx examples/follow.ts
```

```ts
const r = await resolver.resolve('surah about elephants', null);   // -> candidates, first card 105:1

session.onDisplay((d) => console.log(d.verse?.key, d.cursor?.from)); // ayah and word being recited
session.handle({ type: 'capture', captureEpoch: 1, event: 'recording' });
session.handle({ type: 'transcript', captureEpoch: 1, seq: 0, receivedAt: 0,
  tokens: [{ text: 'قل هو الله احد', isFinal: true }] });              // words from any recogniser
```

Feed it the words your speech recogniser hears (final and in-progress tokens, with timings if you have them) and it reports the ayah and word being recited, the same engine that drives the reader and overlay. Its output is references (`112:1`, word 4); take the Arabic and translation from their publisher (for example the [Quran.com API](https://api-docs.quran.com)) under its terms. There is no npm package or hosted API yet; open an issue if you need one.

## Privacy

In hosted mode, audio passes through the app server to Soniox only while listening is on. The public service does not save audio or transcripts to disk; recognised words are held temporarily and may go to OpenRouter or TypeSafe for matching. Self-hosted mode sends audio directly to Soniox and can optionally save diagnostic text captures. Request logging is off. With working voice detection, a pause of about 8 seconds after speech closes the recognition stream until voice returns; initial silence and unavailable detection can leave it open. Stop listening explicitly closes the microphone and stream. Reading, word meanings and translations never require the microphone.

The community panel shows lifetime hours funded, used for listening, and remaining—no donor names, monthly targets or personal purchase plans by default. Usage includes time connected to recognition and is settled when a stream ends. Hosted listening permits one stream per visitor, checks only provider-originated recitation evidence, and applies a five-minute cooldown after 90 seconds of connected time without recognised recitation (including repeated restarts). Repeated cutoffs across fresh identities also trigger a temporary network cooldown. This is resource protection, not a judgment of recitation quality or a guarantee against all abuse.

## Attribution

Arabic text (Uthmani and Imlaei), Saheeh International translation, chapter metadata, word-by-word meanings and transliterations: [Quran.com](https://quran.com) API v4 (Quran Foundation). Saheeh International is published by Dar Abul-Qasim. Font: KFGQPC Uthmanic Script HAFS, King Fahd Glorious Quran Printing Complex (free to use and distribute; not to be sold or modified). Speech recognition: [Soniox](https://soniox.com). Decisions: JEV via OpenRouter.

## License

The code is [MIT licensed](LICENSE). The Quran text, translation, word-by-word data and font are not part of this repository and are not covered by that license: `npm run corpus:fetch` and `npm run wbw:import` download them from their publishers, whose terms apply (see *Attribution*).

The Nurra name and logo belong to Nurra LLC and are not covered by the MIT license; a fork should use its own name and mark.

---

The sections below are for contributors: how following works, commands, and what has been verified.

## Development

Before push, follow [local verification and hosted exceptions](docs/LOCAL_VERIFICATION.md).
Routine checks run on the owner's PCs; GitHub CI is an explicit platform/release check.

For development with hot reload: `npm run dev` (backend + Vite on `http://127.0.0.1:5173`; open the printed control link with port 5173).

### Listening and decisions (optional keys)

Copy `.env.example` to `.env` and fill in what you have. Nothing else is read from other projects.

| Variable | Needed for |
|---|---|
| `SONIOX_API_KEY` | Following recitation from the microphone. The server mints a single-use 60-second temporary key per stream; the long-lived key never reaches the browser. |
| `JEV_PROVIDER` + `TYPESAFE_API_KEY` or `OPENROUTER_API_KEY` | Optional JEV decisions for ambiguous places and English search selection. Only the selected gateway is called. |
| `TRACKER_MODE` | `hybrid` (default), `deterministic`, or `jev_required` (experiment). Also switchable on the control page. |

Without keys, everything except listening works: manual and keyboard navigation, typed English references and meaning search, the reading screen and the overlay.

## Use it in the browser first

- **Your reading page:** in `/reader`, *Menu → Reading appearance* chooses Night or Paper and adjusts Arabic and translation size together. These choices are saved on this device; the audience keeps the broadcaster's chosen look.
- **Overlay appearance:** choose Reading, Stream captions or Arabic only, then adjust text size, colour, shading and caption placement. The audience preview offers light, dark and transparency backdrops for checking contrast; these backdrops are preview-only.
- **Reading screen:** *Stream output → Open reading screen* opens the same display with a solid background; make it full-screen (F11) on a second monitor.
- **Recite or ask:** one microphone for both. Recite and the screen follows; say or type `2:255`, `surah two verse two hundred fifty five`, `yaseen`, `go to inna fatahna`, `surah about elephants`, `English only`, `next`. References and explicit finding requests show immediately; plain descriptions of a verse stay private until you choose **Show on stream** on a result card.
- **Going back and moving on:** restarting a few words back after a breath (or at the start of the ayah) is followed, not treated as a new place. When recitation stops matching (a jump elsewhere, a pause to talk), the last ayah stays up until the new place is found; *When recitation stops matching → clear the screen after 3 s* is the alternative.
- **Three different actions:** *Stop listening* keeps the current ayah on screen. *Pause following* freezes the screen while still listening. *Hide from stream* blanks the audience view without losing your place.
- **Keyboard:** ← / → previous/next ayah, H pause/resume, B hide/unhide.
- **Long ayahs** that cannot fit legibly are paged, never shrunk or clipped: the Arabic part follows the recitation position; translation pages turn on a timer or with ›. A lower third that cannot hold an ayah is shown full frame for that ayah, and the control page says so.

## OBS

Sources → + → Browser, paste the link from **Copy OBS overlay link**, set width 1920 and height 1080. Leave "Shutdown source when not visible" off so scene switches don't reconnect it (both settings recover: every (re)connect receives the full current state). The overlay link can only display ayahs; **Replace overlay link** revokes it. On the hosted site your link and your chosen look are kept for your browser, so OBS keeps working across restarts and days away. The overlay plays no audio. Keep the microphone in the Chrome/Edge control page, not in OBS.

### Charity stream scene

The control page's **Charity stream** card sets up `/stream`, a 1920 × 1080 scene for a fundraising stream: the partner (who receives the donations), the project and what a donation provides, an optional project photo, the donation link (shown, and as a QR code), a goal, the reciter's name and an "Hour 3 of 24" clock. In OBS add it as a Browser source (**Copy OBS stream link**, 1920 × 1080) and put your camera or VTuber source *under* it in the source list: the arch at the left is a see-through window, so move the camera until you show in it (or untick *Camera window* to show the project photo there instead).

**Preview charity scene** shows that actual scene in the control monitor. Its page controls measure the scene's reading panel, so even the longest translation can be paged completely. The preview itself does not count as a connected audience or grant live-stream listening allowances.

Money goes to the partner's own donation page, never through this app. When a donation comes in, add it under **A donation came in** (a name, or empty for anonymous; the amount; the donor's own words if they want, e.g. "For my late father"): the stream announces it in Nurra gold, silently, one at a time, and the total and the recent list update. **Remove** takes a mistake back. Amounts are hidden on stream unless *Show amounts* is ticked: every donor gets the same du'a. Settings and donations are kept across restarts (hosted: with your overlay link; self-hosted: `data/state/local-stream.json`). While the scene is open in OBS your listening counts as live on stream (no daily limit; see [Deploy: live streams](docs/DEPLOY.md#live-streams)).

## How it works

```text
Control page ── mic → hosted audio relay → Soniox → tokens ─────────┐
Self-hosted mode ── mic → Soniox directly → tokens ────────────────┤
                                                                    ▼
Local server: transcript assembly → tracker (full-corpus retrieval + bounded alignment)
             → optional JEV decision (shortlist + WAIT, revalidated) → one display state
                                                                    │ WebSocket (revisioned)
                      overlay / reading screen / control preview ◄──┘
```

- `src/shared/contracts.ts` is the single owner of every wire message and the display state.
- `src/server/tracker/` — normalization, full-corpus index, alignment, candidate generation, reducer (proposals, uncertainty, collisions), scheduler (single flight, newest pending, deadline, negative cache), follower (modes, evidence binding, revalidation), pace (keeps the highlight on the word being recited, within the ayah on screen). No React or network dependency; usable by other apps.
- `src/server/providers/` — hosted audio relay and Soniox key minting; JEV Decisions clients for TypeSafe direct and OpenRouter with strict response validation.
- `src/server/search/`, `src/server/commands/` — reference/number parsing, chapter aliases derived from corpus names, BM25 over the translation, optional semantic adapter, command resolution.
- `src/web/` — control page, overlay/reading screen, and one shared `VerseDisplay` renderer that measures real line boxes before paint.
- `src/shared/display-encoding.ts` — see *Known limitations*.

## Commands

| Command | What it does |
|---|---|
| `npm run corpus:fetch` | Download every corpus source from its recorded URL; refuses files that do not match the pinned SHA-256. |
| `npm run wbw:import` | Word-by-word English and transliterations from Quran.com, aligned to the display words (6,232 of 6,236 ayahs). |
| `npm run speedlab -- --name duha` | End-to-end latency through the real pipeline: a TTS recitation WAV as Edge's microphone → Soniox → screen (see `scripts/speedlab/`). |
| `npm run speedlab:hosted` | Hosted mode end to end with a one-minute allowance: following, the provider cut, clean stop, one charge. |
| `npm run replay:session -- [captures or scenarios]` | Replay captures/scenarios through the real session in virtual time: latency, wrong displays, flip-backs. |
| `npm run secrets:hook` | Once per clone: every commit is first checked for keys (the actual values in your `.env` and `deploy/production.env`, and well-known key formats) and for env files themselves; the repository is public. `npm run secrets:check` checks the whole history. |
| `npm run replay:timing -- [captures]` | Word by word: while each word is recited, is the highlight on it, behind or ahead, and how soon after the word begins it lights up (`--each`, `--trace`). |
| `npm run corpus:import -- --manifest corpus/sources.json` | Verify source hashes, build and validate the processed corpus and copy the font. Writes nothing if any check fails. |
| `npm run corpus:validate` | Re-check the processed corpus (25 checks: 114 surahs, Hafs verse map, exact key sets, basmala rules incl. 1:1, 9:1 and 27:30, disjoint-letter openings, markup, UTF-8, hashes, font coverage). |
| `npm test` | Unit and integration tests (tracker, transcript, JEV validation, scheduler, follower modes, server authorization, commands, push-to-talk lane, capture). |
| `npm run test:ui` | Builds, starts a server on port 4399 and runs the browser walkthrough in installed Edge. |
| `npm run typecheck` | TypeScript check. |
| `npm run replay -- --fixture <path> --mode <mode>` | Replay a scenario (`fixtures/scenarios/*.json`) or a capture (`.jsonl`) through the real follower. |
| `npm run benchmark -- --manifest fixtures/benchmark.json` | All fixtures × three modes → `docs/BENCHMARK.md`. |
| `npm run eval:english [-- --set <file> --out <md> --jev]` | English requests → report. `fixtures/english-requests-v2.json` is frozen and untouched by tuning; `--jev` measures live JEV selection. |
| `npm run resources:import` | Import QUL exports from `data/inbox/`. |
| `npm run fixtures:derived` | Regenerate resource-derived tracking scenarios from the collision index. |
| `npm run search:embed` | Optional semantic search: fetch the pinned, hash-checked model and embed all translations — see below. |

Set `QO_DIAGNOSTIC_CAPTURE=1` to write recognized text tokens (never audio) to `data/captures/*.jsonl`, bounded at 20 MB, in the replay format. Off by default.

## What has and has not been verified

| Evidence layer | Status |
|---|---|
| Source and tests | 197 unit/integration tests, typecheck, production build and 10 browser tests pass locally. Includes anonymous access, shared funding, signed donation idempotency, relay ownership, persistent cooldowns, browser SDK audio through a stand-in provider, load recovery and the silence skipper. Check recorded local verification and any explicitly dispatched CI on the deployment commit; see [the final review](docs/FINAL_REVIEW.md) for evidence boundaries. |
| Hosted at a path | The hosted site under `/quran-reader` was run and checked in a browser (every request under the prefix, live connection, OBS link). The Cloudflare Worker that puts it at nurra.org/quran-reader has not run yet. |
| Corpus | 25/25 validation checks; all 6,236 ayahs present in display, search and English with matching keys. |
| Replay (synthetic) | 19 hand-authored scenarios over real corpus text, three modes: deterministic 0 wrong displays, 168/178 ayahs shown; hybrid identical with a *simulated* decider; jev_required 0 wrong but slower (see `docs/BENCHMARK.md`). Streams use assumed provider timing and error rates. |
| Browser | Playwright walkthrough in Edge (control page + separate reading screen): privacy of search, show/pause/resume, hide/unhide, paging, lower-third promotion, reload recovery. Frames reviewed visually. |
| Soniox connection | Verified 2026-09-28: temporary-key minting (111–176 ms) and a real-time stream opening, accepting audio and closing cleanly. Owner live sessions (latest 2026-09-29: Ya-Sin, Al-Baqarah, Ar-Rahman) are captured as text and replayed; that session's three problems (going back after a breath, elongated words, "go to Surah Rahman" heard in Arabic script) were fixed and verified by replaying it, not yet by a new live session. |
| JEV decisions (OpenRouter) | Live calls verified: strict validation passes on real responses; it chose 67:1 over its textual neighbours (p 0.98) and answered WAIT (p 0.99) on the indistinguishable "يا أيها الذين آمنوا". The service intermittently stalled >10 s during testing (reproduced with curl) while successful calls took ~0.3 s. In replay (`docs/BENCHMARK.md`) hybrid with live JEV matched deterministic exactly (0 wrong, same ayahs shown); jev_required showed fewer ayahs and is not recommended. For English search, live JEV selection raised first-card relevance on a frozen set from 15/30 to 21–26/30 (`docs/ENGLISH_EVAL_V2*.md`). |
| Capacity | **Local load test** (`npm run load`, one desktop core, recogniser stand-in, owner recordings of five surahs): 10,000 connected readers with 0 errors in ~0.5 GB; up to ~200 people reciting at once with results reaching the highlight in 12 ms (p50), saturating near 250. Roughly 70–80 on a $6 cloud server; the relay's default cap is 60 (`QO_MAX_LISTENERS`), and beyond it people wait in line (their place shown; listening starts by itself when a place frees). Live streams (an overlay link open in OBS) have no daily limit or idle stop and keep their place through breaks (see [Deploy: live streams](docs/DEPLOY.md#live-streams)). Soniox allows 10 streams at once by default. Not measured on the deployed server. See [the audit](docs/AUDIT_2026-09-29.md). |
| Word highlight timing | **Replay of recorded owner recitation** (9 live sessions, 1,268 words; audio start estimated from the recogniser's delay, so absolute values are estimates and before/after comparisons exact). While a word is recited the highlight is on it 61% of the time (was 13%), behind 13% (was 69%), ahead 9% (was 1%); a word lights up p50 0.09 s, p90 0.66 s after it begins (was 0.90 s, 1.20 s). The remaining 17% is mostly the first word of a new ayah, which still waits for evidence (zero wrong ayahs). Waiting during breaths uses the page's own voice detector, which recorded sessions do not contain: not yet measured live. `npm run replay:timing`. |
| Microphone → screen latency | **Historical direct-stream measurement**, before the hosted relay: speed lab (TTS recitation as the microphone, real Soniox), ayah start → screen p50 0.9–1.0 s, p90 1.3–1.5 s, 0 wrong. First letter delivered → screen on recorded sessions: p50 0.12 s, p90 0.43 s. These timings do not verify the current hosted relay; measure it with owner recitation before launch. Do not generate new TTS recitation. |
| OBS rendering | **Not verified** in OBS. The overlay is the same page verified in Edge. |

## Known limitations

- **Display text/font pairing.** The display text is Quran.com Uthmani; the font is KFGQPC Uthmanic Hafs (QUL font 245), which is built for QPC-Hafs encoding. Rendered directly, every silent-letter mark (U+06DF, 3,988 occurrences) appears as a detached dotted circle. `display-encoding.ts` maps the three affected marks to the codepoints this font draws (verified against QUL's own QPC-Hafs text for the 1,923 verses in the development dump, and visually). One mark remains unrenderable: U+06E3 in 52:37. Tanween and ya forms follow the Uthmani source rather than QPC print conventions. Importing QUL resource 86 (QPC-Hafs text) would remove the mapping.
- **Rights.** Quran Foundation's developer terms allow free, paid and freemium apps that display their content in-app without reselling or redistributing it; this repository commits no corpus data (it is fetched and hash-verified). The KFGQPC font may be used and distributed free of charge but not sold or modified. Their terms permit app donations without a separate commercial licence, subject to content and source-specific requirements. Resolve the pinned corpus's retention/sync arrangement before public hosting (see `docs/DEPLOY.md`).
- **Footnotes.** Saheeh footnote markers are removed from the display; footnote bodies are not in the local corpus (their ids are kept).
- **Word highlighting:** source scripts differ. The exact normalized split/join mapper returns no cursor for 556 unsupported or ambiguous search-word positions (0.7%; Uthmani spellings such as ٱلصَّلَوٰةَ, مَوْلَىٰنَا and ٱلَّيْلِ are matched to their Imlaei forms). Word focus holds the last supported word without an active highlight. This mapping is algorithmically checked, not scholar-certified or phoneme alignment. Word meanings (Quran.com word-by-word) are shown only where their word count matches the display text exactly (6,232 ayahs); the other 4 show none rather than risk a wrong meaning.
- **Basmala:** a recited basmala alone is ambiguous (1:1, 27:30 and the unnumbered basmala before 112 surahs); the tracker waits for the next words rather than guessing.
- **Semantic search** (optional, set up here): `npm run search:embed` fetches Xenova/all-MiniLM-L6-v2 at pinned revision `751bff37…` from huggingface.co (four files, ~23.7 MB, each checked against a pinned sha256), stores it in `data/models/local/` and embeds all 6,236 translations (~10 s). The server loads it offline only (never downloads) and re-verifies the hashes; without it, lexical search still works. Measured on the 26 meaning queries: shown-card recall 25/26 (lexical alone 24), JEV-shortlist recall 26/26 (was 25); `be kind to mom and dad` moved from lexical rank 84 to visible cards. Query cost ~6–9 ms plus ~0.4 s warm-up at startup. Card ordering is still imperfect (JEV selection is meant to help, unverified). The model's licence was not reviewed.
- The tracker's thresholds are engineering values checked against synthetic streams and five owner captures. Those captures lack audio-aligned labels; the thresholds are not a calibrated accuracy guarantee.

More: `docs/REUSE_NOTES.md` (what was carried over from Moard and Nur, and how it is verified here), `docs/BENCHMARK.md`, `docs/ENGLISH_EVAL.md`, and the research/plan in `outputs/`.


## QUL resource layer

`src/server/resources/` owns Quran resource relationships (`ResourceCatalog`). Import status is visible on the control page under *Quran resources*.

- **In use now:** the five core corpus sources; a complete corpus-derived exact-phrase collision index (2,823 ayahs share a 4-word phrase with another), given to JEV as decision evidence ("related candidates", "continues with"); contextual revalidation of every decision with the real anchor.
- **Ready, waiting for data:** importers (written against QUL's exporter source, content-detected, validated, fixture-tested) for similar ayah (74), mutashabihat (73), topics (45), themes (62), QPC-Hafs ayah/word text (86/312), ayah metadata (69) and juz/hizb/rub/manzil (68/67/63/66). QUL downloads need a logged-in account: put the files in `data/inbox/` and run `npm run resources:import`; provenance and coverage go to `corpus/resources.lock.json` and `docs/RESOURCE_COVERAGE.md`. Once imported, curated near-matches become tracker candidate regions, topics become a search channel, and juz/hizb navigation works.
- **Measured and changed:** aligning exact-phrase neighbours as extra tracker candidates doubled compute with no behavioural change across 51 fixtures, so exact collisions stay decision evidence only.

## Required next integration: QUL resource layer

Read [Resource integration correction](docs/RESOURCE_INTEGRATION.md) and [the 14-category capability catalog](corpus/resource-catalog.json). These identify the missing resource-to-feature connections in the current implementation and define the import, coverage, tracking and search work required. They are an audited implementation brief, not a claim that these runtime integrations already exist.
