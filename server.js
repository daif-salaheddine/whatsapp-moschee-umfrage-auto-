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
let client;

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

  c.on('qr', async qr => {
    isReady = false;
    qrCodeData = await qrcode.toDataURL(qr);
    console.log('QR code generated');
  });

  c.on('ready', async () => {
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
let recovering = null;

function withTimeout(promise, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`${label} timed out after ${HANG_TIMEOUT_MS}ms`)), HANG_TIMEOUT_MS);
    }),
  ]);
}

function waitForReady(timeoutMs) {
  if (isReady) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = setInterval(() => {
      if (isReady) {
        clearInterval(check);
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(check);
        reject(new Error('Timed out waiting for WhatsApp client to become ready again'));
      }
    }, 500);
  });
}

async function recoverFromHang(reason) {
  if (recovering) return recovering;

  recovering = (async () => {
    isReady = false;
    console.error(`Recovering wedged WhatsApp client (reason: ${reason})`);
    const oldClient = client;

    try {
      await Promise.race([oldClient.destroy(), new Promise(r => setTimeout(r, 10_000))]);
    } catch (err) {
      console.error('client.destroy() failed, forcing kill:', err.message);
    }

    const proc = oldClient.pupBrowser?.process?.();
    if (proc && !proc.killed) proc.kill('SIGKILL');

    const sessionDir = path.join(AUTH_PATH, 'session');
    for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
      try { fs.unlinkSync(path.join(sessionDir, f)); } catch { }
    }

    client = buildClient();
    client.initialize();
    await waitForReady(60_000);
    console.log('Recovery complete, client is ready again');
  })();

  try {
    await recovering;
  } finally {
    recovering = null;
  }
}

async function withRecoveryRetry(fn, label) {
  try {
    return await withTimeout(fn(), label);
  } catch (err) {
    console.error(`${label} failed, attempting recovery + one retry:`, err.message);
    await recoverFromHang(label);
    return await withTimeout(fn(), label);
  }
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
  res.json({ ready: isReady, pinnedVersion: VERSION_PIN || null, recovering: Boolean(recovering) });
});

app.get('/groups', requireReady, async (req, res) => {
  try {
    const chats = await withRecoveryRetry(() => client.getChats(), 'getChats');
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
    await withRecoveryRetry(() => client.sendMessage(groupId, 'test message from server'), 'sendMessage');
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
    await withRecoveryRetry(() => client.sendMessage(groupId, poll1), 'sendPoll1');
    await withRecoveryRetry(() => client.sendMessage(groupId, poll2), 'sendPoll2');
    res.json({ success: true });
  } catch (err) {
    console.error('Failed to send polls:', err.message);
    res.status(503).json({ success: false, error: err.message });
  }
});

client = buildClient();
client.initialize();
app.listen(3000, () => console.log('Server running on port 3000'));