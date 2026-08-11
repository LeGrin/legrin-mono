export const CATEGORIES = [
  'Food & groceries',
  'Restaurants & coffee',
  'Housing',
  'Utilities',
  'Transport',
  'Health',
  'Sport',
  'Subscriptions & software',
  'Shopping',
  'Travel',
  'Cash',
  'Transfers',
  'Income',
  'Fees',
  'Other',
] as const;

export type Category = (typeof CATEGORIES)[number];
export type TransactionSource = 'monobank' | 'revolut_business' | 'revolut_personal';
export type TransactionStatus = 'pending' | 'completed' | 'declined' | 'failed' | 'reverted';
export type TransactionKind = 'expense' | 'income' | 'transfer';

export interface NormalizedTransaction {
  id: string;
  source: TransactionSource;
  sourceTransactionId: string;
  sourceLegId?: string;
  accountId: string;
  occurredAt: string;
  updatedAt: string;
  localDate: string;
  localMonth: string;
  description: string;
  merchant: string;
  merchantKey: string;
  mcc?: number;
  amountMinor: number;
  amountExponent: number;
  currency: string;
  status: TransactionStatus;
  kind: TransactionKind;
  category?: Category;
  categoryConfidence?: number;
  categorySource?: 'rule' | 'history' | 'hermes' | 'manual';
  needsReview: boolean;
  raw: unknown;
}

export interface StoredTransaction extends NormalizedTransaction {
  analysisJson?: string;
  analyzedAt?: string;
  notifiedAt?: string;
  firstSeenAt: string;
  lastSeenAt: string;
}

export function merchantKey(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .toLocaleUpperCase('en-US');
}

export function currencyExponent(currency: string): number {
  if (new Set(['BIF', 'CLP', 'DJF', 'GNF', 'ISK', 'JPY', 'KMF', 'KRW', 'PYG', 'RWF', 'UGX', 'UYI', 'VND', 'VUV', 'XAF', 'XOF', 'XPF']).has(currency)) return 0;
  if (new Set(['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND']).has(currency)) return 3;
  if (currency === 'CLF') return 4;
  return 2;
}

export function decimalToMinor(value: number, currency: string): number {
  return Math.round(value * 10 ** currencyExponent(currency));
}

export function money(amountMinor: number, currency: string, exponent = currencyExponent(currency)): string {
  return new Intl.NumberFormat('uk-UA', {
    style: 'currency',
    currency,
    minimumFractionDigits: exponent,
    maximumFractionDigits: exponent,
  }).format(amountMinor / 10 ** exponent);
}
