'use strict';
const store = require('./store');
const { sendPost, escapeHtml } = require('./scheduler');

const HELP = `<b>Perintah Auto Poster</b>

<b>Isi postingan</b>
/settext — atur teks (boleh langsung: <code>/settext Halo semua</code>)
/setgambar — atur gambar (kirim foto, atau <code>/setgambar https://...</code>)
/hapusgambar — hapus gambar, kirim teks saja
/mode — format teks: <code>/mode html</code> | <code>/mode markdown</code> | <code>/mode none</code>
/pratinjau — lihat contoh kiriman

<b>Jadwal</b>
/setinterval — jarak kirim dalam menit, contoh <code>/setinterval 60</code>
/setjeda — jeda antar grup dalam detik, contoh <code>/setjeda 5</code>
/on — aktifkan auto post
/off — matikan auto post
/kirim — kirim sekarang juga

<b>Grup tujuan</b>
/scan — daftar semua grup yang bot ikuti + ID-nya, klik untuk pilih
/target — lihat tujuan aktif (<code>/target add ID</code>, <code>/target del ID</code>, <code>/target clear</code>)
/id — tampilkan ID chat (jalankan di dalam grup)
/addhere — jadikan grup tempat perintah ini dikirim sebagai tujuan

<b>Lain-lain</b>
/status — ringkasan pengaturan
/log — hasil pengiriman terakhir
/batal — batalkan input yang sedang ditunggu`;

function createBot({ api, scheduler, me }) {
  const pending = new Map(); // userId -> nama input yang sedang ditunggu

  function ownerId() {
    const fromEnv = String(process.env.OWNER_ID || '').trim();
    if (fromEnv) return fromEnv;
    const saved = store.getConfig().ownerId;
    return saved ? String(saved) : '';
  }

  const isOwner = (userId) => Boolean(ownerId()) && String(userId) === ownerId();

  const reply = (chatId, text, extra = {}) =>
    api.sendMessage({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra });

  async function notifyOwner(text) {
    const owner = ownerId();
    if (!owner) return;
    try {
      await reply(owner, text);
    } catch (error) {
      console.error('[notify] gagal kirim ke owner:', error.message);
    }
  }

  // ---------- tampilan ----------

  function menuKeyboard() {
    const config = store.getConfig();
    return {
      inline_keyboard: [
        [
          { text: config.enabled ? '⏸️ Matikan auto post' : '▶️ Aktifkan auto post', callback_data: 'toggle' },
          { text: '🚀 Kirim sekarang', callback_data: 'postnow' }
        ],
        [
          { text: '📋 Scan grup', callback_data: 'scan' },
          { text: '🎯 Tujuan', callback_data: 'targets' }
        ],
        [
          { text: '👁️ Pratinjau', callback_data: 'preview' },
          { text: '🔄 Status', callback_data: 'status' }
        ]
      ]
    };
  }

  function statusText() {
    const config = store.getConfig();
    const groups = store.getGroups();
    const targetLines = config.targets.length
      ? config.targets
          .map((id) => `• ${escapeHtml(groups[String(id)]?.title || 'Tanpa nama')} (<code>${id}</code>)`)
          .join('\n')
      : '<i>belum ada</i>';
    const preview = config.text ? escapeHtml(config.text.slice(0, 120)) : '<i>kosong</i>';

    return [
      `<b>Status ${escapeHtml(me?.first_name || 'Auto Poster')}</b>`,
      `Auto post : ${config.enabled ? '🟢 aktif' : '🔴 mati'}`,
      `Interval  : ${config.intervalMinutes} menit`,
      `Jeda grup : ${config.gapSeconds} detik`,
      `Format    : ${config.parseMode}`,
      `Gambar    : ${config.photo ? '✅ ada' : '—'}`,
      `Terkirim  : ${config.lastRunAt ? formatTime(config.lastRunAt) : '—'}`,
      `Berikutnya: ${config.enabled && config.nextRunAt ? formatTime(config.nextRunAt) : '—'}`,
      '',
      `<b>Teks</b>\n${preview}`,
      '',
      `<b>Grup tujuan (${config.targets.length})</b>\n${targetLines}`
    ].join('\n');
  }

  function scanText() {
    const groups = Object.values(store.getGroups());
    if (!groups.length) {
      return [
        '<b>Belum ada grup terdeteksi.</b>',
        '',
        'Cara mendaftarkan grup:',
        '1. Tambahkan bot ini ke grup tujuan.',
        '2. Jadikan admin (wajib kalau grup membatasi anggota mengirim pesan).',
        '3. Ketik <code>/id</code> di dalam grup, atau kirim pesan apa pun di grup itu.',
        '',
        'Grup akan otomatis muncul di sini beserta ID-nya.'
      ].join('\n');
    }
    const config = store.getConfig();
    const lines = ['<b>Grup yang terdeteksi</b>', ''];
    for (const group of sortGroups(groups)) {
      const mark = config.targets.includes(String(group.id)) ? '🎯' : '▫️';
      const health = group.status === 'error' ? ' ⚠️' : '';
      lines.push(`${mark} ${escapeHtml(group.title)}${health}\n   <code>${group.id}</code> · ${group.type}`);
    }
    lines.push('', 'Klik tombol di bawah untuk menambah/menghapus tujuan.');
    return lines.join('\n');
  }

  function scanKeyboard() {
    const config = store.getConfig();
    const groups = sortGroups(Object.values(store.getGroups())).slice(0, 40);
    const rows = groups.map((group) => [
      {
        text: `${config.targets.includes(String(group.id)) ? '✅' : '⬜'} ${truncate(group.title, 40)}`,
        callback_data: `t:${group.id}`
      }
    ]);
    rows.push([{ text: '⬅️ Menu', callback_data: 'menu' }]);
    return { inline_keyboard: rows };
  }

  // ---------- router ----------

  async function handleUpdate(update) {
    if (update.my_chat_member) return handleMembership(update.my_chat_member);
    if (update.callback_query) return handleCallback(update.callback_query);
    const message = update.message || update.channel_post;
    if (!message) return;

    const chat = message.chat;
    if (chat.type === 'private') return handlePrivate(message);

    // Setiap pesan di grup dipakai untuk mengisi daftar hasil scan.
    store.rememberChat(chat);
    const text = (message.text || '').trim();
    if (/^\/(id|ping)(@\w+)?$/i.test(text)) {
      await reply(chat.id, `ID chat ini: <code>${chat.id}</code>\nJudul: ${escapeHtml(chat.title || '-')}`, {
        reply_to_message_id: message.message_id
      });
    } else if (/^\/addhere(@\w+)?$/i.test(text) && isOwner(message.from?.id)) {
      addTarget(chat.id);
      await reply(chat.id, `✅ Grup ini ditambahkan sebagai tujuan (<code>${chat.id}</code>).`);
    }
  }

  async function handleMembership(event) {
    const chat = event.chat;
    const status = event.new_chat_member?.status;
    if (['member', 'administrator'].includes(status)) {
      store.rememberChat(chat);
      await notifyOwner(
        `➕ Bot ditambahkan ke <b>${escapeHtml(chat.title || chat.type)}</b>\nID: <code>${chat.id}</code>\n` +
          `Status: ${status}\n\nPakai /scan untuk memilihnya sebagai tujuan.`
      );
    } else if (['left', 'kicked'].includes(status)) {
      store.markChat(chat.id, { status: 'error', error: `bot ${status}` });
      const config = store.getConfig();
      if (config.targets.includes(String(chat.id))) {
        store.saveConfig({ targets: config.targets.filter((id) => String(id) !== String(chat.id)) });
      }
      await notifyOwner(`➖ Bot keluar/dikeluarkan dari <b>${escapeHtml(chat.title || chat.id)}</b> dan dilepas dari daftar tujuan.`);
    }
  }

  async function handlePrivate(message) {
    const userId = message.from?.id;
    const chatId = message.chat.id;
    const text = (message.text || message.caption || '').trim();

    if (!ownerId()) {
      if (/^\/claim/i.test(text)) {
        store.saveConfig({ ownerId: String(userId) });
        return reply(chatId, `✅ Anda terdaftar sebagai owner (<code>${userId}</code>).\n\n${HELP}`, {
          reply_markup: menuKeyboard()
        });
      }
      return reply(
        chatId,
        `Bot belum punya owner.\nID Telegram Anda: <code>${userId}</code>\n\n` +
          'Kirim /claim untuk menjadikan akun ini owner, atau isi <code>OWNER_ID</code> di file .env lalu restart bot.'
      );
    }

    if (!isOwner(userId)) {
      return reply(chatId, `Bot ini hanya bisa dipakai ownernya.\nID Anda: <code>${userId}</code>`);
    }

    // Sedang menunggu input lanjutan dari perintah sebelumnya.
    if (pending.has(userId) && !text.startsWith('/')) {
      return consumePending(userId, chatId, message);
    }
    if (message.photo && !text.startsWith('/')) return consumePending(userId, chatId, message, 'photo');

    const [rawCommand, ...rest] = text.split(/\s+/);
    const command = rawCommand.toLowerCase().replace(/@.*$/, '');
    const argument = text.slice(rawCommand.length).trim();

    switch (command) {
      case '/start':
      case '/menu':
        return reply(chatId, `${statusText()}\n\nKetik /help untuk daftar perintah.`, { reply_markup: menuKeyboard() });
      case '/help':
        return reply(chatId, HELP, { reply_markup: menuKeyboard() });
      case '/claim':
        return reply(chatId, 'Owner sudah terdaftar.');
      case '/status':
        return reply(chatId, statusText(), { reply_markup: menuKeyboard() });

      case '/settext':
      case '/setteks':
        if (argument) {
          store.saveConfig({ text: argument });
          return reply(chatId, '✅ Teks disimpan.\n\n' + preview(argument));
        }
        pending.set(userId, 'text');
        return reply(chatId, 'Kirim teks postingannya sekarang. Batalkan dengan /batal.');

      case '/setgambar':
      case '/setimage':
        if (argument) {
          store.saveConfig({ photo: argument });
          return reply(chatId, '✅ Gambar (URL) disimpan.');
        }
        pending.set(userId, 'photo');
        return reply(chatId, 'Kirim fotonya sekarang (atau tempel URL gambar). Batalkan dengan /batal.');

      case '/hapusgambar':
      case '/delimage':
        store.saveConfig({ photo: '' });
        return reply(chatId, '✅ Gambar dihapus, bot akan mengirim teks saja.');

      case '/setinterval': {
        const minutes = Number(argument);
        if (!Number.isFinite(minutes) || minutes < 1) {
          pending.set(userId, 'interval');
          return reply(chatId, 'Berapa menit sekali? Kirim angkanya, contoh <code>30</code>.');
        }
        const config = store.saveConfig({ intervalMinutes: minutes });
        scheduler.reschedule();
        return reply(chatId, `✅ Interval jadi ${config.intervalMinutes} menit.`, { reply_markup: menuKeyboard() });
      }

      case '/setjeda': {
        const seconds = Number(argument);
        if (!Number.isFinite(seconds) || seconds < 0) {
          pending.set(userId, 'gap');
          return reply(chatId, 'Berapa detik jeda antar grup? Kirim angkanya, contoh <code>5</code>.');
        }
        const config = store.saveConfig({ gapSeconds: seconds });
        return reply(chatId, `✅ Jeda antar grup jadi ${config.gapSeconds} detik.`);
      }

      case '/mode': {
        const mode = argument.toLowerCase();
        const map = { html: 'HTML', markdown: 'MarkdownV2', md: 'MarkdownV2', none: 'none', polos: 'none' };
        if (!map[mode]) return reply(chatId, 'Pilihan: <code>/mode html</code>, <code>/mode markdown</code>, atau <code>/mode none</code>.');
        store.saveConfig({ parseMode: map[mode] });
        return reply(chatId, `✅ Format teks jadi ${map[mode]}.`);
      }

      case '/scan':
        return reply(chatId, scanText(), { reply_markup: scanKeyboard() });

      case '/target': {
        const [action, value] = argument.split(/\s+/);
        if (action === 'add' && value) {
          addTarget(value);
          return reply(chatId, `✅ <code>${escapeHtml(value)}</code> ditambahkan.`, { reply_markup: menuKeyboard() });
        }
        if ((action === 'del' || action === 'remove') && value) {
          const config = store.getConfig();
          store.saveConfig({ targets: config.targets.filter((id) => String(id) !== String(value)) });
          return reply(chatId, `✅ <code>${escapeHtml(value)}</code> dihapus dari tujuan.`);
        }
        if (action === 'clear') {
          store.saveConfig({ targets: [] });
          return reply(chatId, '✅ Semua tujuan dikosongkan.');
        }
        return reply(chatId, statusText(), { reply_markup: scanKeyboard() });
      }

      case '/on': {
        const check = validateReady();
        if (check) return reply(chatId, `⚠️ ${check}`);
        store.saveConfig({ enabled: true });
        const nextRunAt = scheduler.reschedule();
        return reply(
          chatId,
          `🟢 Auto post aktif setiap ${store.getConfig().intervalMinutes} menit.\nKiriman pertama: ${formatTime(nextRunAt)}\nMau langsung? /kirim`,
          { reply_markup: menuKeyboard() }
        );
      }

      case '/off':
        store.saveConfig({ enabled: false, nextRunAt: null });
        scheduler.stop();
        return reply(chatId, '🔴 Auto post dimatikan.', { reply_markup: menuKeyboard() });

      case '/kirim':
      case '/postnow': {
        const result = await scheduler.runOnce({ manual: true });
        if (result.skipped) return reply(chatId, `⚠️ ${result.reason}`);
        return null; // ringkasan sudah dikirim scheduler
      }

      case '/pratinjau':
      case '/preview':
        return sendPreview(chatId);

      case '/log': {
        const { lastResults, lastRunAt } = store.getConfig();
        if (!lastResults.length) return reply(chatId, 'Belum ada riwayat pengiriman.');
        const groups = store.getGroups();
        const lines = lastResults.map((item) => {
          const title = groups[String(item.chatId)]?.title || item.chatId;
          return `${item.ok ? '✅' : '❌'} ${escapeHtml(title)}${item.ok ? '' : ` — ${escapeHtml(item.error)}`}`;
        });
        return reply(chatId, `<b>Pengiriman ${formatTime(lastRunAt)}</b>\n${lines.join('\n')}`);
      }

      case '/batal':
      case '/cancel':
        pending.delete(userId);
        return reply(chatId, 'Dibatalkan.');

      case '/id':
        return reply(chatId, `ID Anda: <code>${userId}</code>`);

      default:
        return reply(chatId, 'Perintah tidak dikenal. Ketik /help.', { reply_markup: menuKeyboard() });
    }
  }

  async function consumePending(userId, chatId, message, forced) {
    const action = forced || pending.get(userId);
    if (!action) return null;

    if (action === 'text') {
      const value = message.text || message.caption || '';
      if (!value.trim()) return reply(chatId, 'Teks kosong, coba lagi.');
      pending.delete(userId);
      store.saveConfig({ text: value });
      return reply(chatId, '✅ Teks disimpan.\n\n' + preview(value), { reply_markup: menuKeyboard() });
    }

    if (action === 'photo') {
      if (message.photo?.length) {
        const best = message.photo[message.photo.length - 1];
        const patch = { photo: best.file_id };
        if (message.caption) patch.text = message.caption;
        pending.delete(userId);
        store.saveConfig(patch);
        return reply(chatId, `✅ Gambar disimpan.${message.caption ? ' Caption dipakai sebagai teks.' : ''}`, {
          reply_markup: menuKeyboard()
        });
      }
      const url = (message.text || '').trim();
      if (/^https?:\/\//i.test(url)) {
        pending.delete(userId);
        store.saveConfig({ photo: url });
        return reply(chatId, '✅ Gambar (URL) disimpan.', { reply_markup: menuKeyboard() });
      }
      return reply(chatId, 'Kirim fotonya sebagai gambar, atau tempel URL yang diawali http(s)://.');
    }

    if (action === 'interval' || action === 'gap') {
      const number = Number((message.text || '').trim());
      if (!Number.isFinite(number) || number < 0) return reply(chatId, 'Kirim angka saja, contoh <code>30</code>.');
      pending.delete(userId);
      if (action === 'interval') {
        const config = store.saveConfig({ intervalMinutes: Math.max(1, number) });
        scheduler.reschedule();
        return reply(chatId, `✅ Interval jadi ${config.intervalMinutes} menit.`, { reply_markup: menuKeyboard() });
      }
      const config = store.saveConfig({ gapSeconds: number });
      return reply(chatId, `✅ Jeda antar grup jadi ${config.gapSeconds} detik.`);
    }
    return null;
  }

  async function handleCallback(query) {
    const userId = query.from?.id;
    const chatId = query.message?.chat?.id;
    const data = query.data || '';

    if (!isOwner(userId)) {
      return api.answerCallbackQuery({ callback_query_id: query.id, text: 'Hanya owner.', show_alert: true });
    }
    await api.answerCallbackQuery({ callback_query_id: query.id });

    if (data.startsWith('t:')) {
      const id = data.slice(2);
      const config = store.getConfig();
      if (config.targets.includes(id)) {
        store.saveConfig({ targets: config.targets.filter((item) => item !== id) });
      } else {
        addTarget(id);
      }
      return safeEdit(query, scanText(), scanKeyboard());
    }

    switch (data) {
      case 'menu':
      case 'status':
        return safeEdit(query, statusText(), menuKeyboard());
      case 'scan':
      case 'targets':
        return safeEdit(query, scanText(), scanKeyboard());
      case 'toggle': {
        const config = store.getConfig();
        if (!config.enabled) {
          const check = validateReady();
          if (check) return reply(chatId, `⚠️ ${check}`);
          store.saveConfig({ enabled: true });
          scheduler.reschedule();
        } else {
          store.saveConfig({ enabled: false, nextRunAt: null });
          scheduler.stop();
        }
        return safeEdit(query, statusText(), menuKeyboard());
      }
      case 'postnow': {
        const result = await scheduler.runOnce({ manual: true });
        if (result.skipped) return reply(chatId, `⚠️ ${result.reason}`);
        return null;
      }
      case 'preview':
        return sendPreview(chatId);
      default:
        return null;
    }
  }

  // ---------- util ----------

  function addTarget(chatId) {
    const config = store.getConfig();
    store.saveConfig({ targets: [...config.targets, String(chatId)] });
    store.markChat(chatId, { status: 'ok', error: '' });
  }

  function validateReady() {
    const config = store.getConfig();
    if (!config.targets.length) return 'Belum ada grup tujuan. Pakai /scan dulu.';
    if (!config.text && !config.photo) return 'Teks dan gambar masih kosong. Pakai /settext atau /setgambar.';
    return null;
  }

  async function sendPreview(chatId) {
    const config = store.getConfig();
    if (!config.text && !config.photo) return reply(chatId, 'Belum ada isi postingan.');
    try {
      await sendPost(api, chatId, config);
    } catch (error) {
      return reply(chatId, `⚠️ Pratinjau gagal: ${escapeHtml(error.description || error.message)}\nCek format teks (/mode) atau URL gambar.`);
    }
    return reply(chatId, '⬆️ Begini tampilan yang akan dikirim ke grup.');
  }

  async function safeEdit(query, text, replyMarkup) {
    try {
      await api.editMessageText({
        chat_id: query.message.chat.id,
        message_id: query.message.message_id,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: replyMarkup
      });
    } catch (error) {
      if (!String(error.description || '').includes('message is not modified')) {
        await reply(query.message.chat.id, text, { reply_markup: replyMarkup });
      }
    }
  }

  function preview(text) {
    return `<b>Pratinjau teks</b>\n${escapeHtml(text.slice(0, 500))}`;
  }

  return { handleUpdate, notifyOwner, ownerId, isOwner, statusText };
}

function sortGroups(groups) {
  return [...groups].sort((a, b) => String(a.title).localeCompare(String(b.title), 'id'));
}

function truncate(value, max) {
  const text = String(value);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function formatTime(value) {
  if (!value) return '—';
  return new Date(value).toLocaleString('id-ID', {
    timeZone: process.env.TZ || 'Asia/Jakarta',
    dateStyle: 'short',
    timeStyle: 'short'
  });
}

module.exports = { createBot, HELP };
