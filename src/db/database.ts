import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

import type { Category, NormalizedTransaction, StoredTransaction, TransactionStatus } from '../domain/transaction.js';
import { SCHEMA } from './schema.js';

export interface QueueItem {
  id: number;
  source?: string;
  kind?: string;
  aggregateKey?: string;
  payload: unknown;
  attempts: number;
}

export interface MonthSummaryRow {
  category: string;
  currency: string;
  amountMinor: number;
  amountExponent: number;
  count: number;
}

export interface MerchantStats {
  count7d: number;
  count30d: number;
  averageExpenseMinor30d: number;
}

type Row = Record<string, unknown>;

const now = () => new Date().toISOString();

function retryAt(attempts: number): string {
  const delaySeconds = Math.min(3600, 5 * 2 ** Math.min(attempts, 9));
  return new Date(Date.now() + delaySeconds * 1000).toISOString();
}

export class FinanceDatabase {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  enqueueWebhook(source: string, dedupeKey: string, payload: unknown): boolean {
    const timestamp = now();
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO webhook_events
        (source, dedupe_key, payload_json, status, attempts, next_attempt_at, created_at, updated_at)
      VALUES (?, ?, ?, 'pending', 0, ?, ?, ?)
    `).run(source, dedupeKey, JSON.stringify(payload), timestamp, timestamp, timestamp);
    return result.changes > 0;
  }

  claimWebhook(): QueueItem | undefined {
    return this.claimQueueItem('webhook_events');
  }

  claimOutbox(): QueueItem | undefined {
    return this.claimQueueItem('outbox');
  }

  private claimQueueItem(table: 'webhook_events' | 'outbox'): QueueItem | undefined {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const staleBefore = new Date(Date.now() - 5 * 60_000).toISOString();
      this.db.prepare(`
        UPDATE ${table}
        SET status = 'pending', next_attempt_at = ?, updated_at = ?
        WHERE status = 'processing' AND updated_at <= ?
      `).run(now(), now(), staleBefore);
      const row = this.db.prepare(`
        SELECT * FROM ${table}
        WHERE status = 'pending' AND next_attempt_at <= ?
        ORDER BY id
        LIMIT 1
      `).get(now()) as Row | undefined;
      if (!row) {
        this.db.exec('COMMIT');
        return undefined;
      }
      this.db.prepare(`
        UPDATE ${table}
        SET status = 'processing', attempts = attempts + 1, updated_at = ?
        WHERE id = ?
      `).run(now(), row.id as number);
      this.db.exec('COMMIT');
      return {
        id: row.id as number,
        ...(row.source ? { source: String(row.source) } : {}),
        ...(row.kind ? { kind: String(row.kind) } : {}),
        ...(row.aggregate_key ? { aggregateKey: String(row.aggregate_key) } : {}),
        payload: JSON.parse(String(row.payload_json)),
        attempts: Number(row.attempts) + 1,
      };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  completeWebhook(id: number): void {
    this.completeQueueItem('webhook_events', id);
  }

  completeOutbox(id: number): void {
    this.completeQueueItem('outbox', id);
  }

  private completeQueueItem(table: 'webhook_events' | 'outbox', id: number): void {
    this.db.prepare(`UPDATE ${table} SET status = 'done', updated_at = ?, last_error = NULL WHERE id = ?`).run(now(), id);
  }

  failWebhook(id: number, attempts: number, error: string, maxAttempts: number, deferSeconds?: number): void {
    this.failQueueItem('webhook_events', id, attempts, error, maxAttempts, deferSeconds);
  }

  failOutbox(id: number, attempts: number, error: string, maxAttempts: number): void {
    this.failQueueItem('outbox', id, attempts, error, maxAttempts);
  }

  private failQueueItem(
    table: 'webhook_events' | 'outbox',
    id: number,
    attempts: number,
    error: string,
    maxAttempts: number,
    deferSeconds?: number,
  ): void {
    const status = attempts >= maxAttempts ? 'failed' : 'pending';
    const nextAttempt = deferSeconds
      ? new Date(Date.now() + deferSeconds * 1000).toISOString()
      : retryAt(attempts);
    this.db.prepare(`
      UPDATE ${table}
      SET status = ?, next_attempt_at = ?, last_error = ?, updated_at = ?
      WHERE id = ?
    `).run(status, nextAttempt, error.slice(0, 2000), now(), id);
  }

  upsertTransaction(transaction: NormalizedTransaction): { created: boolean; materiallyChanged: boolean } {
    const previous = this.getTransaction(transaction.id);
    const timestamp = now();
    const values: SQLInputValue[] = [
      transaction.id,
      transaction.source,
      transaction.sourceTransactionId,
      transaction.sourceLegId ?? null,
      transaction.accountId,
      transaction.occurredAt,
      transaction.updatedAt,
      transaction.localDate,
      transaction.localMonth,
      transaction.description,
      transaction.merchant,
      transaction.merchantKey,
      transaction.mcc ?? null,
      transaction.amountMinor,
      transaction.amountExponent,
      transaction.currency,
      transaction.status,
      transaction.kind,
      transaction.category ?? null,
      transaction.categoryConfidence ?? null,
      transaction.categorySource ?? null,
      transaction.needsReview ? 1 : 0,
      JSON.stringify(transaction.raw),
      timestamp,
      timestamp,
    ];

    this.db.prepare(`
      INSERT INTO transactions (
        id, source, source_transaction_id, source_leg_id, account_id,
        occurred_at, updated_at, local_date, local_month, description,
        merchant, merchant_key, mcc, amount_minor, amount_exponent, currency,
        status, kind, category, category_confidence, category_source,
        needs_review, raw_json, first_seen_at, last_seen_at
      ) VALUES (${values.map(() => '?').join(',')})
      ON CONFLICT(id) DO UPDATE SET
        account_id = excluded.account_id,
        occurred_at = excluded.occurred_at,
        updated_at = excluded.updated_at,
        local_date = excluded.local_date,
        local_month = excluded.local_month,
        description = excluded.description,
        merchant = excluded.merchant,
        merchant_key = excluded.merchant_key,
        mcc = excluded.mcc,
        amount_minor = excluded.amount_minor,
        amount_exponent = excluded.amount_exponent,
        currency = excluded.currency,
        status = excluded.status,
        kind = excluded.kind,
        category = COALESCE(transactions.category, excluded.category),
        category_confidence = COALESCE(transactions.category_confidence, excluded.category_confidence),
        category_source = COALESCE(transactions.category_source, excluded.category_source),
        needs_review = CASE WHEN transactions.category_source = 'manual' THEN 0 ELSE excluded.needs_review END,
        raw_json = excluded.raw_json,
        last_seen_at = excluded.last_seen_at
      WHERE excluded.updated_at >= transactions.updated_at
    `).run(...values);

    const materiallyChanged = !previous
      || previous.amountMinor !== transaction.amountMinor
      || previous.status !== transaction.status
      || previous.localDate !== transaction.localDate
      || previous.description !== transaction.description;
    return { created: !previous, materiallyChanged };
  }

  updateRevolutStatus(
    sourceTransactionId: string,
    status: TransactionStatus,
    eventOccurredAt: string,
    raw: unknown,
  ): StoredTransaction[] {
    const existing = this.db.prepare(`
      SELECT * FROM transactions
      WHERE source = 'revolut_business' AND source_transaction_id = ?
    `).all(sourceTransactionId) as Row[];
    if (existing.length === 0) return [];
    const result = this.db.prepare(`
      UPDATE transactions
      SET status = ?, updated_at = ?, raw_json = ?, last_seen_at = ?
      WHERE source = 'revolut_business' AND source_transaction_id = ? AND updated_at <= ?
    `).run(status, eventOccurredAt, JSON.stringify(raw), now(), sourceTransactionId, eventOccurredAt);
    if (result.changes === 0) return [];
    const updated = this.db.prepare(`
      SELECT * FROM transactions
      WHERE source = 'revolut_business' AND source_transaction_id = ?
    `).all(sourceTransactionId) as Row[];
    return updated.map((row) => this.mapTransaction(row));
  }

  hasRevolutBusinessTransaction(sourceTransactionId: string): boolean {
    const row = this.db.prepare(`
      SELECT 1 AS present FROM transactions
      WHERE source = 'revolut_business' AND source_transaction_id = ?
      LIMIT 1
    `).get(sourceTransactionId) as Row | undefined;
    return Boolean(row?.present);
  }

  enqueueOutbox(kind: string, aggregateKey: string, payload: unknown, coalesce = false): void {
    const timestamp = now();
    if (coalesce) {
      this.db.prepare(`
        INSERT INTO outbox
          (kind, aggregate_key, payload_json, status, attempts, next_attempt_at, created_at, updated_at)
        VALUES (?, ?, ?, 'pending', 0, ?, ?, ?)
        ON CONFLICT(kind, aggregate_key) DO UPDATE SET
          payload_json = excluded.payload_json,
          status = 'pending',
          attempts = 0,
          next_attempt_at = excluded.next_attempt_at,
          last_error = NULL,
          updated_at = excluded.updated_at
      `).run(kind, aggregateKey, JSON.stringify(payload), timestamp, timestamp, timestamp);
      return;
    }
    this.db.prepare(`
      INSERT OR IGNORE INTO outbox
        (kind, aggregate_key, payload_json, status, attempts, next_attempt_at, created_at, updated_at)
      VALUES (?, ?, ?, 'pending', 0, ?, ?, ?)
    `).run(kind, aggregateKey, JSON.stringify(payload), timestamp, timestamp, timestamp);
  }

  getTransaction(id: string): StoredTransaction | undefined {
    const row = this.db.prepare('SELECT * FROM transactions WHERE id = ?').get(id) as Row | undefined;
    return row ? this.mapTransaction(row) : undefined;
  }

  listTransactions(options: { localDate?: string; localMonth?: string; needsReview?: boolean; limit?: number } = {}): StoredTransaction[] {
    const where: string[] = [];
    const params: SQLInputValue[] = [];
    if (options.localDate) {
      where.push('local_date = ?');
      params.push(options.localDate);
    }
    if (options.localMonth) {
      where.push('local_month = ?');
      params.push(options.localMonth);
    }
    if (options.needsReview !== undefined) {
      where.push('needs_review = ?');
      params.push(options.needsReview ? 1 : 0);
    }
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    const rows = this.db.prepare(`
      SELECT * FROM transactions
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY occurred_at DESC
      LIMIT ?
    `).all(...params, limit) as Row[];
    return rows.map((row) => this.mapTransaction(row));
  }

  getMonthSummary(localMonth: string): MonthSummaryRow[] {
    const rows = this.db.prepare(`
      SELECT COALESCE(category, 'Other') AS category, currency, amount_exponent,
             SUM(-amount_minor) AS amount_minor, COUNT(*) AS count
      FROM transactions
      WHERE local_month = ? AND amount_minor < 0 AND kind != 'transfer'
        AND status NOT IN ('declined', 'failed', 'reverted')
      GROUP BY COALESCE(category, 'Other'), currency, amount_exponent
      ORDER BY amount_minor DESC
    `).all(localMonth) as Row[];
    return rows.map((row) => ({
      category: String(row.category),
      currency: String(row.currency),
      amountMinor: Number(row.amount_minor),
      amountExponent: Number(row.amount_exponent),
      count: Number(row.count),
    }));
  }

  getMerchantStats(merchant: string, occurredAt: string): MerchantStats {
    const end = new Date(occurredAt).getTime();
    const from7d = new Date(end - 7 * 86_400_000).toISOString();
    const from30d = new Date(end - 30 * 86_400_000).toISOString();
    const row = this.db.prepare(`
      SELECT
        SUM(CASE WHEN occurred_at >= ? THEN 1 ELSE 0 END) AS count_7d,
        COUNT(*) AS count_30d,
        COALESCE(AVG(CASE WHEN amount_minor < 0 THEN -amount_minor END), 0) AS avg_minor
      FROM transactions
      WHERE merchant_key = ? AND occurred_at >= ?
        AND status NOT IN ('declined', 'failed', 'reverted')
    `).get(from7d, merchant, from30d) as Row;
    return {
      count7d: Number(row.count_7d ?? 0),
      count30d: Number(row.count_30d ?? 0),
      averageExpenseMinor30d: Math.round(Number(row.avg_minor ?? 0)),
    };
  }

  findCategoryRule(merchant: string, mcc?: number): Category | undefined {
    const row = this.db.prepare(`
      SELECT category FROM category_rules
      WHERE (merchant_key = ? OR merchant_key IS NULL)
        AND (mcc = ? OR mcc IS NULL)
      ORDER BY
        CASE WHEN merchant_key IS NOT NULL THEN 1 ELSE 0 END DESC,
        CASE WHEN mcc IS NOT NULL THEN 1 ELSE 0 END DESC,
        priority DESC
      LIMIT 1
    `).get(merchant, mcc ?? null) as Row | undefined;
    return row?.category as Category | undefined;
  }

  findHistoricalCategory(merchant: string): Category | undefined {
    const row = this.db.prepare(`
      SELECT category, COUNT(*) AS uses
      FROM transactions
      WHERE merchant_key = ? AND category IS NOT NULL AND category_source IN ('manual', 'hermes', 'rule')
      GROUP BY category
      ORDER BY uses DESC, MAX(last_seen_at) DESC
      LIMIT 1
    `).get(merchant) as Row | undefined;
    return row?.category as Category | undefined;
  }

  setAnalysis(
    id: string,
    analysis: unknown,
    category: Category | undefined,
    confidence: number,
    needsReview: boolean,
  ): void {
    this.db.prepare(`
      UPDATE transactions
      SET analysis_json = ?, analyzed_at = ?,
          category = CASE WHEN category_source = 'manual' THEN category ELSE COALESCE(?, category) END,
          category_confidence = CASE WHEN category_source = 'manual' THEN category_confidence ELSE ? END,
          category_source = CASE WHEN category_source = 'manual' THEN category_source ELSE ? END,
          needs_review = CASE WHEN category_source = 'manual' THEN 0 ELSE ? END
      WHERE id = ?
    `).run(
      JSON.stringify(analysis),
      now(),
      category ?? null,
      confidence,
      category ? 'hermes' : null,
      needsReview ? 1 : 0,
      id,
    );
  }

  setCategory(id: string, category: Category, remember: boolean): StoredTransaction | undefined {
    const transaction = this.getTransaction(id);
    if (!transaction) return undefined;
    this.db.prepare(`
      UPDATE transactions
      SET category = ?, category_confidence = 1, category_source = 'manual', needs_review = 0,
          kind = CASE
            WHEN ? = 'Transfers' THEN 'transfer'
            WHEN kind = 'transfer' AND amount_minor < 0 THEN 'expense'
            WHEN kind = 'transfer' AND amount_minor >= 0 THEN 'income'
            ELSE kind
          END,
          last_seen_at = ?
      WHERE id = ?
    `).run(category, category, now(), id);
    if (remember && transaction.merchantKey) {
      this.db.prepare(`
        DELETE FROM category_rules WHERE merchant_key = ? AND mcc IS NULL
      `).run(transaction.merchantKey);
      this.db.prepare(`
        INSERT INTO category_rules (merchant_key, mcc, category, priority, created_at)
        VALUES (?, NULL, ?, 1000, ?)
      `).run(transaction.merchantKey, category, now());
    }
    return this.getTransaction(id);
  }

  markNotified(id: string): void {
    this.db.prepare('UPDATE transactions SET notified_at = ? WHERE id = ?').run(now(), id);
  }

  getCalendarEvent(localDate: string): { eventId: string; contentHash: string } | undefined {
    const row = this.db.prepare('SELECT event_id, content_hash FROM calendar_events WHERE local_date = ?').get(localDate) as Row | undefined;
    return row ? { eventId: String(row.event_id), contentHash: String(row.content_hash) } : undefined;
  }

  setCalendarEvent(localDate: string, eventId: string, contentHash: string): void {
    this.db.prepare(`
      INSERT INTO calendar_events (local_date, event_id, content_hash, synced_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(local_date) DO UPDATE SET
        event_id = excluded.event_id,
        content_hash = excluded.content_hash,
        synced_at = excluded.synced_at
    `).run(localDate, eventId, contentHash, now());
  }

  retryFailed(): number {
    const timestamp = now();
    const webhooks = this.db.prepare(`
      UPDATE webhook_events SET status = 'pending', next_attempt_at = ?, updated_at = ? WHERE status = 'failed'
    `).run(timestamp, timestamp).changes;
    const outbox = this.db.prepare(`
      UPDATE outbox SET status = 'pending', next_attempt_at = ?, updated_at = ? WHERE status = 'failed'
    `).run(timestamp, timestamp).changes;
    return Number(webhooks) + Number(outbox);
  }

  enqueueBudgetBackfill(): number {
    const rows = this.db.prepare('SELECT id FROM transactions ORDER BY occurred_at').all() as Row[];
    for (const row of rows) {
      const id = String(row.id);
      this.enqueueOutbox('budget_sync', id, { transactionId: id }, true);
    }
    return rows.length;
  }

  private mapTransaction(row: Row): StoredTransaction {
    return {
      id: String(row.id),
      source: row.source as StoredTransaction['source'],
      sourceTransactionId: String(row.source_transaction_id),
      ...(row.source_leg_id ? { sourceLegId: String(row.source_leg_id) } : {}),
      accountId: String(row.account_id),
      occurredAt: String(row.occurred_at),
      updatedAt: String(row.updated_at),
      localDate: String(row.local_date),
      localMonth: String(row.local_month),
      description: String(row.description),
      merchant: String(row.merchant),
      merchantKey: String(row.merchant_key),
      ...(row.mcc !== null && row.mcc !== undefined ? { mcc: Number(row.mcc) } : {}),
      amountMinor: Number(row.amount_minor),
      amountExponent: Number(row.amount_exponent),
      currency: String(row.currency),
      status: row.status as StoredTransaction['status'],
      kind: row.kind as StoredTransaction['kind'],
      ...(row.category ? { category: row.category as Category } : {}),
      ...(row.category_confidence !== null && row.category_confidence !== undefined
        ? { categoryConfidence: Number(row.category_confidence) }
        : {}),
      ...(row.category_source
        ? { categorySource: row.category_source as NonNullable<StoredTransaction['categorySource']> }
        : {}),
      needsReview: Boolean(row.needs_review),
      raw: JSON.parse(String(row.raw_json)),
      ...(row.analysis_json ? { analysisJson: String(row.analysis_json) } : {}),
      ...(row.analyzed_at ? { analyzedAt: String(row.analyzed_at) } : {}),
      ...(row.notified_at ? { notifiedAt: String(row.notified_at) } : {}),
      firstSeenAt: String(row.first_seen_at),
      lastSeenAt: String(row.last_seen_at),
    };
  }
}
