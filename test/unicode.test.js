'use strict';
/**
 * Regresi: judul grup ber-emoji tidak boleh membuat Telegram menolak pesan
 * dengan "must be encoded in UTF-8". Bot API tiruan di sini memvalidasi
 * setiap teks persis seperti Telegram: string harus UTF-8 valid dan
 * teks tombol tidak boleh kosong.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '..', 'data');
fs.rmSync(dataDir, { recursive: true, force: true });

const store = require('../src/store');
const { createBot } = require('../src/bot');
const { isValidUtf8, buttonLabel, sanitize, truncate } = require('../src/text');

const OWNER = 111;
const MOBIL = String.fromCodePoint(0x1f697);
const API = String.fromCodePoint(0x1f525);
const BENDERA = String.fromCodePoint(0x1f1ee) + String.fromCodePoint(0x1f1e9);
const KELUARGA = [0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467].map((code) => String.fromCodePoint(code)).join('');

// Judul yang emoji-nya jatuh tepat di batas potong 40 karakter.
const judul = [
  `GRUP PROMO OTOMOTIF SE-INDONESIA RAYA ${MOBIL}${API} Jual Beli Mobil Bekas`,
  `${BENDERA} Jual Beli Serba Ada Nusantara ${KELUARGA} Terpercaya Sejak 2019`,
  `A`.repeat(38) + MOBIL + 'lanjutan judul yang panjang sekali', // emoji tepat di batas potong
  `${MOBIL}`.repeat(45),
  '   ',
  ''
];

const groups = {};
judul.forEach((title, index) => {
  const id = `-100${2000000000 + index}`;
  groups[id] = { id, title, type: 'supergrup', status: 'ok' };
});
store.saveGroups(groups);
store.saveConfig({ ownerId: String(OWNER), targets: [] });

const outbox = [];

// Validasi ala Telegram.
function periksaTeks(text, asal) {
  if (typeof text !== 'string') return;
  if (!isValidUtf8(text)) {
    throw new Error(`Bad Request: strings must be encoded in UTF-8 (${asal})`);
  }
}

function periksaKeyboard(markup) {
  if (!markup?.inline_keyboard) return;
  for (const row of markup.inline_keyboard) {
    for (const button of row) {
      if (!isValidUtf8(button.text)) {
        throw new Error('Bad Request: inline keyboard button text must be encoded in UTF-8');
      }
      if (!button.text || !button.text.trim()) {
        throw new Error('Bad Request: BUTTON_TEXT_EMPTY');
      }
      if (!isValidUtf8(button.callback_data || '')) {
        throw new Error('Bad Request: BUTTON_DATA_INVALID');
      }
    }
  }
}

const api = {
  call: async () => ({}),
  sendMessage: async (params) => {
    periksaTeks(params.text, 'sendMessage');
    periksaKeyboard(params.reply_markup);
    outbox.push(params);
    return { message_id: outbox.length };
  },
  editMessageText: async (params) => {
    periksaTeks(params.text, 'editMessageText');
    periksaKeyboard(params.reply_markup);
    outbox.push(params);
    return { message_id: params.message_id };
  },
  answerCallbackQuery: async () => null,
  deleteMessage: async () => null
};

const userClient = {
  isLoggedIn: async () => true,
  status: async () => ({ loggedIn: true, account: { id: '1', name: `Fauzi ${MOBIL}`, username: '', phone: '' } }),
  listGroups: async () => Object.values(groups)
};

const bot = createBot({
  api,
  scheduler: { reschedule: () => null, stop: () => {}, runOnce: async () => ({ skipped: true, reason: '-' }) },
  userClient,
  me: { id: 999, username: 'panelbot' }
});

const pesan = (text) => ({
  message: { message_id: 1, from: { id: OWNER }, chat: { id: OWNER, type: 'private' }, text }
});
const klik = (data) => ({
  callback_query: { id: 'cb', from: { id: OWNER }, data, message: { message_id: 9, chat: { id: OWNER } } }
});
const terakhir = () => outbox[outbox.length - 1];

async function run() {
  // 1. Pemotongan tidak membelah emoji.
  const label = buttonLabel(judul[2], 40);
  assert.ok(isValidUtf8(label), 'label tombol harus UTF-8 valid');
  assert.ok(!/[\uD800-\uDFFF]/.test(label.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '')), 'tidak ada surrogate yatim');

  // 2. Judul kosong / spasi saja tetap menghasilkan tombol yang sah.
  assert.strictEqual(buttonLabel('   ', 40), 'Tanpa nama');
  assert.strictEqual(buttonLabel('', 40), 'Tanpa nama');

  // 3. Emoji majemuk (bendera, keluarga ZWJ) tidak dibelah jadi potongan aneh.
  assert.ok(isValidUtf8(truncate(BENDERA.repeat(20), 5)));
  assert.ok(isValidUtf8(truncate(KELUARGA.repeat(20), 5)));

  // 4. Karakter kontrol dibuang, tab/newline dipertahankan.
  assert.strictEqual(sanitize(`a${String.fromCharCode(7)}b`), 'ab');
  assert.strictEqual(sanitize('baris1\nbaris2\tkolom'), 'baris1\nbaris2\tkolom');

  // 5. Alur nyata: /scan lalu tekan tombol — inilah yang dulu error.
  await bot.handleUpdate(pesan('/scan'));
  periksaKeyboard(terakhir().reply_markup);
  assert.ok(terakhir().reply_markup.inline_keyboard.length > 0, 'tombol grup muncul');

  await bot.handleUpdate(klik(`t:-1002000000000:0`));
  assert.deepStrictEqual(store.getConfig().targets, ['-1002000000000'], 'pilihan tersimpan');
  assert.ok(!/Tombol gagal diproses/.test(terakhir().text), 'tombol tidak error');

  await bot.handleUpdate(pesan('/status'));
  periksaTeks(terakhir().text, 'status');

  // 6. Teks postingan yang mengandung potongan emoji rusak tetap aman dikirim.
  store.saveConfig({ text: `Promo ${MOBIL}${String.fromCharCode(0xd83d)} hari ini` });
  await bot.handleUpdate(pesan('/status'));
  periksaTeks(terakhir().text, 'status dengan teks rusak');

  console.log('✅ Uji Unicode lolos (6 skenario).');
}

run()
  .catch((error) => {
    console.error('❌ Uji Unicode gagal:', error.message);
    process.exitCode = 1;
  })
  .finally(() => fs.rmSync(dataDir, { recursive: true, force: true }));
