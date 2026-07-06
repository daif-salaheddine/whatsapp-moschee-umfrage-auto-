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

client.on('ready', async () => {
  console.log('WhatsApp ready!');
  qrCodeData = '';
  // Force-sync the chat list so sendMessage looks up chats from local
  // cache instead of falling back to a slow/hanging network lookup.
  await client.getChats();
  console.log('Chats synced');
});

app.get('/', (req, res) => {
  if (qrCodeData) {
    res.send(`<html><body><h2>Scan this QR code with WhatsApp</h2><img src="${qrCodeData}"/></body></html>`);
  } else {
    res.send('<html><body><h2>WhatsApp is connected!</h2></body></html>');
  }
});

app.get('/groups', async (req, res) => {
  const chats = await client.getChats();
  const groups = chats
    .filter(chat => chat.isGroup)
    .map(chat => ({ id: chat.id._serialized, name: chat.name }));
  res.json(groups);
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