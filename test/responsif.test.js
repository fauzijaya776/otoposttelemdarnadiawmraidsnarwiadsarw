'use strict';
/**
 * Regresi: pengiriman ke banyak grup makan waktu menit-menitan (jeda antar grup).
 * Dulu handler menunggunya sampai selesai, sehingga SELURUH bot membeku —
 * /off dan /status tidak terjawab. Sekarang pengiriman jalan di latar belakang
 * dan bisa dihentikan.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '..', 'data');
fs.rmSync(dataDir, { recursive: true, force: true });

const store = require('../src/store');
const { createBot } = require('../src/bot');
const { createScheduler } = require('../src/scheduler');

const OWNER = 111;
const TUJUAN = Array.from({ length: 8 }, (_, i) => `-100${3000000000 + i}`);

const outbox = [];
const posted = [];
let lanjutkanKirim = null; // menahan pengiriman supaya kita bisa menyela di tengah

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
  deleteMessage: async () => null
};

const account = {
  isLoggedIn: async () => true,
  connectIfPossible: async () => ({ name: 'Fauzi' }),
  status: async () => ({ loggedIn: true, account: { id: '1', name: 'Fauzi', username: '', phone: '' } }),
  async sendPost(payload) {
    posted.push(payload);
    // Setiap grup menunggu izin dari tes — meniru jeda antar grup yang lama.
    await new Promise((resolve) => {
      lanjutkanKirim = resolve;
    });
    return { id: posted.length };
  }
};

let bot;
const scheduler = createScheduler({
  userClient: account,
  notifyOwner: (text) => bot.notifyOwner(text),
  timers: { setTimeout: () => 1, clearTimeout: () => {}, setInterval: () => 2, clearInterval: () => {} }
});
bot = createBot({ api, scheduler, userClient: account, me: { id: 999, username: 'panelbot' } });

const pesan = (text) => ({
  message: { message_id: outbox.length + 1, from: { id: OWNER }, chat: { id: OWNER, type: 'private' }, text }
});
const terakhir = () => outbox[outbox.length - 1].text;

/** Tunggu sampai pengiriman berikutnya sedang menggantung, lalu lepaskan satu grup. */
async function lepasSatuGrup() {
  for (let i = 0; i < 200 && !lanjutkanKirim; i++) await new Promise((r) => setImmediate(r));
  assert.ok(lanjutkanKirim, 'pengiriman harus sedang berjalan');
  const lepas = lanjutkanKirim;
  lanjutkanKirim = null;
  lepas();
  await new Promise((r) => setImmediate(r));
}

async function run() {
  store.saveConfig({
    ownerId: String(OWNER),
    enabled: false,
    intervalMinutes: 60,
    gapSeconds: 0,
    text: 'Promo hari ini!',
    imagePath: '',
    targets: [...TUJUAN]
  });

  // 1. /kirim membalas SEGERA, tidak menunggu 8 grup selesai.
  const mulai = Date.now();
  await bot.handleUpdate(pesan('/kirim'));
  assert.ok(Date.now() - mulai < 1000, 'handler tidak boleh menunggu pengiriman selesai');
  assert.match(terakhir(), /Mengirim…/);

  await lepasSatuGrup(); // grup 1 selesai, grup 2 mulai
  assert.ok(scheduler.health().running, 'pengiriman masih berjalan di latar belakang');

  // 2. Perintah lain TETAP dijawab selagi mengirim — ini yang dulu membeku.
  await bot.handleUpdate(pesan('/status'));
  assert.match(terakhir(), /Penjadwal/, '/status tetap terjawab saat mengirim');
  await bot.handleUpdate(pesan('/log'));
  assert.ok(outbox.length > 0, '/log tetap terjawab saat mengirim');

  // 3. /off menghentikan pengiriman yang sedang berjalan.
  await bot.handleUpdate(pesan('/off'));
  assert.match(terakhir(), /dihentikan setelah grup ini/i, 'owner diberi tahu pengiriman dihentikan');

  await lepasSatuGrup(); // grup yang sedang jalan selesai, sisanya dibatalkan
  for (let i = 0; i < 50 && scheduler.health().running; i++) await new Promise((r) => setImmediate(r));

  assert.strictEqual(scheduler.health().running, false, 'pengiriman benar-benar berhenti');
  assert.ok(posted.length < TUJUAN.length, `berhenti di tengah (${posted.length}/${TUJUAN.length} grup)`);
  assert.ok(
    outbox.some((item) => /Kirim manual dihentikan/.test(item.text)),
    'ringkasan menyebut pengiriman dihentikan'
  );

  console.log(`✅ Uji responsif lolos — bot tetap menjawab saat mengirim, berhenti di ${posted.length}/${TUJUAN.length} grup.`);
}

run()
  .catch((error) => {
    console.error('❌ Uji responsif gagal:', error.message);
    process.exitCode = 1;
  })
  .finally(() => {
    if (lanjutkanKirim) lanjutkanKirim();
    scheduler.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
