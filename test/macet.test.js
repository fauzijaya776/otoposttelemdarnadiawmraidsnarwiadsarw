'use strict';
/**
 * Regresi: panggilan kirim ke Telegram tidak punya batas waktu. Kalau satu
 * pengiriman menggantung (koneksi MTProto macet), flag "sedang mengirim"
 * tidak pernah lepas — dan SEMUA siklus berikutnya dilewati selamanya
 * dengan alasan "Masih ada pengiriman yang berjalan". Auto post mati permanen.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '..', 'data');
fs.rmSync(dataDir, { recursive: true, force: true });

const store = require('../src/store');
const { createScheduler } = require('../src/scheduler');

const posted = [];
const notifikasi = [];
let gantung = false;

const account = {
  isLoggedIn: async () => true,
  connectIfPossible: async () => ({ name: 'Fauzi' }),
  async sendPost(payload) {
    if (gantung) return new Promise(() => {}); // tidak pernah selesai
    posted.push(payload);
    return { id: posted.length };
  }
};

const scheduler = createScheduler({
  userClient: account,
  notifyOwner: async (text) => notifikasi.push(text),
  timers: { setTimeout: () => 1, clearTimeout: () => {}, setInterval: () => 2, clearInterval: () => {} },
  sendTimeoutMs: 300 // aslinya 90 detik; dipendekkan supaya tes cepat
});

async function run() {
  store.saveConfig({
    ownerId: '111',
    enabled: true,
    intervalMinutes: 60,
    gapSeconds: 0,
    text: 'Promo hari ini!',
    imagePath: '',
    targets: ['-1001111111111']
  });

  // 1. Pengiriman normal berjalan.
  const normal = await scheduler.runOnce({ manual: true });
  assert.strictEqual(normal.sent, 1);

  // 2. Pengiriman yang menggantung harus menyerah sendiri karena batas waktu.
  gantung = true;
  const mulai = Date.now();
  const janji = scheduler.runOnce({ manual: true });

  // Selagi menggantung, penjadwal memang menandai dirinya sibuk.
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(scheduler.health().running, true, 'ditandai sedang mengirim');
  assert.ok(scheduler.health().runningForMs >= 0, 'lama pengiriman ikut dicatat');

  // Siklus lain yang datang saat itu dilewati dengan sopan (belum dianggap macet).
  const bersamaan = await scheduler.runOnce({ manual: false });
  assert.strictEqual(bersamaan.skipped, true);
  assert.match(bersamaan.reason, /Masih ada pengiriman/);

  // Pengiriman ini TIDAK PERNAH selesai sendiri — batas waktulah yang menyelamatkannya.
  const hasil = await janji;
  assert.ok(Date.now() - mulai < 5000, 'menyerah karena batas waktu, bukan menggantung');
  assert.strictEqual(scheduler.health().running, false, 'flag sibuk dilepas setelah batas waktu');
  assert.strictEqual(hasil.failed, 1, 'dihitung gagal');
  assert.match(hasil.results[0].error, /tidak merespons/, 'alasannya jelas');
  assert.ok(
    notifikasi.some((text) => /tidak merespons/.test(text)),
    'owner diberi tahu pengiriman macet'
  );
  gantung = false;

  // 3. Setelah itu penjadwal sehat lagi — inilah bagian yang dulu mati permanen.
  const berikutnya = await scheduler.runOnce({ manual: true });
  assert.ok(!berikutnya.skipped, 'siklus berikutnya tidak lagi diblokir');
  assert.strictEqual(berikutnya.sent, 1, 'pengiriman jalan lagi');

  // 4. Batas waktu benar-benar dipasang pada panggilan kirim.
  const sumber = fs.readFileSync(path.join(__dirname, '..', 'src', 'scheduler.js'), 'utf8');
  assert.match(sumber, /withTimeout\(\s*\n?\s*userClient\.sendPost/, 'sendPost dibungkus batas waktu');
  assert.match(sumber, /STUCK_AFTER_MS/, 'ada pemulihan kalau flag sibuk tersangkut');

  assert.ok(hasil, 'runOnce tetap mengembalikan hasil');
  console.log('✅ Uji anti-macet lolos (4 skenario).');
}

run()
  .catch((error) => {
    console.error('❌ Uji anti-macet gagal:', error.message);
    process.exitCode = 1;
  })
  .finally(() => {
    scheduler.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
