# Telegram Auto Poster

Auto-post ke banyak grup Telegram **dari akun pribadi Anda**, dengan seluruh pengaturan dilakukan lewat **bot BotFather** — teks, gambar, interval, daftar grup, on/off, semuanya dari chat.

```
Anda ──chat──> Bot (BotFather)  ──perintah──>  Akun Telegram Anda ──posting──> Grup A, B, C…
     (remote control)                           (pengirim asli)
```

## ⚠️ Kenapa kode OTP tidak bisa diketik di chat bot

Kalau Anda pernah dapat pesan ini dari Telegram:

> *The code was entered correctly, but sign in was not allowed, because this code was previously shared by your account.*

itu **bukan bug**. Telegram memindai pesan yang Anda kirim; begitu kode login terdeteksi pernah muncul di dalam sebuah chat, kode itu langsung dibatalkan — walaupun ditulis dengan spasi, tanda hubung, atau emoji di antaranya. Ini perlindungan Telegram terhadap penipuan "minta kirim kodenya ke saya".

Karena itu login di sini **tidak pernah memakai kode di chat**. Ada dua jalur, dua-duanya aman:

| Jalur | Caranya | Kapan dipakai |
| --- | --- | --- |
| **QR** (disarankan) | `/login` di bot → bot mengirim gambar QR → pindai dari HP | Paling praktis, tidak ada yang perlu diketik |
| **Terminal** | `npm run login` di komputer tempat bot jalan | Kalau QR gagal, atau bot dijalankan tanpa chat |

Password 2FA boleh dikirim lewat chat — yang dibatalkan Telegram hanya kode login, bukan password. Bot menghapus pesan itu segera setelah dipakai.

## 1. Siapkan dua kredensial

**Bot pengendali** — buka [@BotFather](https://t.me/BotFather), kirim `/newbot`, salin token.

**Akun pengirim** — buka [my.telegram.org/apps](https://my.telegram.org/apps), login dengan nomor Anda, buat aplikasi, salin **App api_id** dan **App api_hash**.

## 2. Konfigurasi

```bash
npm install
copy .env.example .env
```

Isi `.env`:

```
BOT_TOKEN=1234567890:AAxxxxxxxxxxxxxxxxxxxxx
OWNER_ID=
API_ID=1234567
API_HASH=abcdef1234567890abcdef1234567890
```

## 3. Jalankan dan hubungkan akun

```bash
npm start
```

1. Chat bot Anda, kirim `/start` → bot menampilkan ID Telegram Anda → kirim `/claim` supaya akun itu jadi owner. Setelah itu perintah dari siapa pun ditolak.
2. Kirim `/login`. Bot mengirim gambar QR yang berganti otomatis tiap 30 detik.
3. Di HP: **Telegram → Pengaturan → Perangkat → Tautkan Perangkat Desktop**, lalu pindai QR-nya.
4. Kalau akun pakai 2FA, bot meminta passwordnya lewat chat dan langsung menghapus pesannya.

**Kalau QR bermasalah**, login dari terminal:

```bash
npm run login            # tanya mau QR atau kode
npm run login -- --kode  # langsung ke jalur kode OTP
npm run login -- --qr    # langsung ke jalur QR (QR digambar di terminal)
```

Di jalur kode, OTP diketik **di terminal**, bukan di Telegram — jadi tidak ikut dibatalkan.

Sesi login tersimpan di `data/session.txt`, jadi restart berikutnya tidak perlu login lagi.

## 3b. Kalau dipasang di hosting (Render, Railway, dll)

Dua hal yang membuat bot terlihat "tidak jalan" di hosting:

**1. Paket gratis tidak punya disk permanen.** `data/session.txt` terhapus setiap restart dan deploy, jadi akun selalu kembali ke keadaan belum login dan auto post selalu dilewati. Login QR di sana pun akan hilang lagi. Solusinya simpan sesi di environment variable:

```bash
npm run login   # di komputer Anda, sekali saja
npm run sesi    # menampilkan SESSION_STRING=...
```

Salin nilainya ke **Environment → SESSION_STRING** di dashboard hosting, lalu restart. Saat start, log akan menulis `[akun] sesi dibaca dari SESSION_STRING (environment)`.

> `SESSION_STRING` setara akses penuh ke akun Telegram Anda. Jangan di-commit, jangan ditempel di chat mana pun.

**2. Jangan jalankan bot di dua tempat sekaligus.** Kalau `npm start` hidup di komputer sementara service di Render juga hidup, keduanya memakai `BOT_TOKEN` yang sama dan berebut update — perintah Anda masuk ke salah satu secara acak, dan satu siklus bisa terkirim dua kali. Telegram menandainya dengan error `409 Conflict`; bot sekarang berhenti sendiri setelah 3 kali konflik sambil menjelaskan mana yang harus dimatikan. Kalau memang butuh dua-duanya, buat bot kedua di @BotFather dengan token berbeda.

## 4. Pilih grup tujuan

Kirim `/scan` — bot membaca semua grup, supergrup, dan channel (yang Anda jadi adminnya) dari akun Anda, lengkap dengan **ID**-nya. Klik tombol ⬜/✅ untuk menandai tujuan posting. Daftar tersimpan di `data/groups.json`.

Daftar ditampilkan 15 grup per halaman dengan tombol **⬅️ Sebelumnya / Berikutnya ➡️**, karena satu pesan Telegram maksimal 4096 karakter — daftar ratusan grup tidak akan muat dalam satu pesan.

Manual: `/target add -1001234567890`, `/target del ID`, `/target clear`.

## 5. Atur isi dan jadwal

> Kalau auto post terasa "tidak jalan", kirim **`/diag`** — bot menandai ✅/❌ pada setiap syarat (akun, tujuan, isi, timer) dan menyebut berapa menit lagi kiriman berikutnya.

| Perintah | Fungsi |
| --- | --- |
| `/settext` | Atur teks. Bisa langsung: `/settext Promo hari ini` |
| `/setgambar` | Kirim fotonya ke bot; bot mengunduh dan menyimpannya ke `uploads/` |
| `/hapusgambar` | Kirim teks saja |
| `/mode html\|markdown\|none` | Format teks |
| `/pratinjau` | Contoh postingan dikirim ke **Pesan Tersimpan** akun Anda |
| `/setinterval 60` | Kirim tiap 60 menit |
| `/setjeda 15` | Jeda 15 detik antar grup |
| `/on` `/off` | Nyalakan / matikan auto post. Menyalakan **selalu** langsung mengirim satu putaran sebagai pembuktian — sama saja lewat perintah atau lewat tombol ▶️ di panel |
| `/kirim` | Kirim sekarang juga |
| `/status` `/log` | Ringkasan pengaturan & hasil pengiriman terakhir |
| `/diag` | Periksa satu per satu kenapa auto post kirim / tidak kirim |
| `/notif mati\|penting\|semua` | Seberapa sering bot melapor (bawaan: hanya kalau ada masalah) |
| `/autohapus langsung\|3x\|fatal` | Kapan grup gagal dibuang dari tujuan (bawaan: 3x gagal beruntun) |
| `/akun` `/logout` | Info akun pengirim / putuskan akun |

## Anti-flood dan grup bermasalah

- Pengiriman satu grup per satu grup dengan jeda `setjeda` detik.
- Kena `FLOOD_WAIT` atau `SLOWMODE_WAIT` → bot menunggu sesuai permintaan Telegram lalu mengulang sekali. Kalau diminta menunggu lebih dari 5 menit, grup itu dilewati dulu supaya siklus tidak macet.
- Grup yang membalas `CHAT_WRITE_FORBIDDEN`, `USER_BANNED_IN_CHANNEL`, `CHANNEL_PRIVATE`, dan sejenisnya **selalu langsung dilepas** — itu bukti akun sudah dikeluarkan atau diblokir di sana.
- Kegagalan lain (jaringan, timeout, slowmode) dihitung: setelah **3 kali gagal beruntun** grup ikut dilepas. Satu kali berhasil mereset hitungannya. Ubah dengan `/autohapus langsung` (sekali gagal langsung dibuang) atau `/autohapus fatal` (hanya kalau benar-benar dikick).
- `/diag` menampilkan grup mana yang sedang bermasalah dan sudah berapa kali gagal, sebelum ia dibuang.
- `/on` ditolak kalau akun belum login, tujuan kosong, atau isi postingan kosong.
- Pengiriman berjalan di **latar belakang**: bot tetap menjawab perintah selama mengirim ke puluhan grup, dan `/off` menghentikan pengiriman yang sedang berjalan.
- **Tidak ada laporan tiap siklus.** Auto post yang berjalan mulus tidak mengirim pesan apa pun; buktinya dilihat lewat `/status` pada baris `Terkirim` — misalnya `24/08 20:15 · 12 berhasil, 0 gagal`.
- Yang tetap dilaporkan hanya **masalah**: grup gagal, grup dilepas, atau siklus dilewati (akun terputus, isi kosong) — sekali per penyebab. Atur dengan `/notif`; `/notif mati` membuat bot benar-benar diam dan semuanya hanya lewat `/status`.
- Kiriman manual (`/kirim`, `/on`) tetap dibalas karena Anda yang memintanya.
- Sebelum menyerah, bot mencoba **menyambung ulang** akun yang koneksinya putus.
- Setiap pengiriman punya **batas waktu 90 detik**. Tanpa ini, satu koneksi MTProto yang macet membuat penjadwal mengira dirinya "sedang mengirim" selamanya, dan seluruh auto post mati permanen.
- Ada **watchdog** tiap menit: kalau timer auto post hilang atau macet (misalnya setelah komputer sleep), timer dipasang ulang otomatis. Kondisinya bisa dilihat di baris `Penjadwal:` pada `/status`.

## ⚠️ Risiko akun

Posting otomatis dari akun pribadi bisa membuat akun kena limit sementara sampai banned permanen kalau terlalu agresif. Yang mengurangi risiko:

- Interval **minimal 15–30 menit** (bot memperingatkan kalau Anda memaksa di bawah 15).
- Jeda antar grup minimal 5–15 detik.
- Jangan pakai akun utama kalau grup tujuannya banyak.
- Variasikan isi pesan; teks identik yang dikirim berulang ke puluhan grup paling cepat terdeteksi spam.

Isi `data/session.txt` setara akses penuh ke akun Telegram Anda — jangan dibagikan atau di-commit. `.env` dan `data/` sudah masuk `.gitignore`.

## Uji tanpa menyentuh Telegram

```bash
npm test
```

Menjalankan tiga belas berkas uji dengan Telegram tiruan: alur login QR (termasuk pembaruan QR dan 2FA), login kode lewat terminal, penolakan nomor tanpa kode negara, scan grup, pemilihan tujuan lewat tombol, penyimpanan teks/gambar, penolakan non-owner, retry `FLOOD_WAIT`, pelepasan grup terlarang, paginasi daftar grup dengan 120 grup (setiap halaman dipastikan di bawah batas 4096 karakter), judul grup ber-emoji (dipastikan tidak terpotong di tengah emoji sehingga ditolak Telegram), penjadwal auto post dengan jam palsu (siklus berulang, notifikasi saat dilewati, sambung ulang, dan watchdog), audit yang menjalankan setiap perintah dan setiap tombol satu per satu, uji responsif (bot tetap menjawab selama pengiriman panjang dan bisa dihentikan di tengah jalan), uji anti-macet (pengiriman yang menggantung menyerah karena batas waktu, bukan mengunci penjadwal selamanya), uji laporan (siklus mulus tidak mengirim pesan, tapi hasilnya tetap terbaca di `/status`), uji pembuangan grup gagal (yang dikick langsung dibuang, yang cuma gangguan sesaat tidak ikut terbuang), uji hosting (sesi dari SESSION_STRING mengalahkan berkas, dan penanganan konflik dua instance), serta uji aktifkan (tombol panel dan perintah `/on` dipaksa menghasilkan keadaan yang sama persis).

## Struktur

```
src/index.js       bootstrap: polling bot, sambung akun, health check HTTP
src/bot.js         perintah owner, menu tombol, QR login lewat chat
src/userClient.js  akun pengirim (GramJS): login QR/kode, daftar grup, kirim post
src/cliLogin.js    alur login versi terminal
src/qr.js          pembuatan QR (PNG untuk chat, ASCII untuk terminal)
src/scheduler.js   siklus posting, jeda antar grup, FLOOD_WAIT, auto-drop
src/api.js         pembungkus Bot API + unggah/unduh gambar + retry
src/store.js       penyimpanan config.json & groups.json
src/text.js        pembersih teks & pemotong aman-emoji untuk tombol
login.js           entri "npm run login"
sesi.js            entri "npm run sesi" — menampilkan SESSION_STRING
data/              sesi login + pengaturan (rahasia, jangan dibagikan)
legacy/            panel web lama, tidak dipakai lagi
```
