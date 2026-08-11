import { loadConfig } from '../src/config.js';

const config = loadConfig();
if (!config.MONOBANK_TOKEN) throw new Error('MONOBANK_TOKEN is required');
if (!config.PUBLIC_BASE_URL) throw new Error('PUBLIC_BASE_URL is required');

const webHookUrl = `${config.PUBLIC_BASE_URL.replace(/\/$/, '')}/webhooks/monobank/${encodeURIComponent(config.WEBHOOK_SHARED_SECRET)}`;
const response = await fetch('https://api.monobank.ua/personal/webhook', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Token': config.MONOBANK_TOKEN,
  },
  body: JSON.stringify({ webHookUrl }),
  signal: AbortSignal.timeout(15_000),
});
if (!response.ok) throw new Error(`Monobank returned ${response.status}: ${(await response.text()).slice(0, 500)}`);
console.log(`Monobank webhook configured for ${new URL(config.PUBLIC_BASE_URL).host}.`);
