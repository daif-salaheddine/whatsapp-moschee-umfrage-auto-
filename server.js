const { Client, LocalAuth, Poll } = require('whatsapp-web.js');
const express = require('express');
const qrcode = require('qrcode');

const app = express();
app.use(express.json());

let qrCodeData = '';

const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    executablePath: '/usr/bin/chromium',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-dbus',
      '--disable-gpu',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
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

app.post('/send', async (req, res) => {
  const { groupId } = req.body;
  const poll = new Poll(
    'Wer ist nächsten Freitag dabei? (Freitagsgebet)',
    ['Ich bin dabei ❤️', 'Leider nicht 😔'],
    { allowMultipleAnswers: false }
  );
  await client.sendMessage(groupId, poll);
  res.json({ success: true });
});

client.initialize();
app.listen(3000, () => console.log('Server running on port 3000'));