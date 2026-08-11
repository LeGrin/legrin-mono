import {
  monobankWebhookSchema,
  normalizeMonobank,
} from '../adapters/monobank.js';
import {
  normalizeRevolutCreated,
  normalizeRevolutPersonal,
  revolutBusinessWebhookSchema,
  revolutPersonalTransactionSchema,
} from '../adapters/revolut.js';
import type { AppConfig } from '../config.js';
import type { FinanceDatabase } from '../db/database.js';
import type { NormalizedTransaction, TransactionStatus } from '../domain/transaction.js';

export class DeferredEventError extends Error {
  constructor(message: string, readonly deferSeconds = 60) {
    super(message);
  }
}

function mapRevolutStatus(value: string): TransactionStatus {
  if (value === 'completed') return 'completed';
  if (value === 'declined') return 'declined';
  if (value === 'failed') return 'failed';
  if (value === 'reverted') return 'reverted';
  return 'pending';
}

export class WebhookProcessor {
  constructor(
    private readonly config: AppConfig,
    private readonly database: FinanceDatabase,
  ) {}

  process(source: string, payload: unknown): void {
    if (source === 'monobank') {
      this.persist([normalizeMonobank(monobankWebhookSchema.parse(payload), this.config.TIMEZONE)]);
      return;
    }
    if (source === 'revolut_personal') {
      this.persist([normalizeRevolutPersonal(revolutPersonalTransactionSchema.parse(payload), this.config.TIMEZONE)]);
      return;
    }
    if (source === 'revolut_business') {
      const event = revolutBusinessWebhookSchema.parse(payload);
      if (event.event === 'TransactionCreated') {
        this.persist(normalizeRevolutCreated(event, this.config.TIMEZONE));
        return;
      }
      const affected = this.database.updateRevolutStatus(
        event.data.id,
        mapRevolutStatus(event.data.new_state),
        event.timestamp,
        event,
      );
      if (affected.length === 0) {
        if (!this.database.hasRevolutBusinessTransaction(event.data.id)) {
          throw new DeferredEventError(`Revolut state change arrived before TransactionCreated for ${event.data.id}`, 70);
        }
        return;
      }
      for (const transaction of affected) {
        this.database.enqueueOutbox('calendar_sync', transaction.localDate, { localDate: transaction.localDate }, true);
        if (['declined', 'failed', 'reverted'].includes(transaction.status)) {
          this.database.enqueueOutbox(
            'status_notification',
            `${transaction.id}:${transaction.status}`,
            { transactionId: transaction.id, status: transaction.status },
          );
        }
      }
      return;
    }
    throw new Error(`Unsupported webhook source: ${source}`);
  }

  private persist(transactions: NormalizedTransaction[]): void {
    const primaryTransfer = transactions.find((transaction) => transaction.kind === 'transfer' && transaction.amountMinor < 0)
      ?? transactions.find((transaction) => transaction.kind === 'transfer');
    for (const transaction of transactions) {
      const result = this.database.upsertTransaction(transaction);
      if (result.materiallyChanged) {
        this.database.enqueueOutbox('calendar_sync', transaction.localDate, { localDate: transaction.localDate }, true);
      }
      const shouldAnalyze = result.created
        && (transaction.kind !== 'transfer' || transaction.id === primaryTransfer?.id);
      if (shouldAnalyze) {
        this.database.enqueueOutbox('analyze_transaction', transaction.id, { transactionId: transaction.id });
      }
      if (!result.created && ['declined', 'failed', 'reverted'].includes(transaction.status)) {
        this.database.enqueueOutbox(
          'status_notification',
          `${transaction.id}:${transaction.status}`,
          { transactionId: transaction.id, status: transaction.status },
        );
      }
    }
  }
}
