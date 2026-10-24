# Live recitation following review

Current behavior: [October 23 word alignment repair](WORD_ALIGNMENT_REVIEW.md). The September
29 pace predictor and its timing results below are historical; live highlighting now follows
recognized speech and supports repeated words without clock-based advancement.

September 28, 2026. Local project: C:\QuranOverlay. No deployment.

## What caused the experience

The display was fed finalized transcript evidence. The main owner capture contained 444 partial-only messages; finalized updates arrived with a median gap of 2.042 seconds and a p95 gap of 8.076 seconds. The UI consequently appeared to wait for breaths. The screenshot also selected the experimental JEV-required mode: every ayah transition depended on another bounded provider request. `below_gate`, `wait`, and `deadline` are rejected, abstained, or late decisions, not successful navigation.

The screenshot's displayed 93:11 and recognized Al-Ikhlas illustrate a stale location; a regression now checks recovery from 93:11 to 112:1 on distinctive partial speech. Diagnostic "jump" describes a candidate's distance from the confirmed anchor; it does not mean that the candidate was shown. Existing continuity preference was present, but it operated on delayed evidence.

## Implemented behavior

- A reversible live cursor processes the complete current ASR hypothesis, including partials. It keeps the current passage as a prior and uses the existing full-corpus matcher, start hint, and imported relationship candidate provider. It does not commit provisional text to the confirmed follower.
- Ordinary within-ayah motion and supported continuation run locally. JEV remains available for ambiguity on confirmed evidence. The explicit experimental JEV-required mode still gates ayah changes; Hybrid is the normal mode.
- Partial spelling revisions re-align without discarding the previous passage. Transcript processing publishes one combined verse/translation/cursor state, avoiding a flash of older finalized text. Unsupported fragments retain the source verse with no active cursor.
- Source-word mapping handles supported one-to-many groups and excludes standalone pause marks from speech coordinates. Only unambiguous optimal alignments produce highlights. Across all 6,236 ayahs: 76,248/77,797 search words map (98.01%); 5,011 ayahs map completely. No verse was removed. Unsupported positions remain readable without a guessed highlight.
- Follow words highlights the current Arabic source word/group. Word focus isolates it, retaining it dimly during a temporary tracking gap. Full ayah preserves the original framed view. Modes sit above the preview. The same renderer serves control, reading window, and overlay.
- English speech on the listening microphone enters one bounded JEV intent decision after finalization/settling. Explicit navigation uses the existing validated command resolver; searches remain private. Commentary, negation, and translation recitation should abstain. Arabic resumption, manual navigation, Stop, and replacement requests invalidate stale decisions. An abandoned request's timer cannot cancel a newer request.
- Pause freezes the audience view; Resume reconciles the current hypothesis; Stop keeps the source verse and clears the active highlight. Pending speech from an old capture cannot move the screen.

English remains the existing Saheeh International **ayah translation**. It is not a synchronized word gloss or generated translation. The verified word-translation dataset needed for that feature is not installed. This change uses the existing corpus and resource interfaces; it does not claim new QUL resources were downloaded.

## Verification and limits

116 unit/integration tests, typecheck, production build, and two Edge browser walkthroughs passed. Browser verification sends provider-shaped events through the real control WebSocket and server, checks movement before finalization, mode changes, pause/stop, and reading-window recovery. Source Arabic and English remain source-owned. Screenshots include several successive word positions, both live views, and the control page; those frames were visually inspected. This is not a fresh microphone or OBS run, nor a continuous-video perceptual certification.

### Main owner capture replay

Capture `1790604246787`, 512 records, SHA-256 `024793919bb2ac7e67e7e041d8696e551c6a24ace55f13375a56aa1e53cd6d90`.

| Measure | Finalized events only | Full current hypothesis |
|---|---:|---:|
| First cursor from capture start | 13.854 s | 8.937 s |
| Word-position updates | 53 | 148 |
| Cursor updates on partial-only messages | 0 | 141 |
| Displayed ayahs | 18:1 through 18:15 | 18:1 through 18:15 |

The comparison runs the corrected Session twice, filtering partial tokens for the baseline. It isolates evidence availability; it is not a timing benchmark of two deployed builds. Neither capture-start timing nor tracker compute is speech-to-screen latency. There is no audio-aligned accuracy ground truth, so these results do not establish zero wrong ayahs. Other four owner captures also acquired a cursor earlier, including the sequence 112:1 through 112:4.

Reproduce without provider calls:

```powershell
node node_modules/tsx/dist/cli.mjs scripts/inspect-live-capture.ts data/captures/capture-1790604246787.jsonl data/processed/live-follow-review.json
```

### Live JEV routing check

Six authored text cases were sent to the configured OpenRouter JEV endpoint; no microphone or navigation effects. Five returned the expected routing/gate outcome (188-325 ms); one navigation request exceeded the 1.5-second deadline. The bare reference and patience search were accepted; discussion, negation, and English translation were rejected. A prior redundant second intent gate caused false abstentions and was removed after that failure. Timeouts remain a provider limitation, now surfaced privately without blocking the recitation cursor. Six authored cases are a smoke test, not a broad false-activation or accuracy estimate.

Run `scripts/eval-listening-routing.ts` explicitly to repeat paid live requests; it is not part of ordinary tests. Raw captures, credentials, and provider reports remain ignored local data.

## Remaining work

1. Measure actual spoken-word end to rendered highlight with synchronized microphone/audio and paint evidence. ASR emission delay remains outside the local matcher; these changes cannot highlight a word before useful recognition arrives.
2. Import licensed, verified word-level English and canonical QUL word-coordinate data for synchronized meanings and remaining script differences. Do not generate missing scripture or silently guess alignments.
3. Retain the existing font/text limitation at 52:37 and resource-specific redistribution restrictions documented in README. They were not resolved by this update.

## September 29, 2026: keeping pace with the reciter

The owner reported the highlight moving on only as each word ended. Measured on replay of nine recorded owner sessions (1,268 words, `npm run replay:timing`): while a word was being recited the highlight was on it 13% of the time and behind it 69% (by about one word); a word lit up a median 0.90 s after it began. The recogniser reports each piece of a word about 0.65–0.8 s after it is spoken (consistent across every capture), and the tracker needed about half of a word's letters before placing it.

The live display now keeps pace (`src/server/tracker/pace.ts`, `Session.followPace`):

- A word counts as begun from its first letters when they begin the next word of the ayah on screen; the piece carries the word's start time.
- From the newest evidenced word and when it began, the reciter's own pace (learned from their recent consecutive words, letters plus written madd) says which word they are on now; a timer moves the highlight when the next word is due.
- Bounds: never past the end of the ayah or a pause mark by the clock; at most two words beyond the evidence; a word due long enough ago to have been reported, yet not reported, means a pause or a held madd, so the highlight waits. The control page's voice detector reports silences (180 ms) and the voice returning at once: the highlight waits through a breath and moves on as the voice returns, including past a pause mark. Evidence of an earlier word heard later (a restart) moves it back; a prediction never does.
- Ayah changes are unchanged and evidence-only. Replay of all 105 captures and scenarios: 805 ayahs, 0 wrong, 0 blank, flip-backs and highlight gaps identical to the previous code.

After, on the same nine sessions: on the word 61%, behind 13%, ahead 9%, a different ayah or no highlight 17% (mostly the first word of each new ayah); a word lights up p50 0.09 s, p90 0.66 s after it begins. The audio start in these captures is estimated (earliest delivery minus 0.6 s), so absolute timings are estimates; the before/after comparison is exact. Recorded sessions contain no voice-detector events, so waiting during breaths is covered by tests, not yet by a live measurement. New captures record the page's audio clock and voice events, so the next owner session can be replayed exactly.

The page no longer shows what the recogniser heard: its spelling is not the Quran's, and the highlighted word is the proof that listening works. The server stopped sending it.

Follow-up the same day:

- Catching up by more than a word (a late report after a pause mark, a faster reciter) passes through the words between, 90 ms each, instead of jumping over them: forward jumps on the nine sessions 27 → 2, timing unchanged.
- The remaining 17% of recitation time off the recited word is entirely the start of each new ayah (never an ayah on screen without a highlight). It is bounded by the recogniser reporting the new ayah's first letters ~0.75 s after they are spoken: a prototype that accepted two letters when the previous ayah had been heard to its end gained 1% and was not kept, since it could show a wrong ayah. Moving sooner would mean guessing the next ayah.
- The 16 flip-backs in the owner captures are all one Ar-Rahman session in which the reciter went back from 55:45 to 55:24; the screen followed correctly.
- Pages received a full control snapshot (~6 KB, with the display and static setup) for every recogniser result: ~42 KB/s on a phone while reciting. Display changes now go out at once in their own messages and later snapshots omit the display and unchanged setup: 7.7 KB/s measured on the local reader during simulated recitation.
- The control page's speed meter timed words from when the recogniser reported them, so it would have called an on-time highlight 0.7 s late. The server now times each word from when it began to when it was first highlighted.
