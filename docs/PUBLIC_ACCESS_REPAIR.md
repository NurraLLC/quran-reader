# Public reader session recovery — October 24, 2026

The owner reported the public Nurra link showing the self-hosted private-link gate.
A fresh browser and a returning anonymous request opened normally, so those checks
did not reproduce the owner's persistent browser state. Interactive investigation
stopped at the owner's request; browser data and cookie settings were not cleared.

The source had a matching failure: it accepted only the first `qo_visitor` cookie.
An old domain/path-scoped duplicate could mask a later valid signed cookie. The
identity endpoint could then renew the browser's session, but the control socket
would still reject the duplicate header and the hosted reader would show the local
private-link message.

The server now selects the first verified visitor cookie and uses that same value
when renewing the scoped cookie. Invalid and malformed copies cannot mask a valid
identity. Signature, origin, quota and private-owner checks remain enforced.

The public reader also renews a refused anonymous session once before reconnecting.
Recovery is bounded, ignores late results after navigation, and cannot keep creating
identities in a loop. Repeated refusal closes listening and shows a retryable public
error; only a self-hosted reader asks for its private link. Access requests bypass
the browser response cache.

Typecheck and 26 focused cookie, connection, hosted-session and private-owner tests
passed. These are code checks, not owner-browser, microphone or OBS acceptance.
Publication details are recorded in [LAUNCH_STATUS.md](LAUNCH_STATUS.md).
