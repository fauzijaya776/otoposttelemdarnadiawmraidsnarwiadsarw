'use strict';
const store = require('./store');
const { sanitize } = require('./text');
const { sleep } = require('./api');

// Error yang artinya akun memang tidak bisa lagi posting di grup itu -> target dilepas otomatis.
const FATAL_PATTERNS = [
  'chat_write_forbidden',
  'user_banned_in_channel',
  'channel_private',
  'chat_admin_required',
  'peer_id_invalid',
  'channel_invalid',
  'user_is_blocked',
  'chat_restricted',
  'chat_send_plain_forbidden',
  'chat_send_media_forbidden',
  'topic_closed',
  'input_user_deactivated',
  'user_deactivated_ban'
];

// Batas maksimal menunggu FLOOD_WAIT dalam satu pengiriman (detik).
const MAX_FLOOD_WAIT = 300;

// Satu pengiriman tidak boleh menggantung selamanya. Koneksi MTProto yang macet
// pernah bisa mengunci penjadwal permanen karena flag "sedang mengirim" tidak pernah lepas.
const SEND_TIMEOUT_MS = 90 * 1000;

// Kalau flag "sedang mengirim" bertahan selebihnya ini, anggap macet dan paksa lepas.
const STUCK_AFTER_MS = 15 * 60 * 1000;

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    // Sengaja tidak di-unref: selama pengiriman berlangsung, proses harus tetap hidup.
    const timer = setTimeout(() => reject(new Error(`${label} tidak merespons dalam ${Math.round(ms / 1000)} detik`)), ms);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function errorText(error) {
  return String(error?.errorMessage || error?.message || error || '');
}

function isFatal(error) {
  const text = errorText(error).toLowerCase();
  return FATAL_PATTERNS.some((pattern) => text.includes(pattern));
}

function waitSeconds(error) {
  const text = errorText(error).toUpperCase();
  if (!/FLOOD_WAIT|SLOWMODE_WAIT/.test(text)) return 0;
  const fromField = Number(error?.seconds);
  if (Number.isFinite(fromField) && fromField > 0) return fromField;
  const match = text.match(/_(\d+)$/) || text.match(/(\d+)\s*SECONDS?/);
  return match ? Number(match[1]) : 0;
}

/**
 * Kapan sebuah grup dilepas dari daftar tujuan.
 *   fatal    → hanya kalau Telegram bilang kita memang tidak boleh kirim (dikick/diban)
 *   3x       → itu, plus setelah 3 kali gagal beruntun (bawaan)
 *   langsung → sekali gagal langsung dilepas
 * Error "fatal" selalu dilepas, apa pun modenya, karena itu bukti nyata sudah tidak bisa posting.
 */
function shouldDrop({ mode, fatal, fails }) {
  if (fatal) return true;
  if (mode === 'langsung') return true;
  if (mode === 'fatal') return false;
  return fails >= 3;
}

function createScheduler({
  userClient,
  notifyOwner,
  timers = { setTimeout, clearTimeout, setInterval, clearInterval },
  watchdogMs = 60 * 1000,
  sendTimeoutMs = SEND_TIMEOUT_MS
}) {
  let timer = null;
  let watchdog = null;
  let running = false;
  let lastTickAt = null;
  let lastSkipReason = null;
  let aborted = false;
  let runningSince = null;

  function stop() {
    if (timer) timers.clearTimeout(timer);
    timer = null;
    if (watchdog) timers.clearInterval(watchdog);
    watchdog = null;
  }

  function reschedule() {
    if (timer) timers.clearTimeout(timer);
    timer = null;

    const config = store.getConfig();
    if (!config.enabled) {
      store.saveConfig({ nextRunAt: null });
      if (watchdog) timers.clearInterval(watchdog);
      watchdog = null;
      return null;
    }

    const delayMs = Math.max(1, config.intervalMinutes) * 60 * 1000;
    const nextRunAt = new Date(Date.now() + delayMs).toISOString();
    store.saveConfig({ nextRunAt });
    // Sengaja TIDAK di-unref: timer ini yang menjaga proses tetap hidup.
    timer = timers.setTimeout(tick, delayMs);
    startWatchdog();
    return nextRunAt;
  }

  // Pengaman: timer bisa hilang (tidak terpasang) atau macet (terpasang tapi
  // waktunya sudah lewat jauh, misal setelah komputer sleep). Dua-duanya dipasang ulang.
  function startWatchdog() {
    if (watchdog || !timers.setInterval) return;
    watchdog = timers.setInterval(() => {
      const config = store.getConfig();
      if (!config.enabled || running) return;

      const jatuhTempo = config.nextRunAt ? Date.parse(config.nextRunAt) : null;
      const macet = Boolean(jatuhTempo) && jatuhTempo < Date.now() - watchdogMs;
      if (timer && !macet) return;

      console.warn(
        `[scheduler] penjadwal ${timer ? 'macet' : 'tidak terpasang'} padahal auto post aktif — dipasang ulang.`
      );
      reschedule();
    }, watchdogMs);
    if (watchdog?.unref) watchdog.unref();
  }

  async function tick() {
    timer = null;
    lastTickAt = new Date().toISOString();
    try {
      const result = await runOnce({ manual: false });
      if (result.skipped) await reportSkip(result.reason);
      else lastSkipReason = null;
    } catch (error) {
      console.error('[scheduler] siklus gagal:', error.message);
      await reportSkip(`Siklus gagal: ${error.message}`);
    } finally {
      reschedule();
    }
  }

  /**
   * Seberapa cerewet laporan ke owner:
   *   semua   → tiap siklus dilaporkan
   *   penting → hanya kalau ada yang gagal / dilewati (bawaan)
   *   mati    → tidak pernah; semuanya cukup dilihat lewat /status
   * Kiriman manual (/kirim, /on) selalu dibalas karena owner yang memintanya.
   */
  function bolehLapor({ manual, adaMasalah }) {
    if (manual) return true;
    const level = store.getConfig().notifyLevel || 'penting';
    if (level === 'mati') return false;
    if (level === 'semua') return true;
    return Boolean(adaMasalah);
  }

  // Siklus yang dilewati dilaporkan sekali per penyebab — kecuali owner memilih 'mati'.
  async function reportSkip(reason) {
    console.warn('[scheduler] siklus dilewati:', reason);
    if (!notifyOwner || reason === lastSkipReason) return;
    if (!bolehLapor({ manual: false, adaMasalah: true })) {
      lastSkipReason = reason;
      return;
    }
    lastSkipReason = reason;
    await notifyOwner(
      `⏭️ <b>Auto post dilewati</b>\n${escapeHtml(reason)}\n\n` +
        'Siklus berikutnya tetap dijadwalkan. Pesan ini hanya dikirim sekali per penyebab.'
    ).catch(() => null);
  }

  /**
   * Satu putaran: kirim ke semua grup tujuan lewat akun pribadi, satu per satu dengan jeda.
   */
  async function runOnce({ manual = false } = {}) {
    if (running) {
      const lamanya = runningSince ? Date.now() - runningSince : 0;
      if (lamanya < STUCK_AFTER_MS) {
        return { skipped: true, reason: 'Masih ada pengiriman yang berjalan.' };
      }
      // Pengiriman sebelumnya macet — jangan biarkan auto post mati permanen.
      console.error(`[scheduler] pengiriman sebelumnya macet ${Math.round(lamanya / 60000)} menit, dipaksa lepas.`);
      running = false;
      runningSince = null;
    }
    const config = store.getConfig();

    if (!config.targets.length) return { skipped: true, reason: 'Belum ada grup tujuan. Kirim /scan.' };
    if (!config.text && !config.imagePath) return { skipped: true, reason: 'Teks dan gambar masih kosong.' };

    // Koneksi akun bisa putus (restart server, jaringan). Coba sambung ulang dulu
    // sebelum menyerah, supaya auto post tidak mati diam-diam.
    if (!(await userClient.isLoggedIn())) {
      const reconnected = userClient.connectIfPossible ? await userClient.connectIfPossible() : null;
      if (!reconnected) {
        return { skipped: true, reason: 'Akun Telegram terputus atau belum login. Kirim /login.' };
      }
      console.log('[scheduler] koneksi akun tersambung ulang.');
    }

    running = true;
    runningSince = Date.now();
    aborted = false;
    const results = [];
    const dropped = [];
    const mode = config.autoRemove || '3x';

    try {
      for (const chatId of [...config.targets]) {
        // Owner bisa menghentikan pengiriman panjang di tengah jalan lewat /off.
        if (aborted) {
          console.warn('[post] pengiriman dihentikan owner.');
          break;
        }
        const outcome = await sendWithRetry(chatId, config);
        results.push(outcome);

        if (outcome.ok) {
          // Berhasil = hitungan gagal beruntun direset.
          store.markChat(chatId, { status: 'ok', error: '', fails: 0, lastPostAt: new Date().toISOString() });
        } else {
          const fails = (store.getGroups()[String(chatId)]?.fails || 0) + 1;
          const buang = shouldDrop({ mode, fatal: outcome.fatal, fails });
          store.markChat(chatId, { status: buang ? 'error' : 'warn', error: outcome.error, fails });
          if (buang) dropped.push({ chatId, error: outcome.error, fatal: outcome.fatal, fails });
        }
        if (config.gapSeconds > 0) await sleep(config.gapSeconds * 1000);
      }
    } finally {
      running = false;
      runningSince = null;
    }

    if (dropped.length) {
      const removed = new Set(dropped.map((item) => String(item.chatId)));
      store.saveConfig({ targets: store.getConfig().targets.filter((id) => !removed.has(String(id))) });
    }

    const sent = results.filter((item) => item.ok).length;
    const failed = results.length - sent;
    const dihentikan = aborted;
    aborted = false;
    // Statistik disimpan supaya /status bisa jadi bukti tanpa perlu pesan masuk.
    store.saveConfig({
      lastRunAt: new Date().toISOString(),
      lastRunStats: { sent, failed, manual, dihentikan },
      lastResults: results.slice(-30)
    });

    const adaMasalah = Boolean(failed || dropped.length || dihentikan);
    if (notifyOwner && bolehLapor({ manual, adaMasalah })) {
      await notifyOwner(buildSummary({ sent, failed, dropped, results, manual, dihentikan }));
    }
    return { sent, failed, results, dropped, dihentikan };
  }

  // Satu grup: kirim, tunggu bila kena FLOOD_WAIT/SLOWMODE, lalu coba sekali lagi.
  async function sendWithRetry(chatId, config) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await withTimeout(
          userClient.sendPost({
            chatId,
            text: config.text,
            imagePath: config.imagePath,
            parseMode: config.parseMode
          }),
          sendTimeoutMs,
          'Pengiriman'
        );
        return { chatId, ok: true };
      } catch (error) {
        const wait = waitSeconds(error);
        const message = errorText(error);
        if (wait > 0 && attempt === 0) {
          if (wait > MAX_FLOOD_WAIT) {
            console.warn(`[post] ${chatId}: diminta tunggu ${wait} detik, dilewati dulu.`);
            return { chatId, ok: false, error: `Telegram meminta tunggu ${wait} detik`, fatal: false };
          }
          console.warn(`[post] ${chatId}: menunggu ${wait} detik (limit Telegram).`);
          await sleep((wait + 1) * 1000);
          continue;
        }
        console.error(`[post] ${chatId}: ${message}`);
        return { chatId, ok: false, error: message, fatal: isFatal(error) };
      }
    }
    return { chatId, ok: false, error: 'Gagal setelah percobaan ulang.', fatal: false };
  }

  function buildSummary({ sent, failed, dropped, results, manual, dihentikan }) {
    const groups = store.getGroups();
    const title = (id) => escapeHtml(groups[String(id)]?.title || id);
    const judul = dihentikan ? 'dihentikan' : 'selesai';
    const lines = [`<b>${manual ? 'Kirim manual' : 'Auto post'} ${judul}</b>`, `Berhasil: ${sent} | Gagal: ${failed}`];
    for (const item of results.filter((entry) => !entry.ok).slice(0, 10)) {
      lines.push(`• ${title(item.chatId)} — ${escapeHtml(item.error)}`);
    }
    if (dropped.length) {
      lines.push('', '<b>Dilepas dari daftar tujuan:</b>');
      for (const item of dropped) {
        const sebab = item.fatal ? 'sudah tidak bisa posting' : `gagal ${item.fails}x beruntun`;
        lines.push(`• ${title(item.chatId)} — ${sebab}\n  <code>${item.chatId}</code>`);
      }
      lines.push('<i>Tambahkan lagi lewat /scan kalau ternyata masih bisa.</i>');
    }
    return lines.join('\n');
  }

  /** Hentikan pengiriman yang sedang berjalan (dipakai /off). */
  function abort() {
    if (!running) return false;
    aborted = true;
    return true;
  }

  /** Dipakai /status untuk memastikan penjadwalnya benar-benar hidup. */
  function health() {
    const config = store.getConfig();
    return {
      armed: Boolean(timer),
      running,
      runningForMs: runningSince ? Date.now() - runningSince : 0,
      nextRunInMs: config.nextRunAt ? Date.parse(config.nextRunAt) - Date.now() : null,
      lastTickAt,
      lastSkipReason
    };
  }

  return { reschedule, runOnce, stop, abort, health, isRunning: () => running };
}

// Selain meloloskan tanda HTML, string juga dibersihkan dari potongan emoji
// dan karakter kontrol yang ditolak Telegram ("must be encoded in UTF-8").
function escapeHtml(value) {
  return sanitize(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

module.exports = { createScheduler, escapeHtml, isFatal, waitSeconds, shouldDrop };
