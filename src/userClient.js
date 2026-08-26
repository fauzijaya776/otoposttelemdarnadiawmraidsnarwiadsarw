'use strict';
const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '..', 'data');
const sessionPath = path.join(dataDir, 'session.txt');

function readSession() {
  try {
    return fs.existsSync(sessionPath) ? fs.readFileSync(sessionPath, 'utf8').trim() : '';
  } catch {
    return '';
  }
}

function writeSession(value) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(sessionPath, value, { mode: 0o600 });
}

function clearSession() {
  try {
    fs.rmSync(sessionPath, { force: true });
  } catch {
    /* abaikan */
  }
}

// Janji yang bisa diselesaikan dari luar — dipakai menunggu OTP/password yang dikirim owner lewat chat bot.
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Pembungkus akun Telegram pribadi (GramJS).
 * Akun inilah yang benar-benar mengirim postingan; bot BotFather hanya remote control.
 */
function createUserClient({ onEvent: initialListener, loadModule = () => require('telegram') } = {}) {
  const listeners = initialListener ? [initialListener] : [];

  /** Daftarkan pendengar kejadian login (QR, minta password, berhasil, gagal). */
  function onEvent(listener) {
    listeners.push(listener);
    return () => {
      const index = listeners.indexOf(listener);
      if (index >= 0) listeners.splice(index, 1);
    };
  }

  function emit(event) {
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch (error) {
        console.error('[event] pendengar error:', error.message);
      }
    }
  }

  let gram = null;
  let client = null;
  let login = null;     // status login yang sedang berjalan
  let profile = null;   // info akun setelah terhubung

  function loadGramJs() {
    if (gram) return gram;
    try {
      const { TelegramClient, Api, utils, sessions } = loadModule();
      gram = { TelegramClient, Api, utils, StringSession: sessions.StringSession };
      return gram;
    } catch (error) {
      throw new Error(
        'Library "telegram" (GramJS) belum terpasang. Jalankan: npm install\n' + `Detail: ${error.message}`
      );
    }
  }

  function credentials() {
    const apiId = Number(process.env.API_ID || process.env.TG_API_ID);
    const apiHash = String(process.env.API_HASH || process.env.TG_API_HASH || '').trim();
    if (!Number.isInteger(apiId) || apiId <= 0 || !apiHash) {
      throw new Error('API_ID dan API_HASH belum diisi di .env. Ambil dari https://my.telegram.org/apps.');
    }
    return { apiId, apiHash };
  }

  async function getClient() {
    if (client) {
      if (!client.connected) await client.connect();
      return client;
    }
    const { TelegramClient, StringSession } = loadGramJs();
    const { apiId, apiHash } = credentials();
    client = new TelegramClient(new StringSession(readSession()), apiId, apiHash, {
      connectionRetries: 5,
      retryDelay: 2000,
      autoReconnect: true,
      deviceModel: 'Telegram Auto Poster',
      appVersion: '2.1.0'
    });
    client.setLogLevel?.('error');
    await client.connect();
    return client;
  }

  async function isLoggedIn() {
    if (!readSession()) return false;
    try {
      const current = await getClient();
      return await current.isUserAuthorized();
    } catch {
      return false;
    }
  }

  async function connectIfPossible() {
    if (!readSession()) return null;
    try {
      const current = await getClient();
      if (!(await current.isUserAuthorized())) return null;
      profile = await current.getMe();
      return describe(profile);
    } catch (error) {
      emit({ type: 'error', message: `Gagal menyambung ke akun: ${error.message}` });
      return null;
    }
  }

  function describe(user) {
    if (!user) return null;
    return {
      id: String(user.id),
      name: [user.firstName, user.lastName].filter(Boolean).join(' ') || 'Tanpa nama',
      username: user.username || '',
      phone: user.phone ? `+${user.phone}` : ''
    };
  }

  async function status() {
    if (!readSession()) return { loggedIn: false, account: null };
    try {
      const current = await getClient();
      if (!(await current.isUserAuthorized())) return { loggedIn: false, account: null };
      if (!profile) profile = await current.getMe();
      return { loggedIn: true, account: describe(profile) };
    } catch (error) {
      return { loggedIn: false, account: null, error: error.message };
    }
  }

  /**
   * Login QR: Telegram HP memindai kode, jadi tidak ada kode OTP yang perlu diketik.
   * Ini satu-satunya cara login dari chat yang tidak dibatalkan Telegram.
   */
  async function startQrLogin({ maxRefresh = 10 } = {}) {
    if (login) throw new Error('Proses login lain sedang berjalan. Kirim /batal dulu.');
    const current = await getClient();
    if (await current.isUserAuthorized()) throw new Error('Akun sudah login.');
    const { apiId, apiHash } = credentials();
    const qr = require('./qr');

    login = { mode: 'qr', step: 'qr', aborted: false, refreshes: 0, password: deferred(), error: null };
    login.password.promise.catch(() => {});

    login.task = current
      .signInUserWithQrCode(
        { apiId, apiHash },
        {
          qrCode: async ({ token, expires }) => {
            if (login?.aborted) throw new Error('QR login dibatalkan.');
            if (login && ++login.refreshes > maxRefresh) {
              login.aborted = true;
              throw new Error('Waktu login QR habis. Kirim /login lagi.');
            }
            emit({ type: 'qr', url: qr.loginUrl(token), expires, attempt: login?.refreshes || 1 });
          },
          password: async (hint) => {
            login.step = 'password';
            emit({ type: 'need-password', hint: hint || '' });
            return login.password.promise;
          },
          onError: async (error) => {
            if (login) login.error = error;
            return true;
          }
        }
      )
      .then(async (user) => {
        writeSession(current.session.save());
        profile = user;
        finishLogin();
        emit({ type: 'logged-in', account: describe(user) });
        return describe(user);
      })
      .catch((error) => {
        const message = translateAuthError(login?.error || error);
        finishLogin();
        emit({ type: 'login-failed', message });
        throw new Error(message);
      });

    login.task.catch(() => {});
    return true;
  }

  /**
   * Login dengan kode OTP. HANYA dipakai dari terminal (npm run login):
   * kode yang diketik di chat Telegram akan dibatalkan otomatis oleh Telegram.
   */
  async function loginWithCode({ phoneNumber, askCode, askPassword, forceSMS = false }) {
    const phone = normalizePhone(phoneNumber);
    const current = await getClient();
    if (await current.isUserAuthorized()) throw new Error('Akun sudah login.');
    const { apiId, apiHash } = credentials();
    let failure = null;

    try {
      const user = await current.signInUser(
        { apiId, apiHash },
        {
          phoneNumber: async () => phone,
          phoneCode: async () => String(await askCode()).replace(/\D/g, ''),
          password: async (hint) => String(await askPassword(hint || '')),
          forceSMS,
          onError: async (error) => {
            failure = error;
            return true;
          }
        }
      );
      writeSession(current.session.save());
      profile = user;
      emit({ type: 'logged-in', account: describe(user) });
      return describe(user);
    } catch (error) {
      throw new Error(translateAuthError(failure || error));
    }
  }

  function normalizePhone(value) {
    const phone = String(value).replace(/[^\d+]/g, '');
    if (!/^\+\d{8,15}$/.test(phone)) throw new Error('Format nomor salah. Contoh yang benar: +628123456789');
    return phone;
  }

  function finishLogin() {
    if (login?.timeout) clearTimeout(login.timeout);
    login = null;
  }

  function loginStep() {
    return login?.step || null;
  }

  function submitPassword(password) {
    if (!login) throw new Error('Tidak ada proses login yang berjalan.');
    if (!password) throw new Error('Password 2FA kosong.');
    login.password.resolve(String(password));
    return true;
  }

  function cancelLogin(reason = 'Login dibatalkan.') {
    if (!login) return false;
    login.aborted = true;
    login.password.reject(new Error(reason));
    finishLogin();
    return true;
  }

  async function logout() {
    try {
      if (readSession()) {
        const current = await getClient();
        const { Api } = loadGramJs();
        await current.invoke(new Api.auth.LogOut()).catch(() => null);
      }
    } finally {
      try {
        await client?.destroy();
      } catch {
        /* abaikan */
      }
      client = null;
      profile = null;
      clearSession();
    }
    return true;
  }

  /** Ambil semua grup/channel yang diikuti akun — inilah "scan ID grup". */
  async function listGroups() {
    const current = await getClient();
    if (!(await current.isUserAuthorized())) throw new Error('Akun Telegram belum login. Kirim /login dulu.');
    const { utils } = loadGramJs();

    // Akun promosi bisa punya ratusan grup; batas 500 dulu memotong daftar diam-diam.
    const MAX_DIALOG = 2000;
    const found = [];
    let dibaca = 0;
    for await (const dialog of current.iterDialogs({})) {
      if (++dibaca > MAX_DIALOG) {
        console.warn(`[scan] berhenti di ${MAX_DIALOG} chat pertama.`);
        break;
      }
      const entity = dialog.entity;
      if (!entity) continue;
      let type = null;
      if (entity.className === 'Chat') type = 'grup';
      else if (entity.className === 'Channel' && entity.megagroup) type = 'supergrup';
      else if (entity.className === 'Channel' && entity.broadcast) type = 'channel';
      if (!type) continue;
      if (entity.left || entity.deactivated) continue;
      // Untuk channel siaran, hanya masukkan yang memang boleh kita posting.
      if (type === 'channel' && !(entity.creator || entity.adminRights)) continue;

      found.push({
        id: String(utils.getPeerId(entity)),
        title: dialog.title || entity.title || 'Tanpa nama',
        type,
        username: entity.username || '',
        canPost: !isMuted(entity)
      });
    }
    return found.sort((a, b) => a.title.localeCompare(b.title, 'id'));
  }

  function isMuted(entity) {
    const rights = entity.defaultBannedRights;
    return Boolean(rights?.sendMessages) && !entity.creator && !entity.adminRights;
  }

  /** Kirim satu postingan sebagai akun pribadi. */
  async function sendPost({ chatId, text, imagePath, parseMode }) {
    const current = await getClient();
    if (!(await current.isUserAuthorized())) throw new Error('Akun Telegram belum login.');

    let target = chatId;
    try {
      target = await current.getInputEntity(normalizePeer(chatId));
    } catch {
      target = normalizePeer(chatId);
    }

    const mode = parseMode && parseMode !== 'none' ? parseMode : undefined;
    if (imagePath) {
      return current.sendFile(target, {
        file: imagePath,
        caption: text || undefined,
        parseMode: text ? mode : undefined,
        forceDocument: false
      });
    }
    return current.sendMessage(target, { message: text, parseMode: mode, linkPreview: false });
  }

  function normalizePeer(chatId) {
    const asString = String(chatId).trim();
    if (/^-?\d+$/.test(asString)) return Number(asString);
    return asString;
  }

  async function disconnect() {
    try {
      await client?.disconnect();
    } catch {
      /* abaikan */
    }
  }

  return {
    onEvent,
    status,
    isLoggedIn,
    connectIfPossible,
    startQrLogin,
    loginWithCode,
    normalizePhone,
    loginStep,
    submitPassword,
    cancelLogin,
    hasPendingLogin: () => Boolean(login),
    logout,
    listGroups,
    sendPost,
    disconnect
  };
}

function translateAuthError(error) {
  const message = String(error?.errorMessage || error?.message || error || '').toUpperCase();
  if (message.includes('PHONE_CODE_INVALID')) {
    return (
      'Kode OTP ditolak.\n\nKalau kodenya sudah benar, penyebabnya biasanya kode itu pernah diketik di dalam chat Telegram — ' +
      'Telegram otomatis membatalkannya demi keamanan. Ketik kode HANYA di terminal (npm run login), atau pakai login QR.'
    );
  }
  if (message.includes('PHONE_CODE_EXPIRED')) return 'Kode OTP kedaluwarsa. Minta kode baru dan masukkan lebih cepat.';
  if (message.includes('AUTH_TOKEN_EXPIRED') || message.includes('AUTH_TOKEN_INVALID')) {
    return 'Kode QR kedaluwarsa sebelum sempat dipindai. Kirim /login lagi.';
  }
  if (message.includes('PHONE_NUMBER_INVALID')) return 'Nomor telepon tidak valid.';
  if (message.includes('PHONE_NUMBER_BANNED')) return 'Nomor ini diblokir Telegram.';
  if (message.includes('PASSWORD_HASH_INVALID')) return 'Password 2FA salah. Ulangi login.';
  if (message.includes('FLOOD_WAIT')) return `Terlalu sering mencoba login. ${error?.seconds ? `Tunggu ${error.seconds} detik.` : 'Coba lagi nanti.'}`;
  if (message.includes('AUTH_RESTART')) return 'Telegram meminta login diulang. Mulai /login lagi.';
  return error?.message || 'Login gagal.';
}

module.exports = { createUserClient, readSession, clearSession, translateAuthError };
