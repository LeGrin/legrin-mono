# Budget integration acceptance, 2026-08-11

## Delivered topology

- Private source repository: `LeGrin/legrin-budget`.
- Public PIN-gated UI: `https://budget.legrin-tech.net`.
- Runtime container: `budget-app` on `budget_default`, `legrin-network`, and `legrin_default`.
- Persistent mirror: `/app/data/budget.db`, alongside the preserved Budget JSON state and uploads.
- Finance remains authoritative for provider facts and categories.
- Budget owns planning state, expected flows, notes, envelopes, reporting inclusion, and the UI mirror.
- KITT has scoped Docker-loopback access to both services and uses typed command endpoints rather than independent dual writes.

## Requirement traceability

| Requirement | Acceptance path | Observed result |
|---|---|---|
| Preserve the existing Budget UI and data | Deployed the new image over the existing persistent mounts, then fetched public UI and internal dashboard | Public UI returned `200`; existing state/manual files remained mounted; the dashboard returned the mirrored finance row. |
| Budget works without Monobank | Started and tested Budget with no bank provider dependency | Budget health, state, manual entry, expected income, SQLite mirror, and dashboard tests passed independently of Monobank. |
| Finance transactions update Budget | Added durable `budget_sync` outbox delivery and invoked the protected production backfill | Finance health reports `budget:true`; one existing synthetic row was enqueued, persisted once in Budget SQLite, and appeared in the UI ledger. |
| Retry-safe mirroring | Repeated the same transaction PUT with the same idempotency key in the Budget end-to-end test | First call returned `201`; repeat returned the stored result without a duplicate row. |
| KITT can read Budget | Recreated `kitt-hermes` with scoped Budget URL/token, called the internal dashboard from the container, and asked the real agent to use the finance skill | Container call returned `200`; the real KITT agent reported successful Budget access and one mirrored synthetic row without exposing transaction details. |
| KITT can update Budget-only context | Called the annotation endpoint from inside `kitt-hermes` with actor and idempotency headers | Synthetic probe received the note `Synthetic finance and Budget integration probe`; the persisted row returned it after deployment. |
| Category correction updates canonical finance and UI mirror | Sent an idempotent `Transfers` category command through Budget for the existing synthetic probe | Budget forwarded the command to finance; both services returned `Transfers`, `transfer`, manual source, and no review requirement. |
| Internal API is private | Called the same route publicly and over Docker/host loopback | Public `/internal/v1/health` returned `404`; authenticated loopback returned `200`. Nginx syntax validation passed. |
| Least-privilege runtime | Inspected the final CI-deployed container | Runs as `node`, non-privileged, read-only root filesystem, only `/app/data` writable, with dropped capabilities and three required private networks. |
| Budget CI/CD and rollback safety | Inspected private workflow run [`31486174211`](https://github.com/LeGrin/legrin-budget/actions/runs/31486174211) and the prior failed deployment | Verify and deploy passed for exact revision `465d2a9`. An earlier read-only database failure was health-gated and automatically restored the previous healthy container before the ownership/runtime fix. |
| Finance CI/CD with Budget integration | Inspected workflow run [`31485309376`](https://github.com/LeGrin/legrin-mono/actions/runs/31485309376) | All 17 tests, production image build, deploy, and health check passed for revision `079311c`. |
| Monobank callback is registered | Stored the supplied token only in VPS env mode `0600`, ran the registration helper, and checked callback handshake | Monobank returned `200 {"status":"ok"}` for webhook registration; public handshake returned `200`. No real post-registration bank movement was manufactured for testing. |

## Automated coverage

- Budget end-to-end test starts the actual server and exercises authentication, SQLite upsert, idempotency, listing, annotation, monthly summary, dashboard visibility, and missing-data output.
- Finance mirror contract test verifies URL encoding, scoped authentication, idempotency, analysis serialization, and that raw provider payloads never leave finance-ingest.
- Finance suite now contains 17 passing tests across five files.
- Both production Docker images build with zero npm audit findings.

## Remaining external boundary

- Google Calendar remains disabled because the supplied API key cannot edit a private Calendar. OAuth or a service-account credential with Calendar edit permission is still required.
- Real Monobank transaction delivery is now provider-registered but remains naturally unobserved until the next genuine account movement.
- Personal Revolut continues through deterministic CSV upload because there is no official personal transaction webhook product available for this workflow.
