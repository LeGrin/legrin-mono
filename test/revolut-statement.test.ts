import { describe, expect, it } from 'vitest';

import { parseRevolutStatementCsv } from '../src/adapters/revolut-statement.js';

const statement = `Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance
CARD_PAYMENT,Current,2026-08-10 18:30:00,2026-08-10 18:31:00,"MLINAR, CENTAR",-8.50,0.00,EUR,COMPLETED,1200.25
TRANSFER,Current,11/08/2026 09:15:00,,Rent,-700.00,0.50,EUR,PENDING,500.25
`;

describe('Revolut CSV statement parser', () => {
  it('parses quoted fields, European dates, state, and a separate fee movement', () => {
    const transactions = parseRevolutStatementCsv(statement, 'personal-main');
    expect(transactions).toHaveLength(3);
    expect(transactions[0]).toMatchObject({
      accountId: 'personal-main',
      occurredAt: '2026-08-10T18:31:00.000Z',
      description: 'MLINAR, CENTAR',
      amount: -8.5,
      currency: 'EUR',
      status: 'completed',
    });
    expect(transactions[1]).toMatchObject({
      occurredAt: '2026-08-11T09:15:00.000Z',
      description: 'Rent',
      amount: -700,
      status: 'pending',
    });
    expect(transactions[2]).toMatchObject({
      description: 'Revolut fee · Rent',
      merchant: 'Revolut fee',
      amount: -0.5,
      status: 'pending',
    });
  });

  it('keeps the same source ID when mutable state, balance, or completion changes', () => {
    const pending = parseRevolutStatementCsv(statement, 'personal-main')[1]!;
    const completedStatement = statement.replace(
      '11/08/2026 09:15:00,,Rent,-700.00,0.50,EUR,PENDING,500.25',
      '11/08/2026 09:15:00,2026-08-11 09:16:00,Rent,-705.00,0.75,EUR,COMPLETED,-205.75',
    );
    const completedTransactions = parseRevolutStatementCsv(completedStatement, 'personal-main');
    const completed = completedTransactions[1]!;
    expect(completed.id).toBe(pending.id);
    expect(completedTransactions[2]!.id).toBe(`${pending.id}:fee`);
    expect(completed.amount).toBe(-705);
    expect(completed.updatedAt).toBe('2026-08-11T09:16:00.000Z');
    expect(completed.status).toBe('completed');
  });

  it('rejects incomplete statement formats without partial guessing', () => {
    expect(() => parseRevolutStatementCsv('Date,Description\n2026-01-01,Coffee\n', 'main'))
      .toThrow('Description, Amount, and Currency');
  });
});
