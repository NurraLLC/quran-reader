# Community project budget

Owner decision, 2026-09-29: start with a **$10 project budget**. This is a launch allocation, not a payment already received. Do not copy the sandbox's funded hours into production.

The community supports the whole Quran Reader project. Contributions add to the budget. Listening and project expenses reduce it. The public display uses hour equivalents; it must keep actual listening time separate from costs. A negative balance represents uncovered costs and prevents new listening.

## Community funding scope — 2026-10-02

The owner confirmed that community support covers **Quran Reader's own costs**.
Do not allocate the main Nurra website/domain or unrelated products to this pool.
Record only costs attributable to running this reader, including its server,
voice recognition, AI requests, payment fees, and any reader-specific overages.

The 13-cent conversion is not an all-in operating price. Fixed hosting continues
when no one is listening, and its cost per listening hour changes with traffic.
The current server plan is $6/month before applicable taxes or overages. For a
planning example, 100 listener-hours at the existing 13-cent voice estimate plus
the $6 server plan requires about $19 **before AI charges, payment fees, taxes,
overages and any reserve top-up**. This is a planning example, not an invoice.

Use two distinct calculations:

- Actual project funds remaining = confirmed support received − actual
  attributable hosting, voice, AI, payment fees and other running costs.
- Estimated listening capacity = the spendable budget after protecting the
  operating reserve, converted using the ledger's fixed rate.

The reserve is money still held, not a second expense. Replacing a voice estimate
with its actual charge must reconcile the difference; importing the complete
voice invoice as an extra cost would charge it twice. A true actual-cost balance
requires that reconciliation and real receipts. Live contributions were activated
on October 28 with the owner's authorization to accept support while bank payouts
are paused. A genuine paid contribution and its fee/pool readback remain unverified;
see [LAUNCH_STATUS.md](LAUNCH_STATUS.md).

## Read actual provider costs without changing the budget

`scripts/project-budget-report.mjs` reads the existing ledger in read-only mode
and the providers' read-only accounting endpoints. Run it inside the existing
container so keys stay there:

```sh
docker exec -e QO_BUDGET_REPORT_START=2026-09-29T00:00:00Z quran-reader-prelaunch node scripts/project-budget-report.mjs
```

The default window is the last seven days; a window may not exceed 31 days.
The scan is bounded to three pages of 1,000 Soniox records. Only the server-owned
`quran-reader:` reference prefix is attributed to shared listening; own-key and
other-product records are excluded. UUIDs are deduplicated, decimal USD costs are
summed exactly, and partial/denied/malformed results are unknown rather than zero.
No keys, visitor references, private receipt IDs, transcripts or raw log entries
are output. No financial entries are created or corrected by this report.

Soniox reports completed requests; OpenRouter reports totals for the configured
key, so confirm its exclusive use for this reader before allocating its totals.
Neither report replaces an invoice or proves that all failed/boundary-crossing
usage has been reconciled. Documentation:
[Soniox usage logs](https://soniox.com/docs/guides/usage-logs),
[OpenRouter current-key accounting](https://openrouter.ai/docs/api/api-reference/api-keys/get-current-key).

The October 2 read-only audit since September 29 found 20 shared-reader Soniox
records costing $0.06937, with about 0.6965 reported audio hours. The configured
OpenRouter key reported $0.003416448 lifetime usage and $0.000086898 in the current
UTC month. The ledger held 2,518 listening seconds and no additional expense
receipts. Those are provider/ledger readbacks, not newly recorded expenses or a
claim of fully reconciled community funding.

## Current accounting and its limits

- The existing conversion is 13 US cents per hour equivalent (`QO_SPONSOR_CENTS_PER_HOUR`). This is a display/admission estimate, not a provider price guarantee. Keep it fixed for an existing ledger; changing it requires a reviewed conversion of historical balances.
- Connected listening time is deducted automatically as an estimate. It includes short pauses. Stripe contributions are added once after a verified paid webhook.
- Hosting, payment fees, AI, and other expenses can now be recorded with their actual USD amount and a private stable receipt ID. Corrections replace the same receipt; retries do not duplicate costs. Public totals expose no receipt IDs or contributor details.
- Stripe payment fees are fetched from the actual balance transaction and deducted atomically with each paid contribution. If the fee is unavailable, the webhook returns a retryable error without adding partial funding. Repeated deliveries do not repeat the contribution or fee. Provider billing and hosting invoices still require an import or operator entry. Do not describe this counter as an automatically reconciled cash balance.
- Do not enter the full recognition invoice as an additional expense: listening already reduced the pool. A production invoice reconciliation must replace the corresponding listening estimate, not add it twice. That reconciliation is still required for fully actual-cost accounting.
- Record only Quran Reader's attributable costs. Do not charge the entire Nurra site's costs to this pool unless that allocation is explicitly agreed.

## Record an additional cost

Run budget tools with the same `QO_STATE_DIR`, `QO_SPONSOR_CENTS_PER_HOUR`
and `QO_OPERATING_RESERVE_CENTS` as the hosted reader. Both manual funding and
expense reports subtract the configured reserve from available listening time.
`pool:add` accepts hours, not dollars, and records a bookkeeping allocation; it
does not transfer cash or top up a speech/AI provider account.

Use the service's actual `QO_STATE_DIR` and matching conversion rate. USD supports up to six decimal places; values are persisted as integer microdollars. The command records an accounting entry; it does not transfer money.

```sh
npx tsx scripts/project-cost.ts stripe-fee-receipt payment_fees 0.45
npx tsx scripts/project-cost.ts hosting-invoice-2026-10 hosting 5.00
```

Reuse the receipt ID to correct the amount. Entering zero reverses that receipt's debit while preserving the record. This is an operator command, not a public API.

## Hosting

The launch configuration protects a rolling $6 operating buffer with
`QO_OPERATING_RESERVE_CENTS=600`. This is unspent money set aside, shown separately
from expenses, and cannot be consumed by new listening sessions. Actual invoices
still reduce the ledger when recorded; the buffer remains available for the next
costs. At 13 cents per hour, a $10 owner allocation represents 76.9 hour equivalents;
46.2 are reserved and about 30.8 are initially available for listening. Rounding
is conservative to whole seconds. A negative available amount can mean that the
reserve is not fully funded, rather than that an invoice is already overdue.

The owner approved and provisioned a DigitalOcean Basic server on 2026-09-29 at $6/month plus applicable taxes or usage overages. Configuration: Ubuntu 24.04 LTS, NYC1, one vCPU, 1 GB RAM, 25 GB SSD, no paid add-ons. Billing begins with provisioning. Record actual hosting charges with a stable invoice ID; the initial $10 allocation alone does not cover ongoing operation indefinitely.

Host preparation verified: key-only SSH, an active firewall allowing SSH, Docker/Compose, and 2 GB swap. Image `quran-reader:dc02530` built on that server and started in an isolated prelaunch container bound to `127.0.0.1:4317`. Its health endpoint returned `{"ok":true}`, all 6,236 ayahs loaded, and the isolated pool remained zero. Soniox and OpenRouter production keys were subsequently validated with read-only provider endpoints and installed in a root-only settings file (mode 600); startup confirms both are configured. The owner intentionally selected a $5 non-resetting OpenRouter cap. This cap is not a contribution to the pool. Stripe keys remain empty. Public web ports remain closed; this is host/runtime and key-authentication proof, not a public launch, paid JEV decision, or microphone test.

`reader-origin.nurra.org` now resolves to the server through Squarespace DNS. The main website, email records, and nameservers were preserved. The existing Nurra Site has a Worker entry point that can be evaluated for path forwarding; its WebSocket and visitor-address behavior must be proven before publishing that integration. No Cloudflare zone migration or Sites publication was performed during host preparation.

The existing public Nurra Site is verified at `https://nurra.org`, version 13. Keep it intact. Its Sites runtime requires a Workers-compatible server build. Quran Reader currently uses Fastify, long-lived session state, and `node:sqlite` with a persistent volume. It cannot be deployed unchanged as a static subdirectory of that Site. Resolve a compatible backend deployment or port before public launch; a domain alone does not run this backend.
