'use strict';
/**
 * Grup yang sudah tidak bisa diposting harus keluar sendiri dari daftar tujuan,
 * TAPI grup sehat tidak boleh ikut terbuang gara-gara gangguan sesaat.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '..', 'data');
fs.rmSync(dataDir, { recursive: true, force: true });

const store = require('../src/store');
const { createScheduler, shouldDrop } = require('../src/scheduler');
const { createBot } = require('../src/bot');

const OWNER = 111;
const SEHAT = '-1001111111111';
const DIKICK = '-1002222222222';
const RIBUT = '-1003333333333'; // gagal karena gangguan sesaat, bukan dikick

const outbox = [];
let gagalRibut = true;

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
  async sendPost({ chatId }) {
    if (chatId === DIKICK) throw new Error('USER_BANNED_IN_CHANNEL');
    if (chatId === RIBUT && gagalRibut) throw new Error('Timeout: jaringan sedang jelek');
    return { id: 1 };
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
const grup = (id) => store.getGroups()[id] || {};

async function run() {
  store.saveGroups({
    [SEHAT]: { id: SEHAT, title: 'Grup Sehat', type: 'supergrup', status: 'ok' },
    [DIKICK]: { id: DIKICK, title: 'Grup Dikick', type: 'supergrup', status: 'ok' },
    [RIBUT]: { id: RIBUT, title: 'Grup Jaringan Jelek', type: 'supergrup', status: 'ok' }
  });
  store.saveConfig({
    ownerId: String(OWNER),
    enabled: true,
    intervalMinutes: 60,
    gapSeconds: 0,
    text: 'Promo hari ini!',
    imagePath: '',
    targets: [SEHAT, DIKICK, RIBUT]
  });

  // ---------- Aturan dasar ----------
  assert.strictEqual(shouldDrop({ mode: 'fatal', fatal: true, fails: 1 }), true, 'dikick selalu dibuang');
  assert.strictEqual(shouldDrop({ mode: 'fatal', fatal: false, fails: 9 }), false, 'mode fatal tidak buang yang lain');
  assert.strictEqual(shouldDrop({ mode: 'langsung', fatal: false, fails: 1 }), true);
  assert.strictEqual(shouldDrop({ mode: '3x', fatal: false, fails: 2 }), false, 'dua kali belum dibuang');
  assert.strictEqual(shouldDrop({ mode: '3x', fatal: false, fails: 3 }), true, 'tiga kali dibuang');

  // ---------- Siklus 1 ----------
  await scheduler.runOnce({ manual: false });
  assert.ok(!store.getConfig().targets.includes(DIKICK), 'grup yang mengeluarkan kita langsung dibuang');
  assert.ok(store.getConfig().targets.includes(RIBUT), 'gangguan sesaat belum dibuang');
  assert.strictEqual(grup(RIBUT).fails, 1, 'kegagalan dihitung');
  assert.strictEqual(grup(SEHAT).fails, 0, 'grup sehat tetap bersih');
  assert.ok(
    outbox.some((item) => /sudah tidak bisa posting/.test(item.text)),
    'owner diberi tahu alasan pembuangan'
  );

  // ---------- Siklus 2 & 3: gangguan berlanjut ----------
  await scheduler.runOnce({ manual: false });
  assert.strictEqual(grup(RIBUT).fails, 2);
  assert.ok(store.getConfig().targets.includes(RIBUT), 'dua kali gagal masih ditahan');

  await scheduler.runOnce({ manual: false });
  assert.strictEqual(grup(RIBUT).fails, 3);
  assert.ok(!store.getConfig().targets.includes(RIBUT), 'tiga kali gagal beruntun baru dibuang');
  assert.ok(
    outbox.some((item) => /gagal 3x beruntun/.test(item.text)),
    'alasannya disebut apa adanya'
  );

  // ---------- Gagal yang sembuh tidak menumpuk ----------
  store.saveConfig({ targets: [SEHAT, RIBUT] });
  store.markChat(RIBUT, { fails: 2 });
  gagalRibut = false;
  await scheduler.runOnce({ manual: false });
  assert.strictEqual(grup(RIBUT).fails, 0, 'hitungan direset setelah berhasil');
  assert.ok(store.getConfig().targets.includes(RIBUT), 'grup yang pulih tetap dipakai');

  // ---------- Mode langsung ----------
  await bot.handleUpdate(pesan('/autohapus langsung'));
  assert.match(terakhir(), /sekali gagal langsung dibuang/);
  gagalRibut = true;
  await scheduler.runOnce({ manual: false });
  assert.ok(!store.getConfig().targets.includes(RIBUT), 'mode langsung membuang pada kegagalan pertama');

  // ---------- Mode fatal ----------
  await bot.handleUpdate(pesan('/autohapus fatal'));
  store.saveConfig({ targets: [SEHAT, RIBUT] });
  store.markChat(RIBUT, { fails: 0 });
  for (let i = 0; i < 5; i++) await scheduler.runOnce({ manual: false });
  assert.ok(store.getConfig().targets.includes(RIBUT), 'mode fatal menahan grup meski gagal berkali-kali');

  // ---------- /diag menampilkan grup bermasalah ----------
  await bot.handleUpdate(pesan('/diag'));
  assert.match(terakhir(), /grup sedang bermasalah/i);
  assert.match(terakhir(), /Grup Jaringan Jelek/);

  // ---------- /autohapus tanpa argumen menjelaskan pilihan ----------
  await bot.handleUpdate(pesan('/autohapus'));
  assert.match(terakhir(), /\/autohapus langsung/);
  assert.match(terakhir(), /selalu<\/b> langsung dibuang/);

  console.log('✅ Uji buang grup gagal lolos (8 skenario).');
}

run()
  .catch((error) => {
    console.error('❌ Uji buang grup gagal:', error.message);
    process.exitCode = 1;
  })
  .finally(() => {
    scheduler.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
