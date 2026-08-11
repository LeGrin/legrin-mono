import type { AppConfig } from '../config.js';
import type { StoredTransaction } from '../domain/transaction.js';

function parsedAnalysis(value: string | undefined): unknown {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

export class BudgetMirror {
  constructor(private readonly config: AppConfig) {}

  async sync(transaction: StoredTransaction): Promise<void> {
    if (!this.config.BUDGET_API_URL || !this.config.BUDGET_API_TOKEN) return;
    const response = await fetch(
      `${this.config.BUDGET_API_URL}/internal/v1/transactions/${encodeURIComponent(transaction.id)}`,
      {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${this.config.BUDGET_API_TOKEN}`,
          'content-type': 'application/json',
          'x-budget-actor': 'finance-sync',
          'idempotency-key': `finance:${transaction.id}:${transaction.lastSeenAt}:${transaction.category ?? 'none'}:${transaction.status}`,
        },
        body: JSON.stringify({
          id: transaction.id,
          source: transaction.source,
          sourceTransactionId: transaction.sourceTransactionId,
          ...(transaction.sourceLegId ? { sourceLegId: transaction.sourceLegId } : {}),
          accountId: transaction.accountId,
          occurredAt: transaction.occurredAt,
          updatedAt: transaction.updatedAt,
          localDate: transaction.localDate,
          localMonth: transaction.localMonth,
          description: transaction.description,
          merchant: transaction.merchant,
          merchantKey: transaction.merchantKey,
          ...(transaction.mcc !== undefined ? { mcc: transaction.mcc } : {}),
          amountMinor: transaction.amountMinor,
          amountExponent: transaction.amountExponent,
          currency: transaction.currency,
          status: transaction.status,
          kind: transaction.kind,
          ...(transaction.category ? { category: transaction.category } : {}),
          ...(transaction.categoryConfidence !== undefined
            ? { categoryConfidence: transaction.categoryConfidence }
            : {}),
          ...(transaction.categorySource ? { categorySource: transaction.categorySource } : {}),
          needsReview: transaction.needsReview,
          ...(transaction.analysisJson ? { analysisJson: parsedAnalysis(transaction.analysisJson) } : {}),
          ...(transaction.analyzedAt ? { analyzedAt: transaction.analyzedAt } : {}),
          firstSeenAt: transaction.firstSeenAt,
          lastSeenAt: transaction.lastSeenAt,
        }),
        signal: AbortSignal.timeout(this.config.BUDGET_API_TIMEOUT_MS),
      },
    );
    if (!response.ok) {
      throw new Error(`Budget mirror returned ${response.status}: ${(await response.text()).slice(0, 500)}`);
    }
  }
}
