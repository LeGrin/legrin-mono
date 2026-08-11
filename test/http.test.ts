import { afterEach, describe, expect, it, vi } from 'vitest';

import { FinanceDatabase } from '../src/db/database.js';
import { buildApp } from '../src/http/app.js';
import type { PipelineWorker } from '../src/pipeline/worker.js';
import { testConfig } from './helpers.js';

const databases: FinanceDatabase[] = [];
afterEach(() => {
  while (databases.length) databases.pop()!.close();
});

describe('HTTP API', () => {
  it('imports a Revolut CSV statement idempotently through the protected API', async () => {
    const config = testConfig();
    const database = new FinanceDatabase(':memory:');
    databases.push(database);
    const tick = vi.fn(async () => undefined);
    const app = await buildApp({ config, database, worker: { tick } as unknown as PipelineWorker });
    const csv = `Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance
CARD_PAYMENT,Current,2026-08-10 18:30:00,2026-08-10 18:31:00,Mlinar,-8.50,0.00,EUR,COMPLETED,1200.25
TRANSFER,Current,2026-08-11 09:15:00,2026-08-11 09:16:00,Rent,-700.00,0.50,EUR,COMPLETED,500.25
`;
    const request = () => app.inject({
      method: 'POST' as const,
      url: '/api/import/revolut/csv?account_id=personal-main',
      headers: {
        authorization: `Bearer ${config.INTERNAL_API_TOKEN}`,
        'content-type': 'text/csv',
      },
      payload: csv,
    });

    expect((await app.inject({ method: 'POST', url: '/api/import/revolut/csv', headers: { 'content-type': 'text/csv' }, payload: csv })).statusCode).toBe(401);
    const first = await request();
    expect(first.statusCode).toBe(202);
    expect(first.json()).toEqual({ rows: 3, accepted: 3, duplicates: 0 });
    const second = await request();
    expect(second.statusCode).toBe(202);
    expect(second.json()).toEqual({ rows: 3, accepted: 0, duplicates: 3 });
    expect(database.db.prepare('SELECT COUNT(*) AS count FROM webhook_events').get()).toMatchObject({ count: 3 });
    expect(tick).toHaveBeenCalledTimes(2);
    await app.close();
  });

  it('implements the Monobank handshake, rejects wrong secrets, and durably accepts events', async () => {
    const config = testConfig();
    const database = new FinanceDatabase(':memory:');
    databases.push(database);
    const tick = vi.fn(async () => undefined);
    const app = await buildApp({ config, database, worker: { tick } as unknown as PipelineWorker });

    expect((await app.inject({ method: 'GET', url: '/webhooks/monobank/wrong-secret-value' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/webhooks/monobank/${config.WEBHOOK_SHARED_SECRET}` })).statusCode).toBe(200);
    const malformed = await app.inject({
      method: 'POST',
      url: `/webhooks/monobank/${config.WEBHOOK_SHARED_SECRET}`,
      headers: { 'content-type': 'application/json' },
      payload: '',
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toEqual({ error: 'invalid_request' });

    const payload = {
      type: 'StatementItem',
      data: {
        account: 'a',
        statementItem: {
          id: 'http-1',
          time: 1_786_436_400,
          description: 'Konzum',
          hold: false,
          amount: -1234,
          currencyCode: 978,
        },
      },
    };
    const response = await app.inject({
      method: 'POST',
      url: `/webhooks/monobank/${config.WEBHOOK_SHARED_SECRET}`,
      payload,
    });
    expect(response.statusCode).toBe(200);
    expect(database.claimWebhook()).toMatchObject({ source: 'monobank', payload });
    expect(tick).toHaveBeenCalledOnce();
    await app.close();
  });

  it('protects the reporting API and persists a category correction', async () => {
    const config = testConfig();
    const database = new FinanceDatabase(':memory:');
    databases.push(database);
    database.upsertTransaction({
      id: 'monobank:a:manual-1',
      source: 'monobank',
      sourceTransactionId: 'manual-1',
      accountId: 'a',
      occurredAt: '2026-08-11T08:00:00.000Z',
      updatedAt: '2026-08-11T08:00:00.000Z',
      localDate: '2026-08-11',
      localMonth: '2026-08',
      description: 'Unknown',
      merchant: 'Unknown',
      merchantKey: 'UNKNOWN',
      amountMinor: -500,
      amountExponent: 2,
      currency: 'EUR',
      status: 'completed',
      kind: 'expense',
      needsReview: true,
      raw: {},
    });
    const tick = vi.fn(async () => undefined);
    const app = await buildApp({ config, database, worker: { tick } as unknown as PipelineWorker });

    expect((await app.inject({ method: 'GET', url: '/api/transactions' })).statusCode).toBe(401);
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/transactions/monobank%3Aa%3Amanual-1/category',
      headers: { authorization: `Bearer ${config.INTERNAL_API_TOKEN}` },
      payload: { category: 'Food & groceries', remember: true },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ category: 'Food & groceries', categorySource: 'manual', needsReview: false });
    expect(tick).toHaveBeenCalledOnce();
    await app.close();
  });
});
