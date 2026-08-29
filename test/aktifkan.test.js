'use strict';
/**
 * Regresi: menyalakan auto post lewat TOMBOL panel dulu hanya memasang jadwal,
 * tanpa mengirim putaran pembuktian — beda dari perintah /on. Owner yang menekan
 * tombol jadi mengira auto post tidak jalan.
 *
 * Tes ini memaksa kedua jalur berperilaku identik.
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
const GRUP_A = '-1001111111111';
const GRUP_B = '-1002222222222';

let outbox = [];
let posted = [];

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
  loggedIn: true,
  isLoggedIn: async () => account.loggedIn,
  connectIfPossible: async () => (account.loggedIn ? { name: 'Fauzi' } : null),
  status: async () =>
    account.loggedIn
      ? { loggedIn: true, account: { id: '1', name: 'Fauzi', username: '', phone: '' } }
      : { loggedIn: false, account: null },
  async sendPost(payload) {
    posted.push(payload);
    return { id: posted.length };
  }
};

let bot;
const scheduler = createScheduler({
  userClient: account,
  notifyOwner: (text) => bot.notifyOwner(text),
  timers: { setTimeout: () => 1, clearTimeout: () => {}, setInterval: () => 2, clearInterval: () => {} }
});
bot = createBot({ api, scheduler, userClient: account, me: { id: 9, username: 'panelbot' }, version: 'test' });

const pesan = (text) => ({
  message: { message_id: outbox.length + 1, from: { id: OWNER }, chat: { id: OWNER, type: 'private' }, text }
});
const klik = (data) => ({
  callback_query: { id: 'cb', from: { id: OWNER }, data, message: { message_id: 9, chat: { id: OWNER } } }
});
const semuaTeks = () => outbox.map((item) => item.text).join('\n---\n');

function siapkan() {
  outbox = [];
  posted = [];
  store.saveConfig({
    ownerId: String(OWNER),
    enabled: false,
    nextRunAt: null,
    intervalMinutes: 60,
    gapSeconds: 0,
    text: 'Promo hari ini!',
    imagePath: '',
    targets: [GRUP_A, GRUP_B]
  });
}

async function tungguSelesai() {
  for (let i = 0; i < 400; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    if (!scheduler.health().running && posted.length) return;
  }
}

/** Jalankan satu cara menyalakan, lalu potret hasilnya. */
async function nyalakan(cara, update) {
  siapkan();
  await bot.handleUpdate(update);
  await tungguSelesai();
  return {
    cara,
    enabled: store.getConfig().enabled,
    armed: scheduler.health().armed,
    adaJadwal: Boolean(store.getConfig().nextRunAt),
    terkirim: posted.length,
    adaPembuktian: /pembuktian/i.test(semuaTeks()),
    adaRingkasan: /Kirim manual/i.test(semuaTeks())
  };
}

async function run() {
  // 1. Perintah /on dan tombol panel harus menghasilkan keadaan yang sama persis.
  const lewatPerintah = await nyalakan('/on', pesan('/on'));
  const lewatTombol = await nyalakan('tombol', klik('toggle'));

  assert.deepStrictEqual(
    { ...lewatTombol, cara: '-' },
    { ...lewatPerintah, cara: '-' },
    `tombol dan /on harus sama:\n  /on    = ${JSON.stringify(lewatPerintah)}\n  tombol = ${JSON.stringify(lewatTombol)}`
  );

  // 2. Dan keduanya benar-benar mengirim, bukan cuma memasang jadwal.
  for (const hasil of [lewatPerintah, lewatTombol]) {
    assert.strictEqual(hasil.enabled, true, `${hasil.cara}: auto post menyala`);
    assert.strictEqual(hasil.armed, true, `${hasil.cara}: timer terpasang`);
    assert.strictEqual(hasil.adaJadwal, true, `${hasil.cara}: jadwal berikutnya tersimpan`);
    assert.strictEqual(hasil.terkirim, 2, `${hasil.cara}: langsung mengirim ke 2 grup`);
    assert.ok(hasil.adaPembuktian, `${hasil.cara}: owner diberi tahu sedang mengirim`);
    assert.ok(hasil.adaRingkasan, `${hasil.cara}: ringkasan hasil dikirim`);
  }

  // 3. Syarat belum lengkap: dua-duanya menolak dengan cara yang sama, tanpa mengirim.
  for (const [cara, update] of [
    ['/on', pesan('/on')],
    ['tombol', klik('toggle')]
  ]) {
    siapkan();
    account.loggedIn = false;
    await bot.handleUpdate(update);
    assert.strictEqual(store.getConfig().enabled, false, `${cara}: tidak menyala saat akun belum login`);
    assert.strictEqual(posted.length, 0, `${cara}: tidak mengirim apa pun`);
    assert.match(semuaTeks(), /belum login/i, `${cara}: alasannya disebut`);
    account.loggedIn = true;
  }

  // 4. Mematikan juga sama lewat kedua jalur.
  for (const [cara, update] of [
    ['/off', pesan('/off')],
    ['tombol', klik('toggle')]
  ]) {
    siapkan();
    store.saveConfig({ enabled: true });
    outbox = [];
    await bot.handleUpdate(update);
    assert.strictEqual(store.getConfig().enabled, false, `${cara}: auto post mati`);
    assert.strictEqual(store.getConfig().nextRunAt, null, `${cara}: jadwal dibersihkan`);
    assert.match(semuaTeks(), /dimatikan/i, `${cara}: dikonfirmasi ke owner`);
  }

  console.log('✅ Uji aktifkan lolos — tombol dan /on berperilaku identik.');
}

run()
  .catch((error) => {
    console.error('❌ Uji aktifkan gagal:', error.message);
    process.exitCode = 1;
  })
  .finally(() => {
    scheduler.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
