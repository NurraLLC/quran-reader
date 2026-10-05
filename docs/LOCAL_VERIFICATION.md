# Local verification and hosted exceptions

Routine checks run explicitly on the owner's reviewed local checkout. The
laptop is the primary background test/staging machine; the main PC remains for
development/current devices. Never run untrusted PR code automatically on either
PC or register a GitHub self-hosted runner. Provision and verify Node 24,
lockfile dependencies and the complete pinned corpus before calling the laptop
ready. Docker/Linux tooling is a separate prerequisite, not assumed installed.

## Before push

From the repository root, use the hash-verified corpus fetch/import commands
when the pinned inputs are missing or change:

```powershell
npm ci
npm run corpus:fetch
npm run corpus:import -- --manifest corpus/sources.json
npm run wbw:import
npm run corpus:validate
npm run typecheck
npm test -- --maxWorkers=1
npm run secrets:check
```

Keep all 6,236 ayahs across 114 surahs and the existing corpus validator. Missing
corpus/provider fixtures are not grounds for a fake pass. Run `npm run build`
before merge/release or when the changed frontend/build seam requires it. The
existing browser gate `npm run test:ui` remains necessary for affected UI flows;
it is separate from source tests and does not prove a live microphone/provider
or OBS session. Use touched Vitest paths for iteration, then the affected suite.
Inspect each exit code and stop on failure; shell command sequences alone are
not an aggregate success result.

## Production container verification

Before a container release, retain every command in the `container` job in
`.github/workflows/ci.yml`: Docker image build, Caddy configuration validation,
health check, synthetic pool funding and authenticated cookie/pool readback.
Run its Bash block in a disposable Linux/WSL checkout with Docker and Python 3,
using the same loopback-only port and synthetic pool; never fund a live service.
Do not translate away the cookie check or pool assertion. The workflow is the
canonical exact command sequence. If that Linux environment is unavailable or
the result differs, explicitly dispatch hosted CI for that platform seam.

## Resource limits and evidence

Run one repository suite at a time on the laptop, with Vitest `--maxWorkers=1`.
Use NODE_OPTIONS=--max-old-space-size=3072 as an initial JavaScript heap ceiling
in its dedicated session; it is not a cap on total RSS or child-process memory.
Do not overlap corpus imports, builds, browser suites, Docker builds or load
tests. Stop on sustained pressure/freezes and reduce the workload. The main PC's
current freeze investigation permits only light source/edit validation.

Record HEAD, corpus pin, commands, exit codes and failures before push. Later
code/dependency/input changes invalidate affected results. Source tests, corpus,
container, browser, provider and OBS evidence stay distinct. No skip markers or
fabricated remote statuses replace failing checks.

## GitHub use and migration

CI is `workflow_dispatch` only, with a required reason and reviewed ref: an
unresolved Linux/container discrepancy or explicitly requested release
reproducibility check. Both original jobs and all assertions remain. Routine
push/PR events do not invoke them; same-ref superseded diagnostics cancel.

Inspect target branch protection and effective rulesets before integration. If
`test` or `container` is required, this migration needs administrator approval
for a real alternative verification path. Do not loosen settings or add a dummy
green job. Manual dispatch becomes available once this definition reaches the
default branch. Old refs retain old triggers until updated, and the transition
push itself may still run old CI. Coordinate that push; no push or deployment is
part of preparing this patch.
