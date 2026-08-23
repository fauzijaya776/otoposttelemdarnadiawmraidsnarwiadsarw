require('dotenv').config();

const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { readConfig, saveConfig } = require('./storage');
const telegram = require('./telegramClient');

const app = express();
const port = Number(process.env.PORT) || 3000;
const uploadDir = path.join(__dirname, '..', 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });
const upload = multer({ dest: uploadDir, limits: { fileSize: 10 * 1024 * 1024 } });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  const panelPassword = process.env.PANEL_PASSWORD;
  if (!panelPassword) return next();
  const authorization = req.headers.authorization || '';
  const [scheme, encoded] = authorization.split(' ');
  const provided = scheme === 'Basic' && encoded
    ? Buffer.from(encoded, 'base64').toString('utf8').split(':').slice(1).join(':')
    : '';
  if (provided === panelPassword) return next();
  res.set('WWW-Authenticate', 'Basic realm="Telegram Auto Poster"');
  return res.status(401).send('Autentikasi panel diperlukan.');
});

let timer;
let isPosting = false;

async function postNow() {
  const config = readConfig();
  if (isPosting || !config.enabled || !config.selectedGroups.length || (!config.message && !config.imagePath)) return;
  isPosting = true;
  try {
    const results = await Promise.allSettled(
      config.selectedGroups.map((group) => telegram.sendPost(group.id, config.message, config.imagePath))
    );
    const failed = results.filter((result) => result.status === 'rejected');
    if (failed.length) console.error('Sebagian pengiriman gagal:', failed.map((item) => item.reason.message));
  } finally {
    isPosting = false;
  }
}

function refreshSchedule() {
  if (timer) clearInterval(timer);
  const interval = Math.max(30, Number(readConfig().intervalMinutes) || 30);
  timer = setInterval(postNow, interval * 60 * 1000);
}

app.get('/health', async (_req, res) => {
  let loggedIn = false;
  try { loggedIn = await telegram.isAuthorized(); } catch {}
  res.json({ status: 'ok', service: 'telegram-auto-poster', loggedIn });
});

app.get('/api/config', (_req, res) => res.json(readConfig()));
app.get('/api/groups', async (_req, res) => {
  try { res.json(await telegram.listGroups()); } catch (error) { res.status(401).json({ error: error.message }); }
});

app.post('/api/login/request-code', async (req, res) => {
  try {
    if (!req.body.phoneNumber) throw new Error('Nomor Telegram wajib diisi, contoh: +628123456789.');
    await telegram.requestLoginCode(req.body.phoneNumber);
    res.json({ ok: true });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

app.post('/api/login/verify', async (req, res) => {
  try {
    const result = await telegram.verifyLogin(req.body);
    res.json({ ok: true, ...result });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

app.post('/api/config', upload.single('image'), (req, res) => {
  const groups = JSON.parse(req.body.selectedGroups || '[]');
  const previous = readConfig();
  const config = {
    ...previous,
    enabled: req.body.enabled === 'true',
    intervalMinutes: Math.max(30, Number(req.body.intervalMinutes) || 30),
    message: String(req.body.message || ''),
    selectedGroups: groups
  };
  if (req.file) config.imagePath = req.file.path;
  saveConfig(config);
  refreshSchedule();
  res.json({ ok: true, config });
});

app.post('/api/post-now', async (_req, res) => {
  const config = readConfig();
  if (!config.selectedGroups.length || (!config.message && !config.imagePath)) {
    return res.status(400).json({ error: 'Pilih grup dan isi pesan atau gambar terlebih dahulu.' });
  }
  try {
    await Promise.all(config.selectedGroups.map((group) => telegram.sendPost(group.id, config.message, config.imagePath)));
    res.json({ ok: true });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

app.get('/', (_req, res) => {
  res.type('html').send(`<!doctype html><html lang="id"><head><meta charset="utf-8"><title>Telegram Auto Poster</title><style>body{font-family:system-ui;max-width:760px;margin:32px auto;padding:0 16px}textarea,input,button{width:100%;box-sizing:border-box;margin:6px 0;padding:10px}textarea{height:120px}.groups{max-height:260px;overflow:auto;border:1px solid #ddd;padding:10px}.groups label{display:block;margin:5px}button{cursor:pointer}#status{padding:8px 0}</style></head><body><h1>Telegram Auto Poster</h1><p id="status">Memuat status…</p><h2>Login Telegram</h2><input id="phone" placeholder="+628123456789"><button onclick="requestCode()">Kirim kode login</button><input id="code" placeholder="Kode OTP Telegram"><input id="password" type="password" placeholder="Password 2FA (jika ada)"><button onclick="verify()">Verifikasi & muat grup</button><h2>Posting</h2><textarea id="message" placeholder="Tulis pesan di sini"></textarea><input id="image" type="file" accept="image/*"><label>Interval (menit, minimal 30)</label><input id="interval" type="number" min="30" value="30"><label><input id="enabled" type="checkbox"> Aktifkan posting otomatis</label><h3>Pilih grup</h3><div class="groups" id="groups">Login terlebih dahulu.</div><button onclick="save()">Simpan pengaturan</button><button onclick="postNow()">Kirim sekarang</button><script>let groups=[];let selected=[];const status=t=>document.querySelector('#status').textContent=t;async function req(u,o={}){const r=await fetch(u,o);const d=await r.json();if(!r.ok)throw Error(d.error||'Terjadi kesalahan');return d}async function requestCode(){try{await req('/api/login/request-code',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phoneNumber:phone.value})});status('Kode terkirim. Masukkan OTP.')}catch(e){status(e.message)}}async function verify(){try{const d=await req('/api/login/verify',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:code.value,password:password.value})});if(d.needsPassword){status('Masukkan password 2FA lalu klik verifikasi lagi.');return}status('Login berhasil. Memuat grup…');loadGroups()}catch(e){status(e.message)}}async function loadGroups(){try{groups=await req('/api/groups');groupsEl.innerHTML=groups.map(g=>'<label><input type="checkbox" value="'+g.id+'">'+g.title.replace(/</g,'&lt;')+'</label>').join('')||'Tidak ada grup.'}catch(e){status(e.message)}}async function save(){try{selected=[...document.querySelectorAll('#groups input:checked')].map(x=>groups.find(g=>g.id===x.value));const f=new FormData();f.append('message',message.value);f.append('intervalMinutes',interval.value);f.append('enabled',enabled.checked);f.append('selectedGroups',JSON.stringify(selected));if(image.files[0])f.append('image',image.files[0]);await req('/api/config',{method:'POST',body:f});status('Pengaturan disimpan.')}catch(e){status(e.message)}}async function postNow(){try{await req('/api/post-now',{method:'POST'});status('Pesan dikirim ke grup terpilih.')}catch(e){status(e.message)}}const groupsEl=document.querySelector('#groups');fetch('/health').then(r=>r.json()).then(d=>{status(d.loggedIn?'Sudah login. Memuat grup…':'Silakan login Telegram.');if(d.loggedIn)loadGroups()});</script></body></html>`);
});

refreshSchedule();
app.listen(port, '0.0.0.0', () => console.log(`Telegram Auto Poster aktif di port ${port}`));
