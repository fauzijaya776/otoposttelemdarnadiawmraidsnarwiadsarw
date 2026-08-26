'use strict';
/**
 * Menguji login lewat terminal (npm run login) dengan akun tiruan.
 */
const assert = require('assert');
const { runCliLogin } = require('../src/cliLogin');

function fakeUserClient({ needPassword = false, loggedIn = false } = {}) {
  const listeners = [];
  const emit = (event) => listeners.forEach((listener) => listener(event));

  return {
    calls: [],
    passwords: [],
    onEvent(listener) {
      listeners.push(listener);
      return () => listeners.splice(listeners.indexOf(listener), 1);
    },
    async status() {
      return loggedIn ? { loggedIn: true, account: { name: 'Sudah Masuk' } } : { loggedIn: false, account: null };
    },
    async startQrLogin() {
      this.calls.push('qr');
      setTimeout(async () => {
        emit({ type: 'qr', url: 'tg://login?token=AAAA', expires: 30, attempt: 1 });
        if (needPassword) {
          emit({ type: 'need-password', hint: 'petunjuk' });
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        emit({ type: 'logged-in', account: { name: 'Fauzi' } });
      }, 5);
      return true;
    },
    submitPassword(password) {
      this.passwords.push(password);
      return true;
    },
    async loginWithCode(params) {
      this.calls.push('kode');
      this.phone = params.phoneNumber;
      this.code = await params.askCode();
      this.password = await params.askPassword('petunjuk');
      return { name: 'Fauzi' };
    }
  };
}

async function run() {
  // 1. Akun sudah login -> tidak melakukan apa-apa.
  const sudah = fakeUserClient({ loggedIn: true });
  const hasil = await runCliLogin({ userClient: sudah, ask: async () => '1', askHidden: async () => '', log: () => {} });
  assert.strictEqual(hasil.alreadyLoggedIn, true);
  assert.deepStrictEqual(sudah.calls, [], 'tidak memulai login baru');

  // 2. Mode QR: URL ditampilkan di terminal (fallback teks bila paket qrcode belum ada).
  const logs = [];
  const qrClient = fakeUserClient();
  await runCliLogin({
    userClient: qrClient,
    ask: async () => '1',
    askHidden: async () => '',
    log: (message) => logs.push(message),
    mode: '1'
  });
  assert.deepStrictEqual(qrClient.calls, ['qr']);
  assert.ok(logs.join('\n').includes('tg://login?token=AAAA'), 'QR/URL ditampilkan ke pengguna');
  assert.ok(logs.join('\n').includes('Tautkan Perangkat Desktop'), 'ada petunjuk cara memindai');

  // 3. Mode QR dengan 2FA: password diminta di terminal, bukan di chat.
  const duaFaktor = fakeUserClient({ needPassword: true });
  await runCliLogin({
    userClient: duaFaktor,
    ask: async () => '1',
    askHidden: async (question) => {
      assert.match(question, /petunjuk/);
      return 'rahasia';
    },
    log: () => {},
    mode: '1'
  });
  assert.deepStrictEqual(duaFaktor.passwords, ['rahasia']);

  // 4. Mode kode OTP: kode diketik di terminal, dengan peringatan jelas.
  const kodeLogs = [];
  const kodeClient = fakeUserClient();
  await runCliLogin({
    userClient: kodeClient,
    ask: async (question) => (/Nomor/.test(question) ? '+628123456789' : '12345'),
    askHidden: async () => 'rahasia',
    log: (message) => kodeLogs.push(message),
    mode: '2'
  });
  assert.deepStrictEqual(kodeClient.calls, ['kode']);
  assert.strictEqual(kodeClient.phone, '+628123456789');
  assert.strictEqual(kodeClient.code, '12345');
  assert.strictEqual(kodeClient.password, 'rahasia');
  assert.ok(
    kodeLogs.join('\n').includes('jangan menyalinnya ke dalam chat Telegram'),
    'pengguna diperingatkan agar tidak menempel kode di chat'
  );

  console.log('✅ Uji login terminal lolos (4 skenario).');
}

run().catch((error) => {
  console.error('❌ Uji login terminal gagal:', error.message);
  process.exitCode = 1;
});
