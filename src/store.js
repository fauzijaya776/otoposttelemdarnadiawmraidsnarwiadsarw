'use strict';
const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '..', 'data');
const configPath = path.join(dataDir, 'config.json');
const groupsPath = path.join(dataDir, 'groups.json');

const defaultConfig = {
  ownerId: null,          // diisi lewat .env OWNER_ID atau perintah /claim
  enabled: false,         // status auto post
  intervalMinutes: 30,    // jarak antar siklus posting
  gapSeconds: 5,          // jeda antar grup dalam satu siklus (anti-flood)
  text: '',               // teks yang dikirim
  photo: '',              // file_id hasil upload ke bot, atau URL gambar
  parseMode: 'HTML',      // HTML | Markdown | none
  disablePreview: false,
  targets: [],            // daftar chat id tujuan (string)
  lastRunAt: null,
  nextRunAt: null,
  lastResults: []         // ringkasan pengiriman terakhir
};

function ensureDir() {
  fs.mkdirSync(dataDir, { recursive: true });
}

function readJson(file, fallback) {
  ensureDir();
  if (!fs.existsSync(file)) return structuredClone(fallback);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : structuredClone(fallback);
  } catch (error) {
    console.error(`[store] ${path.basename(file)} rusak, memakai nilai bawaan:`, error.message);
    return structuredClone(fallback);
  }
}

// Tulis atomik: tulis ke file sementara lalu rename, supaya file tidak korup saat proses mati.
function writeJson(file, value) {
  ensureDir();
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

let config = null;
let groups = null;

function getConfig() {
  if (!config) config = { ...defaultConfig, ...readJson(configPath, defaultConfig) };
  return config;
}

function saveConfig(patch = {}) {
  config = { ...getConfig(), ...patch };
  if (!Array.isArray(config.targets)) config.targets = [];
  config.targets = [...new Set(config.targets.map(String))];
  config.intervalMinutes = clamp(toNumber(config.intervalMinutes, 30), 1, 10080);
  config.gapSeconds = clamp(toNumber(config.gapSeconds, 5), 0, 600);
  writeJson(configPath, config);
  return config;
}

function getGroups() {
  if (!groups) groups = readJson(groupsPath, {});
  return groups;
}

function saveGroups(next) {
  groups = next;
  writeJson(groupsPath, groups);
  return groups;
}

// Dipanggil setiap bot melihat sebuah chat, jadi daftar grup terisi otomatis.
function rememberChat(chat, patch = {}) {
  if (!chat || !chat.id) return null;
  const all = getGroups();
  const key = String(chat.id);
  const before = all[key] || {};
  all[key] = {
    id: key,
    title: chat.title || chat.username || before.title || `Chat ${key}`,
    type: chat.type || before.type || 'unknown',
    username: chat.username || before.username || '',
    status: 'ok',
    error: '',
    firstSeenAt: before.firstSeenAt || new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    ...patch
  };
  saveGroups(all);
  return all[key];
}

function markChat(chatId, patch) {
  const all = getGroups();
  const key = String(chatId);
  if (!all[key]) all[key] = { id: key, title: `Chat ${key}`, type: 'unknown' };
  all[key] = { ...all[key], ...patch, lastSeenAt: new Date().toISOString() };
  saveGroups(all);
  return all[key];
}

function forgetChat(chatId) {
  const all = getGroups();
  delete all[String(chatId)];
  saveGroups(all);
}

function toNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Math.round(value)));
}

module.exports = {
  dataDir,
  getConfig,
  saveConfig,
  getGroups,
  saveGroups,
  rememberChat,
  markChat,
  forgetChat
};
