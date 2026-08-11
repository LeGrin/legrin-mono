import type { AppConfig } from '../config.js';

export class TelegramNotifier {
  constructor(private readonly config: AppConfig) {}

  async send(text: string): Promise<void> {
    if (!this.config.telegramEnabled) return;
    const response = await fetch(`https://api.telegram.org/bot${this.config.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: this.config.TELEGRAM_CHAT_ID,
        text: text.slice(0, 4000),
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Telegram returned ${response.status}: ${(await response.text()).slice(0, 500)}`);
  }
}
