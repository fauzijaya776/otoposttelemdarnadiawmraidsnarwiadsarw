'use strict';
const path = require('path');
const fs = require('fs');
const store = require('./store');
const defaultQrTools = require('./qr');
const { buttonLabel, sanitize } = require('./text');
const { escapeHtml } = require('./scheduler');

const uploadDir = path.join(__dirname, '..', 'uploads');

const HELP = `<b>Panel Auto Poster</b>
Postingan dikirim dari <b>akun Telegram Anda</b>. Bot ini hanya remote control-nya.

<b>Akun pengirim</b>
/login — hubungkan akun dengan memindai QR dari HP
/akun — lihat akun yang terhubung
/logout — putuskan akun

⚠️ Kode OTP <b>tidak bisa</b> diketik di chat ini: Telegram otomatis membatalkan
kode yang terkirim lewat chat. Pakai QR, atau login dari terminal: <code>npm run login</code>

<b>Isi postingan</b>
/settext — atur teks (boleh langsung: <code>/settext Halo semua</code>)
/setgambar — atur gambar (kirim fotonya ke bot ini)
/hapusgambar — kirim teks saja
/mode — format teks: <code>/mode html</code> | <code>/mode markdown</code> | <code>/mode none</code>
/pratinjau — kirim contoh ke Pesan Tersimpan Anda

<b>Jadwal</b>
/setinterval — jarak kirim dalam menit, contoh <code>/setinterval 60</code>
/setjeda — jeda antar grup dalam detik, contoh <code>/setjeda 15</code>
/on — aktifkan auto post
/off — matikan auto post
/kirim — kirim sekarang juga

<b>Grup tujuan</b>
/scan — ambil semua grup yang diikuti akun Anda + ID-nya, klik untuk memilih
/target — <code>/target add ID</code>, <code>/target del ID</code>, <code>/target clear</code>

<b>Lain-lain</b>
/status — ringkasan pengaturan
/diag — periksa kenapa auto post kirim / tidak kirim
/notif — atur laporan: <code>mati</code> | <code>penting</code> | <code>semua</code>
/autohapus — kapan grup gagal dibuang: <code>langsung</code> | <code>3x</code> | <code>fatal</code>
/log — hasil pengiriman terakhir
/batal — batalkan input yang sedang ditunggu`;

function createBot({ api, scheduler, userClient, me, qrTools = defaultQrTools, version = '?' }) {
  const pending = new Map(); // userId -> input yang sedang ditunggu

  function ownerId() {
    const fromEnv = String(process.env.OWNER_ID || '').trim();
    if (fromEnv) return fromEnv;
    const saved = store.getConfig().ownerId;
    return saved ? String(saved) : '';
  }

  const isOwner = (userId) => Boolean(ownerId()) && String(userId) === ownerId();

  const reply = (chatId, text, extra = {}) =>
    api.sendMessage({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra });

  async function notifyOwner(text, extra) {
    const owner = ownerId();
    if (!owner) return null;
    try {
      return await reply(owner, text, extra);
    } catch (error) {
      console.error('[notify] gagal kirim ke owner:', error.message);
      return null;
    }
  }

  // ---------- kejadian dari proses login akun ----------

  async function handleAccountEvent(event) {
    const owner = ownerId();
    if (!owner) return;

    if (event.type === 'qr') return sendQrCode(owner, event);
    if (event.type === 'need-password') {
      pending.set(owner, 'password');
      return notifyOwner(
        `🔐 Akun ini memakai verifikasi dua langkah.${event.hint ? `\nPetunjuk: <i>${escapeHtml(event.hint)}</i>` : ''}\n\n` +
          'Kirim password 2FA Anda. Pesannya akan langsung saya hapus setelah dipakai.'
      );
    }
    if (event.type === 'logged-in') {
      pending.delete(owner);
      await clearQrMessage(owner);
      const account = event.account;
      return notifyOwner(
        `✅ Akun terhubung: <b>${escapeHtml(account.name)}</b>` +
          `${account.username ? ` (@${account.username})` : ''}\n\nLanjut /scan untuk mengambil daftar grup.`,
        { reply_markup: menuKeyboard() }
      );
    }
    if (event.type === 'login-failed') {
      pending.delete(owner);
      await clearQrMessage(owner);
      return notifyOwner(`❌ ${escapeHtml(event.message)}`);
    }
    if (event.type === 'error') {
      return notifyOwner(`⚠️ ${escapeHtml(event.message)}`);
    }
    return null;
  }

  // ---------- QR login ----------

  let qrMessageId = null;

  async function sendQrCode(chatId, event) {
    const caption =
      '<b>Login tanpa kode</b>\n' +
      'Di HP: Telegram → Pengaturan → <b>Perangkat</b> → <b>Tautkan Perangkat Desktop</b>, lalu pindai QR ini.\n\n' +
      `Kode ini berganti otomatis tiap 30 detik (ke-${event.attempt}). Batalkan dengan /batal.`;
    try {
      const buffer = await qrTools.toPng(event.url);
      const previous = qrMessageId;
      const message = await api.sendPhotoBuffer({ chatId, buffer, filename: 'login-qr.png', caption });
      qrMessageId = message.message_id;
      if (previous) await api.deleteMessage({ chat_id: chatId, message_id: previous });
      return message;
    } catch (error) {
      userClient.cancelLogin();
      return reply(
        chatId,
        `⚠️ Tidak bisa membuat QR: ${escapeHtml(error.message)}\n\n` +
          'Login lewat terminal saja: jalankan <code>npm run login</code> di komputer tempat bot berjalan.'
      );
    }
  }

  async function clearQrMessage(chatId) {
    if (!qrMessageId) return;
    const messageId = qrMessageId;
    qrMessageId = null;
    await api.deleteMessage({ chat_id: chatId, message_id: messageId });
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
          { text: '👁️ Pratinjau', callback_data: 'preview' }
        ],
        [
          { text: '🔐 Akun', callback_data: 'account' },
          { text: '🔄 Status', callback_data: 'status' }
        ]
      ]
    };
  }

  async function statusText() {
    const config = store.getConfig();
    const groups = store.getGroups();
    const account = await userClient.status();

    const shownTargets = config.targets.slice(0, 20);
    const targetLines = config.targets.length
      ? shownTargets
          .map((id) => `• ${escapeHtml(groups[String(id)]?.title || 'Tanpa nama')} (<code>${id}</code>)`)
          .join('\n') +
        (config.targets.length > shownTargets.length
          ? `\n<i>…dan ${config.targets.length - shownTargets.length} grup lain (lihat /scan)</i>`
          : '')
      : '<i>belum ada</i>';

    const text = [
      `<b>Status Auto Poster</b> <i>v${escapeHtml(version)}</i>`,
      `Akun     : ${account.loggedIn ? `🟢 ${escapeHtml(account.account.name)}` : '🔴 belum login (/login)'}`,
      `Auto post: ${config.enabled ? '🟢 aktif' : '🔴 mati'}`,
      `Interval : ${config.intervalMinutes} menit`,
      `Jeda grup: ${config.gapSeconds} detik`,
      `Format   : ${config.parseMode}`,
      `Laporan  : ${labelNotif(config.notifyLevel)}`,
      `Buang gagal: ${labelAutoHapus(config.autoRemove)}`,
      `Gambar   : ${config.imagePath ? '✅ ada' : '—'}`,
      `Terkirim : ${ringkasanTerakhir(config)}`,
      `Berikutnya: ${config.enabled && config.nextRunAt ? formatTime(config.nextRunAt) : '—'}`,
      `Penjadwal: ${schedulerLine()}`,
      '',
      `<b>Teks</b>\n${config.text ? escapeHtml(config.text.slice(0, 200)) : '<i>kosong</i>'}`,
      '',
      `<b>Grup tujuan (${config.targets.length})</b>\n${targetLines}`
    ].join('\n');
    return clampText(text);
  }

  // Telegram menolak pesan di atas 4096 karakter, jadi daftar grup dipotong per halaman.
  const PER_PAGE = 15;
  const MAX_TEXT = 3800;

  function totalPages() {
    return Math.max(1, Math.ceil(Object.keys(store.getGroups()).length / PER_PAGE));
  }

  function pageSlice(page) {
    const all = sortGroups(Object.values(store.getGroups()));
    const safePage = Math.min(Math.max(0, page), totalPages() - 1);
    return { safePage, all, items: all.slice(safePage * PER_PAGE, safePage * PER_PAGE + PER_PAGE) };
  }

  function scanText(page = 0) {
    const { safePage, all, items } = pageSlice(page);
    if (!all.length) {
      return 'Belum ada grup tersimpan. Kirim /scan untuk mengambil daftar grup dari akun Anda.';
    }
    const config = store.getConfig();
    const lines = [
      `<b>Grup di akun Anda (${all.length})</b>`,
      `Halaman ${safePage + 1}/${totalPages()} · ditandai ${config.targets.length}`,
      ''
    ];
    for (const group of items) {
      const mark = config.targets.includes(String(group.id)) ? '🎯' : '▫️';
      const warn = group.status === 'error' ? ' ⚠️' : '';
      lines.push(`${mark} ${escapeHtml(group.title)}${warn}\n   <code>${group.id}</code> · ${group.type}`);
    }
    lines.push('', 'Klik tombol di bawah untuk menandai grup tujuan.');
    return clampText(lines.join('\n'));
  }

  function scanKeyboard(page = 0) {
    const config = store.getConfig();
    const { safePage, all, items } = pageSlice(page);

    const rows = items.map((group) => [
      {
        text: `${config.targets.includes(String(group.id)) ? '✅' : '⬜'} ${buttonLabel(group.title, 40)}`,
        callback_data: `t:${group.id}:${safePage}`
      }
    ]);

    const nav = [];
    if (safePage > 0) nav.push({ text: '⬅️ Sebelumnya', callback_data: `page:${safePage - 1}` });
    if ((safePage + 1) * PER_PAGE < all.length) nav.push({ text: 'Berikutnya ➡️', callback_data: `page:${safePage + 1}` });
    if (nav.length) rows.push(nav);

    rows.push([
      { text: '🔄 Muat ulang dari akun', callback_data: 'rescan' },
      { text: '⬅️ Menu', callback_data: 'menu' }
    ]);
    return { inline_keyboard: rows };
  }

  // ---------- router ----------

  async function handleUpdate(update) {
    if (update.callback_query) return handleCallback(update.callback_query);
    const message = update.message;
    if (!message) return null;

    if (message.chat.type !== 'private') {
      const text = (message.text || '').trim();
      if (/^\/(id|ping)(@\w+)?$/i.test(text)) {
        return reply(message.chat.id, `ID chat ini: <code>${message.chat.id}</code>`, {
          reply_to_message_id: message.message_id
        });
      }
      return null;
    }
    return handlePrivate(message);
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
          'Kirim /claim untuk menjadikan akun ini owner, atau isi <code>OWNER_ID</code> di .env lalu restart.'
      );
    }

    if (!isOwner(userId)) {
      return reply(chatId, `Bot ini hanya bisa dipakai ownernya.\nID Anda: <code>${userId}</code>`);
    }

    const waiting = pending.get(String(userId)) || pending.get(userId);
    if (waiting && (!text.startsWith('/') || waiting === 'password')) {
      return consumePending(userId, chatId, message, waiting);
    }
    if (message.photo && !text.startsWith('/')) return consumePending(userId, chatId, message, 'photo');

    const [rawCommand] = text.split(/\s+/);
    const command = rawCommand.toLowerCase().replace(/@.*$/, '');
    const argument = text.slice(rawCommand.length).trim();

    switch (command) {
      case '/start':
      case '/menu':
        return reply(chatId, `${await statusText()}\n\nKetik /help untuk daftar perintah.`, {
          reply_markup: menuKeyboard()
        });
      case '/help':
        return reply(chatId, HELP, { reply_markup: menuKeyboard() });
      case '/claim':
        return reply(chatId, 'Owner sudah terdaftar.');
      case '/status':
        return reply(chatId, await statusText(), { reply_markup: menuKeyboard() });
      case '/id':
        return reply(chatId, `ID Anda: <code>${userId}</code>`);

      case '/diag':
        return reply(chatId, await diagnosa(), { reply_markup: menuKeyboard() });

      case '/autohapus': {
        const pilihan = {
          langsung: 'langsung',
          '1x': 'langsung',
          '3x': '3x',
          '3': '3x',
          fatal: 'fatal',
          mati: 'fatal',
          off: 'fatal'
        };
        const mode = pilihan[argument.toLowerCase()];
        if (!mode) {
          return reply(
            chatId,
            `<b>Buang grup gagal otomatis</b>\nSekarang: <b>${labelAutoHapus(store.getConfig().autoRemove)}</b>\n\n` +
              '<code>/autohapus langsung</code> — sekali gagal langsung dibuang\n' +
              '<code>/autohapus 3x</code> — dibuang setelah 3 kali gagal beruntun (bawaan)\n' +
              '<code>/autohapus fatal</code> — hanya kalau Telegram menyatakan tidak boleh kirim\n\n' +
              'Grup yang benar-benar mengeluarkan/memblokir Anda <b>selalu</b> langsung dibuang, apa pun pilihannya.'
          );
        }
        store.saveConfig({ autoRemove: mode });
        return reply(chatId, `✅ Buang grup gagal: <b>${labelAutoHapus(mode)}</b>.`, { reply_markup: menuKeyboard() });
      }

      case '/notif': {
        const pilihan = { semua: 'semua', penting: 'penting', mati: 'mati', off: 'mati', diam: 'mati' };
        const level = pilihan[argument.toLowerCase()];
        if (!level) {
          const sekarang = store.getConfig().notifyLevel || 'penting';
          return reply(
            chatId,
            `<b>Laporan auto post</b>\nSekarang: <b>${labelNotif(sekarang)}</b>\n\n` +
              '<code>/notif mati</code> — bot tidak pernah mengirim laporan; cek hasilnya lewat /status\n' +
              '<code>/notif penting</code> — hanya kalau ada grup gagal atau siklus dilewati (bawaan)\n' +
              '<code>/notif semua</code> — laporan tiap siklus\n\n' +
              'Kiriman manual (/kirim) tetap dibalas karena Anda yang meminta.'
          );
        }
        store.saveConfig({ notifyLevel: level });
        return reply(
          chatId,
          `✅ Laporan diatur ke: <b>${labelNotif(level)}</b>.` +
            (level === 'mati' ? '\n\nBukti pengiriman terakhir tetap bisa dilihat kapan saja lewat /status.' : ''),
          { reply_markup: menuKeyboard() }
        );
      }

      // ----- akun pengirim -----
      case '/login': {
        const account = await userClient.status();
        if (account.loggedIn) {
          return reply(chatId, `Akun <b>${escapeHtml(account.account.name)}</b> sudah terhubung. Putuskan dulu dengan /logout.`);
        }
        if (!qrTools.isAvailable()) {
          return reply(
            chatId,
            '⚠️ Paket <code>qrcode</code> belum terpasang, jadi login QR belum bisa dipakai.\n\n' +
              'Jalankan <code>npm install</code> lalu /login lagi, atau login lewat terminal: <code>npm run login</code>.'
          );
        }
        await reply(
          chatId,
          '⏳ Menyiapkan QR login…\n\n' +
            'Kode OTP sengaja tidak dipakai di sini: Telegram membatalkan kode yang terdeteksi dikirim lewat chat.'
        );
        try {
          await userClient.startQrLogin();
        } catch (error) {
          return reply(chatId, `⚠️ ${escapeHtml(error.message)}`);
        }
        return null;
      }

      case '/akun': {
        const account = await userClient.status();
        if (!account.loggedIn) return reply(chatId, '🔴 Belum ada akun terhubung. Kirim /login.');
        const info = account.account;
        return reply(
          chatId,
          `<b>Akun pengirim</b>\nNama: ${escapeHtml(info.name)}\n` +
            `${info.username ? `Username: @${escapeHtml(info.username)}\n` : ''}` +
            `${info.phone ? `Nomor: <code>${escapeHtml(info.phone)}</code>\n` : ''}` +
            `ID: <code>${info.id}</code>`
        );
      }

      case '/logout': {
        store.saveConfig({ enabled: false, nextRunAt: null });
        scheduler.stop();
        await userClient.logout();
        return reply(chatId, '✅ Akun diputuskan dan sesi dihapus. Auto post dimatikan.');
      }

      // ----- isi postingan -----
      case '/settext':
      case '/setteks':
        if (argument) {
          store.saveConfig({ text: argument });
          return reply(chatId, `✅ Teks disimpan.\n\n<b>Pratinjau</b>\n${escapeHtml(argument.slice(0, 500))}`);
        }
        setPending(userId, 'text');
        return reply(chatId, 'Kirim teks postingannya sekarang. Batalkan dengan /batal.');

      case '/setgambar':
      case '/setimage':
        setPending(userId, 'photo');
        return reply(chatId, 'Kirim fotonya ke chat ini sekarang (boleh dengan caption). Batalkan dengan /batal.');

      case '/hapusgambar':
      case '/delimage':
        store.saveConfig({ imagePath: '' });
        return reply(chatId, '✅ Gambar dihapus, postingan jadi teks saja.');

      case '/mode': {
        const map = { html: 'html', markdown: 'md', md: 'md', none: 'none', polos: 'none' };
        const mode = map[argument.toLowerCase()];
        if (!mode) return reply(chatId, 'Pilihan: <code>/mode html</code>, <code>/mode markdown</code>, <code>/mode none</code>.');
        store.saveConfig({ parseMode: mode });
        return reply(chatId, `✅ Format teks jadi ${mode}.`);
      }

      case '/pratinjau':
      case '/preview':
        return sendPreview(chatId);

      // ----- jadwal -----
      case '/setinterval': {
        const minutes = Number(argument);
        if (!Number.isFinite(minutes) || minutes < 1) {
          setPending(userId, 'interval');
          return reply(chatId, 'Berapa menit sekali? Kirim angkanya, contoh <code>60</code>.');
        }
        const config = store.saveConfig({ intervalMinutes: minutes });
        scheduler.reschedule();
        return reply(chatId, `✅ Interval jadi ${config.intervalMinutes} menit.${intervalWarning(config)}`, {
          reply_markup: menuKeyboard()
        });
      }

      case '/setjeda': {
        const seconds = Number(argument);
        if (!Number.isFinite(seconds) || seconds < 0) {
          setPending(userId, 'gap');
          return reply(chatId, 'Berapa detik jeda antar grup? Kirim angkanya, contoh <code>15</code>.');
        }
        const config = store.saveConfig({ gapSeconds: seconds });
        return reply(chatId, `✅ Jeda antar grup jadi ${config.gapSeconds} detik.${gapWarning(config)}`);
      }

      case '/on': {
        const problem = await validateReady();
        if (problem) return reply(chatId, `⚠️ ${problem}`);
        store.saveConfig({ enabled: true });
        const nextRunAt = scheduler.reschedule();
        const config = store.getConfig();
        await reply(
          chatId,
          `🟢 Auto post aktif setiap ${config.intervalMinutes} menit ke ${config.targets.length} grup.\n` +
            `Kiriman berikutnya: ${formatTime(nextRunAt)}${intervalWarning(config)}\n\n` +
            '⏳ Mengirim satu putaran sekarang sebagai pembuktian…\n' +
            'Setelah ini bot tidak mengabari tiap siklus — cek hasilnya lewat /status.',
          { reply_markup: menuKeyboard() }
        );
        // Kirim sekali langsung supaya owner tahu pipeline-nya benar-benar bekerja,
        // bukan menunggu satu interval penuh tanpa kepastian.
        kirimDiLatarBelakang(chatId);
        return null;
      }

      case '/off': {
        store.saveConfig({ enabled: false, nextRunAt: null });
        scheduler.stop();
        const dihentikan = scheduler.abort ? scheduler.abort() : false;
        return reply(
          chatId,
          dihentikan
            ? '🔴 Auto post dimatikan. Pengiriman yang sedang berjalan dihentikan setelah grup ini.'
            : '🔴 Auto post dimatikan.',
          { reply_markup: menuKeyboard() }
        );
      }

      case '/kirim':
      case '/postnow': {
        await reply(chatId, '⏳ Mengirim… (bot tetap bisa menerima perintah, /off untuk menghentikan)');
        kirimDiLatarBelakang(chatId);
        return null; // ringkasan dikirim scheduler saat selesai
      }

      // ----- grup -----
      case '/scan':
        return refreshGroups(chatId);

      case '/target': {
        const [action, value] = argument.split(/\s+/);
        if (action === 'add' && value) {
          if (!isValidChatId(value)) {
            return reply(
              chatId,
              `⚠️ <code>${escapeHtml(value)}</code> bukan ID chat yang sah.\n\n` +
                'Contoh yang benar: <code>-1001234567890</code> atau <code>@namagrup</code>.\n' +
                'Cara termudah: /scan lalu pilih lewat tombol.'
            );
          }
          addTarget(value);
          return reply(chatId, `✅ <code>${escapeHtml(value)}</code> ditambahkan.`);
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
        return reply(chatId, scanText(0), { reply_markup: scanKeyboard(0) });
      }

      case '/log': {
        const { lastResults, lastRunAt } = store.getConfig();
        if (!lastResults.length) return reply(chatId, 'Belum ada riwayat pengiriman.');
        const groups = store.getGroups();
        const lines = lastResults.map((item) => {
          const title = groups[String(item.chatId)]?.title || item.chatId;
          return `${item.ok ? '✅' : '❌'} ${escapeHtml(title)}${item.ok ? '' : ` — ${escapeHtml(item.error)}`}`;
        });
        return reply(chatId, clampText(`<b>Pengiriman ${formatTime(lastRunAt)}</b>\n${lines.join('\n')}`));
      }

      case '/batal':
      case '/cancel':
        pending.delete(String(userId));
        userClient.cancelLogin();
        return reply(chatId, 'Dibatalkan.');

      default:
        return reply(chatId, 'Perintah tidak dikenal. Ketik /help.', { reply_markup: menuKeyboard() });
    }
  }

  // ---------- input bertahap ----------

  function setPending(userId, action) {
    pending.set(String(userId), action);
  }

  async function consumePending(userId, chatId, message, action) {
    const text = (message.text || '').trim();

    if (action === 'password') {
      await api.deleteMessage({ chat_id: chatId, message_id: message.message_id });
      try {
        userClient.submitPassword(text);
        return reply(chatId, '⏳ Password dikirim, menunggu verifikasi…');
      } catch (error) {
        return reply(chatId, `⚠️ ${escapeHtml(error.message)}`);
      }
    }

    if (action === 'text') {
      const value = message.text || message.caption || '';
      if (!value.trim()) return reply(chatId, 'Teks kosong, coba lagi.');
      pending.delete(String(userId));
      store.saveConfig({ text: value });
      return reply(chatId, `✅ Teks disimpan.\n\n<b>Pratinjau</b>\n${escapeHtml(value.slice(0, 500))}`, {
        reply_markup: menuKeyboard()
      });
    }

    if (action === 'photo') {
      if (!message.photo?.length) {
        return reply(chatId, 'Kirim gambarnya sebagai foto ya (bukan link atau file).');
      }
      const best = message.photo[message.photo.length - 1];
      pending.delete(String(userId));
      try {
        fs.mkdirSync(uploadDir, { recursive: true });
        const destination = path.join(uploadDir, `post-${Date.now()}.jpg`);
        await api.downloadFile(best.file_id, destination);
        cleanupOldImages(destination);
        const patch = { imagePath: destination };
        if (message.caption) patch.text = message.caption;
        store.saveConfig(patch);
        return reply(chatId, `✅ Gambar disimpan.${message.caption ? ' Caption dipakai sebagai teks.' : ''}`, {
          reply_markup: menuKeyboard()
        });
      } catch (error) {
        return reply(chatId, `⚠️ Gagal menyimpan gambar: ${escapeHtml(error.message)}`);
      }
    }

    if (action === 'interval' || action === 'gap') {
      const number = Number(text);
      if (!Number.isFinite(number) || number < 0) return reply(chatId, 'Kirim angka saja, contoh <code>60</code>.');
      pending.delete(String(userId));
      if (action === 'interval') {
        const config = store.saveConfig({ intervalMinutes: Math.max(1, number) });
        scheduler.reschedule();
        return reply(chatId, `✅ Interval jadi ${config.intervalMinutes} menit.${intervalWarning(config)}`, {
          reply_markup: menuKeyboard()
        });
      }
      const config = store.saveConfig({ gapSeconds: number });
      return reply(chatId, `✅ Jeda antar grup jadi ${config.gapSeconds} detik.${gapWarning(config)}`);
    }
    return null;
  }

  // ---------- tombol ----------

  async function handleCallback(query) {
    const userId = query.from?.id;
    const chatId = query.message?.chat?.id;

    if (!isOwner(userId)) {
      return api.answerCallbackQuery({ callback_query_id: query.id, text: 'Hanya owner.', show_alert: true });
    }
    await api.answerCallbackQuery({ callback_query_id: query.id });

    try {
      return await routeCallback(query, chatId);
    } catch (error) {
      const detail = error?.description || error?.message || String(error);
      console.error('[tombol] gagal:', detail);
      return reply(chatId, `⚠️ Tombol gagal diproses: ${escapeHtml(detail)}`).catch(() => null);
    }
  }

  async function routeCallback(query, chatId) {
    const data = query.data || '';

    if (data.startsWith('t:')) {
      const [, id, page] = data.split(':');
      const config = store.getConfig();
      if (config.targets.includes(id)) {
        store.saveConfig({ targets: config.targets.filter((item) => item !== id) });
      } else {
        addTarget(id);
      }
      return safeEdit(query, scanText(Number(page) || 0), scanKeyboard(Number(page) || 0));
    }
    if (data.startsWith('page:')) {
      const page = Number(data.split(':')[1]) || 0;
      return safeEdit(query, scanText(page), scanKeyboard(page));
    }

    switch (data) {
      case 'menu':
      case 'status':
        return safeEdit(query, await statusText(), menuKeyboard());
      case 'scan':
        return safeEdit(query, scanText(0), scanKeyboard(0));
      case 'rescan':
        return refreshGroups(chatId);
      case 'account': {
        const account = await userClient.status();
        return reply(
          chatId,
          account.loggedIn
            ? `🟢 Akun terhubung: <b>${escapeHtml(account.account.name)}</b>`
            : '🔴 Belum ada akun terhubung. Kirim /login.'
        );
      }
      case 'toggle': {
        const config = store.getConfig();
        if (!config.enabled) {
          const problem = await validateReady();
          if (problem) return reply(chatId, `⚠️ ${problem}`);
          store.saveConfig({ enabled: true });
          scheduler.reschedule();
        } else {
          store.saveConfig({ enabled: false, nextRunAt: null });
          scheduler.stop();
          if (scheduler.abort) scheduler.abort();
        }
        return safeEdit(query, await statusText(), menuKeyboard());
      }
      case 'postnow': {
        await reply(chatId, '⏳ Mengirim… (bot tetap bisa menerima perintah, /off untuk menghentikan)');
        kirimDiLatarBelakang(chatId);
        return null;
      }
      case 'preview':
        return sendPreview(chatId);
      default:
        // Biasanya tombol dari pesan versi lama setelah bot diperbarui.
        console.warn('[tombol] data tidak dikenal:', data);
        return reply(chatId, 'Tombol ini sudah tidak berlaku (mungkin dari pesan lama). Kirim /menu untuk panel terbaru.', {
          reply_markup: menuKeyboard()
        });
    }
  }

  // ---------- util ----------

  /** Ambil ulang daftar grup dari akun pengirim, lalu simpan ke groups.json. */
  async function refreshGroups(chatId) {
    if (!(await userClient.isLoggedIn())) {
      return reply(chatId, '⚠️ Akun belum login. Kirim /login dulu.');
    }
    await reply(chatId, '⏳ Mengambil daftar grup dari akun Anda…');
    try {
      const found = await userClient.listGroups();
      const previous = store.getGroups();
      const next = {};
      for (const group of found) {
        next[group.id] = {
          ...previous[group.id],
          id: group.id,
          title: sanitize(group.title) || 'Tanpa nama',
          type: group.type,
          username: group.username,
          status: previous[group.id]?.status === 'error' ? 'error' : 'ok',
          lastSeenAt: new Date().toISOString()
        };
      }
      store.saveGroups(next);

      // Buang tujuan yang sudah tidak ada di akun.
      const config = store.getConfig();
      const stillThere = config.targets.filter((id) => next[String(id)]);
      if (stillThere.length !== config.targets.length) store.saveConfig({ targets: stillThere });

      if (!found.length) {
        return reply(chatId, 'Akun Anda belum tergabung di grup mana pun.');
      }
      return reply(chatId, scanText(0), { reply_markup: scanKeyboard(0) });
    } catch (error) {
      return reply(chatId, `⚠️ Gagal mengambil daftar grup: ${escapeHtml(error.message)}`);
    }
  }

  // ID chat Telegram selalu angka (negatif untuk grup/channel) atau @username.
  function isValidChatId(value) {
    const text = String(value).trim();
    return /^-?\d{5,20}$/.test(text) || /^@[A-Za-z][\w]{3,31}$/.test(text);
  }

  function addTarget(chatId) {
    const config = store.getConfig();
    store.saveConfig({ targets: [...config.targets, String(chatId)] });
    store.markChat(chatId, { status: 'ok', error: '' });
  }

  // Pengiriman ke puluhan grup bisa makan menit-menitan. Kalau ditunggu di dalam
  // handler, seluruh bot ikut membeku dan /off pun tidak terjawab. Jadi dijalankan
  // di latar belakang; ringkasannya dikirim scheduler saat selesai.
  function kirimDiLatarBelakang(chatId) {
    scheduler
      .runOnce({ manual: true })
      .then((result) => {
        if (result?.skipped) return reply(chatId, `⚠️ ${result.reason}`);
        return null;
      })
      .catch((error) => reply(chatId, `⚠️ Pengiriman gagal: ${escapeHtml(error.message)}`).catch(() => null));
  }

  async function validateReady() {
    const config = store.getConfig();
    if (!(await userClient.isLoggedIn())) return 'Akun Telegram belum login. Kirim /login.';
    if (!config.targets.length) return 'Belum ada grup tujuan. Kirim /scan.';
    if (!config.text && !config.imagePath) return 'Teks dan gambar masih kosong.';
    return null;
  }

  async function sendPreview(chatId) {
    const config = store.getConfig();
    if (!config.text && !config.imagePath) return reply(chatId, 'Belum ada isi postingan.');
    if (!(await userClient.isLoggedIn())) return reply(chatId, '⚠️ Akun belum login, pratinjau belum bisa dikirim.');
    try {
      await userClient.sendPost({
        chatId: 'me',
        text: config.text,
        imagePath: config.imagePath,
        parseMode: config.parseMode
      });
      return reply(chatId, '✅ Contoh postingan dikirim ke <b>Pesan Tersimpan</b> (Saved Messages) akun Anda.');
    } catch (error) {
      return reply(chatId, `⚠️ Pratinjau gagal: ${escapeHtml(error.message || error)}`);
    }
  }

  async function safeEdit(query, rawText, replyMarkup) {
    const text = clampText(rawText);
    const chatId = query.message.chat.id;
    try {
      await api.editMessageText({
        chat_id: chatId,
        message_id: query.message.message_id,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: replyMarkup
      });
      return;
    } catch (error) {
      const detail = String(error.description || error.message || '');
      // Pesan yang isinya sama persis bukan kegagalan.
      if (detail.includes('message is not modified')) return;
      console.warn('[tombol] edit gagal, kirim pesan baru:', detail);
    }
    // Pesan aslinya mungkin sudah dihapus atau terlalu tua untuk diedit.
    await reply(chatId, text, { reply_markup: replyMarkup });
  }

  /** Laporan lengkap satu pesan: kenapa auto post kirim / tidak kirim. */
  async function diagnosa() {
    const config = store.getConfig();
    const info = scheduler.health ? scheduler.health() : {};
    const account = await userClient.status();
    const baris = [];

    baris.push(`<b>Diagnosa Auto Poster</b> (versi ${escapeHtml(version)})`, '');
    baris.push(`${account.loggedIn ? '✅' : '❌'} Akun: ${account.loggedIn ? escapeHtml(account.account.name) : 'belum login → /login'}`);
    baris.push(`${config.targets.length ? '✅' : '❌'} Grup tujuan: ${config.targets.length}${config.targets.length ? '' : ' → /scan'}`);
    baris.push(`${config.text || config.imagePath ? '✅' : '❌'} Isi: ${config.text ? 'teks' : ''}${config.imagePath ? (config.text ? ' + gambar' : 'gambar') : ''}${!config.text && !config.imagePath ? 'kosong → /settext' : ''}`);
    baris.push(`${config.enabled ? '✅' : '❌'} Auto post: ${config.enabled ? 'aktif' : 'mati → /on'}`);
    baris.push('');

    baris.push(`Interval : ${config.intervalMinutes} menit`);
    baris.push(`Jeda grup: ${config.gapSeconds} detik`);

    if (config.enabled) {
      baris.push(`Timer    : ${info.armed ? '✅ terpasang' : '❌ TIDAK terpasang'}`);
      if (typeof info.nextRunInMs === 'number' && info.nextRunInMs !== null) {
        const menit = Math.round(info.nextRunInMs / 60000);
        baris.push(`Kirim berikutnya: ${menit > 0 ? `${menit} menit lagi` : 'sebentar lagi'} (${formatTime(config.nextRunAt)})`);
      }
    }
    if (info.running) {
      baris.push(`Sedang mengirim: ya (${Math.round((info.runningForMs || 0) / 1000)} detik)`);
    }
    baris.push(`Kirim terakhir : ${config.lastRunAt ? formatTime(config.lastRunAt) : 'belum pernah'}`);
    baris.push(`Cek terakhir   : ${info.lastTickAt ? formatTime(info.lastTickAt) : 'belum ada siklus'}`);
    if (info.lastSkipReason) baris.push(`Dilewati karena: ${escapeHtml(info.lastSkipReason)}`);

    const bermasalah = config.targets.filter((id) => (store.getGroups()[String(id)]?.fails || 0) > 0);
    if (bermasalah.length) {
      baris.push('', `⚠️ ${bermasalah.length} grup sedang bermasalah (akan dibuang: ${labelAutoHapus(config.autoRemove)}):`);
      for (const id of bermasalah.slice(0, 10)) {
        const grup = store.getGroups()[String(id)];
        baris.push(`• ${escapeHtml(grup.title)} — gagal ${grup.fails}x: ${escapeHtml(grup.error || '-')}`);
      }
    }

    const siap = account.loggedIn && config.targets.length && (config.text || config.imagePath);
    baris.push('', siap ? '👉 Semua syarat terpenuhi. /kirim untuk membuktikan sekarang.' : '👉 Lengkapi baris bertanda ❌ di atas dulu.');
    return clampText(baris.join('\n'));
  }

  // Bukti bahwa auto post bekerja, tanpa perlu pesan masuk tiap siklus.
  function ringkasanTerakhir(config) {
    if (!config.lastRunAt) return 'belum pernah';
    const waktu = formatTime(config.lastRunAt);
    const stats = config.lastRunStats;
    if (!stats) return waktu;
    const bagian = [`${stats.sent} berhasil`];
    if (stats.failed) bagian.push(`${stats.failed} gagal`);
    if (stats.dihentikan) bagian.push('dihentikan');
    return `${waktu} · ${bagian.join(', ')}${stats.manual ? ' (manual)' : ''}`;
  }

  function labelAutoHapus(mode) {
    if (mode === 'langsung') return 'sekali gagal langsung dibuang';
    if (mode === 'fatal') return 'hanya kalau dikick/diban';
    return 'setelah 3x gagal beruntun';
  }

  function labelNotif(level) {
    if (level === 'mati') return 'mati — cek lewat /status';
    if (level === 'semua') return 'setiap siklus';
    return 'hanya kalau ada masalah';
  }

  // Supaya kalau auto post "tidak jalan", penyebabnya kelihatan dari /status.
  function schedulerLine() {
    const config = store.getConfig();
    if (!config.enabled) return 'mati';
    const info = scheduler.health ? scheduler.health() : {};
    if (info.running) return '🟢 sedang mengirim';
    if (!info.armed) return '⚠️ timer tidak aktif — kirim /off lalu /on';
    const terakhir = info.lastTickAt ? ` · cek terakhir ${formatTime(info.lastTickAt)}` : '';
    const alasan = info.lastSkipReason ? `\n           ⏭️ dilewati: ${escapeHtml(info.lastSkipReason)}` : '';
    return `🟢 aktif${terakhir}${alasan}`;
  }

  function intervalWarning(config) {
    return config.intervalMinutes < 15
      ? '\n\n⚠️ Interval di bawah 15 menit berisiko membuat akun kena limit Telegram.'
      : '';
  }

  function gapWarning(config) {
    return config.gapSeconds < 5 ? '\n\n⚠️ Jeda di bawah 5 detik berisiko memicu FLOOD_WAIT.' : '';
  }

  // Simpan hanya gambar terbaru, sisanya dibuang supaya folder uploads tidak menumpuk.
  function cleanupOldImages(keepPath) {
    try {
      for (const name of fs.readdirSync(uploadDir)) {
        const full = path.join(uploadDir, name);
        if (full !== keepPath && name.startsWith('post-')) fs.rmSync(full, { force: true });
      }
    } catch {
      /* abaikan */
    }
  }

  return { handleUpdate, handleAccountEvent, notifyOwner, ownerId, isOwner, statusText };
}

// Jaga-jaga: Telegram menolak pesan lebih dari 4096 karakter.
function clampText(text, max = 3800) {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n<i>…daftar dipotong, buka halaman berikutnya.</i>`;
}

function sortGroups(groups) {
  return [...groups].sort((a, b) => String(a.title).localeCompare(String(b.title), 'id'));
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
