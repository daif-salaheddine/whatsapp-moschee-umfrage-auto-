const { Client, LocalAuth, Poll } = require('whatsapp-web.js');
const express = require('express');
const qrcode = require('qrcode-terminal');
const { execSync } = require('child_process');
const fs = require('fs');

const app = express();
app.use(express.json());

function resolveChromiumPath() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;
  try {
    const found = execSync('which chromium').toString().trim();
    if (found) return found;
  } catch {}
  for (const candidate of ['/usr/bin/chromium', '/usr/bin/chromium-browser']) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    executablePath: resolveChromiumPath(),
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  }
});

client.on('qr', qr => qrcode.generate(qr, { small: true }));
client.on('ready', () => console.log('WhatsApp ready!'));

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