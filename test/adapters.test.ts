import { describe, expect, it } from 'vitest';

import { monobankDedupeKey, monobankWebhookSchema, normalizeMonobank } from '../src/adapters/monobank.js';
import {
  normalizeRevolutPersonal,
  revolutPersonalTransactionSchema,
  verifyRevolutSignature,
} from '../src/adapters/revolut.js';

describe('bank adapters', () => {
  it('normalizes a Monobank expense and changes dedupe key when hold changes', () => {
    const base = {
      type: 'StatementItem',
      data: {
        account: 'mono-account',
        statementItem: {
          id: 'mono-1',
          time: 1_723_372_200,
          description: 'Mlinar Centar',
          mcc: 5812,
          hold: true,
          amount: -850,
          currencyCode: 978,
        },
      },
    };
    const pending = monobankWebhookSchema.parse(base);
    const completed = monobankWebhookSchema.parse({
      ...base,
      data: { ...base.data, statementItem: { ...base.data.statementItem, hold: false } },
    });

    const normalized = normalizeMonobank(pending, 'Europe/Zagreb');
    expect(normalized).toMatchObject({
      id: 'monobank:mono-account:mono-1',
      source: 'monobank',
      amountMinor: -850,
      currency: 'EUR',
      status: 'pending',
      kind: 'expense',
      merchantKey: 'MLINAR CENTAR',
    });
    expect(monobankDedupeKey(pending)).not.toBe(monobankDedupeKey(completed));
  });

  it('normalizes a personal Revolut adapter transaction', () => {
    const payload = revolutPersonalTransactionSchema.parse({
      id: 'rev-1',
      accountId: 'personal-eur',
      occurredAt: '2026-08-11T08:30:00.000Z',
      description: 'Spotify',
      amount: -10.99,
      currency: 'eur',
    });
    expect(normalizeRevolutPersonal(payload, 'Europe/Zagreb')).toMatchObject({
      id: 'revolut_personal:personal-eur:rev-1',
      amountMinor: -1099,
      currency: 'EUR',
      status: 'completed',
      kind: 'expense',
      localDate: '2026-08-11',
    });
  });

  it('uses ISO 4217 minor units for three-decimal currencies', () => {
    const payload = revolutPersonalTransactionSchema.parse({
      id: 'rev-kwd',
      accountId: 'personal-kwd',
      occurredAt: '2026-08-11T08:30:00.000Z',
      description: 'Coffee',
      amount: -1.234,
      currency: 'KWD',
    });
    expect(normalizeRevolutPersonal(payload, 'UTC')).toMatchObject({
      amountMinor: -1234,
      amountExponent: 3,
    });
  });

  it('matches the official Revolut webhook signature vector and preserves raw bytes', () => {
    const rawBody = '{"data":{"id":"645a7696-22f3-aa47-9c74-cbae0449cc46","new_state":"completed","old_state":"pending","request_id":"app_charges-9f5d5eb3-1e06-46c5-b1c0-3914763e0bcb"},"event":"TransactionStateChanged","timestamp":"2023-05-09T16:36:38.028960Z"}';
    const options = {
      rawBody,
      timestamp: '1683650202360',
      signatureHeader: 'v1=bca326fb378d0da7f7c490ad584a8106bab9723d8d9cdd0d50b4c5b3be3837c0',
      secret: 'wsk_r59a4HfWVAKycbCaNO1RvgCJec02gRd8',
      toleranceSeconds: 300,
      nowMs: 1_683_650_202_360,
    };
    expect(verifyRevolutSignature(options)).toBe(true);
    expect(verifyRevolutSignature({ ...options, rawBody: `${rawBody}\n` })).toBe(false);
    expect(verifyRevolutSignature({ ...options, nowMs: options.nowMs + 301_000 })).toBe(false);
  });
});
