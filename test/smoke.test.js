'use strict';
/**
 * Uji panel kontrol + penjadwal tanpa menyentuh Telegram:
 * Bot API dan akun pengirim sama-sama diganti tiruan.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '..', 'data');
fs.rmSync(dataDir, { recursive: true, force: true });

const store = require('../src/store');
const { createScheduler } = require('../src/scheduler');
const { createBot } = require('../src/bot');

const OWNER = 111;
const GRUP_A = '-1001111111111';
const GRUP_B = '-1002222222222';

const outbox = [];      // pesan yang dikirim bot ke owner
const posted = [];      // postingan yang dikirim akun ke grup
const deleted = [];     // pesan yang dihapus (QR lama / password)
const photos = [];      // gambar yang diunggah bot (QR login)
let downloads = 0;

const api = {
  call: async () => ({}),
  sendMessage: async (params) => {
    outbox.push(params);
    return { message_id: outbox.length };
  },
  editMessageText: async (params) => {
    outbox.push(params);
    return { message_id: params.message_id };
  },
  answerCallbackQuery: async () => null,
  deleteMessage: async (params) => {
    deleted.push(params);
    return true;
  },
  sendPhotoBuffer: async (params) => {
    photos.push(params);
    return { message_id: 500 + photos.length };
  },
  downloadFile: async (_fileId, destination) => {
    downloads++;
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, 'gambar-palsu');
    return { path: destination, bytes: 12 };
  }
};

// Akun pengirim tiruan.
const account = {
  loggedIn: false,
  loginCalls: [],
  failNext: null,
  floodOnce: false,
  async isLoggedIn() {
    return this.loggedIn;
  },
  async status() {
    return this.loggedIn
      ? { loggedIn: true, account: { id: '777', name: 'Fauzi', username: 'fauzi', phone: '+628123456789' } }
      : { loggedIn: false, account: null };
  },
  async startQrLogin() {
    this.loginCalls.push('qr');
    return true;
  },
  submitPassword(password) {
    this.password = password;
    return true;
  },
  cancelLogin: () => true,
  hasPendingLogin: () => false,
  async logout() {
    this.loggedIn = false;
    return true;
  },
  async listGroups() {
    return [
      { id: GRUP_A, title: 'Grup Promo A', type: 'supergrup', username: '' },
      { id: GRUP_B, title: 'Grup Promo B', type: 'grup', username: '' }
    ];
  },
  async sendPost(payload) {
    if (this.floodOnce && payload.chatId === GRUP_A) {
      this.floodOnce = false;
      const error = new Error('FLOOD_WAIT_1');
      error.seconds = 1;
      throw error;
    }
    if (payload.chatId === GRUP_B) {
      throw new Error('CHAT_WRITE_FORBIDDEN: kamu tidak boleh menulis di grup ini');
    }
    posted.push(payload);
    return { id: posted.length };
  },
  async disconnect() {}
};

const qrTools = {
  available: true,
  isAvailable() {
    return this.available;
  },
  async toPng(url) {
    return Buffer.from(`png:${url}`);
  }
};

let bot;
const scheduler = createScheduler({ userClient: account, notifyOwner: (text) => bot.notifyOwner(text) });
bot = createBot({ api, scheduler, userClient: account, qrTools, me: { id: 999, username: 'panelbot' } });

const pesan = (text, extra = {}) => ({
  message: { message_id: outbox.length + 1, from: { id: OWNER }, chat: { id: OWNER, type: 'private' }, text, ...extra }
});
const klik = (data) => ({
  callback_query: { id: 'cb', from: { id: OWNER }, data, message: { message_id: 9, chat: { id: OWNER } } }
});
const terakhir = () => outbox[outbox.length - 1].text;

/** Tunggu pengiriman latar belakang selesai (maksimal ~5 detik). */
async function tungguSelesai() {
  for (let i = 0; i < 500; i++) {
    if (!scheduler.health().running) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      if (!scheduler.health().running) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('pengiriman latar belakang tidak selesai');
}

async function run() {
  delete process.env.OWNER_ID;

  // 1. Owner didaftarkan lewat /claim.
  await bot.handleUpdate(pesan('/start'));
  assert.match(terakhir(), /belum punya owner/i);
  await bot.handleUpdate(pesan('/claim'));
  assert.strictEqual(store.getConfig().ownerId, String(OWNER));

  // 2. Akun lain ditolak.
  await bot.handleUpdate({ message: { message_id: 2, from: { id: 222 }, chat: { id: 222, type: 'private' }, text: '/status' } });
  assert.match(terakhir(), /hanya bisa dipakai ownernya/i);

  // 3. Login QR: tidak ada kode OTP yang diketik di chat.
  await bot.handleUpdate(pesan('/login'));
  assert.deepStrictEqual(account.loginCalls, ['qr'], 'login QR dimulai');
  assert.match(terakhir(), /Telegram membatalkan kode yang terdeteksi dikirim lewat chat/i);

  await bot.handleAccountEvent({ type: 'qr', url: 'tg://login?token=AAAA', expires: 30, attempt: 1 });
  assert.strictEqual(photos.length, 1, 'QR dikirim sebagai gambar');
  assert.match(photos[0].caption, /Tautkan Perangkat Desktop/);
  assert.strictEqual(deleted.length, 0, 'QR pertama belum perlu dihapus');

  // QR diperbarui -> gambar lama dihapus supaya tidak menumpuk.
  await bot.handleAccountEvent({ type: 'qr', url: 'tg://login?token=BBBB', expires: 30, attempt: 2 });
  assert.strictEqual(photos.length, 2);
  assert.strictEqual(deleted[0].message_id, 501, 'QR lama dihapus');

  // 2FA tetap lewat chat (password tidak dibatalkan Telegram), pesannya dihapus.
  await bot.handleAccountEvent({ type: 'need-password', hint: 'nama kucing' });
  await bot.handleUpdate(pesan('rahasia'));
  assert.strictEqual(account.password, 'rahasia');
  assert.ok(deleted.some((item) => item.message_id > 0), 'pesan password dihapus');

  account.loggedIn = true;
  await bot.handleAccountEvent({ type: 'logged-in', account: { name: 'Fauzi', username: 'fauzi' } });
  assert.match(terakhir(), /Akun terhubung/i);

  // Kalau paket qrcode belum terpasang, owner diarahkan ke login terminal.
  account.loggedIn = false;
  qrTools.available = false;
  await bot.handleUpdate(pesan('/login'));
  assert.match(terakhir(), /npm run login/i, 'ada jalan keluar lewat terminal');
  qrTools.available = true;
  account.loggedIn = true;

  // 4. Scan grup diambil dari daftar chat akun.
  await bot.handleUpdate(pesan('/scan'));
  const groups = store.getGroups();
  assert.ok(groups[GRUP_A] && groups[GRUP_B], 'dua grup tersimpan');
  assert.ok(terakhir().includes(GRUP_A) && terakhir().includes('Grup Promo B'), 'ID grup ditampilkan');

  // 5. Pilih tujuan lewat tombol.
  await bot.handleUpdate(klik(`t:${GRUP_A}:0`));
  await bot.handleUpdate(klik(`t:${GRUP_B}:0`));
  assert.deepStrictEqual(store.getConfig().targets, [GRUP_A, GRUP_B]);

  // 6. Isi teks, interval, jeda.
  await bot.handleUpdate(pesan('/settext'));
  await bot.handleUpdate(pesan('Promo hari ini!'));
  assert.strictEqual(store.getConfig().text, 'Promo hari ini!');
  await bot.handleUpdate(pesan('/setinterval 45'));
  assert.strictEqual(store.getConfig().intervalMinutes, 45);
  await bot.handleUpdate(pesan('/setinterval 5'));
  assert.match(terakhir(), /berisiko membuat akun kena limit/i, 'interval terlalu pendek diperingatkan');
  await bot.handleUpdate(pesan('/setinterval 45'));
  await bot.handleUpdate(pesan('/setjeda 0'));
  assert.strictEqual(store.getConfig().gapSeconds, 0);

  // 7. Gambar diunduh dari Bot API lalu disimpan sebagai file.
  await bot.handleUpdate(pesan('/setgambar'));
  await bot.handleUpdate({
    message: { message_id: 30, from: { id: OWNER }, chat: { id: OWNER, type: 'private' }, photo: [{ file_id: 'kecil' }, { file_id: 'besar' }] }
  });
  assert.strictEqual(downloads, 1);
  assert.ok(fs.existsSync(store.getConfig().imagePath), 'file gambar ada di uploads');
  await bot.handleUpdate(pesan('/hapusgambar'));
  assert.strictEqual(store.getConfig().imagePath, '');

  // 8. Auto post tidak bisa aktif kalau akun belum login.
  account.loggedIn = false;
  await bot.handleUpdate(pesan('/on'));
  assert.match(terakhir(), /belum login/i);
  account.loggedIn = true;

  // 9. /on langsung mengirim satu putaran sebagai pembuktian — owner tidak perlu
  //    menunggu satu interval penuh untuk tahu auto post benar-benar jalan.
  account.floodOnce = true;
  outbox.length = 0;
  await bot.handleUpdate(pesan('/on'));
  await tungguSelesai(); // pengiriman kini berjalan di latar belakang

  assert.strictEqual(store.getConfig().enabled, true);
  assert.ok(store.getConfig().nextRunAt, 'jadwal berikutnya tersimpan');
  assert.ok(outbox.some((item) => /pembuktian/i.test(item.text)), 'owner diberi tahu sedang mengirim');
  assert.strictEqual(posted.length, 1, 'grup A terkirim setelah menunggu FLOOD_WAIT');
  assert.strictEqual(posted[0].text, 'Promo hari ini!');
  assert.deepStrictEqual(store.getConfig().targets, [GRUP_A], 'grup terlarang dilepas otomatis');
  assert.ok(outbox.some((item) => /Dilepas dari daftar tujuan/.test(item.text)), 'owner diberi tahu');

  // Penjadwal benar-benar terpasang, bukan cuma flag di config.
  assert.strictEqual(scheduler.health().armed, true, 'timer auto post aktif');
  await bot.handleUpdate(pesan('/status'));
  assert.match(terakhir(), /Penjadwal: 🟢 aktif/, 'status menampilkan penjadwal hidup');

  // 10. Riwayat pengiriman.
  await bot.handleUpdate(pesan('/log'));
  assert.match(terakhir(), /Grup Promo A/);

  // 11. Matikan, lalu logout mematikan auto post juga.
  await bot.handleUpdate(pesan('/off'));
  assert.strictEqual(store.getConfig().enabled, false);
  store.saveConfig({ enabled: true });
  await bot.handleUpdate(pesan('/logout'));
  assert.strictEqual(store.getConfig().enabled, false, 'logout mematikan auto post');
  scheduler.stop();

  console.log('✅ Uji panel lolos (11 skenario).');
}

run()
  .catch((error) => {
    console.error('❌ Uji panel gagal:', error.message);
    process.exitCode = 1;
  })
  .finally(() => {
    scheduler.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(path.join(__dirname, '..', 'uploads'), { recursive: true, force: true });
  });
