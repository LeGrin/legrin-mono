import { z } from 'zod';

const optionalUrl = z.string().url().optional().or(z.literal('').transform(() => undefined));
const optionalString = z.string().min(1).optional().or(z.literal('').transform(() => undefined));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().default(8088),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_PATH: z.string().default('./data/finance.db'),
  TIMEZONE: z.string().default('Europe/Zagreb'),
  WEBHOOK_SHARED_SECRET: z.string().min(16),
  INTERNAL_API_TOKEN: z.string().min(24),
  MONOBANK_TOKEN: optionalString,
  PUBLIC_BASE_URL: optionalUrl,
  REVOLUT_WEBHOOK_SIGNING_SECRET: optionalString,
  REVOLUT_TIMESTAMP_TOLERANCE_SECONDS: z.coerce.number().int().positive().default(300),
  GOOGLE_CALENDAR_ID: optionalString,
  GOOGLE_SERVICE_ACCOUNT_FILE: optionalString,
  GOOGLE_SERVICE_ACCOUNT_JSON: optionalString,
  HERMES_AGENT_URL: optionalUrl,
  HERMES_AGENT_KEY: optionalString,
  HERMES_AGENT_TIMEOUT_MS: z.coerce.number().int().positive().default(150_000),
  TELEGRAM_BOT_TOKEN: optionalString,
  TELEGRAM_CHAT_ID: optionalString,
  MONTHLY_BUDGETS_JSON: z.string().default('{}'),
  CATEGORY_BUDGETS_JSON: z.string().default('{}'),
  CATEGORY_CONFIDENCE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.72),
  WORKER_INTERVAL_MS: z.coerce.number().int().positive().default(750),
  MAX_DELIVERY_ATTEMPTS: z.coerce.number().int().positive().default(12),
});

export type MoneyMap = Record<string, number>;
export type CategoryBudgetMap = Record<string, MoneyMap>;

function parseMoneyMap(raw: string, name: string): MoneyMap {
  try {
    const value = JSON.parse(raw) as unknown;
    return z.record(z.string(), z.number().nonnegative()).parse(value);
  } catch (error) {
    throw new Error(`${name} must be a JSON object of non-negative numeric values`, { cause: error });
  }
}

function parseCategoryBudgetMap(raw: string): CategoryBudgetMap {
  try {
    const value = JSON.parse(raw) as unknown;
    return z.record(z.string(), z.record(z.string(), z.number().nonnegative())).parse(value);
  } catch (error) {
    throw new Error('CATEGORY_BUDGETS_JSON must be {"Category":{"EUR":500}}', { cause: error });
  }
}

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = schema.parse(env);
  return {
    ...parsed,
    monthlyBudgets: parseMoneyMap(parsed.MONTHLY_BUDGETS_JSON, 'MONTHLY_BUDGETS_JSON'),
    categoryBudgets: parseCategoryBudgetMap(parsed.CATEGORY_BUDGETS_JSON),
    calendarEnabled: Boolean(parsed.GOOGLE_CALENDAR_ID && (parsed.GOOGLE_SERVICE_ACCOUNT_FILE || parsed.GOOGLE_SERVICE_ACCOUNT_JSON)),
    hermesEnabled: Boolean(parsed.HERMES_AGENT_URL && parsed.HERMES_AGENT_KEY),
    telegramEnabled: Boolean(parsed.TELEGRAM_BOT_TOKEN && parsed.TELEGRAM_CHAT_ID),
  };
}
