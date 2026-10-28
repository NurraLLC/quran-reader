# Launch status — 2026-10-28

## Latest: separate listening and fees; payments and payouts active

Owner-approved display correction `4ae2fdd` is live as
`quran-reader:4ae2fdd`, immutable image
`sha256:f14901be2dbfad35460dd14a6ddd2f17550479b4f3414faf99a385507334867b`.
The ring and legend separate listening from fees/costs; costs display in dollars.
Live browser readback showed 1h 52m listening used and $0.45 fees/costs, with
63h 53m available. Opening and closing support details retained those values.

- The owner's real $5 contribution was committed on October 28. Read-only ledger
  inspection confirmed 500 cents funded and a 45-cent actual payment fee, adding
  approximately 35 available listening hours after fees. No donor identity or
  payment credential is included in this record.
- The Stripe Dashboard account-status page showed Payments and Payouts Active
  and no active verification tasks. This supersedes the earlier payout-review
  limitation below. An actual bank payout receipt remains unverified.
- TypeScript checking, Windows and Linux frontend builds, secret history scan
  (1,051 file versions), Caddy configuration validation, and an isolated
  container's health/authenticated-cookie/synthetic 3,600-second pool readback
  passed. The test used disposable state and no production payment credentials.
  Its alternate loopback port required the application's expected Host header.
- The release switched with zero open listening holds. Production pool totals
  were identical across the switch, current protected credentials were retained,
  live contribution checkout remained enabled, and the content-refresh timer
  remained active. The prior `b275ae2` image and a private state backup are
  retained for rollback. No new microphone or OBS proof is claimed.

## Previous: support graph, prompt confirmation, rotated credentials and return navigation

Live application revision `b275ae2` (building on support/backend revision
`f95dabc`) is running as `quran-reader:b275ae2`, immutable image
`sha256:1ef53000438d0627027db11eaeb66690ca29a16bcc649051fd0cf60132c7b48a`.

- The compact community card shows a proportional available/reserved/used ring.
  Details, accounting assumptions and one-time LLC support disclosures expand
  on request. Contribution quotes and Stripe Checkout share the same estimate:
  approximately 35/72/184 additional hours for $5/$10/$25 at the current positive
  balance, after estimated domestic-card fees. Existing shortfalls are covered
  first; future bills can reduce capacity. Actual Stripe fees still own ledger
  accounting. The previously corrected operator scripts are now installed.
- Paid contributions add hours before bank payout. The return page checks the
  committed receipt every two seconds, with bounded retries, and refreshes the
  shared balance after confirmation. Pending/forged return URLs add nothing.
  Payout holds do not gate confirmed funding; the owner can front provider bills.
- Stream controls now have a visible Back to reader link, including their
  loading/error states. Ordinary navigation closes this page's capture and
  returns to the base-path-aware reader; modified clicks retain normal browser
  behavior. Local rendered navigation retained the selected Al-Fatihah 1:1.
- The example keeps its Example badge and concise accessible identity. Its
  visible caption now contains only the Quran Foundation source credit.
- A separate design agent inspected desktop, narrow CSS widths of 387/318px,
  paper/night themes, keyboard operation, empty funding and funding shortfall.
  The closed card measured 544 by 190px with 18 visible words. Parent inspected
  local return navigation and live rendered reader/caption. These are browser
  observations, not physical-device or microphone acceptance.
- Thirteen focused payment/budget tests, TypeScript checking and the Linux
  frontend build passed. The final public API check created a $5 live checkout,
  verified the return receipt configuration and pending status, then expired it
  unpaid. The pool stayed unchanged. No real contribution or Stripe-originated
  paid-event/actual-fee readback was performed.
- With explicit owner approval, created a restricted reader Soniox key for
  realtime recognition, temporary keys and usage/limits. Installed it and the
  rotated production Quran Foundation secret in protected production settings.
  Soniox temporary-key minting returned 201; Quran Foundation token issuance
  returned 200 and its chapter endpoint returned 114 chapters. Old Soniox and
  Quran Foundation credentials both subsequently returned 401. The old reader
  key was named Quran Reader Prod inside Soniox's Moard project; only that key
  was revoked. The separate MoardDEVCLOSE key was untouched. Reader recognition
  now uses the previously empty separate project, so historical provider costs
  must retain their original project attribution when reconciling invoices.
- No direct Typesafe key is configured in production; JEV uses the existing
  OpenRouter key and its $5 non-resetting cap. No OpenRouter rotation was needed
  for the diagnostic exposure. Private local production settings were updated
  and protected; temporary credential staging was deleted. No secret value is
  recorded in this document or release source.
- The public GitHub repository's fetched history passed scanning of 1,048 file
  versions against five local secret values and twelve formats, including
  Soniox and Quran Foundation. GitHub returned zero secret-scanning alerts.
  The manual CI test job now fetches full history and runs this scan. This is
  bounded scanner evidence, not a guarantee about all possible sensitive data.
- Each switch checked zero open listening holds and preserved the shared pool.
  One navigation-release public probe timed out and triggered rollback while
  retaining the rotated credentials; the retry passed private and public checks.
  Latest retained container: `quran-reader-before-support-20261028T125711Z`;
  backup: `/opt/quran-reader-backups/support-release-20261028T125711Z`.
  Roll back using the retained application image with the current protected
  environment, rather than restoring revoked credentials from older backups.
  The content-refresh timer remains active.

Stripe bank payouts are still subject to its review. A genuine paid contribution,
actual fee/pool readback, bank payout and fully reconciled hosting/provider
invoices remain unverified. No new microphone, replay or rendered OBS acceptance
was performed during this release.

## Current update: live Quran Reader contributions

The owner authorized accepting contributions while Stripe holds bank payouts
during its business review. The submitted Quran Reader description is in review,
with completion estimated for October 29; this is not an approval guarantee.
The business payout account is saved. Public contribution checkout is now on at
https://nurra.org/quran-reader/ for the existing $5, $10 and $25 options.

- The owner created a restricted live key: Checkout Sessions write; Balance,
  Charges and Refunds, and Payment Intents read. It cannot issue refunds or
  payouts. That key and the live webhook signing secret were installed only in
  the private production environment. The live webhook listens for
  `checkout.session.completed` and `checkout.session.async_payment_succeeded`.
- This was a configuration change using the existing `quran-reader:2fd1064`
  image and content/state volumes, not an application release or Sites update.
  Zero open listening holds were observed before each switch. Private config,
  container and state backups were retained. The first switch rolled back after
  an automated public probe received HTTP 403; the corrected request passed and
  the second activation completed. The final pool matched before and after:
  276,923 funded seconds, 6,619 used, 104,150 available, 166,154 reserved and zero
  additional recorded costs. This remains an estimate, not reconciled cash.
- Live Stripe authentication and read access passed. The deployed billing code
  created an unpaid live checkout, which was immediately expired. A separate
  checkout through the public donation route also opened successfully and was
  expired unpaid. Neither check moved money or credited the pool.
- The public webhook accepted a locally signed no-op probe with HTTP 200 and
  rejected the tampered payload with HTTP 400. This verifies the deployed route
  and signing secret; it is not Stripe-originated paid-event delivery proof.
  The pool remained unchanged during these checks.
- Eleven focused local payment/project-cost tests passed. The relevant payment
  source matches the deployed revision. Public browser readback showed enabled
  $5/$10/$25 controls, the voluntary one-time project-support notice, and the
  existing estimated-hour and running-cost explanations.
- Rollback container: `quran-reader-prestripe-20261028T120220Z`. The matching
  private backup is under `/opt/quran-reader-backups/stripe-activation-20261028T120220Z`.
  The content-refresh timer remains active.

A real paid contribution, its actual-fee ledger readback, Stripe-originated
paid-event delivery and eventual bank payout are still unverified. Payouts
remain paused by Stripe. Provider/hosting invoice reconciliation and refund or
dispute adjustments remain operator work, as described in
[PROJECT_BUDGET.md](PROJECT_BUDGET.md). No microphone, speech-provider, replay or
native OBS acceptance was performed for this payment configuration change.

### Checkout and formula audit follow-up

- Browser inspection of the actual public $5 button reached live Stripe Checkout
  for Support Quran Reader, $5.00 USD, one-time support for Nurra LLC with the
  same 38-hour gross estimate and cost notice. Returned via the cancel link and
  expired this checkout unpaid. No money or shared hours were added.
- Public pool totals satisfy funded = used + recorded costs + reserve + available,
  with a 13-cent conversion and $6 protected reserve. These are estimated hour
  equivalents, not an invoice-reconciled cash balance.
- Fixed local operator scripts `sponsor-pool.ts` and `project-cost.ts` to apply
  the production reserve to reported availability; manual funding also now reads
  the configured conversion. The deployed application already uses these settings.
  This script-only correction has not been installed in the production image.
  Six focused budget tests and TypeScript checking passed. No application
  deployment or listening interruption was needed for the audit.
- Read-only provider accounting for October 21–28 returned 13 reader-attributed
  completed Soniox records, $0.039392 and 1,387.423 reported audio seconds.
  OpenRouter returned $0.006486984 lifetime key usage and $4.993513016 remaining
  under its $5 cap. These windows/units differ from lifetime connected listening;
  no expense was inferred or entered. Invoice reconciliation remains operator work.
- A diagnostic search accidentally included the ignored local production settings
  file. Its Soniox and Quran Foundation credentials match the deployed values
  and require rotation. No credentials are recorded here. Git history scanning
  passed (1,028 file versions); this does not undo diagnostic-output exposure.
  Production uses OpenRouter for JEV; no direct Typesafe key is configured.
  No provider key was rotated or revoked during this audit.

## Previous update: public reader access recovery

The public reader now runs `quran-reader:2fd1064`, revision
`2fd106494c8266e0fee2cbb045c1109693752db5`, image
`sha256:76279b8e0ac0b3634bbbe555a8885d3ff7e366538b3735f8b512b269ce3b089f`.
It fixes the duplicate visitor-cookie failure path and gives hosted reader
connections one bounded session-renewal attempt instead of the private-link gate.
See [PUBLIC_ACCESS_REPAIR.md](PUBLIC_ACCESS_REPAIR.md).

- [CI passed](https://github.com/NurraLLC/quran-reader/actions/runs/40068156161),
  as did typecheck and 26 focused cookie, connection and hosted/private-access tests.
- The Linux live image passed private startup using temporary state and the
  existing content cache read-only. All 114 chapters and 6,236 ayahs were present.
- The release initially waited for one active recitation. The owner authorized
  publication with a brief interruption; the session finished before the actual
  switch, whose final guard saw zero open holds.
- The existing content/state volumes and production environment were retained.
  Private backups were made, pre/post pool totals matched, and the content-refresh
  timer remains active. Public health and the updated frontend are available.
- Rollback container: `quran-reader-old-adb0cea-20261024T060331Z` (UTC suffix).

The owner requested no further interaction with their browser. No additional
interactive browser, microphone, provider or OBS acceptance was performed after
the repair. The specific failing owner-browser cookie state was not instrumented.

## Previous update: paired word meanings and evidence-based tracking

The owner requested publication on October 23. The public reader at
https://nurra.org/quran-reader/ now runs `quran-reader:adb0cea`, revision
`adb0ceae6e625722519dde8ab76066bd1e13acb5`, image
`sha256:a24aa22e83b3518016ab5daa2b25ba0d5b3ce32497011269f51719f3b2f190bd`.
The previous production revision was `bd56c02`; the server checkout was clean
before the fast-forward. Existing Sites routing was retained.

Arabic and exact source-owned English meanings now share a reserved cell.
Meanings reveal, settle into recent context, and fade away without moving the
text or suppressing adjacent meanings. The complete ayah translation remains
below. The cursor follows recognised speech, including repeats and partial
corrections, instead of predicting unheard words. See
[the implementation review](WORD_ALIGNMENT_REVIEW.md).

- [GitHub CI](https://github.com/NurraLLC/quran-reader/actions/runs/40045219225)
  passed on the deployed revision: 402 tests passed, 7 skipped; corpus validation,
  typecheck, frontend build, image build, proxy validation and hosted startup/pool
  checks passed. Local focused evidence remains 41 tracker/session tests and 25
  browser flows, with the final motion and reduced-motion checks passing.
- The complete Linux `live` image was built from that revision. Private startup
  used temporary state, the production content cache read-only, and no speech
  provider keys. It verified 114 chapters, 6,236 ayahs, source text at 1:1, 2:282
  and 114:6, and frontend assets. The content checkpoint was about 0.4 hours old.
- Production health, policy pages, protected anonymous sessions, control
  WebSocket, all 114 chapters and all four deployed JS/CSS hashes passed public
  verification. Direct origin access returns 404; the main Nurra site returns
  200. The content-refresh timer remains active; contributions remain disabled.
- There were zero open listening holds before the switch. The existing content
  and financial/link-state volumes were preserved, and private environment/state
  backups were made. The pool matched before and after: 276,923 funded seconds,
  5,835 used, 104,934 available, 166,154 reserved, and zero additional recorded costs.
- Public browser inspection of At-Tin 95:3 showed the source meaning “[the] city”
  directly under balad (center error below 0.01 px, gap about 2 px), the loaded
  Arabic font, and the unchanged complete English sentence. Listening stayed off.
- Rollback container: `quran-reader-old-bd56c02-20261024T003502Z`. Backups remain
  private in `/opt/quran-reader-backups`. The container suffix is a UTC timestamp.

These checks establish the deployment and rendered page. They do not constitute
a new speech-provider, owner-microphone, payment or native OBS acceptance run.

## Previous update: appearance, reading comfort and accurate scene preview

The owner explicitly requested this live update on October 2. Production runs
`quran-reader:0b6a506` (image `02f5174f2884`, revision
`0b6a50680018597e3dca30f55ac1cdb511e1963a`). It includes overlay customization
from `fa85423`, the reader/scene improvements in `93dd384`, the Paper hover
contrast correction in `cbcbb01`, and explicit funding scope plus a read-only
provider-cost report in `0b6a506`. The final frontend was built on Linux from
the validated `93dd384` build stage with the changed frontend files mounted;
the final image retains the validated live runtime and adds the exact committed
frontend changes and report script. No provider credentials or bundled scripture
were added.

- Fresh checks: typecheck, 276 source tests, all 23 Edge browser tests, production
  frontend build, and all 25 corpus checks passed. The final CSS correction passed
  five affected browser flows, including measured text/background contrast on the
  hosted support card. Funding clarity passed the hosted support/payment/voice
  flow and the About journey separately. The five report-boundary tests passed;
  final Linux CI passed, including all 281 source tests and the standard image build.
- Private Linux startup checked the production content cache read-only, with fresh
  temporary state and no provider keys: 114 chapters, 6,236 ayahs, and source-owned
  Arabic/English at the beginning, longest ayah and end. The cache checkpoint was
  about 14 hours old. The first external staging probe used the mapped port in its
  Host header and was correctly rejected; the corrected Host probe passed.
- Production is healthy. Public health, policies, assets, protected anonymous
  cookie, control WebSocket and full chapter count passed. All seven served
  JavaScript/CSS hashes (including retained earlier asset versions) matched the
  contrast release; all nine hashes matched the final funding-clarity container.
  Direct origin access returns 404; the main site returns 200. Sites
  routing was not edited. `QO_TRUST_PROXY=1`, `QO_MAX_LISTENERS=10` and
  `QO_REQUIRE_CONTENT_SYNC=1` were read back; the refresh timer is active.
- There were zero open listening holds at each switch. Existing content and
  financial/link-state volumes were preserved. Pool totals matched before and
  after all three switches: 276,923 funded seconds, 2,518 used, 108,251 available,
  166,154 operating-reserve seconds and zero recorded additional costs.
- Live browser review verified Paper selection and persistence, the budget formula
  and 30 h 4 min available, readable support details on hover, the new control
  choices, the actual charity preview and translation page 1 → 2 of 5 for 2:282.
  The preview retained zero audience connections. No microphone or payment was
  started during this production review.
- Rollback containers are retained as `quran-reader-old-c889d26-20261002T140210Z`
  and `quran-reader-old-93dd384-20261002T141536Z`, with
  `quran-reader-old-cbcbb01-20261002T145840Z` for the funding clarification. Private
  env/state backups remain in `/opt/quran-reader-backups`. Each switch had zero
  open listening holds and identical pre/post budget totals.

The owner confirmed Quran Reader's own costs as the community funding scope.
The published support text now labels hours as an estimate and explains ongoing
hosting, voice, AI requests and payment fees. Live browser readback confirmed this
notice and the unchanged 30 h 4 min balance. The packaged read-only report ran
successfully in production: 20 completed shared-reader Soniox requests since
September 29, $0.06937 reported cost and 2,507.579 audio seconds; configured
OpenRouter key totals $0.003416448 lifetime and $0.000086898 current UTC month.
Other Soniox project traffic was excluded by the server-owned reference prefix.
No receipts, refunds or extra charges were imported; the ledger still has zero
additional expense receipts. See [PROJECT_BUDGET.md](PROJECT_BUDGET.md) for scope,
the actual-cost formula, reserve treatment, attribution and reconciliation limits.

Live Stripe contributions remain disabled. Signed-payment conversion, actual-fee
deduction, duplicate delivery, reservations, failed connections and voice usage
are covered by automated fixtures with stand-in providers. These checks do not
confirm a real paid donation. Provider/hosting invoice reconciliation is manual;
the hour rate is a budget estimate. The charity partner's separate donation page
does not automatically fund the listening pool. No new replay, paid inference,
owner-microphone, camera or rendered native OBS proof is claimed. Follow
[STREAM_TEST.md](STREAM_TEST.md) for that owner pass.

## Previous update: charity stream scene — 2026-10-01

The owner explicitly approved deployment on October 1. Production now runs
`quran-reader:c889d26` (image `63449bc561c2`), with the existing content and state
volumes preserved. Sites routing is unchanged. `QO_TRUST_PROXY=1` and
`QO_MAX_LISTENERS=10` are configured. The content-refresh timer remains active.
Live payments remain disabled.

- Fresh source checks: TypeScript, all 271 unit/integration tests, production
  build and all 18 Edge browser tests passed. The image build passed all 25
  corpus checks covering 6,236 ayahs and 114 surahs. These are source/browser
  checks, not fresh replay or microphone measurements.
- Production container is healthy. Public health, policies, assets, anonymous
  session and control WebSocket checks passed. Direct origin access returns 404.
  The shared pool retained its pre-update totals: 276,923 funded seconds,
  2,378 used seconds, 108,391 available seconds and 166,154 reserve seconds.
- Live browser walkthrough: the Charity stream card appears; Al-Ikhlas displays
  in the stream panel; a temporary $1 donation announces and updates the total;
  removal restores $0 and zero donors; 2:282 displays Arabic and English part
  1 of 5. No microphone or paid recognition was started in this walkthrough.
- The previous container is retained as
  `quran-reader-old-48183d0-20261001T110836Z`. A private state archive and env
  backup were made in `/opt/quran-reader-backups` before the switch.
- The owner selected OBS Studio on this PC with the full charity scene. OBS is
  installed. Camera composition, the owner's microphone, phone QR scanning and
  a rendered OBS recording still require the owner test in [STREAM_TEST.md](STREAM_TEST.md).

The records below describe the original September 29 launch, not the current
image or new measurements.

## Original launch — 2026-09-29

**Public reader launched:** https://nurra.org/quran-reader/ . Sites version 14
(`fea5e1f`) forwards only the reader path to backend image
`quran-reader:48183d0`. Production deployment
`appgdep_6abc3065205c8191b753b01720b88939` succeeded with environment revision 1.
Live payments are explicitly disabled while the owner finishes Stripe.

Use this status before the older alternative deployment examples in LAUNCH.md.
The main Nurra website remains on Sites; Squarespace manages its DNS. Do not
migrate nameservers or buy another server.

## Verified

- Quran Foundation **Production** credentials authenticate and return 114 surahs.
- Authenticated content refresh completed on the approved DigitalOcean server:
  6,236 ayahs and 6,232 aligned word-gloss entries. A second refresh correctly
  reported unchanged content and renewed the checkpoint. The daily systemd
  timer is enabled. See [CONTENT_REFRESH.md](CONTENT_REFRESH.md).
- Source commits `c41fabf` (content refresh) and `ac8b077` (operating reserve)
  are pushed; both passed GitHub CI.
- The production-only lifecycle hook issue found during private startup is fixed
  in `6d9eddc`. Three real reader browser checks passed with the live freshness
  guard enabled. The host image uses the built `ac8b077` image plus that exact
  committed one-file fix; no provider credentials are inside the image.
- Local verification: typecheck, 208 tests, production frontend build, all ten
  browser checks, plus a focused hosted-flow rerun after the reserve change.
  Authenticated-content replay: 105 files, 805 ayahs, zero wrong ayahs and zero
  blank screens. Replay is not live microphone latency evidence.
- The $6 operating reserve is distinct from expenses and unavailable to new
  listening. A $10 allocation at 13 cents/hour leaves about 30.8 listening hours.
  This is an owner allocation, not a Stripe payment received.
- Private runtime `quran-reader-prelaunch` is healthy with generation
  `hafs-sync-5fa384339a8dfe90729ea578`. Authenticated external HTTPS and control
  WebSocket checks passed. The seeded ledger reads 276,923 funded seconds,
  166,154 reserved seconds, 110,769 available seconds and zero recorded usage or
  expenses. The owner allocation uses a stable ID to prevent duplicate grants.
  Soniox and OpenRouter are configured; live contributions remain off.

## Still needed for public launch

The public routing, reader policies and consent flow are now published. Remaining
operational verification and payment work:

- Test fairness from two distinct external networks. The proxy validates the
  trusted Cloudflare address and overwrites incoming forwarding headers; live
  multi-network quota isolation has not been measured.
- Confirm Stripe activation; install the live key and signed webhook only when
  available. Live contributions remain disabled. Test-mode funding is separate.
- Reconcile actual provider and hosting bills against the estimated ledger.
  Stripe fees are automatic; this is not yet a fully reconciled cash ledger.
- Test the owner's live microphone and rendered OBS output. Browser fixtures
  and relay handshake checks do not replace those tests.

## Public verification

- Public health, privacy, terms, styles, scripts and pool endpoints return 200.
  Assets stay under `/quran-reader/`. Anonymous sessions work with Secure,
  HttpOnly cookies; public control WebSocket receives a snapshot.
- Direct origin access without the private gateway token returns 404.
- Browser walkthrough opened Al-Fatihah with Arabic and English, showed the
  unchecked voice-consent dialog, cancelled it, and retained the reading page.
  No owner microphone audio was captured during this walkthrough.
- Privacy and terms are available at `/quran-reader/privacy.html` and
  `/quran-reader/terms.html`, with Quran Foundation attribution on About.
  The owner requested email-only contact, `ashfaq@nurra.org`. These pages describe
  implemented practices; publication is not legal certification or confirmation
  of all provider contracts.
- Local checks on `48183d0`: typecheck, 208 tests, build and ten browser tests pass;
  GitHub CI passed. Voice tests cover cancel before any audio, explicit unchecked
  consent, retry, protected relay and silence reopening using synthetic fixtures.
- Main homepage content exactly matches the pre-existing Sites static export.
  The public response adds only Cloudflare's delivery/challenge script; its
  changing bytes explain the raw HTML checksum difference.
- Screenshots: `artifacts/hosting/public-reader-live.png` and
  `artifacts/hosting/public-voice-consent.png` (ignored local proof).

Preserve unrelated local edits in the cookie-path and Cloudflare Worker changes;
they were not included in these commits. Keep all production settings, origin
tokens, SSH keys and content checkpoints private.
