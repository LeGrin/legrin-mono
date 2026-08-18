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

// Movements between the owner's own accounts (ФОП → mono UAH → mono EUR →
// Revolut) are not spending. Monobank uses predictable statement descriptions
// for them, so they are classified as transfers and excluded from expense
// totals while remaining visible in the daily calendar lines.
const BUILT_IN_INTERNAL_TRANSFER_PATTERNS: RegExp[] = [
  /^з\s+.{0,40}?рахунку\s+фоп/iu,
  /^на\s+.{0,40}?рахунок\s+фоп/iu,
  /^переказ\s+на\s+картку/iu,
  /^з\s+(?:білої|єврової|чорної|синьої)\s+картки/iu,
];

export function isInternalTransferDescription(description: string, extraPatterns: readonly RegExp[] = []): boolean {
  const trimmed = description.trim();
  if (!trimmed) return false;
  return [...BUILT_IN_INTERNAL_TRANSFER_PATTERNS, ...extraPatterns]
    .some((pattern) => pattern.test(trimmed));
}

export function isSyntheticTransaction(transaction: Pick<NormalizedTransaction, 'merchantKey' | 'raw'>): boolean {
  if (transaction.merchantKey === 'SYNTHETIC PROBE') return true;
  if (!transaction.raw || typeof transaction.raw !== 'object') return false;
  const raw = transaction.raw as Record<string, unknown>;
  if (raw.synthetic === true) return true;
  const data = raw.data;
  if (!data || typeof data !== 'object') return false;
  const statementItem = (data as Record<string, unknown>).statementItem;
  return Boolean(statementItem && typeof statementItem === 'object'
    && (statementItem as Record<string, unknown>).synthetic === true);
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
