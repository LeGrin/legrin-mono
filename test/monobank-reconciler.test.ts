import { afterEach, describe, expect, it, vi } from 'vitest';

import { FinanceDatabase } from '../src/db/database.js';
import { MonobankReconciler } from '../src/services/monobank-reconciler.js';
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

function storedHold() {
  return {
    id: 'monobank:mono-account:hold-1',
    source: 'monobank' as const,
    sourceTransactionId: 'hold-1',
    accountId: 'mono-account',
    occurredAt: '2026-08-17T12:00:00.000Z',
    updatedAt: '2026-08-17T12:00:00.000Z',
    localDate: '2026-08-17',
    localMonth: '2026-08',
    description: 'MLINAR CENTAR',
    merchant: 'Mlinar',
    merchantKey: 'MLINAR',
    mcc: 5812,
    amountMinor: -3500,
    amountExponent: 2,
    currency: 'EUR',
    status: 'pending' as const,
    kind: 'expense' as const,
    category: 'Restaurants & coffee' as const,
    categoryConfidence: 1,
    categorySource: 'manual' as const,
    needsReview: false,
    raw: {},
  };
}

describe('MonobankReconciler', () => {
  it('completes a stale hold when the authoritative statement reports it confirmed', async () => {
    const config = testConfig({ MONOBANK_TOKEN: 'mono-token-for-tests' });
    const database = createDatabase();
    database.upsertTransaction(storedHold());

    const fetchMock = vi.fn(async () => new Response(JSON.stringify([{
      id: 'hold-1',
      time: 1_786_968_000,
      description: 'MLINAR CENTAR',
      mcc: 5812,
      hold: false,
      amount: -149_000,
      operationAmount: -3500,
      currencyCode: 978,
    }]), { status: 200 }));
    const reconciler = new MonobankReconciler(config, database, logger, fetchMock as unknown as typeof fetch);

    const result = await reconciler.reconcileSafely();

    expect(result).toMatchObject({ accounts: 1, fetched: 1, updated: 1, created: 0 });
    expect(result.touchedDates).toEqual(['2026-08-17']);

    const transaction = database.getTransaction('monobank:mono-account:hold-1')!;
    expect(transaction.status).toBe('completed');
    expect(transaction.amountMinor).toBe(-3500);

    // The calendar day and budget mirror must be re-synced.
    const outbox = database.db.prepare(`SELECT kind, aggregate_key FROM outbox ORDER BY id`).all() as {
      kind: string;
      aggregate_key: string;
    }[];
    expect(outbox).toEqual(expect.arrayContaining([
      { kind: 'calendar_sync', aggregate_key: '2026-08-17' },
      { kind: 'budget_sync', aggregate_key: 'monobank:mono-account:hold-1' },
      { kind: 'status_notification', aggregate_key: 'monobank:mono-account:hold-1:completed' },
    ]));
  });

  it('picks up statement items the webhook never delivered', async () => {
    const config = testConfig({ MONOBANK_TOKEN: 'mono-token-for-tests' });
    const database = createDatabase();
    database.upsertTransaction(storedHold());

    const fetchMock = vi.fn(async () => new Response(JSON.stringify([
      {
        id: 'hold-1',
        time: 1_786_968_000,
        description: 'MLINAR CENTAR',
        mcc: 5812,
        hold: false,
        amount: -149_000,
        operationAmount: -3500,
        currencyCode: 978,
      },
      {
        id: 'missed-1',
        time: 1_787_052_000,
        description: 'PLERS',
        mcc: 5411,
        hold: false,
        amount: -212_000,
        operationAmount: -5000,
        currencyCode: 978,
      },
    ]), { status: 200 }));
    const reconciler = new MonobankReconciler(config, database, logger, fetchMock as unknown as typeof fetch);

    const result = await reconciler.reconcileSafely();

    expect(result).toMatchObject({ accounts: 1, fetched: 2, updated: 1, created: 1 });
    expect(database.getTransaction('monobank:mono-account:missed-1')?.status).toBe('completed');
  });

  it('requests the configured rolling window with the token header', async () => {
    const config = testConfig({
      MONOBANK_TOKEN: 'mono-token-for-tests',
      MONOBANK_RECONCILE_WINDOW_SECONDS: '3600',
    });
    const database = createDatabase();
    database.upsertTransaction(storedHold());

    const fetchMock = vi.fn(async () => new Response(JSON.stringify([]), { status: 200 }));
    const now = new Date('2026-08-18T06:00:00Z');
    const reconciler = new MonobankReconciler(
      config,
      database,
      logger,
      fetchMock as unknown as typeof fetch,
      () => now,
    );

    const result = await reconciler.reconcileSafely();

    expect(result).toMatchObject({ accounts: 1, fetched: 0, updated: 0, created: 0 });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, request] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/personal/statement/mono-account/');
    expect(url.endsWith(`/${Math.floor(now.getTime() / 1000)}`)).toBe(true);
    expect(request.headers).toMatchObject({ 'X-Token': 'mono-token-for-tests' });
  });

  it('keeps going when one account fails and does not crash the run', async () => {
    const config = testConfig({ MONOBANK_TOKEN: 'mono-token-for-tests' });
    const database = createDatabase();
    database.upsertTransaction(storedHold());
    database.upsertTransaction({ ...storedHold(), id: 'monobank:mono-other:hold-2', sourceTransactionId: 'hold-2', accountId: 'mono-other' });

    let calls = 0;
    const fetchMock = vi.fn(async (url: string) => {
      calls += 1;
      if (url.includes('mono-account')) {
        return new Response(JSON.stringify({ errorDescription: 'unknown account' }), { status: 404 });
      }
      return new Response(JSON.stringify([{
        id: 'hold-2',
        time: 1_786_968_000,
        description: 'PLERS',
        mcc: 5411,
        hold: false,
        amount: -1000,
        currencyCode: 980,
      }]), { status: 200 });
    });
    const warn = vi.fn();
    const reconciler = new MonobankReconciler(
      config,
      database,
      { ...logger, warn },
      fetchMock as unknown as typeof fetch,
    );

    const result = await reconciler.reconcileSafely();

    expect(result).toMatchObject({ accounts: 1, fetched: 1, updated: 1 });
    expect(warn).toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does nothing when the token is missing', async () => {
    const config = testConfig();
    const database = createDatabase();
    database.upsertTransaction(storedHold());
    const fetchMock = vi.fn();
    const reconciler = new MonobankReconciler(config, database, logger, fetchMock as unknown as typeof fetch);

    const result = await reconciler.reconcileSafely();

    expect(result).toMatchObject({ accounts: 0, fetched: 0, updated: 0, created: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
