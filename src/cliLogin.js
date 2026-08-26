'use strict';
const qr = require('./qr');

/**
 * Alur login lewat terminal. Kode OTP diketik di sini, TIDAK di chat Telegram,
 * supaya Telegram tidak membatalkannya.
 * @param {object} deps - { userClient, ask, askHidden, log, mode }
 */
async function runCliLogin({ userClient, ask, askHidden, log, mode }) {
  const status = await userClient.status();
  if (status.loggedIn) {
    log(`Akun ${status.account.name} sudah login. Hapus data/session.txt kalau mau ganti akun.`);
    return { alreadyLoggedIn: true, account: status.account };
  }

  const chosen =
    mode || (await ask('Pilih cara login — [1] QR (pindai dari HP)  [2] Kode OTP: ')).trim() || '1';

  if (chosen === '2' || chosen.toLowerCase() === 'kode') {
    return loginWithCode({ userClient, ask, askHidden, log });
  }
  return loginWithQr({ userClient, askHidden, log });
}

async function loginWithQr({ userClient, askHidden, log }) {
  let unsubscribe = () => {};

  const finished = new Promise((resolve, reject) => {
    unsubscribe = userClient.onEvent(async (event) => {
      try {
        if (event.type === 'qr') {
          const art = await qr.toTerminal(event.url).catch(() => null);
          log('\n' + (art || event.url));
          log('Di HP: Telegram → Pengaturan → Perangkat → Tautkan Perangkat Desktop, lalu pindai kode di atas.');
          log('Kode berganti otomatis tiap 30 detik.');
        }
        if (event.type === 'need-password') {
          const password = await askHidden(
            `\nAkun ini memakai 2FA. Password${event.hint ? ` (petunjuk: ${event.hint})` : ''}: `
          );
          userClient.submitPassword(password);
        }
        if (event.type === 'logged-in') resolve(event.account);
        if (event.type === 'login-failed') reject(new Error(event.message));
      } catch (error) {
        reject(error);
      }
    });
  });

  try {
    await userClient.startQrLogin();
    const account = await finished;
    log(`\n✅ Berhasil login sebagai ${account.name}. Sesi disimpan di data/session.txt.`);
    return { account };
  } finally {
    unsubscribe();
  }
}

async function loginWithCode({ userClient, ask, askHidden, log }) {
  const phoneNumber = await ask('Nomor Telegram (contoh +628123456789): ');

  const account = await userClient.loginWithCode({
    phoneNumber,
    askCode: async () => {
      log('\nTelegram mengirim kode ke aplikasi Telegram Anda.');
      log('Ketik kodenya DI SINI saja — jangan menyalinnya ke dalam chat Telegram mana pun,');
      log('karena Telegram otomatis membatalkan kode yang terdeteksi dikirim lewat chat.');
      return ask('Kode OTP: ');
    },
    askPassword: async (hint) => askHidden(`Password 2FA${hint ? ` (petunjuk: ${hint})` : ''}: `)
  });

  log(`\n✅ Berhasil login sebagai ${account.name}. Sesi disimpan di data/session.txt.`);
  return { account };
}

module.exports = { runCliLogin };
