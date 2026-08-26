'use strict';
const http = require('http');
const { loadEnv } = require('./env');

loadEnv();

const store = require('./store');
const { version } = require('../package.json');
const { createApi, sleep } = require('./api');
const { createUserClient } = require('./userClient');
const { createScheduler } = require('./scheduler');
const { createBot } = require('./bot');

const COMMANDS = [
  { command: 'menu', description: 'Panel utama' },
  { command: 'login', description: 'Hubungkan akun pengirim lewat QR' },
  { command: 'akun', description: 'Info akun yang terhubung' },
  { command: 'logout', description: 'Putuskan akun' },
  { command: 'settext', description: 'Atur teks postingan' },
  { command: 'setgambar', description: 'Atur gambar postingan' },
  { command: 'hapusgambar', description: 'Hapus gambar' },
  { command: 'setinterval', description: 'Interval kirim (menit)' },
  { command: 'setjeda', description: 'Jeda antar grup (detik)' },
  { command: 'scan', description: 'Ambil daftar grup + ID dari akun' },
  { command: 'target', description: 'Kelola grup tujuan' },
  { command: 'on', description: 'Aktifkan auto post' },
  { command: 'off', description: 'Matikan auto post' },
  { command: 'kirim', description: 'Kirim sekarang' },
  { command: 'pratinjau', description: 'Contoh kiriman ke Pesan Tersimpan' },
  { command: 'status', description: 'Ringkasan pengaturan' },
  { command: 'diag', description: 'Periksa kenapa auto post tidak kirim' },
  { command: 'notif', description: 'Atur laporan: mati | penting | semua' },
  { command: 'autohapus', description: 'Kapan grup gagal dibuang dari tujuan' },
  { command: 'log', description: 'Hasil pengiriman terakhir' },
  { command: 'batal', description: 'Batalkan input berjalan' },
  { command: 'help', description: 'Bantuan' }
];

async function main() {
  const token = String(process.env.BOT_TOKEN || '').trim();
  if (!token) {
    console.error('\n❌ BOT_TOKEN belum diisi.');
    console.error('   1. Buka @BotFather, kirim /newbot, salin tokennya.');
    console.error('   2. Salin .env.example jadi .env, isi BOT_TOKEN, API_ID, dan API_HASH.\n');
    process.exit(1);
  }

  const api = createApi(token);
  const me = await api.getMe();
  console.log(`[bot] Telegram Auto Poster v${version}`);
  console.log(`[bot] remote control: @${me.username} (${me.id})`);
  await api.deleteWebhook().catch(() => null);

  let bot;
  const userClient = createUserClient({ onEvent: (event) => bot?.handleAccountEvent(event) });
  const scheduler = createScheduler({ userClient, notifyOwner: (text) => bot.notifyOwner(text) });
  bot = createBot({ api, scheduler, userClient, me, version });

  await api.call('setMyCommands', { commands: COMMANDS }).catch(() => null);

  const owner = bot.ownerId();
  console.log(owner ? `[bot] owner: ${owner}` : '[bot] owner belum diatur — kirim /claim ke bot dari akun Anda.');

  // Sambungkan kembali akun pengirim kalau sesinya masih tersimpan.
  const account = await userClient.connectIfPossible();
  if (account) {
    console.log(`[akun] terhubung sebagai ${account.name}`);
  } else {
    console.log('[akun] belum login. Dua cara:');
    console.log('        1. Kirim /login ke bot, lalu pindai QR dengan Telegram di HP.');
    console.log('        2. Jalankan "npm run login" di terminal ini.');
    if (!require('./qr').isAvailable()) {
      console.warn('        (paket "qrcode" belum terpasang — jalankan "npm install" agar QR bisa dibuat)');
    }
  }

  if (store.getConfig().enabled) {
    if (account) {
      console.log(`[scheduler] auto post aktif, kiriman berikutnya ${scheduler.reschedule()}`);
    } else {
      store.saveConfig({ enabled: false, nextRunAt: null });
      console.warn('[scheduler] auto post dimatikan karena akun belum login.');
    }
  }

  if (owner) {
    await bot
      .notifyOwner(`♻️ Bot dijalankan ulang.\n\n${await bot.statusText()}`)
      .catch(() => null);
  }

  startHealthServer(me, userClient);
  process.on('SIGINT', () => shutdown(userClient, 'SIGINT'));
  process.on('SIGTERM', () => shutdown(userClient, 'SIGTERM'));

  await pollUpdates(api, bot);
}

// Long polling ke Bot API — hanya untuk menerima perintah owner.
async function pollUpdates(api, bot) {
  let offset = 0;
  let backoff = 1000;

  for (;;) {
    let updates;
    try {
      updates = await api.getUpdates({
        offset,
        timeout: 30,
        allowed_updates: ['message', 'callback_query']
      });
      backoff = 1000;
    } catch (error) {
      if (error.code === 409) {
        console.error('[poll] ada instance lain memakai token yang sama. Matikan salah satunya.');
      } else if (error.code === 401) {
        console.error('[poll] token ditolak Telegram. Periksa BOT_TOKEN.');
        process.exit(1);
      } else {
        console.error('[poll] gagal ambil update:', error.message);
      }
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 30000);
      continue;
    }

    for (const update of updates) {
      offset = update.update_id + 1;
      try {
        await bot.handleUpdate(update);
      } catch (error) {
        console.error('[update] error:', error.description || error.message);
      }
    }
  }
}

function startHealthServer(me, userClient) {
  const port = Number(process.env.PORT || 3000);
  if (!port) return;
  http
    .createServer(async (_req, res) => {
      const config = store.getConfig();
      const account = await userClient.status().catch(() => ({ loggedIn: false }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'ok',
          bot: me.username,
          accountLoggedIn: account.loggedIn,
          enabled: config.enabled,
          intervalMinutes: config.intervalMinutes,
          targets: config.targets.length,
          nextRunAt: config.nextRunAt,
          lastRunAt: config.lastRunAt
        })
      );
    })
    .listen(port, '0.0.0.0', () => console.log(`[http] health check di port ${port}`))
    .on('error', (error) => console.error('[http] tidak bisa buka port:', error.message));
}

async function shutdown(userClient, signal) {
  console.log(`\n[bot] berhenti (${signal}).`);
  await userClient.disconnect().catch(() => null);
  process.exit(0);
}

process.on('unhandledRejection', (error) => console.error('[unhandled]', error?.message || error));

main().catch((error) => {
  console.error('[fatal]', error.message);
  process.exit(1);
});
