'use strict';
/**
 * Uji cepat tanpa menyentuh Telegram sungguhan: API-nya dipalsukan.
 * Jalankan dengan: npm test
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '..', 'data');
fs.rmSync(dataDir, { recursive: true, force: true });

const store = require('../src/store');
const { createScheduler } = require('../src/scheduler');
const { createBot } = require('../src/bot');

const sent = [];
const OWNER = 111;
const GOOD_GROUP = '-1001111111111';
const BAD_GROUP = '-1002222222222';

function fatalError(description) {
  const error = new Error(description);
  error.code = 403;
  error.description = description;
  return error;
}

const api = {
  call: async () => ({}),
  sendMessage: async (params) => {
    if (String(params.chat_id) === BAD_GROUP) throw fatalError('Forbidden: bot was kicked from the supergroup chat');
    sent.push(params);
    return { message_id: sent.length };
  },
  sendPhoto: async (params) => {
    sent.push(params);
    return { message_id: sent.length };
  },
  answerCallbackQuery: async () => null,
  editMessageText: async (params) => {
    sent.push(params);
    return { message_id: params.message_id };
  }
};

let bot;
const scheduler = createScheduler({ api, notifyOwner: (text) => bot.notifyOwner(text) });
bot = createBot({ api, scheduler, me: { id: 999, username: 'tester', first_name: 'Tester' } });

const privateMessage = (text, extra = {}) => ({
  message: { message_id: 1, from: { id: OWNER }, chat: { id: OWNER, type: 'private' }, text, ...extra }
});
const lastText = () => sent[sent.length - 1].text;

async function run() {
  delete process.env.OWNER_ID;

  // 1. Owner belum ada -> /claim mendaftarkan pengirim.
  await bot.handleUpdate(privateMessage('/start'));
  assert.match(lastText(), /belum punya owner/i, 'harus minta claim');
  await bot.handleUpdate(privateMessage('/claim'));
  assert.strictEqual(store.getConfig().ownerId, String(OWNER));
  assert.ok(bot.isOwner(OWNER) && !bot.isOwner(222), 'pembatasan owner bekerja');

  // 2. Orang lain ditolak.
  await bot.handleUpdate({ message: { message_id: 2, from: { id: 222 }, chat: { id: 222, type: 'private' }, text: '/status' } });
  assert.match(lastText(), /hanya bisa dipakai ownernya/i);

  // 3. Scan grup: grup tercatat otomatis dari update.
  await bot.handleUpdate({
    my_chat_member: {
      chat: { id: GOOD_GROUP, type: 'supergroup', title: 'Grup Promo A' },
      new_chat_member: { status: 'administrator' }
    }
  });
  await bot.handleUpdate({
    message: { message_id: 3, from: { id: 5 }, chat: { id: BAD_GROUP, type: 'supergroup', title: 'Grup Promo B' }, text: 'halo' }
  });
  const groups = store.getGroups();
  assert.ok(groups[GOOD_GROUP] && groups[BAD_GROUP], 'dua grup terdeteksi');
  await bot.handleUpdate(privateMessage('/scan'));
  assert.ok(lastText().includes(GOOD_GROUP) && lastText().includes('Grup Promo B'), 'daftar scan memuat ID');

  // 4. /id di dalam grup.
  await bot.handleUpdate({
    message: { message_id: 4, from: { id: OWNER }, chat: { id: GOOD_GROUP, type: 'supergroup', title: 'Grup Promo A' }, text: '/id' }
  });
  assert.ok(lastText().includes(GOOD_GROUP), 'perintah /id membalas ID grup');

  // 5. Pilih tujuan lewat tombol inline.
  for (const id of [GOOD_GROUP, BAD_GROUP]) {
    await bot.handleUpdate({
      callback_query: { id: 'cb', from: { id: OWNER }, data: `t:${id}`, message: { message_id: 9, chat: { id: OWNER } } }
    });
  }
  assert.deepStrictEqual(store.getConfig().targets, [GOOD_GROUP, BAD_GROUP]);

  // 6. Isi teks lewat input dua langkah, lalu interval.
  await bot.handleUpdate(privateMessage('/settext'));
  await bot.handleUpdate(privateMessage('Promo hari ini!'));
  assert.strictEqual(store.getConfig().text, 'Promo hari ini!');
  await bot.handleUpdate(privateMessage('/setinterval 45'));
  assert.strictEqual(store.getConfig().intervalMinutes, 45);
  await bot.handleUpdate(privateMessage('/setjeda 0'));
  assert.strictEqual(store.getConfig().gapSeconds, 0);

  // 7. Gambar dari foto yang dikirim owner.
  await bot.handleUpdate(privateMessage('/setgambar'));
  await bot.handleUpdate({
    message: { message_id: 7, from: { id: OWNER }, chat: { id: OWNER, type: 'private' }, photo: [{ file_id: 'kecil' }, { file_id: 'besar' }] }
  });
  assert.strictEqual(store.getConfig().photo, 'besar');
  await bot.handleUpdate(privateMessage('/hapusgambar'));
  assert.strictEqual(store.getConfig().photo, '');

  // 8. Aktifkan jadwal.
  await bot.handleUpdate(privateMessage('/on'));
  assert.strictEqual(store.getConfig().enabled, true);
  assert.ok(store.getConfig().nextRunAt, 'jadwal berikutnya tersimpan');

  // 9. Kirim manual: grup baik terkirim, grup bermasalah dilepas otomatis.
  sent.length = 0;
  const result = await scheduler.runOnce({ manual: true });
  assert.strictEqual(result.sent, 1, 'satu grup berhasil');
  assert.strictEqual(result.failed, 1, 'satu grup gagal');
  assert.deepStrictEqual(store.getConfig().targets, [GOOD_GROUP], 'grup gagal dilepas dari tujuan');
  assert.ok(sent.some((item) => String(item.chat_id) === GOOD_GROUP && item.text === 'Promo hari ini!'), 'isi pesan benar');
  assert.ok(sent.some((item) => String(item.chat_id) === String(OWNER) && /Dilepas dari daftar tujuan/.test(item.text)), 'owner diberi tahu');

  // 10. Matikan jadwal.
  await bot.handleUpdate(privateMessage('/off'));
  assert.strictEqual(store.getConfig().enabled, false);
  scheduler.stop();

  // 11. Guard: tidak bisa aktif tanpa isi.
  store.saveConfig({ text: '', photo: '', enabled: false });
  await bot.handleUpdate(privateMessage('/on'));
  assert.match(lastText(), /masih kosong/i);

  console.log('✅ Semua uji lolos (11 skenario).');
}

run()
  .catch((error) => {
    console.error('❌ Uji gagal:', error.message);
    process.exit(1);
  })
  .finally(() => fs.rmSync(dataDir, { recursive: true, force: true }));
