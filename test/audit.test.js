'use strict';
/**
 * Audit menyeluruh: SETIAP perintah dan SETIAP tombol dijalankan sekali,
 * terhadap Bot API dan akun Telegram tiruan. Tujuannya menangkap perintah
 * yang error, diam saja, atau menyimpan data yang salah.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '..', 'data');
const uploadDir = path.join(__dirname, '..', 'uploads');
fs.rmSync(dataDir, { recursive: true, force: true });

const store = require('../src/store');
const { createBot } = require('../src/bot');
const { createScheduler } = require('../src/scheduler');
const { isValidUtf8 } = require('../src/text');

const OWNER = 1641090169;
const ORANG_LAIN = 555;
const GRUP_A = '-1001111111111';
const GRUP_B = '-1002222222222';

const outbox = [];
const posted = [];
const errors = [];
let nextMessageId = 100;

// ---- Bot API tiruan yang galak seperti Telegram asli ----------------------
function validasi(params, asal) {
  if (typeof params.text === 'string') {
    if (params.text.length > 4096) throw new Error(`message is too long (${asal})`);
    if (!isValidUtf8(params.text)) throw new Error(`text bukan UTF-8 (${asal})`);
    if (!params.text.trim()) throw new Error(`message text is empty (${asal})`);
  }
  const rows = params.reply_markup?.inline_keyboard || [];
  for (const row of rows) {
    for (const button of row) {
      if (!button.text?.trim()) throw new Error('BUTTON_TEXT_EMPTY');
      if (!isValidUtf8(button.text)) throw new Error('button bukan UTF-8');
      if (Buffer.byteLength(button.callback_data || '', 'utf8') > 64) throw new Error('BUTTON_DATA_INVALID');
    }
  }
}

const api = {
  call: async () => ({}),
  sendMessage: async (params) => {
    validasi(params, 'sendMessage');
    outbox.push({ kind: 'send', ...params });
    return { message_id: nextMessageId++ };
  },
  editMessageText: async (params) => {
    validasi(params, 'editMessageText');
    outbox.push({ kind: 'edit', ...params });
    return { message_id: params.message_id };
  },
  sendPhotoBuffer: async (params) => {
    outbox.push({ kind: 'photo', ...params });
    return { message_id: nextMessageId++ };
  },
  answerCallbackQuery: async () => null,
  deleteMessage: async () => null,
  downloadFile: async (_fileId, destination) => {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, 'gambar');
    return { path: destination, bytes: 7 };
  }
};

// ---- akun pengirim tiruan --------------------------------------------------
const account = {
  loggedIn: false,
  qrDimulai: 0,
  logoutDipanggil: 0,
  async isLoggedIn() {
    return this.loggedIn;
  },
  async connectIfPossible() {
    return this.loggedIn ? { name: 'Fauzi' } : null;
  },
  async status() {
    return this.loggedIn
      ? { loggedIn: true, account: { id: '77', name: 'Fauzi Fadlurohman', username: 'fauzi', phone: '+628123456789' } }
      : { loggedIn: false, account: null };
  },
  async startQrLogin() {
    this.qrDimulai++;
    return true;
  },
  submitPassword(password) {
    this.password = password;
    return true;
  },
  cancelLogin: () => true,
  hasPendingLogin: () => false,
  async logout() {
    this.logoutDipanggil++;
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
    posted.push(payload);
    return { id: posted.length };
  },
  async disconnect() {}
};

const qrTools = { isAvailable: () => true, toPng: async (url) => Buffer.from(`png:${url}`) };

let bot;
const scheduler = createScheduler({
  userClient: account,
  notifyOwner: (text) => bot.notifyOwner(text),
  timers: { setTimeout: () => 1, clearTimeout: () => {}, setInterval: () => 2, clearInterval: () => {} }
});
bot = createBot({ api, scheduler, userClient: account, qrTools, me: { id: 999, username: 'uzipost_bot' } });

// ---- pembantu --------------------------------------------------------------
const pesan = (text, extra = {}) => ({
  message: { message_id: nextMessageId++, from: { id: OWNER }, chat: { id: OWNER, type: 'private' }, text, ...extra }
});
const klik = (data) => ({
  callback_query: { id: 'cb', from: { id: OWNER }, data, message: { message_id: 9, chat: { id: OWNER } } }
});
const terakhir = () => outbox[outbox.length - 1]?.text || '';

/** Jalankan satu update; kegagalan apa pun dicatat sebagai temuan audit. */
async function coba(nama, update) {
  const sebelum = outbox.length;
  try {
    await bot.handleUpdate(update);
  } catch (error) {
    errors.push(`${nama}: LEMPAR ERROR — ${error.message}`);
    return '';
  }
  if (outbox.length === sebelum) {
    errors.push(`${nama}: tidak membalas apa pun (diam)`);
    return '';
  }
  const balasan = terakhir();
  if (/Tombol gagal diproses|⚠️ Tidak bisa|gagal diproses/i.test(balasan)) {
    errors.push(`${nama}: balasan berisi error — ${balasan.slice(0, 120)}`);
  }
  return balasan;
}

async function run() {
  store.saveConfig({ ownerId: String(OWNER) });

  // ---------- 1. Perintah dasar ----------
  await coba('/start', pesan('/start'));
  await coba('/menu', pesan('/menu'));
  const help = await coba('/help', pesan('/help'));
  await coba('/status', pesan('/status'));
  await coba('/id', pesan('/id'));
  await coba('/diag', pesan('/diag'));
  await coba('/claim (sudah ada owner)', pesan('/claim'));
  await coba('perintah tak dikenal', pesan('/tidakada'));

  // Setiap perintah yang ditulis di /help harus benar-benar ada di kode.
  const tanpaTag = help.replace(/<\/?[a-z]+>/g, ' ');
  const dariHelp = [...tanpaTag.matchAll(/(?:^|\s)\/([a-z]+)/g)].map((m) => m[1]);
  const sumber = fs.readFileSync(path.join(__dirname, '..', 'src', 'bot.js'), 'utf8');
  for (const perintah of new Set(dariHelp)) {
    if (!sumber.includes(`'/${perintah}'`)) errors.push(`/help menyebut /${perintah} tapi tidak ada di kode`);
  }

  // ---------- 2. Penolakan non-owner ----------
  const sebelum = outbox.length;
  await bot.handleUpdate({
    message: { message_id: 1, from: { id: ORANG_LAIN }, chat: { id: ORANG_LAIN, type: 'private' }, text: '/status' }
  });
  if (!/hanya bisa dipakai ownernya/i.test(terakhir())) errors.push('non-owner tidak ditolak');
  assert.ok(outbox.length > sebelum);

  await bot.handleUpdate({
    callback_query: { id: 'x', from: { id: ORANG_LAIN }, data: 'toggle', message: { message_id: 9, chat: { id: ORANG_LAIN } } }
  });
  if (store.getConfig().enabled) errors.push('non-owner bisa menyalakan auto post lewat tombol');

  // ---------- 3. Akun & login ----------
  await coba('/akun (belum login)', pesan('/akun'));
  await coba('/login', pesan('/login'));
  if (account.qrDimulai !== 1) errors.push('/login tidak memulai QR');

  await bot.handleAccountEvent({ type: 'qr', url: 'tg://login?token=AAA', expires: 30, attempt: 1 });
  if (!outbox.some((item) => item.kind === 'photo')) errors.push('QR tidak dikirim sebagai gambar');

  await bot.handleAccountEvent({ type: 'need-password', hint: 'kucing' });
  await coba('kirim password 2FA', pesan('rahasia123'));
  if (account.password !== 'rahasia123') errors.push('password 2FA tidak diteruskan');

  account.loggedIn = true;
  await bot.handleAccountEvent({ type: 'logged-in', account: { name: 'Fauzi', username: 'fauzi' } });
  await coba('/akun (sudah login)', pesan('/akun'));
  await coba('/login saat sudah login', pesan('/login'));

  // ---------- 4. Isi postingan ----------
  await coba('/settext langsung', pesan('/settext Promo hari ini'));
  assert.strictEqual(store.getConfig().text, 'Promo hari ini');

  await coba('/settext dua langkah', pesan('/settext'));
  await coba('kirim teks', pesan('Promo malam ini'));
  assert.strictEqual(store.getConfig().text, 'Promo malam ini');

  await coba('/setgambar', pesan('/setgambar'));
  await coba('kirim foto', { message: { message_id: nextMessageId++, from: { id: OWNER }, chat: { id: OWNER, type: 'private' }, photo: [{ file_id: 'kecil' }, { file_id: 'besar' }] } });
  if (!store.getConfig().imagePath || !fs.existsSync(store.getConfig().imagePath)) {
    errors.push('/setgambar tidak menyimpan file gambar');
  }

  for (const mode of ['html', 'markdown', 'none', 'ngawur']) {
    await coba(`/mode ${mode}`, pesan(`/mode ${mode}`));
  }
  assert.strictEqual(store.getConfig().parseMode, 'none', 'mode terakhir yang sah tersimpan');
  store.saveConfig({ parseMode: 'html' });

  await coba('/pratinjau', pesan('/pratinjau'));
  if (!posted.some((item) => item.chatId === 'me')) errors.push('/pratinjau tidak mengirim ke Pesan Tersimpan');

  await coba('/hapusgambar', pesan('/hapusgambar'));
  assert.strictEqual(store.getConfig().imagePath, '');

  // ---------- 5. Jadwal ----------
  await coba('/setinterval 45', pesan('/setinterval 45'));
  assert.strictEqual(store.getConfig().intervalMinutes, 45);
  await coba('/setinterval dua langkah', pesan('/setinterval'));
  await coba('kirim angka interval', pesan('90'));
  assert.strictEqual(store.getConfig().intervalMinutes, 90);
  await coba('/setinterval nilai ngawur', pesan('/setinterval abc'));
  await coba('batalkan input', pesan('/batal'));

  await coba('/setjeda 20', pesan('/setjeda 20'));
  assert.strictEqual(store.getConfig().gapSeconds, 20);
  await coba('/setjeda 0', pesan('/setjeda 0'));
  assert.strictEqual(store.getConfig().gapSeconds, 0);

  // ---------- 6. Grup ----------
  await coba('/scan', pesan('/scan'));
  const groups = store.getGroups();
  if (!groups[GRUP_A] || !groups[GRUP_B]) errors.push('/scan tidak menyimpan daftar grup');

  await coba('tombol pilih grup', klik(`t:${GRUP_A}:0`));
  if (!store.getConfig().targets.includes(GRUP_A)) errors.push('tombol pilih grup tidak menyimpan tujuan');
  await coba('tombol batal pilih', klik(`t:${GRUP_A}:0`));
  if (store.getConfig().targets.includes(GRUP_A)) errors.push('tombol tidak bisa membatalkan pilihan');

  await coba('/target add', pesan(`/target add ${GRUP_A}`));
  await coba('/target add id ngawur', pesan('/target add bukan-angka'));
  if (store.getConfig().targets.includes('bukan-angka')) {
    errors.push('/target menerima ID yang jelas tidak valid');
  }
  await coba('/target daftar', pesan('/target'));
  await coba('/target del', pesan(`/target del ${GRUP_A}`));
  assert.ok(!store.getConfig().targets.includes(GRUP_A));
  await coba('/target clear', pesan('/target clear'));
  assert.deepStrictEqual(store.getConfig().targets, []);

  // ---------- 7. Auto post ----------
  await coba('/on tanpa tujuan', pesan('/on'));
  if (store.getConfig().enabled) errors.push('/on lolos padahal tujuan kosong');

  store.saveConfig({ targets: [GRUP_A, GRUP_B], text: 'Promo hari ini' });
  await coba('/on', pesan('/on'));
  if (!store.getConfig().enabled) errors.push('/on tidak menyalakan auto post');
  if (posted.filter((item) => item.chatId === GRUP_A).length === 0) {
    errors.push('/on tidak mengirim putaran pembuktian');
  }

  await coba('/kirim', pesan('/kirim'));
  await coba('/log', pesan('/log'));
  await coba('/status saat aktif', pesan('/status'));
  await coba('/off', pesan('/off'));
  if (store.getConfig().enabled) errors.push('/off tidak mematikan auto post');

  // ---------- 8. Semua tombol ----------
  store.saveConfig({ targets: [GRUP_A], text: 'Promo hari ini' });
  for (const data of ['menu', 'status', 'scan', 'rescan', 'account', 'preview', 'postnow', 'toggle', 'page:0', 'toggle']) {
    await coba(`tombol ${data}`, klik(data));
  }
  await coba('tombol tak dikenal', klik('entah-apa'));

  // ---------- 9. Grup: perintah /id ----------
  await coba('/id di grup', {
    message: { message_id: nextMessageId++, from: { id: OWNER }, chat: { id: GRUP_A, type: 'supergroup', title: 'Grup Promo A' }, text: '/id' }
  });
  if (!terakhir().includes(GRUP_A)) errors.push('/id di grup tidak membalas ID');

  // ---------- 10. Logout ----------
  store.saveConfig({ enabled: true });
  await coba('/logout', pesan('/logout'));
  if (account.logoutDipanggil !== 1) errors.push('/logout tidak memutus akun');
  if (store.getConfig().enabled) errors.push('/logout tidak mematikan auto post');

  // ---------- hasil ----------
  if (errors.length) {
    console.error(`\n❌ ${errors.length} temuan:`);
    for (const item of errors) console.error(`   • ${item}`);
    throw new Error(`${errors.length} fitur bermasalah`);
  }
  console.log('✅ Audit fitur lolos — semua perintah & tombol berfungsi.');
}

run()
  .catch((error) => {
    console.error(`❌ Audit gagal: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => {
    scheduler.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(uploadDir, { recursive: true, force: true });
  });
