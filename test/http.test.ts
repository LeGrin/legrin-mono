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
  it('implements the Monobank handshake, rejects wrong secrets, and durably accepts events', async () => {
    const config = testConfig();
    const database = new FinanceDatabase(':memory:');
    databases.push(database);
    const tick = vi.fn(async () => undefined);
    const app = await buildApp({ config, database, worker: { tick } as unknown as PipelineWorker });

    expect((await app.inject({ method: 'GET', url: '/webhooks/monobank/wrong-secret-value' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/webhooks/monobank/${config.WEBHOOK_SHARED_SECRET}` })).statusCode).toBe(200);

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
