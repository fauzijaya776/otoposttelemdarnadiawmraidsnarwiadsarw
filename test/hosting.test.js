'use strict';
/**
 * Masalah nyata di Render free tier:
 *  1. Tidak ada disk permanen -> data/session.txt hilang tiap restart, akun
 *     selalu "belum login", jadi auto post selalu dilewati.
 *  2. Bot jalan di dua tempat sekaligus (Render + komputer) -> keduanya berebut
 *     update, perintah masuk acak, bot terasa tidak merespons.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '..', 'data');
const sessionFile = path.join(dataDir, 'session.txt');
fs.rmSync(dataDir, { recursive: true, force: true });

delete process.env.SESSION_STRING;
const { readSession, sessionSource, currentSessionString } = require('../src/userClient');

async function run() {
  // ---------- 1. Sumber sesi ----------
  assert.strictEqual(sessionSource(), 'none', 'belum ada sesi sama sekali');
  assert.strictEqual(readSession(), '');

  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(sessionFile, 'SESI-DARI-FILE');
  assert.strictEqual(sessionSource(), 'file');
  assert.strictEqual(readSession(), 'SESI-DARI-FILE');

  // Environment menang atas file — inilah yang menyelamatkan hosting tanpa disk.
  process.env.SESSION_STRING = 'SESI-DARI-ENV';
  assert.strictEqual(sessionSource(), 'env');
  assert.strictEqual(readSession(), 'SESI-DARI-ENV', 'SESSION_STRING dipakai lebih dulu');
  assert.strictEqual(currentSessionString(), 'SESI-DARI-ENV', 'npm run sesi menampilkan yang dipakai');

  // Spasi/baris baru dari salin-tempel dashboard tidak boleh merusak sesi.
  process.env.SESSION_STRING = '  SESI-DARI-ENV\n';
  assert.strictEqual(readSession(), 'SESI-DARI-ENV', 'spasi hasil salin-tempel dibersihkan');

  // Nilai kosong dianggap tidak ada, bukan sesi kosong yang bikin login gagal diam-diam.
  process.env.SESSION_STRING = '   ';
  assert.strictEqual(sessionSource(), 'file', 'SESSION_STRING kosong diabaikan');
  delete process.env.SESSION_STRING;

  // Simulasi restart Render: berkas hilang, tapi environment tetap ada.
  fs.rmSync(dataDir, { recursive: true, force: true });
  assert.strictEqual(sessionSource(), 'none', 'tanpa env, restart = harus login ulang');
  process.env.SESSION_STRING = 'SESI-DARI-ENV';
  assert.strictEqual(sessionSource(), 'env', 'dengan env, restart tetap login');
  delete process.env.SESSION_STRING;

  // ---------- 2. Konflik dua instance ----------
  const sumber = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');
  assert.match(sumber, /MAX_CONFLICT/, 'konflik 409 dihitung');
  assert.match(sumber, /conflicts >= MAX_CONFLICT/, 'ada batas sebelum menyerah');
  assert.match(sumber, /process\.exit\(1\)/, 'instance kedua berhenti, bukan ikut berebut');
  assert.match(sumber, /hentikan "npm start" di komputer Anda/, 'pesannya memberi jalan keluar');

  // Konflik harus mereset hitungannya setelah sekali berhasil, supaya gangguan
  // sesaat tidak menumpuk sampai mematikan bot yang sebenarnya sehat.
  assert.match(sumber, /backoff = 1000;\s*\n\s*conflicts = 0;/, 'hitungan konflik direset saat normal');

  // ---------- 3. Peredam warning yang menyesatkan ----------
  assert.match(sumber, /localStorage is not available/, 'warning GramJS yang tidak berbahaya diredam');

  // ---------- 4. Petunjuk hosting muncul saat belum login ----------
  assert.match(sumber, /RENDER_SERVICE_ID/, 'hosting terdeteksi');
  assert.match(sumber, /npm run sesi/, 'petunjuk menyimpan sesi ditampilkan');

  console.log('✅ Uji hosting lolos (sumber sesi, konflik instance, peredam warning).');
}

run()
  .catch((error) => {
    console.error('❌ Uji hosting gagal:', error.message);
    process.exitCode = 1;
  })
  .finally(() => fs.rmSync(dataDir, { recursive: true, force: true }));
