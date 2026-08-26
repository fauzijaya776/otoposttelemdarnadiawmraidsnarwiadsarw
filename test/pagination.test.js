'use strict';
/**
 * Regresi: dengan grup banyak, daftar /scan dan tombol halaman harus tetap
 * di bawah batas 4096 karakter Telegram, dan tombol tidak boleh diam saat gagal.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '..', 'data');
fs.rmSync(dataDir, { recursive: true, force: true });

const store = require('../src/store');
const { createBot } = require('../src/bot');

const TELEGRAM_LIMIT = 4096;
const JUMLAH_GRUP = 120;
const OWNER = 111;

// Judul panjang seperti nama grup promo pada umumnya.
const groups = {};
const ids = [];
for (let i = 0; i < JUMLAH_GRUP; i++) {
  const id = `-100${1000000000 + i}`;
  ids.push(id);
  groups[id] = {
    id,
    title: `GRUP PROMO JUAL BELI SERBA ADA SELURUH INDONESIA ${String(i).padStart(3, '0')}`,
    type: 'supergrup',
    status: 'ok'
  };
}
store.saveGroups(groups);
store.saveConfig({ ownerId: String(OWNER), targets: ids.slice(0, 60) });

const outbox = [];
let editFails = 0;

const api = {
  call: async () => ({}),
  sendMessage: async (params) => {
    cekPanjang(params.text, 'sendMessage');
    outbox.push({ kind: 'send', ...params });
    return { message_id: outbox.length };
  },
  editMessageText: async (params) => {
    cekPanjang(params.text, 'editMessageText');
    if (editFails > 0) {
      editFails--;
      const error = new Error('Bad Request: message to edit not found');
      error.description = 'Bad Request: message to edit not found';
      throw error;
    }
    outbox.push({ kind: 'edit', ...params });
    return { message_id: params.message_id };
  },
  answerCallbackQuery: async () => null,
  deleteMessage: async () => null
};

function cekPanjang(text, asal) {
  if (typeof text === 'string' && text.length > TELEGRAM_LIMIT) {
    const error = new Error(`Bad Request: message is too long (${text.length} > ${TELEGRAM_LIMIT}) dari ${asal}`);
    error.description = 'Bad Request: message is too long';
    throw error;
  }
}

const userClient = {
  isLoggedIn: async () => true,
  status: async () => ({ loggedIn: true, account: { id: '1', name: 'Fauzi', username: 'fauzi', phone: '' } })
};

const bot = createBot({
  api,
  scheduler: { reschedule: () => null, stop: () => {}, runOnce: async () => ({ skipped: true, reason: '-' }) },
  userClient,
  me: { id: 999, username: 'panelbot' }
});

const klik = (data) => ({
  callback_query: { id: 'cb', from: { id: OWNER }, data, message: { message_id: 9, chat: { id: OWNER } } }
});
const pesan = (text) => ({
  message: { message_id: 1, from: { id: OWNER }, chat: { id: OWNER, type: 'private' }, text }
});
const terakhir = () => outbox[outbox.length - 1];

async function run() {
  // 1. Daftar tujuan awal tidak boleh membuat /status kelebihan panjang.
  await bot.handleUpdate(pesan('/status'));
  assert.ok(terakhir().text.length <= TELEGRAM_LIMIT);
  assert.match(terakhir().text, /dan \d+ grup lain/, 'daftar tujuan panjang diringkas');

  // 2. Halaman pertama /target menampilkan potongan, bukan seluruh 120 grup.
  await bot.handleUpdate(pesan('/target'));
  const halamanSatu = terakhir().text;
  assert.ok(halamanSatu.length <= TELEGRAM_LIMIT, 'halaman 1 muat');
  assert.match(halamanSatu, /Halaman 1\/8/, 'ada penanda halaman');
  assert.ok(halamanSatu.includes(ids[0]) && !halamanSatu.includes(ids[20]), 'hanya grup halaman ini yang tampil');

  // 3. Semua halaman lewat tombol "Berikutnya" harus aman — ini yang dulu error.
  for (let page = 1; page < 8; page++) {
    await bot.handleUpdate(klik(`page:${page}`));
    const item = terakhir();
    assert.ok(item.text.length <= TELEGRAM_LIMIT, `halaman ${page + 1} muat`);
    assert.match(item.text, new RegExp(`Halaman ${page + 1}/8`), `halaman ${page + 1} benar`);
    assert.ok(!/Tombol gagal diproses/.test(item.text), `halaman ${page + 1} tidak error`);
  }

  // 4. Halaman di luar jangkauan dijepit ke halaman terakhir, bukan pesan kosong.
  await bot.handleUpdate(klik('page:99'));
  assert.match(terakhir().text, /Halaman 8\/8/);

  // 5. Tombol pilih grup di halaman mana pun tetap bekerja dan menyimpan pilihan.
  const sebelum = store.getConfig().targets.length;
  await bot.handleUpdate(klik(`t:${ids[100]}:6`));
  assert.strictEqual(store.getConfig().targets.length, sebelum + 1, 'grup halaman akhir ikut tersimpan');
  assert.match(terakhir().text, /Halaman 7\/8/, 'tetap di halaman yang sama setelah memilih');

  // 6. Kalau pesan lama tidak bisa diedit, bot mengirim pesan baru — bukan diam.
  editFails = 1;
  await bot.handleUpdate(klik('page:2'));
  assert.strictEqual(terakhir().kind, 'send', 'jatuh ke kirim pesan baru');
  assert.match(terakhir().text, /Halaman 3\/8/);

  // 7. Kegagalan tak terduga dilaporkan ke owner, tidak ditelan diam-diam.
  //    (a) error di dalam handler tombol.
  const rusak = createBot({
    api,
    scheduler: { reschedule: () => null, stop: () => {}, runOnce: async () => ({ skipped: true, reason: '-' }) },
    userClient: {
      ...userClient,
      listGroups: async () => {
        throw new Error('koneksi putus');
      }
    },
    me: { id: 999, username: 'panelbot' }
  });
  await rusak.handleUpdate(klik('rescan'));
  assert.match(terakhir().text, /koneksi putus/, 'error tombol dilaporkan ke owner');

  //    (b) error pada pengiriman latar belakang tetap sampai ke owner.
  const kirimRusak = createBot({
    api,
    scheduler: {
      reschedule: () => null,
      stop: () => {},
      abort: () => false,
      runOnce: async () => {
        throw new Error('jaringan mati');
      }
    },
    userClient,
    me: { id: 999, username: 'panelbot' }
  });
  await kirimRusak.handleUpdate(klik('postnow'));
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.ok(
    outbox.some((item) => /Pengiriman gagal: jaringan mati/.test(item.text)),
    'kegagalan pengiriman latar belakang dilaporkan'
  );

  console.log('✅ Uji paginasi lolos (7 skenario, 120 grup).');
}

run()
  .catch((error) => {
    console.error('❌ Uji paginasi gagal:', error.message);
    process.exitCode = 1;
  })
  .finally(() => fs.rmSync(dataDir, { recursive: true, force: true }));
