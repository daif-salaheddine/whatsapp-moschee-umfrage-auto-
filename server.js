const path = require('path');
const fs = require('fs');
const { Client, LocalAuth, Poll } = require('whatsapp-web.js');
const express = require('express');
const qrcode = require('qrcode');

const app = express();
app.use(express.json());

let qrCodeData = '';

const AUTH_PATH = path.resolve('.wwebjs_auth'); // already on the Railway volume
const CACHE_PATH = path.join(AUTH_PATH, 'wwebjs_cache'); // also lives on the volume
const VERSION_PIN = process.env.WWEB_VERSION_PIN; // unset until bootstrapped

let isReady = false;

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: AUTH_PATH }),
  webVersionCache: {
    type: 'local',
    path: CACHE_PATH,
    // Once a pin is confirmed-good and set via env var, a missing cache file
    // becomes a loud startup failure instead of silently drifting back to
    // "whatever WhatsApp happens to be serving right now".
    strict: Boolean(VERSION_PIN),
  },
  webVersion: VERSION_PIN,
  puppeteer: {
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
    ],
  }
});

const HANG_TIMEOUT_MS = 45_000;
let restarting = false;

function withHangWatchdog(promise, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error(`${label} timed out after ${HANG_TIMEOUT_MS}ms (client likely wedged)`));
        recoverFromHang(label);
      }, HANG_TIMEOUT_MS);
    }),
  ]);
}

async function recoverFromHang(reason) {
  if (restarting) return;
  restarting = true;
  console.error(`Recovering wedged WhatsApp client (reason: ${reason})`);

  try {
    await Promise.race([client.destroy(), new Promise(r => setTimeout(r, 10_000))]);
  } catch (err) {
    console.error('client.destroy() failed, forcing kill:', err.message);
  }

  const proc = client.pupBrowser?.process?.();
  if (proc && !proc.killed) proc.kill('SIGKILL');

  // Clean stale Chrome profile locks so the relaunch doesn't fail acquiring the profile.
  const sessionDir = path.join(AUTH_PATH, 'session');
  for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    try { fs.unlinkSync(path.join(sessionDir, f)); } catch { /* fine if absent */ }
  }

  // Exit and let Railway's restart policy (ON_FAILURE, max 10 retries) relaunch
  // fresh. Session persists via the volume -- no new QR scan needed.
  process.exit(1);
}

client.on('qr', async qr => {
  isReady = false;
  qrCodeData = await qrcode.toDataURL(qr);
  console.log('QR code generated');
});

client.on('ready', async () => {
  const liveVersion = await client.getWWebVersion();
  console.log(`WhatsApp ready! Running WhatsApp Web version: ${liveVersion}`);
  qrCodeData = '';
  isReady = true;
});

client.on('disconnected', reason => {
  console.error(`WhatsApp disconnected: ${reason}`);
  isReady = false;
});

function requireReady(req, res, next) {
  if (!isReady) {
    return res.status(503).json({ success: false, error: 'WhatsApp client is not ready yet (still connecting or awaiting QR scan)' });
  }
  next();
}

app.get('/', (req, res) => {
  if (qrCodeData) {
    res.send(`<html><body><h2>Scan this QR code with WhatsApp</h2><img src="${qrCodeData}"/></body></html>`);
  } else {
    res.send('<html><body><h2>WhatsApp is connected!</h2></body></html>');
  }
});

app.get('/status', (req, res) => {
  res.json({ ready: isReady, pinnedVersion: VERSION_PIN || null, restarting });
});

app.get('/groups', requireReady, async (req, res) => {
  try {
    const chats = await withHangWatchdog(client.getChats(), 'getChats');
    const groups = chats
      .filter(chat => chat.isGroup)
      .map(chat => ({ id: chat.id._serialized, name: chat.name }));
    res.json(groups);
  } catch (err) {
    console.error('Failed to list groups:', err.message);
    res.status(503).json({ success: false, error: err.message });
  }
});

app.post('/send-test', requireReady, async (req, res) => {
  const { groupId } = req.body;
  try {
    await withHangWatchdog(client.sendMessage(groupId, 'test message from server'), 'sendMessage');
    res.json({ success: true });
  } catch (err) {
    console.error('Failed to send test message:', err.message);
    res.status(503).json({ success: false, error: err.message });
  }
});

app.post('/send', requireReady, async (req, res) => {
  const { groupId } = req.body;
  const poll = new Poll(
    'Wer ist nächsten Freitag dabei? (Freitagsgebet)',
    ['Ich bin dabei ❤️', 'Leider nicht 😔'],
    { allowMultipleAnswers: false }
  );
  try {
    await withHangWatchdog(client.sendMessage(groupId, poll), 'sendMessage');
    res.json({ success: true });
  } catch (err) {
    console.error('Failed to send poll:', err.message);
    res.status(503).json({ success: false, error: err.message });
  }
});

client.initialize();
app.listen(3000, () => console.log('Server running on port 3000'));
