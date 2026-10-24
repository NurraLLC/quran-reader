# Word alignment and reading experience — October 23, 2026

Base: `bd56c02` in `C:\QuranOverlay`. Local repair and design work; no deployment.

## Final behavior

The Arabic word and its exact source-owned English meaning form one visual pair. The meaning
is centered directly underneath the word in the same inline grid cell. The cell reserves the larger
of the Arabic and English widths; long meanings wrap inside the reader's column. No label is
suppressed to avoid a collision. The complete Saheeh International ayah translation remains underneath in its
original paragraph and typography. There is no additional live translation strip or generated text.

The previous two distinct meanings stay quietly in their own word positions. In At-Tin 95:3 this
keeps “And this”, “[the] city” and “[the] secure” visible together. Future meanings occupy space
without being visible, so tracking does not move the Arabic or the complete translation. A shared
gold backing opens beneath the active pair over 200 ms and fades out over 280 ms. Its meaning reveals over 160 ms, with a
readable first frame and no moving text. Completed meanings settle over 240 ms; older meanings
fade away over 360 ms. Reduced motion removes all three effects.
Keyboard and tap inspection use the same source mapping. Reader, illustrative home example and
audience renderer share `WordMeaning` and native CSS grid placement. Audience line fitting measures
the actual paired cells; grouped ayahs carry their source glosses so their layout stays stable.

## Tracking repair

The supplied 56-second recording showed the next ayah entering with a later word highlighted.
A source regression reproduced a first-word report displaying word 2: prediction had advanced
before word 1 appeared. Clock-based and single-letter extrapolation have been removed. Voice
onset alone cannot advance a word. Speech batches pass through their supported opening words,
including a manually selected ayah; a mid-ayah start begins at its first supported word.

Fresh earlier speech and rewritten partial hypotheses can move the highlight back. Repeated
identical words keep their own meaning visible, including a teacher repeating `rabbuka` in 93:5,
and continuation afterward. Rapid hypothesis updates cannot erase a word's catch-up frame.
Hold, Stop, capture epochs and the existing confirmed/provisional separation remain authoritative.
The retired predictor and its tests were replaced by `tests/tracker/word-follow.test.ts`;
`replay:timing --pace` now reports that prediction is retired rather than accepting an inert knob.

## Evidence boundaries

Validation completed: typecheck and production build passed; 41 focused source tests passed
(the eight affected files including the same-timestamp partial-correction case); all 25 affected
browser flows passed, including the shared scene renderer and translation paging. The four motion
and example flows are checked again after the final fading treatment. Corpus validation passed
25/25 for `hafs-v1-3754c521faa1ef52`.
Two historical October 10 transcript captures traversed Ad-Duha 93:1–11 with no blank displays,
flip-backs or highlight gaps in the current one-word continuation mode. Those captures have no
new manually labelled audio truth, so their printed `wrong 0` is not an accuracy certification.
Replay timing estimates are deliberately not presented as fresh microphone latency.

- Source: focused tracker/session tests exercise openings, batches, partial corrections, repeats,
  breaths, held syllables, Hold, Stop, navigation, capture restart and audience contracts.
- Browser: `word-meaning.spec.ts` compares exact source glosses and pixel alignment at 375 and
  1280 px, protects balad's retained meaning from overlap, verifies unchanged full translations,
  and inspects positions throughout 2:282.
  The affected reader, keyboard, appearance, overlay and longest-ayah flows are checked separately.
  Browser inputs are synthetic speech events, not a microphone or speech-provider qualification.
- Replay: existing captured transcripts can exercise the new session without provider calls;
  they are historical recordings and do not measure new microphone-to-screen delay.
- Provider and microphone: no new live provider or microphone run in this repair.
- OBS: audience rendering is checked in Edge; no fresh rendered OBS session is claimed.

All 6,236 Arabic and English ayahs remain source-owned. Optional word glosses retain their existing
coverage; absent glosses are never invented. No Moard/Nurra files, credentials or recordings were
copied. Historical prediction timings in earlier reviews do not describe this version.
