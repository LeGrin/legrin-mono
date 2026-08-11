# Production acceptance, 2026-08-11

This is the consolidated whole-result acceptance pass for the finance pipeline and its CI/CD deployment. It combines current observations against deployed revision `0055a41ce95315eedddf186de1e23c21692fd39e` with the earlier real-socket acceptance pass for paths that need unavailable third-party credentials.

## Production topology and packaging

| Requirement or public output | Check | Observed result |
|---|---|---|
| Verified code is deployed to `legrin-main` | Inspected GitHub Actions run [`31482792923`](https://github.com/LeGrin/legrin-mono/actions/runs/31482792923) | `Verify` and `Deploy to legrin-main` succeeded for `0055a41`; dependency install, typecheck/tests, production Docker build, restricted deploy, and local production health all passed. |
| Separate isolated container | Inspected `legrin-finance-pipeline` on the VPS | Running as a non-privileged, read-only container on `legrin_default` and `legrin-network`; only `/app/data` is writable and the host bind is `127.0.0.1:18088`. |
| Persistent finance state | Queried the protected ledger after repeated deployments and a rollback test | SQLite exists in the persistent mount. The original synthetic transaction remained present with completed analysis and Telegram delivery metadata. |
| Public production health | `GET https://kitt.legrin-tech.net/finance/health` through Cloudflare and Nginx Proxy Manager | `200 {"status":"ok","calendar":false,"hermes":true,"telegram":true}`. |
| Protected reporting surface | Called public `/finance/api/transactions` without credentials, then called the internal endpoint with its bearer token | Public unauthenticated request returned `401 {"error":"unauthorized"}`; authenticated internal request returned `200`. Runtime env mode is `0600`. |
| Safe failed-release rollback | Deployed a disposable replacement image whose process exits with code 42 through the real restricted wrapper | Replacement was rejected, exact prior healthy revision was restored in four seconds, public health recovered, and no rollback container remained. |
| Regression and image packaging | Re-ran `npm run check` and `docker build --tag legrin-finance-pipeline:acceptance .` over the whole current tree | Typecheck passed, all 16 tests in four files passed, dependency audit reported zero vulnerabilities, and the production image built successfully. |

## Finance workflow traceability

| User requirement | Acceptance path | Observed result |
|---|---|---|
| Monobank webhook is ready | Called the public provider-shaped handshake with `Monobank-Webhook/1.0` | Wrong secret returned `404`; configured secret returned `200`. A previous public synthetic POST returned `200` and entered the production ledger. |
| Every accepted movement reaches KITT/Hermes | Re-read the persisted public synthetic row and called the finance summary from inside `kitt-hermes` using its runtime token | Synthetic row has non-empty `analysisJson`; KITT's loopback call returned `200` for month `2026-08`. Production health reports `hermes: true`. |
| User is notified or asked about unclear spend | Re-read the persisted synthetic row produced by the requested post-deploy probe | `notifiedAt` is populated, proving the live Telegram Bot API delivery completed. The transaction was initially rendered as a clarification and was then deliberately corrected. |
| Corrections update reporting | Queried the stored synthetic row and current month summary | Row is `Transfers`, source `manual`, kind `transfer`, `needsReview: false`; the month category summary is empty, proving the probe no longer counts as an expense. |
| Useful facts are grounded in ledger data | Re-ran the regression suite and retained the earlier live KITT acceptance | A deliberately hallucinated Hermes sentence is discarded by a regression test. User-visible totals and merchant-frequency facts are rendered deterministically from stored transactions. |
| Revolut Personal adapter works without Monobank | Earlier compiled-service acceptance called normalized Personal webhook and imported a real-format CSV twice; current production image was rebuilt from the same tested revision | Normalized endpoint returned `202`; first CSV import accepted three rows including a separate fee, and the repeat accepted zero with three duplicates. The service starts and remains healthy with no Monobank token configured. |
| Revolut Business integrity protections | Re-ran adapter and pipeline regression tests | Raw-body HMAC, timestamp tolerance, duplicate delivery, status reduction, and out-of-order state behavior pass. No Business account webhook is registered. |
| Unknown expenses can be discussed and corrected | Earlier real HTTP acceptance submitted unknown merchant `XZQ 1947`, queried `needs_review=true`, and patched its category | The deterministic question was emitted, the row appeared in the review queue, and the correction persisted as `Other` with `needsReview: false`. |
| Monthly finance API is available to KITT | Called `/api/summary/month` from both the finance host endpoint and inside the live KITT container | Both returned `200` and the same empty category list after excluding the synthetic transfer. |
| One daily Calendar event can summarize activity | Earlier acceptance rendered `renderDailyEvent` from the real acceptance ledger; current regression suite rechecked Calendar scheduling and rendering | One all-day event was produced with bank labels, category totals, daily total, exclusive next-day end, and red budget signal. |
| Calendar write reaches Google | Checked current production health and credentials | **Externally blocked:** `calendar:false`. An API key cannot edit a private Calendar. A service-account JSON or OAuth grant with edit permission is still required. |
| Real Monobank provider delivery | Stored the supplied token only in the protected VPS env, ran the deployed registration helper, and checked the callback handshake | Monobank registration returned `200 {"status":"ok"}` and the public callback handshake returned `200`. No artificial bank movement was made; real delivery will be observed on the next genuine account movement. |
| Real Personal Revolut automatic feed | Reviewed the implemented adapters and official personal-account constraints | **Externally blocked:** no official personal transaction webhook is available for this use. CSV upload through KITT/Telegram is the production MVP; the normalized endpoint remains available for a future authorized adapter. |

## Edge and failure paths covered

- Invalid webhook secret: `404`.
- Missing API bearer token: `401`.
- Missing Revolut Business signing configuration: deterministic `503` path, with signature behavior covered by regression tests.
- Invalid normalized payload and malformed CSV: `400` behavior covered by HTTP tests.
- Duplicate provider and CSV delivery: idempotent acceptance covered by real-socket acceptance and tests.
- Declined, failed, reverted, pending, and out-of-order transaction states: excluded or reduced correctly by tests.
- KITT unavailable, Telegram unavailable, Calendar unavailable, and process restart: durable outbox retry/recovery covered by pipeline tests.
- Replacement process exits or restart-loops: real production rollback verified.
- Cloudflare provider behavior: the public webhook succeeds with a provider-like User-Agent; a generic Python User-Agent was observed to receive Cloudflare `403`, so provider probes use realistic headers.

## Acceptance boundary

The deployed workflow is accepted for CI/CD, public ingestion, durable processing, KITT analysis, Telegram delivery, protected reporting, correction, Budget synchronization, persistence, and rollback. Monobank webhook registration is complete. End-to-end acceptance with a real Google Calendar write remains blocked by the Calendar credential, while Personal Revolut automation remains constrained by the absence of a Personal webhook product.

## Live acceptance follow-up

A later production recheck exercised the public interfaces again after Monobank registration:

- Public health returned `200` with Hermes, Telegram, and Budget enabled; Calendar remained explicitly disabled.
- The ledger contained four Monobank webhook deliveries: the earlier synthetic probe and three non-synthetic provider deliveries received after registration. Every webhook was fully processed, every transaction had KITT analysis and Telegram delivery metadata, and all four Budget sync jobs were complete. The three real rows were provider holds (`pending`) and the synthetic probe was completed; these are transaction states, not stuck queue items.
- Replaying the latest stored provider payload through public HTTPS returned `200` without increasing webhook or transaction counts, confirming production idempotency.
- Unauthenticated reporting returned `401`, an invalid webhook secret returned `404`, the configured handshake returned `200`, and authenticated transaction and month-summary calls returned `200`.
- KITT called the finance month-summary endpoint over the private container network and received `200`. Its authenticated Budget health boundary also returned `200`; the public Budget internal API remained unavailable.
- The recheck exposed one defect: an empty JSON webhook request returned `500`. The error handler now maps Fastify client parse failures to `400 {"error":"invalid_request"}`, with regression coverage. The full 17-test suite, typecheck, dependency audit, and production Docker build pass with the fix.
