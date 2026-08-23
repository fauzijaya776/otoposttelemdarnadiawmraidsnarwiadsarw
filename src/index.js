'use strict';
const http = require('http');
const { loadEnv } = require('./env');

loadEnv();

const store = require('./store');
const { createApi, sleep } = require('./api');
const { createScheduler } = require('./scheduler');
const { createBot } = require('./bot');

const COMMANDS = [
  { command: 'menu', description: 'Panel utama' },
  { command: 'settext', description: 'Atur teks postingan' },
  { command: 'setgambar', description: 'Atur gambar postingan' },
  { command: 'hapusgambar', description: 'Hapus gambar' },
  { command: 'setinterval', description: 'Atur interval kirim (menit)' },
  { command: 'setjeda', description: 'Jeda antar grup (detik)' },
  { command: 'scan', description: 'Daftar grup + ID-nya' },
  { command: 'target', description: 'Kelola grup tujuan' },
  { command: 'addhere', description: 'Jadikan grup ini tujuan' },
  { command: 'id', description: 'Tampilkan ID chat' },
  { command: 'on', description: 'Aktifkan auto post' },
  { command: 'off', description: 'Matikan auto post' },
  { command: 'kirim', description: 'Kirim sekarang' },
  { command: 'pratinjau', description: 'Lihat contoh kiriman' },
  { command: 'status', description: 'Ringkasan pengaturan' },
  { command: 'log', description: 'Hasil pengiriman terakhir' },
  { command: 'help', description: 'Bantuan' }
];

async function main() {
  const token = String(process.env.BOT_TOKEN || '').trim();
  if (!token) {
    console.error('\n❌ BOT_TOKEN belum diisi.');
    console.error('   1. Buka @BotFather di Telegram, kirim /newbot, salin tokennya.');
    console.error('   2. Salin .env.example menjadi .env, isi BOT_TOKEN=...\n');
    process.exit(1);
  }

  const api = createApi(token);
  const me = await api.getMe();
  console.log(`[bot] terhubung sebagai @${me.username} (${me.id})`);

  // Polling dan webhook tidak bisa jalan bersamaan.
  await api.deleteWebhook().catch(() => null);

  let bot;
  const scheduler = createScheduler({ api, notifyOwner: (text) => bot.notifyOwner(text) });
  bot = createBot({ api, scheduler, me });

  await api.call('setMyCommands', { commands: COMMANDS }).catch(() => null);

  const owner = bot.ownerId();
  console.log(owner ? `[bot] owner: ${owner}` : '[bot] owner belum diatur — kirim /claim ke bot dari akun Anda.');

  const config = store.getConfig();
  if (config.enabled) {
    const nextRunAt = scheduler.reschedule();
    console.log(`[scheduler] auto post aktif, kiriman berikutnya ${nextRunAt}`);
  }
  if (owner) {
    await bot.notifyOwner(`♻️ Bot dijalankan ulang.\n\n${bot.statusText()}`).catch(() => null);
  }

  startHealthServer(bot, me);
  await pollUpdates(api, bot);
}

// Long polling: minta update ke Telegram, tahan koneksi sampai 30 detik.
async function pollUpdates(api, bot) {
  let offset = 0;
  let backoff = 1000;

  for (;;) {
    let updates;
    try {
      updates = await api.getUpdates({
        offset,
        timeout: 30,
        allowed_updates: ['message', 'edited_message', 'channel_post', 'callback_query', 'my_chat_member']
      });
      backoff = 1000;
    } catch (error) {
      if (error.code === 409) {
        console.error('[poll] ada instance bot lain yang jalan dengan token sama. Matikan salah satunya.');
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

// Endpoint kecil supaya bisa dipasang di hosting yang butuh HTTP port (Render, Railway, dll).
function startHealthServer(bot, me) {
  const port = Number(process.env.PORT || 3000);
  if (!port) return;
  http
    .createServer((req, res) => {
      const config = store.getConfig();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'ok',
          bot: me.username,
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

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`\n[bot] berhenti (${signal}).`);
    process.exit(0);
  });
}

process.on('unhandledRejection', (error) => console.error('[unhandled]', error?.message || error));

main().catch((error) => {
  console.error('[fatal]', error.message);
  process.exit(1);
});
