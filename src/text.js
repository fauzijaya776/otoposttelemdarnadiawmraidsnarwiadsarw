'use strict';

// Telegram menolak string yang bukan UTF-8 valid dengan pesan
// "must be encoded in UTF-8". Penyebab tersering: judul grup ber-emoji
// yang terpotong tepat di tengah pasangan surrogate.

const LONE_HIGH_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g;
const LONE_LOW_SURROGATE = /(^|[^\uD800-\uDBFF])([\uDC00-\uDFFF])/g;
// Buang karakter kontrol, tapi pertahankan tab, newline, dan carriage return.
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/** Bersihkan string supaya selalu aman dikirim ke Telegram. */
function sanitize(value) {
  return String(value ?? '')
    .replace(CONTROL_CHARS, '')
    .replace(LONE_HIGH_SURROGATE, '')
    .replace(LONE_LOW_SURROGATE, '$1');
}

/** Apakah string ini selamat melewati validasi UTF-8 Telegram? */
function isValidUtf8(value) {
  const text = String(value);
  return Buffer.from(text, 'utf8').toString('utf8') === text;
}

const segmenter =
  typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter('id', { granularity: 'grapheme' })
    : null;

/** Pecah string per karakter tampak, bukan per unit UTF-16, supaya emoji tidak terbelah. */
function toCharacters(value) {
  const clean = sanitize(value);
  if (segmenter) return [...segmenter.segment(clean)].map((part) => part.segment);
  return Array.from(clean); // fallback: per titik kode
}

/** Potong teks dengan aman; emoji tidak akan terbelah di tengah. */
function truncate(value, max, fallback = '') {
  const characters = toCharacters(value);
  if (!characters.length) return fallback;
  if (characters.length <= max) return characters.join('');
  return `${characters.slice(0, Math.max(1, max - 1)).join('')}…`;
}

/** Teks tombol inline: sudah dipotong aman dan tidak pernah kosong. */
function buttonLabel(value, max = 40, fallback = 'Tanpa nama') {
  const text = truncate(value, max, fallback).trim();
  return text || fallback;
}

module.exports = { sanitize, isValidUtf8, toCharacters, truncate, buttonLabel };
