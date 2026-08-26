'use strict';
const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '..', 'data');
const configPath = path.join(dataDir, 'config.json');
const groupsPath = path.join(dataDir, 'groups.json');

const defaultConfig = {
  ownerId: null,          // diisi lewat .env OWNER_ID atau perintah /claim
  enabled: false,         // status auto post
  intervalMinutes: 60,    // jarak antar siklus posting
  gapSeconds: 15,         // jeda antar grup dalam satu siklus (anti-flood akun)
  text: '',               // teks yang dikirim
  imagePath: '',          // lokasi file gambar di folder uploads/
  parseMode: 'html',      // html | md | none
  notifyLevel: 'penting', // semua | penting | mati — seberapa cerewet laporan ke owner
  autoRemove: '3x',       // langsung | 3x | fatal — kapan grup gagal dilepas dari tujuan
  disablePreview: false,
  targets: [],            // daftar chat id tujuan (string)
  lastRunAt: null,
  lastRunStats: null,     // { sent, failed, manual } dari siklus terakhir
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
  config.intervalMinutes = clamp(toNumber(config.intervalMinutes, 60), 1, 10080);
  config.gapSeconds = clamp(toNumber(config.gapSeconds, 15), 0, 600);
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
  markChat,
  forgetChat
};
