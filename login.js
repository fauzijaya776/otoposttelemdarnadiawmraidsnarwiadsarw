'use strict';
/**
 * Login akun pengirim lewat terminal:  npm run login
 *
 * Kode OTP diketik di terminal ini, bukan di chat Telegram.
 * Telegram membatalkan kode yang terdeteksi pernah dikirim lewat chat,
 * jadi jalur ini yang paling aman kalau QR tidak bisa dipakai.
 */
const readline = require('readline');
const { loadEnv } = require('./src/env');

loadEnv();

const { createUserClient } = require('./src/userClient');
const { runCliLogin } = require('./src/cliLogin');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

const ask = (question) =>
  new Promise((resolve) => rl.question(question, (answer) => resolve(String(answer).trim())));

// Password 2FA disembunyikan: output readline dimatikan sementara.
function askHidden(question) {
  return new Promise((resolve) => {
    let hide = false;
    const original = rl._writeToOutput?.bind(rl);
    rl._writeToOutput = (text) => {
      if (!hide) return original ? original(text) : rl.output.write(text);
      return rl.output.write('*');
    };
    rl.question(question, (answer) => {
      hide = false;
      rl._writeToOutput = original;
      rl.output.write('\n');
      resolve(String(answer));
    });
    hide = true;
  });
}

function pickMode(argument) {
  if (argument === '--kode' || argument === '--code') return '2';
  if (argument === '--qr') return '1';
  return undefined;
}

async function main() {
  const userClient = createUserClient();
  console.log('=== Login akun pengirim Telegram Auto Poster ===');
  console.log('Kode OTP diketik di terminal ini saja, jangan pernah di dalam chat Telegram.');
  console.log('');
  try {
    await runCliLogin({
      userClient,
      ask,
      askHidden,
      log: (message) => console.log(message),
      mode: pickMode(process.argv[2])
    });
  } catch (error) {
    console.error(`\n❌ ${error.message}`);
    if (/NEED_PASSWORD/.test(error.message)) {
      console.error('Akun ini memakai 2FA. Ulangi dengan: npm run login -- --kode');
    }
    process.exitCode = 1;
  } finally {
    rl.close();
    await userClient.disconnect().catch(() => null);
    setTimeout(() => process.exit(process.exitCode || 0), 300).unref();
  }
}

main();
