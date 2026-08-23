# Telegram Auto Poster (Bot API)

Bot auto-post Telegram yang **seluruh pengaturannya dilakukan dari chat Telegram**: teks, gambar, interval kirim, dan daftar grup tujuan. Hanya satu akun (owner) yang boleh memerintah bot.

Tanpa dependency sama sekali — cukup Node.js 18 atau lebih baru. Tidak perlu `npm install`.

## 1. Buat bot di BotFather

1. Buka [@BotFather](https://t.me/BotFather) di Telegram, kirim `/newbot`, ikuti langkahnya, salin **token**-nya.
2. Kirim `/setprivacy` → pilih bot Anda → **Disable**, supaya bot bisa membaca pesan di grup (dipakai untuk mendeteksi ID grup).

## 2. Konfigurasi

```bash
cp .env.example .env      # Windows: copy .env.example .env
```

Isi `.env`:

```
BOT_TOKEN=1234567890:AAxxxxxxxxxxxxxxxxxxxxxxxxxxx
OWNER_ID=            # boleh dikosongkan, lihat langkah 3
PORT=3000
TZ=Asia/Jakarta
```

## 3. Jalankan

```bash
npm start
```

Chat bot Anda di Telegram, kirim `/start`. Kalau `OWNER_ID` masih kosong, bot akan menampilkan ID Telegram Anda — kirim `/claim` untuk menjadikan akun itu owner (tersimpan permanen di `data/config.json`). Setelah itu perintah dari akun lain akan ditolak.

## 4. Daftarkan grup (scan ID)

Bot API tidak bisa membaca daftar grup Anda seperti akun biasa, jadi grup dicatat otomatis begitu bot melihatnya:

1. Tambahkan bot ke grup tujuan, lalu jadikan **admin** (wajib kalau grup membatasi siapa yang boleh mengirim pesan).
2. Begitu bot masuk, owner langsung dapat notifikasi berisi nama dan ID grup.
3. Kalau grup lama belum muncul, ketik `/id` di dalam grup itu — bot membalas ID-nya sekaligus mencatatnya.
4. Kirim `/scan` di chat pribadi untuk melihat semua grup yang terdeteksi. Klik tombol ⬜/✅ untuk memilih grup mana yang jadi tujuan posting.

Alternatif cepat: ketik `/addhere` di dalam grup (khusus owner) untuk langsung menjadikan grup itu tujuan.

## 5. Atur isi dan jadwal

| Perintah | Fungsi |
| --- | --- |
| `/settext` | Atur teks. Bisa langsung: `/settext Promo hari ini` |
| `/setgambar` | Kirim foto ke bot, atau `/setgambar https://...` |
| `/hapusgambar` | Kirim teks saja tanpa gambar |
| `/mode html\|markdown\|none` | Format teks |
| `/pratinjau` | Bot mengirim contoh persis seperti yang akan diposting |
| `/setinterval 30` | Kirim tiap 30 menit |
| `/setjeda 5` | Jeda 5 detik antar grup (anti-flood) |
| `/on` / `/off` | Nyalakan / matikan auto post |
| `/kirim` | Kirim sekarang juga |
| `/scan`, `/target` | Kelola grup tujuan |
| `/status`, `/log` | Ringkasan pengaturan & hasil pengiriman terakhir |

## Anti-flood & grup bermasalah

- Pengiriman dilakukan satu grup per satu grup dengan jeda `setjeda` detik.
- Kalau Telegram membalas `429 Too Many Requests`, bot menunggu sesuai `retry_after` lalu mengulang otomatis.
- Kalau bot dikeluarkan/diblokir/tidak punya izin kirim di sebuah grup, grup itu **otomatis dilepas** dari daftar tujuan dan owner diberi tahu, jadi siklus berikutnya tidak tersendat.

## Catatan

- Jangan pasang interval terlalu pendek. Telegram membatasi sekitar 20 pesan per menit ke grup yang berbeda; interval 15–60 menit jauh lebih aman dan tidak memicu pembatasan akun.
- Jangan jalankan dua proses bot dengan token yang sama — Telegram akan menolak dengan error `409 Conflict`.
- `data/` berisi pengaturan dan daftar grup, `.env` berisi token. Keduanya sudah masuk `.gitignore`; jangan dibagikan.
- Uji cepat tanpa menyentuh Telegram: `npm test`.

## Struktur

```
src/index.js      bootstrap, long polling, health check HTTP
src/bot.js        perintah owner, menu tombol, pencatatan grup
src/scheduler.js  siklus posting, jeda antar grup, penanganan error
src/api.js        pembungkus Bot API + retry 429/5xx
src/store.js      penyimpanan config.json & groups.json
legacy/           kode lama berbasis login akun (GramJS), tidak dipakai lagi
```
