import { loadConfig, type AppConfig } from '../src/config.js';

export function testConfig(overrides: NodeJS.ProcessEnv = {}): AppConfig {
  return loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_PATH: ':memory:',
    TIMEZONE: 'Europe/Zagreb',
    WEBHOOK_SHARED_SECRET: 'webhook-secret-for-tests',
    INTERNAL_API_TOKEN: 'internal-api-token-for-tests',
    WORKER_INTERVAL_MS: '1000',
    MAX_DELIVERY_ATTEMPTS: '3',
    MONTHLY_BUDGETS_JSON: '{"EUR":3000,"UAH":60000}',
    CATEGORY_BUDGETS_JSON: '{"Restaurants & coffee":{"EUR":300}}',
    ...overrides,
  });
}
