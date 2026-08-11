import { afterEach, describe, expect, it } from 'vitest';

import { FinanceDatabase } from '../src/db/database.js';
import { renderDailyEvent } from '../src/services/calendar.js';
import { TransactionAnalyzer } from '../src/services/categorizer.js';
import { TelegramNotifier } from '../src/services/telegram.js';
import { PipelineWorker } from '../src/pipeline/worker.js';
import { testConfig } from './helpers.js';

const databases: FinanceDatabase[] = [];
afterEach(() => {
  while (databases.length) databases.pop()!.close();
});

function createDatabase(): FinanceDatabase {
  const database = new FinanceDatabase(':memory:');
  databases.push(database);
  return database;
}

const logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

describe('durable transaction pipeline', () => {
  it('reclaims a queue item left processing by a crashed worker', () => {
    const database = createDatabase();
    database.enqueueWebhook('monobank', 'crashed-event', { hello: 'world' });
    const firstClaim = database.claimWebhook();
    expect(firstClaim?.attempts).toBe(1);
    database.db.prepare(`
      UPDATE webhook_events SET updated_at = '2000-01-01T00:00:00.000Z' WHERE id = ?
    `).run(firstClaim!.id);
    expect(database.claimWebhook()).toMatchObject({ id: firstClaim!.id, attempts: 2 });
  });

  it('does not let an older Revolut state event regress a newer status', () => {
    const database = createDatabase();
    database.upsertTransaction({
      id: 'revolut_business:business-1:leg-1',
      source: 'revolut_business',
      sourceTransactionId: 'business-1',
      sourceLegId: 'leg-1',
      accountId: 'business-eur',
      occurredAt: '2026-08-11T08:00:00.000Z',
      updatedAt: '2026-08-11T08:00:00.000Z',
      localDate: '2026-08-11',
      localMonth: '2026-08',
      description: 'Supplier',
      merchant: 'Supplier',
      merchantKey: 'SUPPLIER',
      amountMinor: -1000,
      amountExponent: 2,
      currency: 'EUR',
      status: 'pending',
      kind: 'expense',
      needsReview: true,
      raw: {},
    });
    expect(database.updateRevolutStatus('business-1', 'completed', '2026-08-11T10:00:00.000Z', {})).toHaveLength(1);
    expect(database.updateRevolutStatus('business-1', 'failed', '2026-08-11T09:00:00.000Z', {})).toHaveLength(0);
    expect(database.getTransaction('revolut_business:business-1:leg-1')?.status).toBe('completed');
  });

  it('deduplicates webhooks and processes Monobank into categorized reporting', async () => {
    const config = testConfig();
    const database = createDatabase();
    const worker = new PipelineWorker(
      config,
      database,
      { syncDay: async () => undefined } as never,
      new TransactionAnalyzer(config, database),
      new TelegramNotifier(config),
      logger,
    );
    const payload = {
      type: 'StatementItem',
      data: {
        account: 'mono-account',
        statementItem: {
          id: 'pizza-1',
          time: 1_786_436_400,
          description: 'MLINAR DRAŠKOVIĆEVA',
          mcc: 5812,
          hold: false,
          amount: -850,
          currencyCode: 978,
        },
      },
    };
    expect(database.enqueueWebhook('monobank', 'same-event', payload)).toBe(true);
    expect(database.enqueueWebhook('monobank', 'same-event', payload)).toBe(false);

    await worker.tick();

    const transaction = database.getTransaction('monobank:mono-account:pizza-1');
    expect(transaction).toMatchObject({
      category: 'Restaurants & coffee',
      categorySource: 'hermes',
      needsReview: false,
      notifiedAt: expect.any(String),
    });
    expect(database.getMonthSummary(transaction!.localMonth)).toEqual([
      expect.objectContaining({ category: 'Restaurants & coffee', currency: 'EUR', amountMinor: 850, count: 1 }),
    ]);
  });

  it('remembers a manual merchant correction for later transactions', () => {
    const database = createDatabase();
    const transaction = {
      id: 'revolut_personal:eur:1',
      source: 'revolut_personal' as const,
      sourceTransactionId: '1',
      accountId: 'eur',
      occurredAt: '2026-08-11T10:00:00.000Z',
      updatedAt: '2026-08-11T10:00:00.000Z',
      localDate: '2026-08-11',
      localMonth: '2026-08',
      description: 'Mystery Place',
      merchant: 'Mystery Place',
      merchantKey: 'MYSTERY PLACE',
      amountMinor: -1500,
      amountExponent: 2,
      currency: 'EUR',
      status: 'completed' as const,
      kind: 'expense' as const,
      needsReview: true,
      raw: {},
    };
    database.upsertTransaction(transaction);
    database.setCategory(transaction.id, 'Health', true);
    database.setCategory(transaction.id, 'Shopping', true);

    expect(database.findCategoryRule('MYSTERY PLACE')).toBe('Shopping');
    expect(database.db.prepare('SELECT COUNT(*) AS count FROM category_rules WHERE merchant_key = ?').get('MYSTERY PLACE')).toMatchObject({ count: 1 });
    database.setCategory(transaction.id, 'Transfers', false);
    expect(database.getTransaction(transaction.id)?.kind).toBe('transfer');
  });

  it('renders one all-day event with a daily budget signal and correct exclusive end date', () => {
    const config = testConfig();
    const database = createDatabase();
    database.upsertTransaction({
      id: 'monobank:a:1',
      source: 'monobank',
      sourceTransactionId: '1',
      accountId: 'a',
      occurredAt: '2026-08-11T08:00:00.000Z',
      updatedAt: '2026-08-11T08:00:00.000Z',
      localDate: '2026-08-11',
      localMonth: '2026-08',
      description: 'Mlinar',
      merchant: 'Mlinar',
      merchantKey: 'MLINAR',
      amountMinor: -15_000,
      amountExponent: 2,
      currency: 'EUR',
      status: 'completed',
      kind: 'expense',
      category: 'Restaurants & coffee',
      categoryConfidence: 1,
      categorySource: 'manual',
      needsReview: false,
      raw: {},
    });
    const rendered = renderDailyEvent(
      '2026-08-11',
      database.listTransactions({ localDate: '2026-08-11' }),
      database.getMonthSummary('2026-08'),
      config,
    );
    expect(rendered.summary).toContain('🔴');
    expect(rendered.summary).toContain('150,00');
    expect(rendered.description).toContain('[mono] Mlinar');
    expect(rendered.end.date).toBe('2026-08-12');
  });
});
