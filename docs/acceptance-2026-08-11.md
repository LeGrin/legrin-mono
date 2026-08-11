# Acceptance evidence, 2026-08-11

This pass exercised the compiled production service through real HTTP sockets and a disposable SQLite database. The local service connected through an SSH tunnel to the live KITT Hermes Agent API on the VPS. It did not deploy or modify anything on the VPS.

## Requirement traceability

| Requirement | Acceptance path | Observed result |
|---|---|---|
| Monobank movement enters the pipeline | `GET` handshake and `POST /webhooks/monobank/:secret` against the running compiled service | Correct secret returned `200`, wrong secret returned `404`, the POST returned `200`, and the transaction appeared in the protected ledger as `monobank`, `-8.50 EUR`, merchant `Mlinar`. |
| Protected reporting API | Called `/api/transactions` without and with its bearer token | Missing token returned `401`; the valid token returned ledger data. |
| Every accepted movement is analyzed by KITT/Hermes | Enabled `HERMES_AGENT_URL`, connected to the live KITT `hermes-agent` v0.18.2 API, submitted Mono, normalized Revolut, and CSV transactions, then waited until all seven ledger rows contained completed analysis | Health reported `hermes: true`; all seven rows received analysis. No finance service or skill was installed on the VPS. |
| Known expense is categorized and confirmed with the monthly category amount | Submitted a `Mlinar` Monobank expense | Stored as `Restaurants & coffee`, `needsReview: false`; message was `Зафіксував 8,50 EUR ... Цього місяця в категорії вже 8,50 EUR.` |
| Unknown expense asks the user what it was | Submitted merchant `XZQ 1947` without MCC | `needsReview: true`; it appeared in `/api/transactions?needs_review=true` with the deterministic question `Що це за витрата ... на 12,34 EUR?` |
| User can correct a category and teach the service | Called `PATCH /api/transactions/:id/category` for the unknown transaction | Returned category `Other`, source `manual`, and `needsReview: false`. |
| Personalized spending insight | Submitted a second Mlinar expense in the same seven-day window | Message included `Схоже, це вже 2-й раз у Mlinar за останні 7 днів.` This statement is computed from ledger counts, not invented by the model. |
| Personal Revolut can enter through an adapter | Called `POST /webhooks/revolut/personal/:secret` | Returned `202 {"accepted":true}` and entered the same ledger and analysis pipeline. |
| Personal Revolut CSV can be uploaded through the KITT/Telegram contract | Posted a standard Revolut CSV to `POST /api/import/revolut/csv` | First upload returned `rows: 3, accepted: 3, duplicates: 0`; repeating the identical file returned `accepted: 0, duplicates: 3`. The fee became a separate `Fees` row. |
| Monthly financial reporting | Called `GET /api/summary/month?month=2026-08` after analysis and correction | Returned separate totals for Housing, Food & groceries, Restaurants & coffee, Other, and Fees. |
| One daily Calendar entry with bank movements, categories, totals, and budget signal | Rendered the production `renderDailyEvent` output from the acceptance ledger | Produced one all-day event for `2026-08-11` with exclusive end `2026-08-12`, a red `🔴` signal, `772.89 EUR`, six expenses, Mono/Revolut labels, and monthly category totals. |
| Model output must not invent facts about spending | First live pass exposed an unsupported external claim in Hermes prose; implementation was changed so Hermes may classify but all user-visible text and insights are deterministically rendered from ledger data | Follow-up live pass produced only grounded amounts, category totals, and merchant frequency. A regression test supplies deliberately invented Hermes prose and verifies it is discarded. |
| Automated regression safety | Ran `npm run check` after the fix | Typecheck passed; 16 tests across four files passed. |

## Externally blocked acceptance paths

- **Google Calendar write:** not attempted. The supplied API key is saved only in ignored local configuration, but an API key cannot write to a private Calendar. Acceptance requires a service-account JSON or OAuth grant, Calendar API enabled for that project, and edit access to the target calendar.
- **Telegram delivery and file upload in the live bot:** not attempted. Sending a real message is an external side effect, and the user explicitly deferred installing the service and KITT skill on Hetzner.
- **Real Monobank provider delivery:** not attempted because there is intentionally no public deployed HTTPS endpoint yet. The service-side handshake and POST path were exercised over a real local socket.
- **Revolut Business provider delivery:** exact raw-body HMAC, timestamp tolerance, duplicate handling, and out-of-order state protection are covered by automated tests, but no Revolut Business webhook was registered for this personal-finance acceptance pass.
- **Full VPS workflow:** intentionally deferred by user request. The test connected read-only to the existing live KITT API boundary and made inference requests, but did not change the VPS deployment.

The local implementation therefore has representative acceptance evidence for ingestion, durable processing, live KITT analysis, clarification, correction, CSV deduplication, reports, and Calendar payload generation. Final outcome acceptance remains blocked on Calendar credentials and the separately authorized Hetzner/Telegram deployment.
