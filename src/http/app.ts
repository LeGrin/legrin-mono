import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import rawBody from 'fastify-raw-body';
import { z } from 'zod';

import { monobankDedupeKey, monobankWebhookSchema } from '../adapters/monobank.js';
import {
  revolutBusinessWebhookSchema,
  revolutDedupeKey,
  revolutPersonalDedupeKey,
  revolutPersonalTransactionSchema,
  verifyRevolutSignature,
} from '../adapters/revolut.js';
import type { AppConfig } from '../config.js';
import type { FinanceDatabase } from '../db/database.js';
import { CATEGORIES } from '../domain/transaction.js';
import type { PipelineWorker } from '../pipeline/worker.js';
import { bearerToken, safeSecretEqual } from './security.js';

export interface AppDependencies {
  config: AppConfig;
  database: FinanceDatabase;
  worker: PipelineWorker;
}

const categoryBodySchema = z.object({
  category: z.enum(CATEGORIES),
  remember: z.boolean().default(true),
});

export async function buildApp(dependencies: AppDependencies): Promise<FastifyInstance> {
  const { config, database, worker } = dependencies;
  const app = Fastify({
    logger: { level: config.LOG_LEVEL },
    bodyLimit: 1_048_576,
    trustProxy: true,
  });
  await app.register(rateLimit, { max: 120, timeWindow: '1 minute' });
  await app.register(rawBody, { field: 'rawBody', global: false, encoding: 'utf8', runFirst: true });

  const webhookSecretGuard = (secret: string | undefined) => safeSecretEqual(secret, config.WEBHOOK_SHARED_SECRET);
  const apiGuard = (authorization: string | undefined) => safeSecretEqual(bearerToken(authorization), config.INTERNAL_API_TOKEN);

  app.get('/health', async () => ({
    status: 'ok',
    calendar: config.calendarEnabled,
    hermes: config.hermesEnabled,
    telegram: config.telegramEnabled,
  }));

  app.get<{ Params: { secret: string } }>('/webhooks/monobank/:secret', async (request, reply) => {
    if (!webhookSecretGuard(request.params.secret)) return reply.code(404).send();
    return reply.code(200).send();
  });

  app.post<{ Params: { secret: string } }>('/webhooks/monobank/:secret', async (request, reply) => {
    if (!webhookSecretGuard(request.params.secret)) return reply.code(404).send();
    const payload = monobankWebhookSchema.parse(request.body);
    database.enqueueWebhook('monobank', monobankDedupeKey(payload), payload);
    void worker.tick();
    return reply.code(200).send();
  });

  app.post<{ Params: { secret: string } }>(
    '/webhooks/revolut/business/:secret',
    { config: { rawBody: true } },
    async (request, reply) => {
      if (!webhookSecretGuard(request.params.secret)) return reply.code(404).send();
      if (!config.REVOLUT_WEBHOOK_SIGNING_SECRET) return reply.code(503).send({ error: 'revolut_not_configured' });
      const raw = String((request as typeof request & { rawBody?: string }).rawBody ?? '');
      const signatureValid = verifyRevolutSignature({
        rawBody: raw,
        timestamp: request.headers['revolut-request-timestamp'] as string | undefined,
        signatureHeader: request.headers['revolut-signature'] as string | undefined,
        secret: config.REVOLUT_WEBHOOK_SIGNING_SECRET,
        toleranceSeconds: config.REVOLUT_TIMESTAMP_TOLERANCE_SECONDS,
      });
      if (!signatureValid) return reply.code(401).send({ error: 'invalid_signature' });
      const payload = revolutBusinessWebhookSchema.parse(request.body);
      database.enqueueWebhook('revolut_business', revolutDedupeKey(payload), payload);
      void worker.tick();
      return reply.code(204).send();
    },
  );

  app.post<{ Params: { secret: string } }>('/webhooks/revolut/personal/:secret', async (request, reply) => {
    if (!webhookSecretGuard(request.params.secret)) return reply.code(404).send();
    const payload = revolutPersonalTransactionSchema.parse(request.body);
    database.enqueueWebhook('revolut_personal', revolutPersonalDedupeKey(payload), payload);
    void worker.tick();
    return reply.code(202).send({ accepted: true });
  });

  app.get('/api/transactions', async (request, reply) => {
    if (!apiGuard(request.headers.authorization)) return reply.code(401).send({ error: 'unauthorized' });
    const query = z.object({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      month: z.string().regex(/^\d{4}-\d{2}$/).optional(),
      needs_review: z.enum(['true', 'false']).optional(),
      limit: z.coerce.number().int().positive().max(500).default(100),
    }).parse(request.query);
    return database.listTransactions({
      ...(query.date ? { localDate: query.date } : {}),
      ...(query.month ? { localMonth: query.month } : {}),
      ...(query.needs_review ? { needsReview: query.needs_review === 'true' } : {}),
      limit: query.limit,
    });
  });

  app.get<{ Params: { id: string } }>('/api/transactions/:id', async (request, reply) => {
    if (!apiGuard(request.headers.authorization)) return reply.code(401).send({ error: 'unauthorized' });
    const transaction = database.getTransaction(request.params.id);
    return transaction ?? reply.code(404).send({ error: 'not_found' });
  });

  app.patch<{ Params: { id: string } }>('/api/transactions/:id/category', async (request, reply) => {
    if (!apiGuard(request.headers.authorization)) return reply.code(401).send({ error: 'unauthorized' });
    const body = categoryBodySchema.parse(request.body);
    const transaction = database.setCategory(request.params.id, body.category, body.remember);
    if (!transaction) return reply.code(404).send({ error: 'not_found' });
    database.enqueueOutbox('calendar_sync', transaction.localDate, { localDate: transaction.localDate }, true);
    void worker.tick();
    return transaction;
  });

  app.get('/api/summary/month', async (request, reply) => {
    if (!apiGuard(request.headers.authorization)) return reply.code(401).send({ error: 'unauthorized' });
    const query = z.object({ month: z.string().regex(/^\d{4}-\d{2}$/) }).parse(request.query);
    return { month: query.month, categories: database.getMonthSummary(query.month) };
  });

  app.post('/api/admin/retry-failed', async (request, reply) => {
    if (!apiGuard(request.headers.authorization)) return reply.code(401).send({ error: 'unauthorized' });
    const retried = database.retryFailed();
    void worker.tick();
    return { retried };
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError) {
      return reply.code(400).send({ error: 'invalid_payload', issues: error.issues });
    }
    app.log.error({ err: error }, 'request failed');
    return reply.code(500).send({ error: 'internal_error' });
  });

  return app;
}
