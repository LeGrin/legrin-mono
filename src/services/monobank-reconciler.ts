import { statementItemSchema, monobankWebhookSchema, normalizeMonobank } from '../adapters/monobank.js';
import type { AppConfig } from '../config.js';
import type { FinanceDatabase } from '../db/database.js';

const MONOBANK_API = 'https://api.monobank.ua';

export interface ReconcileResult {
  accounts: number;
  fetched: number;
  updated: number;
  created: number;
  touchedDates: string[];
}

interface Logger {
  info(bindings: object, message: string): void;
  warn(bindings: object, message: string): void;
  error(bindings: object, message: string): void;
}

/**
 * Monobank only sends a webhook when a hold appears; a matching confirmation
 * webhook does not always arrive, so pending holds can stay pending forever
 * and the daily calendar event ends the day showing "0 confirmed · N waiting".
 *
 * This reconciler polls `GET /personal/statement/{account}/{from}/{to}` with the
 * Monobank token over a rolling window and replays every authoritative
 * statement item through the same normalize/upsert path as webhooks. Completed
 * (hold=false) items supersede stored holds, and brand-new items that the
 * webhook missed are picked up too.
 */
export class MonobankReconciler {
  private running = false;

  constructor(
    private readonly config: AppConfig,
    private readonly database: FinanceDatabase,
    private readonly logger: Logger,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly nowFn: () => Date = () => new Date(),
  ) {}

  start(): void {
    const intervalMs = this.config.MONOBANK_RECONCILE_INTERVAL_SECONDS * 1000;
    if (!this.config.MONOBANK_TOKEN || intervalMs <= 0) return;
    const timer = setInterval(() => void this.reconcileSafely(), intervalMs);
    timer.unref();
  }

  async reconcileSafely(): Promise<ReconcileResult> {
    if (this.running) return emptyResult();
    this.running = true;
    try {
      return await this.reconcile();
    } finally {
      this.running = false;
    }
  }

  async reconcile(): Promise<ReconcileResult> {
    if (!this.config.MONOBANK_TOKEN) return emptyResult();
    const accounts = this.listKnownAccounts();
    const touchedDates = new Set<string>();
    const result: ReconcileResult = { accounts: 0, fetched: 0, updated: 0, created: 0, touchedDates: [] };

    for (const accountId of accounts) {
      try {
        const items = await this.fetchStatement(accountId);
        result.accounts += 1;
        result.fetched += items.length;
        for (const item of items) {
          const payload = {
            type: 'StatementItem',
            data: { account: accountId, statementItem: item },
          };
          const normalized = normalizeMonobank(
            monobankWebhookSchema.parse(payload),
            this.config.TIMEZONE,
            this.config.internalTransferPatterns,
          );
          const previous = this.database.getTransaction(normalized.id);
          const upsert = this.database.upsertTransaction(normalized);
          if (!upsert.created && !upsert.materiallyChanged) continue;
          if (upsert.created) result.created += 1;
          else result.updated += 1;
          touchedDates.add(previous?.localDate ?? normalized.localDate);
          touchedDates.add(normalized.localDate);
          this.database.enqueueOutbox('calendar_sync', normalized.localDate, { localDate: normalized.localDate }, true);
          this.database.enqueueOutbox('budget_sync', normalized.id, { transactionId: normalized.id }, true);
          if (!upsert.created && previous?.status === 'pending' && normalized.status === 'completed') {
            this.database.enqueueOutbox(
              'status_notification',
              `${normalized.id}:completed`,
              { transactionId: normalized.id, status: 'completed' },
            );
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn({ accountId, error: message }, 'monobank reconcile failed for account');
      }
    }

    result.touchedDates = [...touchedDates].sort();
    if (result.updated > 0 || result.created > 0) {
      this.logger.info(
        { accounts: result.accounts, fetched: result.fetched, updated: result.updated, created: result.created },
        'monobank statement reconcile finished',
      );
    }
    return result;
  }

  private listKnownAccounts(): string[] {
    const rows = this.database.db.prepare(`
      SELECT DISTINCT account_id FROM transactions WHERE source = 'monobank'
    `).all() as { account_id: string }[];
    return rows.map((row) => row.account_id);
  }

  private async fetchStatement(accountId: string): Promise<unknown[]> {
    const to = Math.floor(this.nowFn().getTime() / 1000);
    const from = to - this.config.MONOBANK_RECONCILE_WINDOW_SECONDS;
    const url = `${MONOBANK_API}/personal/statement/${encodeURIComponent(accountId)}/${from}/${to}`;
    const response = await this.fetchFn(url, {
      headers: { 'X-Token': this.config.MONOBANK_TOKEN! },
      signal: AbortSignal.timeout(20_000),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const message = body && typeof body === 'object' && 'errorDescription' in body
        ? String((body as { errorDescription?: unknown }).errorDescription)
        : `status ${response.status}`;
      throw new Error(`Monobank statement API failed: ${message}`);
    }
    if (!Array.isArray(body)) return [];
    return body.map((item) => statementItemSchema.parse(item));
  }
}

function emptyResult(): ReconcileResult {
  return { accounts: 0, fetched: 0, updated: 0, created: 0, touchedDates: [] };
}
