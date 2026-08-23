'use strict';
const store = require('./store');
const { sleep, TelegramApiError } = require('./api');

// Error yang artinya bot memang tidak bisa lagi kirim ke grup itu -> target dilepas otomatis.
const FATAL_PATTERNS = [
  'bot was kicked',
  'bot was blocked',
  'bot is not a member',
  'chat not found',
  'chat_id is empty',
  'user is deactivated',
  'group chat was upgraded',
  'have no rights to send',
  'not enough rights',
  'chat_write_forbidden',
  'topic_closed',
  'peer_id_invalid'
];

function isFatal(error) {
  const text = `${error?.description || error?.message || ''}`.toLowerCase();
  if (error?.code === 403) return true;
  return FATAL_PATTERNS.some((pattern) => text.includes(pattern));
}

function createScheduler({ api, notifyOwner }) {
  let timer = null;
  let running = false;

  function stop() {
    if (timer) clearTimeout(timer);
    timer = null;
  }

  function reschedule({ fromNow = true } = {}) {
    stop();
    const config = store.getConfig();
    if (!config.enabled) {
      store.saveConfig({ nextRunAt: null });
      return null;
    }
    const delayMs = Math.max(1, config.intervalMinutes) * 60 * 1000;
    const nextRunAt = new Date(Date.now() + delayMs).toISOString();
    store.saveConfig({ nextRunAt });
    timer = setTimeout(tick, delayMs);
    if (timer.unref) timer.unref();
    return nextRunAt;
  }

  async function tick() {
    try {
      await runOnce({ manual: false });
    } catch (error) {
      console.error('[scheduler] siklus gagal:', error.message);
    } finally {
      reschedule();
    }
  }

  /**
   * Kirim satu putaran ke semua grup tujuan, satu per satu dengan jeda.
   * @returns ringkasan {sent, failed, results}
   */
  async function runOnce({ manual = false } = {}) {
    if (running) return { skipped: true, reason: 'Masih ada pengiriman yang berjalan.' };
    const config = store.getConfig();

    if (!config.targets.length) return { skipped: true, reason: 'Belum ada grup tujuan.' };
    if (!config.text && !config.photo) return { skipped: true, reason: 'Teks dan gambar masih kosong.' };

    running = true;
    const results = [];
    const droppedTargets = [];

    try {
      for (const chatId of [...config.targets]) {
        try {
          await sendPost(api, chatId, config);
          store.markChat(chatId, { status: 'ok', error: '', lastPostAt: new Date().toISOString() });
          results.push({ chatId, ok: true });
        } catch (error) {
          const description = error instanceof TelegramApiError ? error.description : error.message;
          results.push({ chatId, ok: false, error: description });
          if (isFatal(error)) {
            droppedTargets.push({ chatId, description });
            store.markChat(chatId, { status: 'error', error: description });
          } else {
            store.markChat(chatId, { status: 'warn', error: description });
          }
          console.error(`[post] ${chatId}: ${description}`);
        }
        if (config.gapSeconds > 0) await sleep(config.gapSeconds * 1000);
      }
    } finally {
      running = false;
    }

    // Lepas grup yang sudah pasti gagal supaya siklus berikutnya tidak buang waktu.
    if (droppedTargets.length) {
      const dropped = new Set(droppedTargets.map((item) => String(item.chatId)));
      store.saveConfig({ targets: store.getConfig().targets.filter((id) => !dropped.has(String(id))) });
    }

    const sent = results.filter((item) => item.ok).length;
    const failed = results.length - sent;
    store.saveConfig({
      lastRunAt: new Date().toISOString(),
      lastResults: results.slice(-30)
    });

    if (notifyOwner && (manual || failed || droppedTargets.length)) {
      await notifyOwner(buildSummary({ sent, failed, droppedTargets, results, manual }));
    }
    return { sent, failed, results, droppedTargets };
  }

  function buildSummary({ sent, failed, droppedTargets, results, manual }) {
    const groups = store.getGroups();
    const label = manual ? 'Kirim manual' : 'Auto post';
    const lines = [`<b>${label} selesai</b>`, `Berhasil: ${sent} | Gagal: ${failed}`];
    for (const item of results.filter((entry) => !entry.ok).slice(0, 10)) {
      const title = groups[String(item.chatId)]?.title || item.chatId;
      lines.push(`• ${escapeHtml(title)} — ${escapeHtml(item.error)}`);
    }
    if (droppedTargets.length) {
      lines.push('', '<b>Dilepas dari daftar tujuan:</b>');
      for (const item of droppedTargets) {
        const title = groups[String(item.chatId)]?.title || item.chatId;
        lines.push(`• ${escapeHtml(title)} (<code>${item.chatId}</code>)`);
      }
    }
    return lines.join('\n');
  }

  return { reschedule, runOnce, stop, isRunning: () => running };
}

async function sendPost(api, chatId, config) {
  const parseMode = config.parseMode && config.parseMode !== 'none' ? config.parseMode : undefined;
  if (config.photo) {
    return api.sendPhoto({
      chat_id: chatId,
      photo: config.photo,
      caption: config.text ? config.text.slice(0, 1024) : undefined,
      parse_mode: config.text ? parseMode : undefined
    });
  }
  return api.sendMessage({
    chat_id: chatId,
    text: config.text,
    parse_mode: parseMode,
    disable_web_page_preview: Boolean(config.disablePreview)
  });
}

function escapeHtml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

module.exports = { createScheduler, sendPost, escapeHtml, isFatal };
