const path = require('path');
const fs = require('fs');
const { Client, LocalAuth, Poll } = require('whatsapp-web.js');
const express = require('express');
const qrcode = require('qrcode');

const app = express();
app.use(express.json());

let qrCodeData = '';

const AUTH_PATH = path.resolve('.wwebjs_auth');
const CACHE_PATH = path.join(AUTH_PATH, 'wwebjs_cache');
const VERSION_PIN = process.env.WWEB_VERSION_PIN;

let isReady = false;

const STARTUP_TIMEOUT_MS = Number(process.env.STARTUP_TIMEOUT_MS) || 5 * 60_000;

function buildClient() {
  const c = new Client({
    authStrategy: new LocalAuth({ dataPath: AUTH_PATH }),
    webVersionCache: {
      type: 'local',
      path: CACHE_PATH,
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

  // Neither 'ready' nor 'qr' protects against the client silently hanging
  // during the initial connection itself (confirmed: happened for ~2 days
  // undetected). If we reach neither state within STARTUP_TIMEOUT_MS, it's
  // stuck -- restart via the same safe process-exit recovery used elsewhere.
  const startupTimer = setTimeout(() => {
    if (!isReady && !qrCodeData) {
      console.error(`Client reached neither ready nor qr within ${STARTUP_TIMEOUT_MS}ms of startup -- likely stuck, restarting`);
      recoverFromHang('startup-timeout');
    }
  }, STARTUP_TIMEOUT_MS);

  c.on('qr', async qr => {
    clearTimeout(startupTimer);
    isReady = false;
    qrCodeData = await qrcode.toDataURL(qr);
    console.log('QR code generated');
  });

  c.on('ready', async () => {
    clearTimeout(startupTimer);
    const liveVersion = await c.getWWebVersion();
    console.log(`WhatsApp ready! Running WhatsApp Web version: ${liveVersion}`);
    qrCodeData = '';
    isReady = true;
  });

  c.on('disconnected', reason => {
    console.error(`WhatsApp disconnected: ${reason}`);
    isReady = false;
  });

  return c;
}

const HANG_TIMEOUT_MS = Number(process.env.HANG_TIMEOUT_MS) || 45_000;
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

// Chrome writes these lock files into the profile dir to prevent two
// instances sharing it. If a container is replaced/killed before Chrome
// shuts down cleanly, a stale lock survives on the persistent volume and
// blocks every future launch ("profile in use by another process on
// another computer") until removed.
function clearStaleProfileLocks() {
  const sessionDir = path.join(AUTH_PATH, 'session');
  for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    try { fs.unlinkSync(path.join(sessionDir, f)); } catch { /* fine if absent */ }
  }
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

  clearStaleProfileLocks();

  // Exit and let Railway's restart policy (ON_FAILURE, max 10 retries) relaunch
  // fresh. A real process restart guarantees a clean memory slate -- session
  // persists via the volume, so no new QR scan is needed.
  process.exit(1);
}

function requireReady(req, res, next) {
  if (!isReady) {
    return res.status(503).json({ success: false, error: 'WhatsApp client is not ready yet' });
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

  const poll1 = new Poll(
    'Wer ist nächsten Freitag dabei? (Freitagsgebet)',
    ['Ich bin dabei ❤️', 'Leider nicht 😔'],
    { allowMultipleAnswers: false }
  );

  const poll2 = new Poll(
    'Heute nach Assr Gebet: Moschee sauber machen',
    ['Das ist mir eine Ehre, Gerne ❤️', 'Nein'],
    { allowMultipleAnswers: false }
  );

  try {
    await withHangWatchdog(client.sendMessage(groupId, poll1), 'sendPoll1');
    await withHangWatchdog(client.sendMessage(groupId, poll2), 'sendPoll2');
    res.json({ success: true });
  } catch (err) {
    console.error('Failed to send polls:', err.message);
    res.status(503).json({ success: false, error: err.message });
  }
});

clearStaleProfileLocks();
const client = buildClient();
client.initialize();
app.listen(3000, () => console.log('Server running on port 3000'));
