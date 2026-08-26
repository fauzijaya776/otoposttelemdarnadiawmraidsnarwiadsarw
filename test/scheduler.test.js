'use strict';
/**
 * Regresi: auto post harus benar-benar berulang, dan kalau satu siklus dilewati
 * owner WAJIB diberi tahu — dulu siklus yang dilewati hilang tanpa jejak,
 * jadi auto post terlihat "tidak bekerja" tanpa penjelasan.
 *
 * Waktu dipalsukan supaya interval 60 menit bisa diuji dalam milidetik.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '..', 'data');
fs.rmSync(dataDir, { recursive: true, force: true });

const store = require('../src/store');
const { createScheduler } = require('../src/scheduler');

// ---- jam palsu -------------------------------------------------------------
let pending = [];
let intervals = [];
let nextId = 1;

const timers = {
  setTimeout: (fn, ms) => {
    const id = nextId++;
    pending.push({ id, fn, ms });
    return id;
  },
  clearTimeout: (id) => {
    pending = pending.filter((item) => item.id !== id);
  },
  setInterval: (fn, ms) => {
    const id = nextId++;
    intervals.push({ id, fn, ms });
    return id;
  },
  clearInterval: (id) => {
    intervals = intervals.filter((item) => item.id !== id);
  }
};

/** Jalankan satu timer yang tertunda, seolah waktunya sudah tiba. */
async function majukanWaktu() {
  const next = pending.shift();
  assert.ok(next, 'harus ada siklus berikutnya yang terjadwal');
  await next.fn();
  await new Promise((resolve) => setImmediate(resolve));
}

async function jalankanWatchdog() {
  for (const item of [...intervals]) await item.fn();
  await new Promise((resolve) => setImmediate(resolve));
}

// ---- akun tiruan -----------------------------------------------------------
const posted = [];
const notifikasi = [];

const account = {
  loggedIn: true,
  reconnectBerhasil: false,
  reconnectDipanggil: 0,
  async isLoggedIn() {
    return this.loggedIn;
  },
  async connectIfPossible() {
    this.reconnectDipanggil++;
    if (!this.reconnectBerhasil) return null;
    this.loggedIn = true;
    return { name: 'Fauzi' };
  },
  async sendPost(payload) {
    posted.push(payload);
    return { id: posted.length };
  }
};

const scheduler = createScheduler({
  userClient: account,
  notifyOwner: async (text) => notifikasi.push(text),
  timers,
  watchdogMs: 1000
});

async function run() {
  store.saveConfig({
    ownerId: '111',
    enabled: true,
    intervalMinutes: 60,
    gapSeconds: 0,
    text: 'Promo hari ini!',
    imagePath: '',
    targets: ['-1001111111111', '-1002222222222']
  });

  // 1. Setelah diaktifkan, siklus pertama terjadwal.
  const nextRunAt = scheduler.reschedule();
  assert.ok(nextRunAt, 'jadwal berikutnya tersimpan');
  assert.strictEqual(pending.length, 1, 'ada satu timer aktif');
  assert.strictEqual(scheduler.health().armed, true);

  // 2. Siklus berjalan berulang, bukan sekali lalu berhenti.
  for (let siklus = 1; siklus <= 3; siklus++) {
    await majukanWaktu();
    assert.strictEqual(posted.length, siklus * 2, `siklus ${siklus} mengirim ke 2 grup`);
    assert.strictEqual(pending.length, 1, `siklus ${siklus} menjadwalkan siklus berikutnya`);
  }
  assert.ok(store.getConfig().lastRunAt, 'waktu pengiriman terakhir tercatat');

  // 3. Akun terputus di tengah jalan: dulu ini diam saja — sekarang owner diberi tahu.
  notifikasi.length = 0;
  account.loggedIn = false;
  account.reconnectBerhasil = false;

  await majukanWaktu();
  assert.strictEqual(posted.length, 6, 'tidak ada yang terkirim saat akun terputus');
  assert.strictEqual(account.reconnectDipanggil, 1, 'bot mencoba menyambung ulang lebih dulu');
  assert.strictEqual(notifikasi.length, 1, 'owner diberi tahu sekali');
  assert.match(notifikasi[0], /Auto post dilewati/);
  assert.match(notifikasi[0], /terputus atau belum login/);
  assert.strictEqual(pending.length, 1, 'siklus berikutnya tetap dijadwalkan meski gagal');

  // 4. Penyebab yang sama tidak dikirim berulang kali (anti-spam notifikasi).
  await majukanWaktu();
  await majukanWaktu();
  assert.strictEqual(notifikasi.length, 1, 'penyebab sama hanya dilaporkan sekali');

  // 5. Akun tersambung lagi -> posting lanjut otomatis tanpa perlu /on ulang.
  account.reconnectBerhasil = true;
  await majukanWaktu();
  assert.strictEqual(posted.length, 8, 'pengiriman berlanjut setelah tersambung ulang');

  // 6. Penyebab baru dilaporkan lagi (bukan ditelan karena sudah pernah ada notifikasi).
  notifikasi.length = 0;
  store.saveConfig({ text: '', imagePath: '' });
  await majukanWaktu();
  assert.strictEqual(notifikasi.length, 1);
  assert.match(notifikasi[0], /Teks dan gambar masih kosong/);
  store.saveConfig({ text: 'Promo hari ini!' });

  // 7. Watchdog menyelamatkan penjadwal yang macet (timer terpasang tapi tidak pernah
  //    berbunyi — misalnya setelah komputer sleep atau proses dibekukan).
  pending = [];
  store.saveConfig({ nextRunAt: new Date(Date.now() - 10 * 60 * 1000).toISOString() });
  await jalankanWatchdog();
  assert.strictEqual(pending.length, 1, 'watchdog memasang timer lagi');
  assert.ok(Date.parse(store.getConfig().nextRunAt) > Date.now(), 'jadwal baru di masa depan');

  // Watchdog tidak ikut campur kalau penjadwalnya sehat.
  const sebelumnya = pending.length;
  await jalankanWatchdog();
  assert.strictEqual(pending.length, sebelumnya, 'penjadwal sehat dibiarkan apa adanya');

  // 8. /off benar-benar menghentikan semuanya.
  store.saveConfig({ enabled: false });
  scheduler.reschedule();
  assert.strictEqual(pending.length, 0, 'tidak ada timer tersisa');
  assert.strictEqual(store.getConfig().nextRunAt, null);

  scheduler.stop();
  console.log('✅ Uji penjadwal lolos (8 skenario).');
}

run()
  .catch((error) => {
    console.error('❌ Uji penjadwal gagal:', error.message);
    process.exitCode = 1;
  })
  .finally(() => {
    scheduler.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
