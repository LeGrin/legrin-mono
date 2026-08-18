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
          amount: -44_430,
          operationAmount: -850,
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

  it('pairs Monobank operationAmount with currencyCode instead of mislabelling the account debit', () => {
    const payload = monobankWebhookSchema.parse({
      type: 'StatementItem',
      data: {
        account: 'mono-uah-account',
        statementItem: {
          id: 'cross-currency-1',
          time: 1_786_436_400,
          description: 'Mlinar',
          hold: true,
          amount: -14_107,
          operationAmount: -270,
          currencyCode: 978,
        },
      },
    });

    expect(normalizeMonobank(payload, 'Europe/Zagreb')).toMatchObject({
      amountMinor: -270,
      currency: 'EUR',
      status: 'pending',
      kind: 'expense',
    });
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

describe('internal transfer classification', () => {
  const account = 'mono-account';
  const base = { time: 1_786_968_000, currencyCode: 978, amount: -14_473, operationAmount: -280, mcc: 6051 };

  function normalizeWith(description: string, counterName?: string) {
    const item = { id: 'item-1', description, hold: false, ...base, ...(counterName ? { counterName } : {}) };
    return normalizeMonobank(
      { type: 'StatementItem', data: { account, statementItem: item } },
      'Europe/Zagreb',
    );
  }

  it('classifies movements between own accounts as transfers, not expenses', () => {
    expect(normalizeWith('На гривневий рахунок ФОП для переказу на картку', 'Ковальов Даниіл').kind).toBe('transfer');
    expect(normalizeWith('З гривневого рахунку ФОП').kind).toBe('transfer');
    expect(normalizeWith('З єврового рахунку ФОП для переказу на картку').kind).toBe('transfer');
    expect(normalizeWith('Переказ на картку').kind).toBe('transfer');
    expect(normalizeWith('З Білої картки').kind).toBe('transfer');
    expect(normalizeWith('З білої картки').kind).toBe('transfer');
    expect(normalizeWith('На білу картку').kind).toBe('transfer');
    // Top-ups to the owner's own Revolut card (mono EUR → Revolut leg).
    expect(normalizeWith('Revolut**8551*').kind).toBe('transfer');
    // Income legs of transfers are also transfers.
    expect(normalizeWith('З гривневого рахунку ФОП', undefined).amountMinor).toBeLessThan(0);
  });

  it('does not misclassify real merchants as transfers', () => {
    expect(normalizeWith('MLINAR CENTAR').kind).toBe('expense');
    expect(normalizeWith('TIFON BP').kind).toBe('expense');
    expect(normalizeWith('ФОП Редько Валерія Сергіївна').kind).toBe('expense');
    expect(normalizeWith('Ковальов Даниіл', 'Ковальов Даниіл').kind).toBe('expense');
  });

  it('supports operator-provided extra patterns', () => {
    const patterns = [/^top-up to revolut/iu];
    const item = { id: 'item-2', description: 'Top-up to Revolut', hold: false, ...base };
    const normalized = normalizeMonobank(
      { type: 'StatementItem', data: { account, statementItem: item } },
      'Europe/Zagreb',
      patterns,
    );
    expect(normalized.kind).toBe('transfer');
    expect(normalized.needsReview).toBe(false);
  });
});
