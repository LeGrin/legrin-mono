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

  it('protects Calendar backfill and queues one sync per transaction date', async () => {
    const config = testConfig({
      GOOGLE_CALENDAR_ID: 'finance-calendar',
      GOOGLE_SIDECAR_URL: 'http://google-sidecar:19200',
      GOOGLE_SIDECAR_TOKEN: 'google-sidecar-token-for-tests',
      GOOGLE_SIDECAR_USER_ID: '778286',
    });
    const database = new FinanceDatabase(':memory:');
    databases.push(database);
    for (const [id, localDate] of [
      ['calendar-1', '2026-08-10'],
      ['calendar-2', '2026-08-11'],
      ['calendar-3', '2026-08-11'],
    ] as const) {
      database.upsertTransaction({
        id: `monobank:a:${id}`,
        source: 'monobank',
        sourceTransactionId: id,
        accountId: 'a',
        occurredAt: `${localDate}T08:00:00.000Z`,
        updatedAt: `${localDate}T08:00:00.000Z`,
        localDate,
        localMonth: '2026-08',
        description: 'Calendar acceptance',
        merchant: 'Calendar acceptance',
        merchantKey: 'CALENDAR ACCEPTANCE',
        amountMinor: -500,
        amountExponent: 2,
        currency: 'EUR',
        status: 'completed',
        kind: 'expense',
        needsReview: false,
        raw: {},
      });
    }
    const tick = vi.fn(async () => undefined);
    const app = await buildApp({ config, database, worker: { tick } as unknown as PipelineWorker });

    expect((await app.inject({ method: 'POST', url: '/api/admin/sync-calendar' })).statusCode).toBe(401);
    const response = await app.inject({
      method: 'POST',
      url: '/api/admin/sync-calendar',
      headers: { authorization: `Bearer ${config.INTERNAL_API_TOKEN}` },
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ enqueued: 2 });
    expect(database.db.prepare("SELECT kind, aggregate_key, payload_json FROM outbox WHERE kind = 'calendar_sync' ORDER BY aggregate_key").all())
      .toEqual([
        { kind: 'calendar_sync', aggregate_key: '2026-08-10', payload_json: '{"localDate":"2026-08-10"}' },
        { kind: 'calendar_sync', aggregate_key: '2026-08-11', payload_json: '{"localDate":"2026-08-11"}' },
      ]);
    expect(tick).toHaveBeenCalledOnce();

    expect((await app.inject({ method: 'GET', url: '/api/reports/daily?date=2026-08-11' })).statusCode).toBe(401);
    const report = await app.inject({
      method: 'GET',
      url: '/api/reports/daily?date=2026-08-11',
      headers: { authorization: `Bearer ${config.INTERNAL_API_TOKEN}` },
    });
    expect(report.statusCode).toBe(200);
    expect(report.json()).toMatchObject({
      date: '2026-08-11',
      transactionCount: 2,
      statuses: { completed: 2 },
      start: { date: '2026-08-11' },
      end: { date: '2026-08-12' },
    });
    expect(report.json().summary).toMatch(/10,00\sEUR · 2 підтверджених витрат/u);
    expect(report.json().description).toContain('Рухи коштів за 2026-08-11');
    await app.close();
  });

  it('previews and applies Monobank currency reconciliation without replaying notifications', async () => {
    const config = testConfig();
    const database = new FinanceDatabase(':memory:');
    databases.push(database);
    database.upsertTransaction({
      id: 'monobank:a:cross-currency',
      source: 'monobank',
      sourceTransactionId: 'cross-currency',
      accountId: 'a',
      occurredAt: '2026-08-11T12:00:00.000Z',
      updatedAt: '2026-08-11T12:00:00.000Z',
      localDate: '2026-08-11',
      localMonth: '2026-08',
      description: 'Mlinar',
      merchant: 'Mlinar',
      merchantKey: 'MLINAR',
      amountMinor: -14_107,
      amountExponent: 2,
      currency: 'EUR',
      status: 'pending',
      kind: 'expense',
      needsReview: false,
      raw: {
        type: 'StatementItem',
        data: {
          account: 'a',
          statementItem: {
            id: 'cross-currency',
            time: 1_786_436_400,
            description: 'Mlinar',
            hold: true,
            amount: -14_107,
            operationAmount: -270,
            currencyCode: 978,
          },
        },
      },
    });
    const tick = vi.fn(async () => undefined);
    const app = await buildApp({ config, database, worker: { tick } as unknown as PipelineWorker });
    const auth = { authorization: `Bearer ${config.INTERNAL_API_TOKEN}` };

    expect((await app.inject({ method: 'POST', url: '/api/admin/renormalize/monobank' })).statusCode).toBe(401);
    const preview = await app.inject({
      method: 'POST',
      url: '/api/admin/renormalize/monobank',
      headers: auth,
      payload: { dry_run: true },
    });
    expect(preview.json()).toMatchObject({
      dryRun: true,
      scanned: 1,
      changed: 1,
      changes: [{ merchant: 'Mlinar', before: { amountMinor: -14_107 }, after: { amountMinor: -270, currency: 'EUR' } }],
    });
    expect(database.getTransaction('monobank:a:cross-currency')?.amountMinor).toBe(-14_107);
    expect(tick).not.toHaveBeenCalled();

    const applied = await app.inject({
      method: 'POST',
      url: '/api/admin/renormalize/monobank',
      headers: auth,
      payload: { dry_run: false },
    });
    expect(applied.json()).toMatchObject({ dryRun: false, scanned: 1, changed: 1 });
    expect(database.getTransaction('monobank:a:cross-currency')?.amountMinor).toBe(-270);
    expect(database.db.prepare("SELECT kind, status FROM outbox ORDER BY kind").all()).toEqual([
      { kind: 'budget_sync', status: 'pending' },
      { kind: 'calendar_sync', status: 'pending' },
    ]);
    expect(database.db.prepare("SELECT COUNT(*) AS count FROM outbox WHERE kind = 'status_notification'").get())
      .toMatchObject({ count: 0 });
    expect(tick).toHaveBeenCalledOnce();
    await app.close();
  });
});
