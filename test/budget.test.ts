import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';
import type { StoredTransaction } from '../src/domain/transaction.js';
import { BudgetMirror } from '../src/services/budget.js';

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe('BudgetMirror', () => {
  it('sends a sanitized idempotent transaction mirror without raw provider data', async () => {
    let captured: {
      url: string | undefined;
      headers: Record<string, string | string[] | undefined> | undefined;
      body: unknown;
    } = { url: undefined, headers: undefined, body: undefined };
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      request.on('end', () => {
        captured = {
          url: request.url,
          headers: request.headers,
          body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown,
        };
        response.writeHead(201, { 'content-type': 'application/json' });
        response.end('{"created":true}');
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing test address');

    const config = loadConfig({
      NODE_ENV: 'test',
      WEBHOOK_SHARED_SECRET: 'webhook-secret-long-enough',
      INTERNAL_API_TOKEN: 'internal-token-that-is-long-enough',
      BUDGET_API_URL: `http://127.0.0.1:${address.port}`,
      BUDGET_API_TOKEN: 'budget-token-that-is-private',
    });
    const transaction: StoredTransaction = {
      id: 'monobank:account:tx/1',
      source: 'monobank',
      sourceTransactionId: 'tx/1',
      accountId: 'account',
      occurredAt: '2026-08-11T10:00:00.000Z',
      updatedAt: '2026-08-11T10:00:00.000Z',
      localDate: '2026-08-11',
      localMonth: '2026-08',
      description: 'Coffee',
      merchant: 'Cafe',
      merchantKey: 'CAFE',
      amountMinor: -550,
      amountExponent: 2,
      currency: 'EUR',
      status: 'completed',
      kind: 'expense',
      category: 'Restaurants & coffee',
      categoryConfidence: 0.95,
      categorySource: 'hermes',
      needsReview: false,
      raw: { providerSecret: 'must-not-leave-finance' },
      analysisJson: '{"category":"Restaurants & coffee"}',
      analyzedAt: '2026-08-11T10:00:01.000Z',
      firstSeenAt: '2026-08-11T10:00:00.500Z',
      lastSeenAt: '2026-08-11T10:00:01.500Z',
    };

    await new BudgetMirror(config).sync(transaction);

    expect(captured.url).toBe('/internal/v1/transactions/monobank%3Aaccount%3Atx%2F1');
    expect(captured.headers?.authorization).toBe('Bearer budget-token-that-is-private');
    expect(captured.headers?.['x-budget-actor']).toBe('finance-sync');
    expect(captured.headers?.['idempotency-key']).toContain('monobank:account:tx/1');
    expect(captured.body).toMatchObject({
      id: transaction.id,
      category: 'Restaurants & coffee',
      amountMinor: -550,
      analysisJson: { category: 'Restaurants & coffee' },
    });
    expect(captured.body).not.toHaveProperty('raw');
  });
});
