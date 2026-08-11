# Personal Revolut ingestion strategy

Rechecked against Revolut's official documentation on 2026-08-11.

## Current decision

Use a statement uploaded to KITT in Telegram as the Personal Revolut MVP. KITT forwards the original file to the deterministic importer. Keep the normalized adapter endpoint ready for a future licensed Open Banking provider.

This is intentionally different from Revolut Business:

- The official [Business API](https://developer.revolut.com/docs/business/business-api) is for a customer with a **Revolut Business Account** and includes Business webhooks.
- The official [Open Banking API](https://developer.revolut.com/docs/open-banking/open-banking-api) is a gateway for third-party providers. Production access requires a valid OBIE or eIDAS transport certificate from a regulated certificate authority, plus customer consent and the Open Banking authorization flow. It is not a simple personal webhook token.
- Revolut's Personal help centre confirms that product statements can be exported in CSV format. Currency-statement format can vary by region and app flow, with PDF or Excel also documented.

Therefore a direct self-hosted Personal webhook would add regulatory, certificate, consent-renewal, and operational work that is disproportionate for the first version. Browser scraping or storing Revolut login credentials is not an acceptable substitute.

## When to add automatic Open Banking

Revisit a licensed aggregator only when at least one of these becomes true:

1. Manual uploads regularly leave reporting more than 24 hours behind.
2. More than one Personal bank needs the same connection.
3. Weekly statement upload takes enough effort that provider cost and consent renewal are preferable.
4. Real-time alerts from Revolut become a hard requirement rather than a convenience.

The provider must offer the user's Revolut entity and country, transaction IDs stable across refreshes, pending-to-completed updates, explicit consent status, historical backfill, and a webhook or reliable polling API. It should post normalized records to `POST /webhooks/revolut/personal/:secret`, so the ledger, Calendar, KITT, and deduplication logic remain unchanged.

## Current file workflow

Prefer a Revolut product-statement CSV with transaction rows. Upload the original file rather than copied text or screenshots. If the app only offers Excel for the selected statement flow, export a product statement as CSV when available. PDF is unsuitable for unattended import because table extraction can change signs, dates, currencies, or omit rows.

The implemented CSV path is idempotent, handles quoted values, stable identities, pending-to-completed updates, and separate fee rows. The acceptance pass verified that the first upload accepted three records and the second identical upload accepted zero duplicates.
