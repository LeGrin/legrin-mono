---
name: finance-tracker
description: Track Monobank and Revolut transactions, resolve unclear expenses, correct categories, and report monthly spending through the LeGrin finance pipeline.
version: 1.0.0
metadata:
  hermes:
    tags: [finance, monobank, revolut, expenses, budget, витрати, фінанси, категорія]
    related_skills: []
---

# Finance Tracker

The finance pipeline is the system of record for bank transactions. Use its protected HTTP API through the terminal. Never invent a transaction, total, or category.

Required environment variables inside KITT:

- `FINANCE_API_URL`, for example `http://legrin-finance-pipeline:8088`
- `FINANCE_API_TOKEN`, equal to the pipeline `INTERNAL_API_TOKEN`

## Trigger recognition

- User explains an unknown purchase after a message containing `ID: ...`.
- User says a category is wrong or asks to recategorize a transaction.
- User asks about expenses, monthly totals, a merchant, or uncategorized transactions.

## Resolve or correct a transaction

1. Extract the exact transaction ID from the assistant message or conversation context.
2. If the category is not explicit, ask one short clarifying question.
3. Map the answer to one of these exact categories:
   `Food & groceries`, `Restaurants & coffee`, `Housing`, `Utilities`, `Transport`, `Health`, `Sport`, `Subscriptions & software`, `Shopping`, `Travel`, `Cash`, `Transfers`, `Income`, `Fees`, `Other`.
4. Persist it. Keep `remember: true` unless the user says this merchant is exceptional.

```bash
curl -fsS -X PATCH \
  -H "Authorization: Bearer $FINANCE_API_TOKEN" \
  -H "Content-Type: application/json" \
  "$FINANCE_API_URL/api/transactions/TRANSACTION_ID/category" \
  --data '{"category":"Restaurants & coffee","remember":true}'
```

URL-encode the transaction ID when necessary. After success, fetch the month summary and tell the user that Calendar and reporting were updated.

## Find unresolved transactions

```bash
curl -fsS \
  -H "Authorization: Bearer $FINANCE_API_TOKEN" \
  "$FINANCE_API_URL/api/transactions?needs_review=true&limit=20"
```

Ask about one transaction at a time. Include merchant, amount, bank, and transaction ID.

## Monthly summary

```bash
curl -fsS \
  -H "Authorization: Bearer $FINANCE_API_TOKEN" \
  "$FINANCE_API_URL/api/summary/month?month=YYYY-MM"
```

Summarize by currency without converting currencies unless an exchange-rate source is explicitly available. Highlight the largest categories and a useful behavioral pattern, but avoid moralizing.

## Rules

- The pipeline already calls KITT for initial classification. Return the requested strict JSON during those API turns.
- For low confidence, ask rather than guess.
- Never expose API tokens, webhook secrets, full raw payloads, or account identifiers.
- Do not write finance totals only to memory files. The finance API remains authoritative.
- Keep user-facing messages concise and in the user's language.
