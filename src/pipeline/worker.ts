import type { AppConfig } from '../config.js';
import type { FinanceDatabase, QueueItem } from '../db/database.js';
import { money } from '../domain/transaction.js';
import { DeferredEventError, WebhookProcessor } from './processor.js';
import type { CalendarSync } from '../services/calendar.js';
import type { TransactionAnalyzer, TransactionAnalysis } from '../services/categorizer.js';
import type { TelegramNotifier } from '../services/telegram.js';
import { BudgetMirror } from '../services/budget.js';

interface Logger {
  info(bindings: object, message: string): void;
  error(bindings: object, message: string): void;
  warn(bindings: object, message: string): void;
}

export class PipelineWorker {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private readonly webhookProcessor: WebhookProcessor;
  private readonly budget: BudgetMirror;

  constructor(
    private readonly config: AppConfig,
    private readonly database: FinanceDatabase,
    private readonly calendar: CalendarSync,
    private readonly analyzer: TransactionAnalyzer,
    private readonly telegram: TelegramNotifier,
    private readonly logger: Logger,
    budget?: BudgetMirror,
  ) {
    this.webhookProcessor = new WebhookProcessor(config, database);
    this.budget = budget ?? new BudgetMirror(config);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.config.WORKER_INTERVAL_MS);
    this.timer.unref();
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (let index = 0; index < 20; index += 1) {
        const webhook = this.database.claimWebhook();
        if (!webhook) break;
        this.handleWebhook(webhook);
      }
      for (let index = 0; index < 20; index += 1) {
        const outbox = this.database.claimOutbox();
        if (!outbox) break;
        await this.handleOutbox(outbox);
      }
    } finally {
      this.running = false;
    }
  }

  private handleWebhook(item: QueueItem): void {
    try {
      this.webhookProcessor.process(item.source ?? '', item.payload);
      this.database.completeWebhook(item.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const deferSeconds = error instanceof DeferredEventError ? error.deferSeconds : undefined;
      this.database.failWebhook(item.id, item.attempts, message, this.config.MAX_DELIVERY_ATTEMPTS, deferSeconds);
      this.logger.warn({ webhookId: item.id, source: item.source, attempts: item.attempts, error: message }, 'webhook processing failed');
    }
  }

  private async handleOutbox(item: QueueItem): Promise<void> {
    try {
      if (item.kind === 'calendar_sync') {
        const payload = item.payload as { localDate: string };
        await this.calendar.syncDay(payload.localDate);
      } else if (item.kind === 'analyze_transaction') {
        await this.analyzeTransaction(item.payload as { transactionId: string });
      } else if (item.kind === 'status_notification') {
        await this.sendStatusNotification(item.payload as { transactionId: string; status: string });
      } else if (item.kind === 'budget_sync') {
        await this.syncBudget(item.payload as { transactionId: string });
      } else {
        throw new Error(`Unsupported outbox kind: ${item.kind}`);
      }
      this.database.completeOutbox(item.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.database.failOutbox(item.id, item.attempts, message, this.config.MAX_DELIVERY_ATTEMPTS);
      this.logger.error({ outboxId: item.id, kind: item.kind, attempts: item.attempts, error: message }, 'outbox delivery failed');
    }
  }

  private async analyzeTransaction(payload: { transactionId: string }): Promise<void> {
    let transaction = this.database.getTransaction(payload.transactionId);
    if (!transaction) throw new Error(`Transaction not found: ${payload.transactionId}`);
    if (['declined', 'failed', 'reverted'].includes(transaction.status)) return;

    let analysis: TransactionAnalysis;
    if (transaction.analysisJson) {
      analysis = JSON.parse(transaction.analysisJson) as TransactionAnalysis;
    } else {
      analysis = await this.analyzer.analyze(transaction);
      const needsReview = analysis.needs_clarification
        || !analysis.category
        || analysis.confidence < this.config.CATEGORY_CONFIDENCE_THRESHOLD;
      this.database.setAnalysis(
        transaction.id,
        analysis,
        analysis.category ?? undefined,
        analysis.confidence,
        needsReview,
      );
      this.database.enqueueOutbox('calendar_sync', transaction.localDate, { localDate: transaction.localDate }, true);
      this.database.enqueueOutbox('budget_sync', transaction.id, { transactionId: transaction.id }, true);
      transaction = this.database.getTransaction(transaction.id)!;
    }
    if (!transaction.notifiedAt) {
      await this.telegram.send(analysis.user_message);
      this.database.markNotified(transaction.id);
    }
    this.logger.info({ transactionId: transaction.id, category: analysis.category, confidence: analysis.confidence }, 'transaction analyzed');
  }

  private async syncBudget(payload: { transactionId: string }): Promise<void> {
    const transaction = this.database.getTransaction(payload.transactionId);
    if (!transaction) throw new Error(`Transaction not found: ${payload.transactionId}`);
    await this.budget.sync(transaction);
  }

  private async sendStatusNotification(payload: { transactionId: string; status: string }): Promise<void> {
    const transaction = this.database.getTransaction(payload.transactionId);
    if (!transaction) return;
    const amount = money(Math.abs(transaction.amountMinor), transaction.currency, transaction.amountExponent);
    const syncText = this.config.calendarEnabled
      ? 'Звіт, Budget і Calendar оновлено.'
      : 'Звіт і Budget оновлено; Calendar sync ще не ввімкнено.';
    if (payload.status === 'completed') {
      const totals = transaction.category
        ? this.database.getMonthSummary(transaction.localMonth)
          .filter((row) => row.category === transaction.category)
          .map((row) => money(row.amountMinor, row.currency, row.amountExponent))
          .join(' + ')
        : '';
      const categoryText = transaction.category ? ` → ${transaction.category}` : '';
      const totalText = totals ? ` Цього місяця в категорії вже ${totals}.` : '';
      await this.telegram.send(`✅ Платіж підтверджено: ${amount} у ${transaction.merchant}${categoryText}.${totalText} ${syncText}`);
      return;
    }
    await this.telegram.send(`↩️ ${transaction.merchant}: операція ${amount} має статус ${payload.status} і не враховується у витратах. ${syncText}`);
  }
}
