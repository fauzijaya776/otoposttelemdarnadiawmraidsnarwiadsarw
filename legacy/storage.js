const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '..', 'data');
const configPath = path.join(dataDir, 'config.json');
const sessionPath = path.join(dataDir, 'session.txt');

const defaultConfig = {
  enabled: false,
  intervalMinutes: 30,
  message: '',
  imagePath: '',
  selectedGroups: []
};

function ensureDataDirectory() {
  fs.mkdirSync(dataDir, { recursive: true });
}

function readConfig() {
  ensureDataDirectory();
  if (!fs.existsSync(configPath)) return { ...defaultConfig };
  try {
    return { ...defaultConfig, ...JSON.parse(fs.readFileSync(configPath, 'utf8')) };
  } catch {
    return { ...defaultConfig };
  }
}

function saveConfig(config) {
  ensureDataDirectory();
  fs.writeFileSync(configPath, JSON.stringify({ ...defaultConfig, ...config }, null, 2));
}

function readSession() {
  ensureDataDirectory();
  return fs.existsSync(sessionPath) ? fs.readFileSync(sessionPath, 'utf8').trim() : '';
}

function saveSession(session) {
  ensureDataDirectory();
  fs.writeFileSync(sessionPath, session, { mode: 0o600 });
}

module.exports = { readConfig, saveConfig, readSession, saveSession };
