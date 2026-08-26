'use strict';
/**
 * Menguji dua jalur login akun tanpa menyentuh Telegram:
 *  - QR (dipindai dari HP) — dipakai dari chat bot maupun terminal
 *  - Kode OTP — hanya dari terminal
 * Modul GramJS diganti tiruan.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '..', 'data');
const sessionFile = path.join(dataDir, 'session.txt');
fs.rmSync(dataDir, { recursive: true, force: true });

const { createUserClient } = require('../src/userClient');
const { loginUrl } = require('../src/qr');

process.env.API_ID = '12345';
process.env.API_HASH = 'abcdefabcdefabcdefabcdef';

const QR_TOKEN = Buffer.from([0xfb, 0xff, 0x00, 0x10, 0x3e]);

let authorized = false;
let needPassword = false;
const sent = [];

// Tiruan TelegramClient: hanya meniru bagian yang dipakai userClient.js.
class FakeClient {
  constructor() {
    this.connected = false;
    this.session = { save: () => 'SESSION-STRING-PALSU' };
  }
  async connect() {
    this.connected = true;
  }
  async isUserAuthorized() {
    return authorized;
  }
  async getMe() {
    return { id: 777, firstName: 'Fauzi', lastName: '', username: 'fauzi', phone: '628123456789' };
  }
  // QR: panggil callback beberapa kali seperti GramJS asli (token diperbarui berkala).
  async signInUserWithQrCode(_credentials, params) {
    await params.qrCode({ token: QR_TOKEN, expires: 30 });
    await params.qrCode({ token: QR_TOKEN, expires: 30 });
    if (needPassword) await params.password('petunjuk');
    authorized = true;
    return this.getMe();
  }
  async signInUser(_credentials, params) {
    await params.phoneNumber();
    const code = await params.phoneCode();
    assert.strictEqual(code, '12345', 'kode dibersihkan dari spasi/tanda baca');
    if (needPassword) {
      const password = await params.password('petunjuk');
      assert.strictEqual(password, 'rahasia');
    }
    authorized = true;
    return this.getMe();
  }
  async *iterDialogs() {
    yield { title: 'Grup Satu', entity: { className: 'Chat', id: 111 } };
    yield { title: 'Saluran Siaran', entity: { className: 'Channel', broadcast: true, creator: false, id: 222 } };
    yield { title: 'Supergrup Dua', entity: { className: 'Channel', megagroup: true, id: 333, username: 'dua' } };
    yield { title: 'Chat Pribadi', entity: { className: 'User', id: 444 } };
  }
  async getInputEntity(value) {
    return value;
  }
  async sendMessage(target, params) {
    sent.push({ target, ...params });
    return { id: sent.length };
  }
  async sendFile(target, params) {
    sent.push({ target, ...params });
    return { id: sent.length };
  }
  async invoke() {
    return true;
  }
  async destroy() {
    this.connected = false;
  }
  async disconnect() {
    this.connected = false;
  }
}

const fakeModule = {
  TelegramClient: FakeClient,
  Api: { auth: { LogOut: class {} } },
  sessions: { StringSession: class {} },
  utils: { getPeerId: (entity) => (entity.className === 'Chat' ? `-${entity.id}` : `-100${entity.id}`) }
};

function newClient() {
  const events = [];
  const client = createUserClient({ onEvent: (event) => events.push(event), loadModule: () => fakeModule });
  return { client, events };
}

async function run() {
  // ---------- 1. Login QR ----------
  authorized = false;
  needPassword = false;
  const { client, events } = newClient();

  await client.startQrLogin();
  await waitFor(() => events.some((event) => event.type === 'logged-in'));

  const qrEvents = events.filter((event) => event.type === 'qr');
  assert.strictEqual(qrEvents.length, 2, 'QR diperbarui, tiap pembaruan dikirim ke owner');
  assert.strictEqual(qrEvents[0].url, loginUrl(QR_TOKEN), 'URL QR dibentuk dari token Telegram');
  assert.match(qrEvents[0].url, /^tg:\/\/login\?token=[\w-]+$/, 'format tg://login benar');
  assert.strictEqual(qrEvents[1].attempt, 2, 'nomor pembaruan dilaporkan');
  assert.ok(fs.existsSync(sessionFile), 'sesi tersimpan setelah QR dipindai');
  assert.strictEqual(client.hasPendingLogin(), false, 'status login dibersihkan');

  // Scan grup: chat pribadi & channel yang tidak bisa diposting dibuang.
  const groups = await client.listGroups();
  assert.deepStrictEqual(groups.map((group) => group.title), ['Grup Satu', 'Supergrup Dua']);
  assert.deepStrictEqual(groups.map((group) => group.id), ['-111', '-100333']);

  // Kirim teks dan gambar.
  await client.sendPost({ chatId: '-100333', text: 'Halo', parseMode: 'html' });
  assert.deepStrictEqual(sent[0], { target: -100333, message: 'Halo', parseMode: 'html', linkPreview: false });
  await client.sendPost({ chatId: '-100333', text: 'Dengan foto', imagePath: '/tmp/a.jpg', parseMode: 'none' });
  assert.strictEqual(sent[1].file, '/tmp/a.jpg');
  assert.strictEqual(sent[1].parseMode, undefined, 'mode none tidak diteruskan ke Telegram');

  await client.logout();
  assert.ok(!fs.existsSync(sessionFile), 'sesi dihapus setelah logout');

  // ---------- 2. Login QR dengan 2FA ----------
  authorized = false;
  needPassword = true;
  const dua = newClient();
  await dua.client.startQrLogin();
  await waitFor(() => dua.events.some((event) => event.type === 'need-password'));
  assert.strictEqual(dua.client.loginStep(), 'password');
  dua.client.submitPassword('rahasia');
  await waitFor(() => dua.events.some((event) => event.type === 'logged-in'));
  assert.ok(fs.existsSync(sessionFile), 'sesi tersimpan setelah 2FA');
  await dua.client.logout();

  // ---------- 3. Login kode OTP (jalur terminal) ----------
  authorized = false;
  needPassword = true;
  const tiga = newClient();

  await assert.rejects(
    () => tiga.client.loginWithCode({ phoneNumber: '08123', askCode: async () => '1', askPassword: async () => '1' }),
    /Format nomor salah/,
    'nomor tanpa kode negara ditolak sebelum menyentuh jaringan'
  );

  const account = await tiga.client.loginWithCode({
    phoneNumber: '+62 812-3456-789',
    askCode: async () => '1 2 3 4 5',
    askPassword: async (hint) => {
      assert.strictEqual(hint, 'petunjuk');
      return 'rahasia';
    }
  });
  assert.strictEqual(account.name, 'Fauzi');
  assert.strictEqual(fs.readFileSync(sessionFile, 'utf8'), 'SESSION-STRING-PALSU');

  const status = await tiga.client.status();
  assert.strictEqual(status.loggedIn, true);
  await tiga.client.logout();

  console.log('✅ Uji login akun lolos (QR, QR+2FA, kode OTP).');
}

function waitFor(predicate, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const check = () => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error('waitFor kehabisan waktu'));
      return setTimeout(check, 10);
    };
    check();
  });
}

run()
  .catch((error) => {
    console.error('❌ Uji login gagal:', error.message);
    process.exitCode = 1;
  })
  .finally(() => fs.rmSync(dataDir, { recursive: true, force: true }));
