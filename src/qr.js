'use strict';

// Pembuatan QR memakai paket "qrcode". Dimuat saat dibutuhkan saja,
// supaya bot tetap jalan meski paketnya belum terpasang.
function loadQrcode(loader = () => require('qrcode')) {
  try {
    return loader();
  } catch (error) {
    throw new Error('Paket "qrcode" belum terpasang. Jalankan: npm install');
  }
}

/** URL yang diubah jadi QR; dipindai lewat Telegram HP (Perangkat -> Tautkan Perangkat). */
function loginUrl(token) {
  const base64 = Buffer.from(token).toString('base64');
  const urlSafe = base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `tg://login?token=${urlSafe}`;
}

async function toPng(text, loader) {
  const qrcode = loadQrcode(loader);
  return qrcode.toBuffer(text, { type: 'png', width: 512, margin: 2, errorCorrectionLevel: 'L' });
}

async function toTerminal(text, loader) {
  const qrcode = loadQrcode(loader);
  return qrcode.toString(text, { type: 'terminal', small: true, errorCorrectionLevel: 'L' });
}

function isAvailable(loader) {
  try {
    loadQrcode(loader);
    return true;
  } catch {
    return false;
  }
}

module.exports = { loginUrl, toPng, toTerminal, isAvailable };
