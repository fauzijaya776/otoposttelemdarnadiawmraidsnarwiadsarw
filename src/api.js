'use strict';

class TelegramApiError extends Error {
  constructor(method, body) {
    super(`${method} gagal: ${body.description || 'error tidak diketahui'}`);
    this.name = 'TelegramApiError';
    this.method = method;
    this.code = body.error_code || 0;
    this.description = body.description || '';
    this.parameters = body.parameters || {};
  }
}

function createApi(token) {
  if (!token) throw new Error('BOT_TOKEN kosong. Isi token dari @BotFather di file .env.');
  const base = `https://api.telegram.org/bot${token}/`;

  /**
   * Memanggil Bot API.
   * Otomatis menunggu lalu mengulang ketika kena batas kirim (429) atau error server 5xx.
   */
  async function call(method, payload = {}, options = {}) {
    const { timeoutMs = 60000, retries = 2 } = options;
    let attempt = 0;

    for (;;) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let body;
      try {
        const response = await fetch(base + method, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: controller.signal
        });
        body = await response.json();
      } catch (error) {
        clearTimeout(timer);
        if (attempt++ >= retries) throw new Error(`${method} gagal terhubung: ${error.message}`);
        await sleep(1500 * attempt);
        continue;
      }
      clearTimeout(timer);

      if (body.ok) return body.result;

      const error = new TelegramApiError(method, body);
      const retryAfter = Number(body.parameters?.retry_after) || 0;

      // 429 = kena flood limit, Telegram memberi tahu harus tunggu berapa detik.
      if (error.code === 429 && attempt < retries + 3) {
        attempt++;
        await sleep((retryAfter + 1) * 1000);
        continue;
      }
      if (error.code >= 500 && attempt < retries) {
        attempt++;
        await sleep(2000 * attempt);
        continue;
      }
      throw error;
    }
  }

  return {
    call,
    getMe: () => call('getMe'),
    getUpdates: (params) => call('getUpdates', params, { timeoutMs: (params.timeout + 15) * 1000, retries: 0 }),
    sendMessage: (params) => call('sendMessage', params),
    sendPhoto: (params) => call('sendPhoto', params),
    answerCallbackQuery: (params) => call('answerCallbackQuery', params).catch(() => null),
    editMessageText: (params) => call('editMessageText', params),
    deleteWebhook: () => call('deleteWebhook', { drop_pending_updates: false })
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { createApi, TelegramApiError, sleep };
