import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

import { localDateParts } from '../domain/time.js';
import type { NormalizedTransaction, TransactionStatus } from '../domain/transaction.js';
import { currencyExponent, decimalToMinor, merchantKey } from '../domain/transaction.js';

const counterpartySchema = z.object({
  id: z.string().optional(),
  account_id: z.string().optional(),
  account_type: z.enum(['self', 'revolut', 'external']).optional(),
}).passthrough();

const legSchema = z.object({
  leg_id: z.string().min(1),
  account_id: z.string().min(1),
  counterparty: counterpartySchema.optional(),
  amount: z.number(),
  fee: z.number().optional(),
  currency: z.string().length(3),
  bill_amount: z.union([z.string(), z.number()]).optional(),
  bill_currency: z.string().length(3).optional(),
  description: z.string().optional(),
  balance: z.number().optional(),
}).passthrough();

const transactionCreatedSchema = z.object({
  event: z.literal('TransactionCreated'),
  timestamp: z.string().datetime(),
  data: z.object({
    id: z.string().min(1),
    type: z.string(),
    state: z.string(),
    request_id: z.string().optional(),
    created_at: z.string().datetime(),
    updated_at: z.string().datetime().optional(),
    completed_at: z.string().datetime().optional(),
    reference: z.string().optional(),
    legs: z.array(legSchema).min(1),
  }).passthrough(),
});

const transactionStateChangedSchema = z.object({
  event: z.literal('TransactionStateChanged'),
  timestamp: z.string().datetime(),
  data: z.object({
    id: z.string().min(1),
    request_id: z.string().optional(),
    old_state: z.string(),
    new_state: z.string(),
  }).passthrough(),
});

export const revolutBusinessWebhookSchema = z.discriminatedUnion('event', [
  transactionCreatedSchema,
  transactionStateChangedSchema,
]);

export type RevolutBusinessWebhook = z.infer<typeof revolutBusinessWebhookSchema>;

export const revolutPersonalTransactionSchema = z.object({
  id: z.string().min(1),
  accountId: z.string().min(1),
  occurredAt: z.string().datetime(),
  updatedAt: z.string().datetime().optional(),
  description: z.string().min(1),
  merchant: z.string().optional(),
  amount: z.number(),
  currency: z.string().length(3),
  status: z.enum(['pending', 'completed', 'declined', 'failed', 'reverted']).default('completed'),
  kind: z.enum(['expense', 'income', 'transfer']).optional(),
  mcc: z.number().int().optional(),
}).passthrough();

export type RevolutPersonalTransaction = z.infer<typeof revolutPersonalTransactionSchema>;

export function revolutDedupeKey(payload: RevolutBusinessWebhook): string {
  const state = payload.event === 'TransactionCreated' ? payload.data.state : payload.data.new_state;
  return createHash('sha256')
    .update(`revolut:${payload.event}:${payload.data.id}:${state}:${payload.timestamp}`)
    .digest('hex');
}

export function revolutPersonalDedupeKey(payload: RevolutPersonalTransaction): string {
  return createHash('sha256')
    .update(`revolut-personal:${payload.id}:${payload.status}:${payload.updatedAt ?? payload.occurredAt}`)
    .digest('hex');
}

function normalizeStatus(value: string): TransactionStatus {
  if (value === 'completed') return 'completed';
  if (value === 'declined') return 'declined';
  if (value === 'failed') return 'failed';
  if (value === 'reverted') return 'reverted';
  return 'pending';
}

export function normalizeRevolutCreated(
  payload: Extract<RevolutBusinessWebhook, { event: 'TransactionCreated' }>,
  timeZone: string,
): NormalizedTransaction[] {
  const local = localDateParts(payload.data.created_at, timeZone);
  const internalTransfer = payload.data.legs.length > 1
    && payload.data.legs.every((leg) => leg.counterparty?.account_type === 'self');

  return payload.data.legs.map((leg) => {
    const merchant = leg.description?.trim() || payload.data.reference?.trim() || payload.data.type;
    const currency = leg.currency.toUpperCase();
    return {
      id: `revolut_business:${payload.data.id}:${leg.leg_id}`,
      source: 'revolut_business',
      sourceTransactionId: payload.data.id,
      sourceLegId: leg.leg_id,
      accountId: leg.account_id,
      occurredAt: payload.data.created_at,
      updatedAt: payload.data.updated_at ?? payload.timestamp,
      localDate: local.date,
      localMonth: local.month,
      description: payload.data.reference?.trim() || merchant,
      merchant,
      merchantKey: merchantKey(merchant),
      amountMinor: decimalToMinor(leg.amount, currency),
      amountExponent: currencyExponent(currency),
      currency,
      status: normalizeStatus(payload.data.state),
      kind: internalTransfer ? 'transfer' : leg.amount < 0 ? 'expense' : 'income',
      needsReview: !internalTransfer && leg.amount < 0,
      raw: payload,
    } satisfies NormalizedTransaction;
  });
}

export function normalizeRevolutPersonal(
  payload: RevolutPersonalTransaction,
  timeZone: string,
): NormalizedTransaction {
  const local = localDateParts(payload.occurredAt, timeZone);
  const merchant = payload.merchant?.trim() || payload.description.trim();
  const currency = payload.currency.toUpperCase();
  return {
    id: `revolut_personal:${payload.accountId}:${payload.id}`,
    source: 'revolut_personal',
    sourceTransactionId: payload.id,
    accountId: payload.accountId,
    occurredAt: payload.occurredAt,
    updatedAt: payload.updatedAt ?? payload.occurredAt,
    localDate: local.date,
    localMonth: local.month,
    description: payload.description,
    merchant,
    merchantKey: merchantKey(merchant),
    ...(payload.mcc !== undefined ? { mcc: payload.mcc } : {}),
    amountMinor: decimalToMinor(payload.amount, currency),
    amountExponent: currencyExponent(currency),
    currency,
    status: payload.status,
    kind: payload.kind ?? (payload.amount < 0 ? 'expense' : 'income'),
    needsReview: (payload.kind ?? (payload.amount < 0 ? 'expense' : 'income')) === 'expense',
    raw: payload,
  };
}

export function verifyRevolutSignature(options: {
  rawBody: string;
  timestamp: string | undefined;
  signatureHeader: string | undefined;
  secret: string;
  toleranceSeconds: number;
  nowMs?: number;
}): boolean {
  if (!options.timestamp || !options.signatureHeader) return false;
  const timestampMs = Number(options.timestamp);
  if (!Number.isFinite(timestampMs)) return false;
  const currentMs = options.nowMs ?? Date.now();
  if (Math.abs(currentMs - timestampMs) > options.toleranceSeconds * 1000) return false;

  const payloadToSign = `v1.${options.timestamp}.${options.rawBody}`;
  const expected = `v1=${createHmac('sha256', options.secret).update(payloadToSign).digest('hex')}`;
  return options.signatureHeader.split(',').some((candidate) => {
    const trimmed = candidate.trim();
    const expectedBuffer = Buffer.from(expected);
    const actualBuffer = Buffer.from(trimmed);
    return expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer);
  });
}
