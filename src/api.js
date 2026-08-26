'use strict';
const fs = require('fs');
const path = require('path');


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

  /** Unduh file dari Bot API (foto yang dikirim owner) ke folder lokal. */
  async function downloadFile(fileId, destination) {
    const file = await call('getFile', { file_id: fileId });
    if (!file.file_path) throw new Error('Telegram tidak memberi lokasi file.');
    const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Gagal mengunduh gambar (HTTP ${response.status}).`);
    const buffer = Buffer.from(await response.arrayBuffer());
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, buffer);
    return { path: destination, bytes: buffer.length, extension: path.extname(file.file_path) || '.jpg' };
  }

  /** Kirim gambar dari memori (dipakai untuk QR login) lewat multipart upload. */
  async function sendPhotoBuffer({ chatId, buffer, filename = 'gambar.png', caption, parseMode = 'HTML' }) {
    const form = new FormData();
    form.append('chat_id', String(chatId));
    if (caption) {
      form.append('caption', caption);
      form.append('parse_mode', parseMode);
    }
    form.append('photo', new Blob([buffer], { type: 'image/png' }), filename);

    const response = await fetch(base + 'sendPhoto', { method: 'POST', body: form });
    const body = await response.json();
    if (!body.ok) throw new TelegramApiError('sendPhoto', body);
    return body.result;
  }

  return {
    call,
    downloadFile,
    sendPhotoBuffer,
    getMe: () => call('getMe'),
    getUpdates: (params = {}) => {
      const timeout = Number(params.timeout) || 30;
      return call('getUpdates', { ...params, timeout }, { timeoutMs: (timeout + 15) * 1000, retries: 0 });
    },
    sendMessage: (params) => call('sendMessage', params),
    sendPhoto: (params) => call('sendPhoto', params),
    answerCallbackQuery: (params) => call('answerCallbackQuery', params).catch(() => null),
    deleteMessage: (params) => call('deleteMessage', params).catch(() => null),
    editMessageText: (params) => call('editMessageText', params),
    deleteWebhook: () => call('deleteWebhook', { drop_pending_updates: false })
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { createApi, TelegramApiError, sleep };
