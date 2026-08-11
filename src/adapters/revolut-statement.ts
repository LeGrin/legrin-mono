import { createHash } from 'node:crypto';

import type { RevolutPersonalTransaction } from './revolut.js';

type CsvRow = Record<string, string>;

function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index]!;
    if (quoted) {
      if (character === '"' && input[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
      continue;
    }
    if (character === '"') {
      quoted = true;
    } else if (character === ',') {
      row.push(field);
      field = '';
    } else if (character === '\n') {
      row.push(field.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += character;
    }
  }
  if (quoted) throw new Error('CSV contains an unterminated quoted field');
  if (field || row.length) {
    row.push(field.replace(/\r$/, ''));
    rows.push(row);
  }
  return rows.filter((candidate) => candidate.some((value) => value.trim() !== ''));
}

function headerKey(value: string): string {
  return value.replace(/^\uFEFF/, '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function value(row: CsvRow, ...keys: string[]): string {
  for (const key of keys) {
    const candidate = row[key]?.trim();
    if (candidate) return candidate;
  }
  return '';
}

function parseAmount(raw: string, rowNumber: number, fieldName: string): number {
  let normalized = raw.trim().replace(/[\s'’]/g, '').replace(/[^0-9,.-]/g, '');
  if (normalized.includes(',') && normalized.includes('.')) {
    normalized = normalized.lastIndexOf(',') > normalized.lastIndexOf('.')
      ? normalized.replace(/\./g, '').replace(',', '.')
      : normalized.replace(/,/g, '');
  } else if (normalized.includes(',')) {
    normalized = normalized.replace(',', '.');
  }
  const amount = Number(normalized);
  if (!Number.isFinite(amount)) throw new Error(`Row ${rowNumber}: invalid ${fieldName}`);
  return amount;
}

function parseDate(raw: string, rowNumber: number): string {
  const trimmed = raw.trim();
  let normalized = trimmed;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})?$/.test(trimmed)) {
    normalized = `${trimmed.replace(' ', 'T')}${trimmed.length === 16 ? ':00' : ''}Z`;
  } else {
    const european = /^(\d{2})\/(\d{2})\/(\d{4})[ ,T]+(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(trimmed);
    if (european) {
      normalized = `${european[3]}-${european[2]}-${european[1]}T${european[4]}:${european[5]}:${european[6] ?? '00'}Z`;
    }
  }
  const timestamp = Date.parse(normalized);
  if (!Number.isFinite(timestamp)) throw new Error(`Row ${rowNumber}: invalid transaction date`);
  return new Date(timestamp).toISOString();
}

function status(raw: string): RevolutPersonalTransaction['status'] {
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'reverted') return 'reverted';
  if (normalized === 'failed') return 'failed';
  if (normalized === 'declined') return 'declined';
  if (normalized === 'pending') return 'pending';
  return 'completed';
}

function stableId(accountId: string, row: CsvRow): string {
  const identity = {
    accountId,
    type: value(row, 'type'),
    product: value(row, 'product'),
    startedAt: value(row, 'starteddate', 'startedat', 'date', 'completeddate', 'completedat'),
    description: value(row, 'description', 'merchant', 'reference'),
    currency: value(row, 'currency', 'basecurrency'),
  };
  return `statement-${createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0, 32)}`;
}

export function parseRevolutStatementCsv(csv: string, accountId: string): RevolutPersonalTransaction[] {
  const table = parseCsv(csv);
  if (table.length < 2) throw new Error('CSV must contain a header and at least one transaction');
  const headers = table[0]!.map(headerKey);
  if (!headers.includes('amount') || !headers.includes('currency') || !headers.includes('description')) {
    throw new Error('CSV must include Description, Amount, and Currency columns');
  }

  const transactions: RevolutPersonalTransaction[] = [];
  for (const [index, cells] of table.slice(1).entries()) {
    const rowNumber = index + 2;
    const row = Object.fromEntries(headers.map((header, cellIndex) => [header, cells[cellIndex] ?? '']));
    const description = value(row, 'description', 'merchant', 'reference');
    const currency = value(row, 'currency', 'basecurrency').toUpperCase();
    const occurredAt = parseDate(
      value(row, 'completeddate', 'completedat', 'starteddate', 'startedat', 'date'),
      rowNumber,
    );
    if (!description) throw new Error(`Row ${rowNumber}: missing description`);
    if (!/^[A-Z]{3}$/.test(currency)) throw new Error(`Row ${rowNumber}: invalid currency`);
    const amount = parseAmount(value(row, 'amount'), rowNumber, 'amount');
    const id = stableId(accountId, row);
    const transactionStatus = status(value(row, 'state', 'status'));
    transactions.push({
      id,
      accountId,
      occurredAt,
      updatedAt: occurredAt,
      description,
      merchant: description,
      amount,
      currency,
      status: transactionStatus,
    });

    const feeRaw = value(row, 'fee', 'fees', 'commission');
    if (feeRaw) {
      const fee = parseAmount(feeRaw, rowNumber, 'fee');
      if (fee !== 0) {
        transactions.push({
          id: `${id}:fee`,
          accountId,
          occurredAt,
          updatedAt: occurredAt,
          description: `Revolut fee · ${description}`,
          merchant: 'Revolut fee',
          amount: -Math.abs(fee),
          currency,
          status: transactionStatus,
        });
      }
    }
  }
  return transactions;
}
