'use strict';
/**
 * Tampilkan SESSION_STRING akun yang sudah login:  npm run sesi
 *
 * Dipakai untuk hosting tanpa disk permanen (mis. Render free tier), yang
 * menghapus data/session.txt setiap restart. Tempel nilainya ke environment
 * variable SESSION_STRING di dashboard hosting.
 */
const { loadEnv } = require('./src/env');

loadEnv();

const { currentSessionString, sessionSource } = require('./src/userClient');

const sesi = currentSessionString();
if (!sesi) {
  console.error('Belum ada sesi. Jalankan dulu: npm run login');
  process.exit(1);
}

console.log(`Sumber: ${sessionSource() === 'env' ? 'environment SESSION_STRING' : 'data/session.txt'}`);
console.log('');
console.log('SESSION_STRING=' + sesi);
console.log('');
console.log('⚠️  Nilai ini setara akses penuh ke akun Telegram Anda.');
console.log('    Jangan dibagikan, jangan di-commit, jangan ditempel di chat mana pun.');
