import { createHash } from 'node:crypto';
import { z } from 'zod';

import { localDateParts } from '../domain/time.js';
import type { NormalizedTransaction } from '../domain/transaction.js';
import { isInternalTransferDescription, merchantKey } from '../domain/transaction.js';

export const statementItemSchema = z.object({
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

export function normalizeMonobank(
  payload: MonobankWebhook,
  timeZone: string,
  extraTransferPatterns: readonly RegExp[] = [],
): NormalizedTransaction {
  const item = payload.data.statementItem;
  const occurredAt = new Date(item.time * 1000).toISOString();
  const local = localDateParts(occurredAt, timeZone);
  const merchant = item.counterName?.trim() || item.description.trim() || 'Monobank transaction';
  const currency = ISO_4217[item.currencyCode] ?? `ISO-${item.currencyCode}`;
  const amountMinor = item.operationAmount ?? item.amount;
  const description = item.comment?.trim() || item.description.trim() || merchant;
  const internalTransfer = isInternalTransferDescription(description, extraTransferPatterns);
  return {
    id: `monobank:${payload.data.account}:${item.id}`,
    source: 'monobank',
    sourceTransactionId: item.id,
    accountId: payload.data.account,
    occurredAt,
    updatedAt: new Date().toISOString(),
    localDate: local.date,
    localMonth: local.month,
    description,
    merchant,
    merchantKey: merchantKey(merchant),
    ...(item.mcc !== undefined ? { mcc: item.mcc } : {}),
    // Monobank's `amount` is the debit in the account currency, while
    // `operationAmount` is the actual purchase amount in `currencyCode`.
    // Calendar and user notifications describe the purchase, so the two
    // fields must be paired instead of labelling an account-currency debit as
    // EUR (for example, 141.07 UAH for a 2.70 EUR Mlinar purchase).
    amountMinor,
    amountExponent: 2,
    currency,
    status: item.hold ? 'pending' : 'completed',
    kind: internalTransfer ? 'transfer' : amountMinor < 0 ? 'expense' : 'income',
    needsReview: !internalTransfer && amountMinor < 0,
    raw: payload,
  };
}
