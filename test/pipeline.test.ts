import { afterEach, describe, expect, it, vi } from 'vitest';

import { FinanceDatabase } from '../src/db/database.js';
import { CalendarSync, renderDailyEvent } from '../src/services/calendar.js';
import { TransactionAnalyzer } from '../src/services/categorizer.js';
import { TelegramNotifier } from '../src/services/telegram.js';
import { PipelineWorker } from '../src/pipeline/worker.js';
import { testConfig } from './helpers.js';

const databases: FinanceDatabase[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
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

  it('keeps pending holds out of totals and sends an accurate total when the payment completes', async () => {
    const config = testConfig();
    const database = createDatabase();
    database.upsertTransaction({
      id: 'monobank:mono-account:confirmed-before',
      source: 'monobank',
      sourceTransactionId: 'confirmed-before',
      accountId: 'mono-account',
      occurredAt: '2026-08-10T12:00:00.000Z',
      updatedAt: '2026-08-10T12:00:00.000Z',
      localDate: '2026-08-10',
      localMonth: '2026-08',
      description: 'Mlinar',
      merchant: 'Mlinar',
      merchantKey: 'MLINAR',
      mcc: 5812,
      amountMinor: -1000,
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
    const messages: string[] = [];
    const worker = new PipelineWorker(
      config,
      database,
      { syncDay: async () => undefined } as never,
      new TransactionAnalyzer(config, database),
      { send: async (message: string) => { messages.push(message); } } as TelegramNotifier,
      logger,
    );
    const statementItem = {
      id: 'pending-then-completed',
      time: 1_786_436_400,
      description: 'MLINAR CENTAR',
      mcc: 5812,
      amount: -850,
      currencyCode: 978,
    };

    database.enqueueWebhook('monobank', 'pending-event', {
      type: 'StatementItem',
      data: { account: 'mono-account', statementItem: { ...statementItem, hold: true } },
    });
    await worker.tick();

    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('Банк зарезервував 8,50');
    expect(messages[0]).toContain('Поки не додаю цю суму до місячних витрат');
    expect(database.getMonthSummary('2026-08')).toEqual([
      expect.objectContaining({ category: 'Restaurants & coffee', amountMinor: 1000, count: 1 }),
    ]);

    database.enqueueWebhook('monobank', 'completed-event', {
      type: 'StatementItem',
      data: { account: 'mono-account', statementItem: { ...statementItem, hold: false } },
    });
    await worker.tick();

    expect(messages).toHaveLength(2);
    expect(messages[1]).toContain('Платіж підтверджено: 8,50');
    expect(messages[1]).toContain('Цього місяця в категорії вже 18,50');
    expect(messages[1]).toContain('Calendar sync ще не ввімкнено');
    expect(database.getMonthSummary('2026-08')).toEqual([
      expect.objectContaining({ category: 'Restaurants & coffee', amountMinor: 1850, count: 2 }),
    ]);
  });

  it('includes the current confirmed payment in its initial category total', async () => {
    const config = testConfig();
    const database = createDatabase();
    const base = {
      source: 'monobank' as const,
      accountId: 'mono-account',
      amountExponent: 2,
      currency: 'EUR',
      kind: 'expense' as const,
      status: 'completed' as const,
      needsReview: false,
      raw: {},
    };
    database.upsertTransaction({
      ...base,
      id: 'monobank:mono-account:existing',
      sourceTransactionId: 'existing',
      occurredAt: '2026-08-10T12:00:00.000Z',
      updatedAt: '2026-08-10T12:00:00.000Z',
      localDate: '2026-08-10',
      localMonth: '2026-08',
      description: 'Mlinar',
      merchant: 'Mlinar',
      merchantKey: 'MLINAR',
      mcc: 5812,
      amountMinor: -1000,
      category: 'Restaurants & coffee',
      categoryConfidence: 1,
      categorySource: 'manual',
    });
    database.upsertTransaction({
      ...base,
      id: 'monobank:mono-account:current',
      sourceTransactionId: 'current',
      occurredAt: '2026-08-11T12:00:00.000Z',
      updatedAt: '2026-08-11T12:00:00.000Z',
      localDate: '2026-08-11',
      localMonth: '2026-08',
      description: 'Mlinar',
      merchant: 'Mlinar',
      merchantKey: 'MLINAR',
      mcc: 5812,
      amountMinor: -850,
    });

    const analysis = await new TransactionAnalyzer(config, database).analyze(
      database.getTransaction('monobank:mono-account:current')!,
    );

    expect(analysis.user_message).toContain('Цього місяця в категорії вже 18,50');
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

  it('syncs the daily finance event through the Google OAuth sidecar', async () => {
    const config = testConfig({
      GOOGLE_CALENDAR_ID: 'finance-calendar@example.com',
      GOOGLE_SIDECAR_URL: 'http://google-sidecar:19200',
      GOOGLE_SIDECAR_TOKEN: 'sidecar-token-for-tests',
      GOOGLE_SIDECAR_USER_ID: 'telegram-user-1',
    });
    const database = createDatabase();
    database.upsertTransaction({
      id: 'monobank:a:calendar-sidecar-1',
      source: 'monobank',
      sourceTransactionId: 'calendar-sidecar-1',
      accountId: 'a',
      occurredAt: '2026-08-11T08:00:00.000Z',
      updatedAt: '2026-08-11T08:00:00.000Z',
      localDate: '2026-08-11',
      localMonth: '2026-08',
      description: 'Mlinar',
      merchant: 'Mlinar',
      merchantKey: 'MLINAR',
      amountMinor: -850,
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
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ event: { id: 'sidecar-event-1' } }), { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);

    await new CalendarSync(config, database).syncDay('2026-08-11');

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, request] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://google-sidecar:19200/calendar/events/create');
    expect(request.headers).toMatchObject({ Authorization: 'Bearer sidecar-token-for-tests' });
    expect(JSON.parse(String(request.body))).toMatchObject({
      user_id: 'telegram-user-1',
      calendarId: 'finance-calendar@example.com',
      startDateTime: '2026-08-11T00:00:00',
      endDateTime: '2026-08-12T00:00:00',
    });
    expect(database.getCalendarEvent('2026-08-11')).toMatchObject({ eventId: 'sidecar-event-1' });
  });

  it('uses live Hermes only for classification and discards ungrounded model prose', async () => {
    const config = testConfig({
      HERMES_AGENT_URL: 'http://hermes.test',
      HERMES_AGENT_KEY: 'hermes-test-key',
    });
    const database = createDatabase();
    database.upsertTransaction({
      id: 'monobank:a:hermes-safe-1',
      source: 'monobank',
      sourceTransactionId: 'hermes-safe-1',
      accountId: 'a',
      occurredAt: '2026-08-11T08:00:00.000Z',
      updatedAt: '2026-08-11T08:00:00.000Z',
      localDate: '2026-08-11',
      localMonth: '2026-08',
      description: 'MLINAR CENTAR',
      merchant: 'Mlinar',
      merchantKey: 'MLINAR',
      mcc: 5812,
      amountMinor: -850,
      amountExponent: 2,
      currency: 'EUR',
      status: 'completed',
      kind: 'expense',
      needsReview: true,
      raw: {},
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            category: 'Shopping',
            confidence: 0.99,
            needs_clarification: false,
            clarification_question: null,
            user_message: 'Invented city and unsupported personal claim.',
            insight: 'Invented external merchant fact.',
          }),
        },
      }],
    }), { status: 200 })));

    const analysis = await new TransactionAnalyzer(config, database).analyze(
      database.getTransaction('monobank:a:hermes-safe-1')!,
    );

    expect(analysis.category).toBe('Restaurants & coffee');
    expect(analysis.user_message).toContain('Зафіксував 8,50');
    expect(analysis.user_message).not.toContain('Invented');
    expect(analysis.insight).toBeNull();
  });
});
