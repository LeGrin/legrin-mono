import { createHash } from 'node:crypto';
import { z } from 'zod';

import { localDateParts } from '../domain/time.js';
import type { NormalizedTransaction } from '../domain/transaction.js';
import { merchantKey } from '../domain/transaction.js';

const statementItemSchema = z.object({
  id: z.string().min(1),
  time: z.number().int().positive(),
  description: z.string().default('Monobank transaction'),
  mcc: z.number().int().optional(),
  originalMcc: z.number().int().optional(),
  hold: z.boolean().default(false),
  amount: z.number().int(),
  operationAmount: z.number().int().optional(),
  currencyCode: z.number().int(),
  commissionRate: z.number().int().optional(),
  cashbackAmount: z.number().int().optional(),
  balance: z.number().int().optional(),
  comment: z.string().optional(),
  receiptId: z.string().optional(),
  invoiceId: z.string().optional(),
  counterEdrpou: z.string().optional(),
  counterIban: z.string().optional(),
  counterName: z.string().optional(),
}).passthrough();

export const monobankWebhookSchema = z.object({
  type: z.string(),
  data: z.object({
    account: z.string().min(1),
    statementItem: statementItemSchema,
  }),
});

export type MonobankWebhook = z.infer<typeof monobankWebhookSchema>;

const ISO_4217: Record<number, string> = {
  191: 'HRK',
  203: 'CZK',
  348: 'HUF',
  392: 'JPY',
  826: 'GBP',
  840: 'USD',
  941: 'RSD',
  946: 'RON',
  949: 'TRY',
  978: 'EUR',
  980: 'UAH',
  985: 'PLN',
};

export function monobankDedupeKey(payload: MonobankWebhook): string {
  const item = payload.data.statementItem;
  return createHash('sha256')
    .update(`monobank:${item.id}:${item.hold}:${item.amount}:${item.balance ?? ''}`)
    .digest('hex');
}

export function normalizeMonobank(payload: MonobankWebhook, timeZone: string): NormalizedTransaction {
  const item = payload.data.statementItem;
  const occurredAt = new Date(item.time * 1000).toISOString();
  const local = localDateParts(occurredAt, timeZone);
  const merchant = item.counterName?.trim() || item.description.trim() || 'Monobank transaction';
  const currency = ISO_4217[item.currencyCode] ?? `ISO-${item.currencyCode}`;
  return {
    id: `monobank:${payload.data.account}:${item.id}`,
    source: 'monobank',
    sourceTransactionId: item.id,
    accountId: payload.data.account,
    occurredAt,
    updatedAt: new Date().toISOString(),
    localDate: local.date,
    localMonth: local.month,
    description: item.comment?.trim() || item.description.trim() || merchant,
    merchant,
    merchantKey: merchantKey(merchant),
    ...(item.mcc !== undefined ? { mcc: item.mcc } : {}),
    amountMinor: item.amount,
    amountExponent: 2,
    currency,
    status: item.hold ? 'pending' : 'completed',
    kind: item.amount < 0 ? 'expense' : 'income',
    needsReview: item.amount < 0,
    raw: payload,
  };
}
