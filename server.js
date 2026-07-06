const { Client, LocalAuth, Poll } = require('whatsapp-web.js');
const express = require('express');
const qrcode = require('qrcode');

const app = express();
app.use(express.json());

let qrCodeData = '';

const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-zygote',
      '--no-first-run',
      '--disable-accelerated-2d-canvas',
    ],
  }
});

client.on('qr', async qr => {
  qrCodeData = await qrcode.toDataURL(qr);
  console.log('QR code generated');
});

client.on('ready', () => {
  console.log('WhatsApp ready!');
  qrCodeData = '';
});

app.get('/', (req, res) => {
  if (qrCodeData) {
    res.send(`<html><body><h2>Scan this QR code with WhatsApp</h2><img src="${qrCodeData}"/></body></html>`);
  } else {
    res.send('<html><body><h2>WhatsApp is connected!</h2></body></html>');
  }
});

app.get('/debug-evaluate', async (req, res) => {
  try {
    const title = await client.pupPage.evaluate(() => document.title);
    const networkTest = await client.pupPage.evaluate(() => {
      const withTimeout = (promise, ms) =>
        Promise.race([
          promise.then(v => ({ done: true, ...v })),
          new Promise(resolve => setTimeout(() => resolve({ done: false, timedOut: true }), ms)),
        ]);
      return withTimeout(
        fetch('https://web.whatsapp.com/favicon.ico')
          .then(r => ({ status: r.status }))
          .catch(err => ({ fetchError: err.message })),
        8000
      );
    });
    res.json({ success: true, title, networkTest });
  } catch (err) {
    console.error('Failed debug-evaluate:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/groups', async (req, res) => {
  try {
    const chats = await client.getChats();
    const groups = chats
      .filter(chat => chat.isGroup)
      .map(chat => ({ id: chat.id._serialized, name: chat.name }));
    res.json(groups);
  } catch (err) {
    console.error('Failed to list groups:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/send-test', async (req, res) => {
  const { groupId } = req.body;
  try {
    await client.sendMessage(groupId, 'test message from server');
    res.json({ success: true });
  } catch (err) {
    console.error('Failed to send test message:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/send', async (req, res) => {
  const { groupId } = req.body;
  const poll = new Poll(
    'Wer ist nächsten Freitag dabei? (Freitagsgebet)',
    ['Ich bin dabei ❤️', 'Leider nicht 😔'],
    { allowMultipleAnswers: false }
  );
  try {
    await client.sendMessage(groupId, poll);
    res.json({ success: true });
  } catch (err) {
    console.error('Failed to send poll:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

client.initialize();
app.listen(3000, () => console.log('Server running on port 3000'));