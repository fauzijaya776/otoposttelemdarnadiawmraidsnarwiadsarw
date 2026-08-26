'use strict';
/**
 * Auto post tidak boleh mengirim laporan tiap siklus (spam). Buktinya cukup
 * dilihat lewat /status: kapan terakhir terkirim dan berapa yang berhasil.
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

const outbox = [];
const posted = [];
let gagalkanB = false;

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
    if (gagalkanB && payload.chatId === GRUP_B) throw new Error('CHAT_WRITE_FORBIDDEN');
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
const terakhir = () => outbox[outbox.length - 1].text;

async function run() {
  store.saveConfig({
    ownerId: String(OWNER),
    enabled: true,
    intervalMinutes: 60,
    gapSeconds: 0,
    text: 'Promo hari ini!',
    imagePath: '',
    targets: [GRUP_A, GRUP_B]
  });

  // 1. Bawaan 'penting': siklus otomatis yang mulus TIDAK mengirim pesan apa pun.
  assert.strictEqual(store.getConfig().notifyLevel, 'penting', 'bawaan tidak cerewet');
  outbox.length = 0;
  const mulus = await scheduler.runOnce({ manual: false });
  assert.strictEqual(mulus.sent, 2);
  assert.strictEqual(outbox.length, 0, 'siklus sukses tidak mengirim laporan');

  // 2. Tapi buktinya tercatat dan terbaca di /status.
  await bot.handleUpdate(pesan('/status'));
  assert.match(terakhir(), /Terkirim : \d/, 'ada waktu pengiriman terakhir');
  assert.match(terakhir(), /2 berhasil/, 'jumlah keberhasilan terlihat');
  assert.match(terakhir(), /Laporan  : hanya kalau ada masalah/);

  // 3. Kalau ada grup gagal, owner tetap diberi tahu (jangan diam soal masalah).
  gagalkanB = true;
  outbox.length = 0;
  await scheduler.runOnce({ manual: false });
  assert.ok(outbox.length > 0, 'kegagalan tetap dilaporkan');
  assert.match(outbox[0].text, /Gagal: 1/);

  // 4. /notif mati -> benar-benar diam, bahkan saat gagal.
  store.saveConfig({ targets: [GRUP_A, GRUP_B] });
  await bot.handleUpdate(pesan('/notif mati'));
  assert.match(terakhir(), /Laporan diatur ke/);
  outbox.length = 0;
  await scheduler.runOnce({ manual: false });
  assert.strictEqual(outbox.length, 0, 'mode mati tidak mengirim apa pun');

  // Buktinya tetap ada di /status, termasuk yang gagal.
  await bot.handleUpdate(pesan('/status'));
  assert.match(terakhir(), /1 berhasil, 1 gagal/, 'hasil gagal tetap terbaca di /status');
  assert.match(terakhir(), /Laporan  : mati/);

  // 5. Kiriman manual tetap dibalas — owner yang memintanya.
  outbox.length = 0;
  await scheduler.runOnce({ manual: true });
  assert.ok(outbox.length > 0, 'kirim manual tetap dikonfirmasi');
  assert.match(outbox[0].text, /Kirim manual/);

  // 6. /notif semua -> tiap siklus dilaporkan lagi.
  await bot.handleUpdate(pesan('/notif semua'));
  gagalkanB = false;
  store.saveConfig({ targets: [GRUP_A, GRUP_B] });
  outbox.length = 0;
  await scheduler.runOnce({ manual: false });
  assert.ok(outbox.some((item) => /Auto post selesai/.test(item.text)), 'mode semua melaporkan siklus mulus');

  // 7. /notif tanpa argumen menjelaskan pilihannya.
  await bot.handleUpdate(pesan('/notif'));
  assert.match(terakhir(), /\/notif mati/);
  assert.match(terakhir(), /\/notif penting/);

  console.log('✅ Uji laporan lolos (7 skenario) — auto post diam, /status jadi buktinya.');
}

run()
  .catch((error) => {
    console.error('❌ Uji laporan gagal:', error.message);
    process.exitCode = 1;
  })
  .finally(() => {
    scheduler.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
