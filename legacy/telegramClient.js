const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { Api, utils } = require('telegram');
const { SessionPasswordNeededError } = require('telegram/errors');
const { readSession, saveSession } = require('./storage');

let client;
let pendingLogin;

function credentials() {
  const apiId = Number(process.env.TG_API_ID);
  const apiHash = process.env.TG_API_HASH;
  if (!Number.isInteger(apiId) || !apiHash) {
    throw new Error('TG_API_ID dan TG_API_HASH harus diisi pada file .env.');
  }
  return { apiId, apiHash };
}

async function getClient() {
  if (client?.connected) return client;
  const { apiId, apiHash } = credentials();
  client = new TelegramClient(new StringSession(readSession()), apiId, apiHash, {
    connectionRetries: 5
  });
  await client.connect();
  return client;
}

async function requestLoginCode(phoneNumber) {
  const currentClient = await getClient();
  const { apiId, apiHash } = credentials();
  const result = await currentClient.sendCode({ apiId, apiHash }, phoneNumber);
  pendingLogin = { phoneNumber, phoneCodeHash: result.phoneCodeHash };
  return true;
}

async function verifyLogin({ code, password }) {
  if (!pendingLogin) throw new Error('Minta kode login terlebih dahulu.');
  const currentClient = await getClient();
  try {
    await currentClient.invoke(new Api.auth.SignIn({
      phoneNumber: pendingLogin.phoneNumber,
      phoneCodeHash: pendingLogin.phoneCodeHash,
      phoneCode: String(code).trim()
    }));
  } catch (error) {
    if (!(error instanceof SessionPasswordNeededError)) throw error;
    if (!password) return { needsPassword: true };
    await currentClient.checkPassword(password);
  }

  saveSession(currentClient.session.save());
  pendingLogin = undefined;
  return { needsPassword: false };
}

async function isAuthorized() {
  const currentClient = await getClient();
  return currentClient.isUserAuthorized();
}

async function listGroups() {
  const currentClient = await getClient();
  if (!(await currentClient.isUserAuthorized())) throw new Error('Silakan login Telegram terlebih dahulu.');

  const groups = [];
  for await (const dialog of currentClient.iterDialogs({})) {
    const entity = dialog.entity;
    const isGroup = entity?.className === 'Chat' || (entity?.className === 'Channel' && entity.megagroup);
    if (isGroup) {
      groups.push({ id: utils.getPeerId(entity).toString(), title: dialog.title || 'Tanpa nama' });
    }
  }
  return groups.sort((a, b) => a.title.localeCompare(b.title, 'id'));
}

async function sendPost(groupId, message, imagePath) {
  const currentClient = await getClient();
  if (!(await currentClient.isUserAuthorized())) throw new Error('Sesi Telegram belum login.');
  if (imagePath) {
    await currentClient.sendFile(groupId, { file: imagePath, caption: message || undefined });
  } else {
    await currentClient.sendMessage(groupId, { message });
  }
}

module.exports = { requestLoginCode, verifyLogin, isAuthorized, listGroups, sendPost };
