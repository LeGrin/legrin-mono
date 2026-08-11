import { createHash } from 'node:crypto';

import { google, type calendar_v3 } from 'googleapis';

import type { AppConfig } from '../config.js';
import type { FinanceDatabase } from '../db/database.js';
import { daysInMonth, localDateParts, nextDate } from '../domain/time.js';
import { money, type StoredTransaction } from '../domain/transaction.js';

function transactionEmoji(transaction: StoredTransaction): string {
  if (transaction.status === 'pending') return '⏳';
  if (transaction.status === 'declined' || transaction.status === 'failed' || transaction.status === 'reverted') return '↩️';
  if (transaction.kind === 'income') return '💰';
  if (transaction.kind === 'transfer') return '🔁';
  const major = Math.abs(transaction.amountMinor) / 10 ** transaction.amountExponent;
  if (major >= 100) return '❗';
  if (major >= 40) return '⚠️';
  return '✔️';
}

function totalByCurrency(transactions: StoredTransaction[]): Map<string, { amountMinor: number; exponent: number }> {
  const totals = new Map<string, { amountMinor: number; exponent: number }>();
  for (const transaction of transactions) {
    const existing = totals.get(transaction.currency) ?? { amountMinor: 0, exponent: transaction.amountExponent };
    existing.amountMinor += Math.abs(transaction.amountMinor);
    totals.set(transaction.currency, existing);
  }
  return totals;
}

function budgetSignal(
  localDate: string,
  expenseTotals: Map<string, { amountMinor: number; exponent: number }>,
  monthlyBudgets: Record<string, number>,
): string {
  const localMonth = localDate.slice(0, 7);
  const ratios = [...expenseTotals.entries()].flatMap(([currency, total]) => {
    const monthlyBudget = monthlyBudgets[currency];
    if (!monthlyBudget) return [];
    const dailyBudget = monthlyBudget / daysInMonth(localMonth);
    return [(total.amountMinor / 10 ** total.exponent) / dailyBudget];
  });
  if (ratios.length === 0) return '⚪';
  const ratio = Math.max(...ratios);
  if (ratio > 1.5) return '🔴';
  if (ratio > 1) return '🟡';
  return '🟢';
}

export interface RenderedCalendarEvent {
  summary: string;
  description: string;
  start: { date: string; timeZone: string };
  end: { date: string; timeZone: string };
}

export function renderDailyEvent(
  localDate: string,
  transactions: StoredTransaction[],
  monthSummary: ReturnType<FinanceDatabase['getMonthSummary']>,
  config: Pick<AppConfig, 'TIMEZONE' | 'monthlyBudgets'>,
): RenderedCalendarEvent {
  const active = transactions.filter((transaction) => !['declined', 'failed', 'reverted'].includes(transaction.status));
  const expenses = active.filter((transaction) => transaction.kind === 'expense' && transaction.amountMinor < 0);
  const expenseTotals = totalByCurrency(expenses);
  const totalText = [...expenseTotals.entries()]
    .map(([currency, total]) => money(total.amountMinor, currency, total.exponent))
    .join(' · ') || 'без витрат';
  const signal = budgetSignal(localDate, expenseTotals, config.monthlyBudgets);

  const lines = [...transactions]
    .sort((left, right) => left.occurredAt.localeCompare(right.occurredAt))
    .map((transaction) => {
      const time = localDateParts(transaction.occurredAt, config.TIMEZONE).time;
      const category = transaction.category ?? 'Uncategorized';
      const bank = transaction.source === 'monobank' ? 'mono' : transaction.source === 'revolut_business' ? 'revolut-biz' : 'revolut';
      return `${transactionEmoji(transaction)} ${time} [${bank}] ${transaction.merchant} · ${money(transaction.amountMinor, transaction.currency, transaction.amountExponent)} · ${category}`;
    });

  const categoryLines = monthSummary.map((row) =>
    `• ${row.category}: ${money(row.amountMinor, row.currency, row.amountExponent)} (${row.count})`,
  );

  return {
    summary: `${signal} ${totalText} · ${expenses.length} витрат`,
    description: [
      `Рухи коштів за ${localDate}`,
      '',
      ...lines,
      '',
      `Підсумок категорій за ${localDate.slice(0, 7)}`,
      ...categoryLines,
      '',
      'Автоматично оновлюється legrin-finance-pipeline.',
    ].join('\n'),
    start: { date: localDate, timeZone: config.TIMEZONE },
    end: { date: nextDate(localDate), timeZone: config.TIMEZONE },
  };
}

export class CalendarSync {
  private calendar?: calendar_v3.Calendar;

  constructor(
    private readonly config: AppConfig,
    private readonly database: FinanceDatabase,
  ) {}

  async syncDay(localDate: string): Promise<void> {
    if (!this.config.calendarEnabled) return;
    const transactions = this.database.listTransactions({ localDate, limit: 500 });
    if (transactions.length === 0) return;
    const rendered = renderDailyEvent(
      localDate,
      transactions,
      this.database.getMonthSummary(localDate.slice(0, 7)),
      this.config,
    );
    const contentHash = createHash('sha256').update(JSON.stringify(rendered)).digest('hex');
    const existing = this.database.getCalendarEvent(localDate);
    if (existing?.contentHash === contentHash) return;

    const calendar = await this.getCalendar();
    let eventId = existing?.eventId ?? createHash('sha256').update(`legrin-finance:${localDate}`).digest('hex').slice(0, 32);
    if (eventId) {
      try {
        await calendar.events.update({
          calendarId: this.config.GOOGLE_CALENDAR_ID!,
          eventId,
          requestBody: rendered,
        });
      } catch (error) {
        const status = (error as { code?: number; response?: { status?: number } }).code
          ?? (error as { response?: { status?: number } }).response?.status;
        if (status !== 404) throw error;
        try {
          await calendar.events.insert({
            calendarId: this.config.GOOGLE_CALENDAR_ID!,
            requestBody: { id: eventId, ...rendered },
          });
        } catch (insertError) {
          const insertStatus = (insertError as { code?: number; response?: { status?: number } }).code
            ?? (insertError as { response?: { status?: number } }).response?.status;
          if (insertStatus !== 409) throw insertError;
          await calendar.events.update({
            calendarId: this.config.GOOGLE_CALENDAR_ID!,
            eventId,
            requestBody: rendered,
          });
        }
      }
    }
    this.database.setCalendarEvent(localDate, eventId, contentHash);
  }

  private async getCalendar(): Promise<calendar_v3.Calendar> {
    if (this.calendar) return this.calendar;
    const credentials = this.config.GOOGLE_SERVICE_ACCOUNT_JSON
      ? JSON.parse(this.config.GOOGLE_SERVICE_ACCOUNT_JSON) as Record<string, unknown>
      : undefined;
    const auth = new google.auth.GoogleAuth({
      ...(credentials ? { credentials } : {}),
      ...(this.config.GOOGLE_SERVICE_ACCOUNT_FILE ? { keyFile: this.config.GOOGLE_SERVICE_ACCOUNT_FILE } : {}),
      scopes: ['https://www.googleapis.com/auth/calendar'],
    });
    this.calendar = google.calendar({ version: 'v3', auth });
    return this.calendar;
  }
}
