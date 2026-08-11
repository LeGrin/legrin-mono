import { loadConfig } from './config.js';
import { FinanceDatabase } from './db/database.js';
import { buildApp } from './http/app.js';
import { PipelineWorker } from './pipeline/worker.js';
import { CalendarSync } from './services/calendar.js';
import { TransactionAnalyzer } from './services/categorizer.js';
import { TelegramNotifier } from './services/telegram.js';

const config = loadConfig();
const database = new FinanceDatabase(config.DATABASE_PATH);
const bootstrapLogger = {
  info: (bindings: object, message: string) => console.log(JSON.stringify({ level: 'info', message, ...bindings })),
  warn: (bindings: object, message: string) => console.warn(JSON.stringify({ level: 'warn', message, ...bindings })),
  error: (bindings: object, message: string) => console.error(JSON.stringify({ level: 'error', message, ...bindings })),
};
const calendar = new CalendarSync(config, database);
const analyzer = new TransactionAnalyzer(config, database);
const telegram = new TelegramNotifier(config);
const worker = new PipelineWorker(config, database, calendar, analyzer, telegram, bootstrapLogger);
const app = await buildApp({ config, database, worker });

worker.start();

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  worker.stop();
  await app.close();
  database.close();
  process.exit(0);
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: config.HOST, port: config.PORT });
