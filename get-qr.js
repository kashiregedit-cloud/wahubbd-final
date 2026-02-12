const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const API_KEY = 'e9457ca133cc4d73854ee0d43cee3bc5';
const BASE_URL = 'https://wahubbd.salesmanchatbot.online';
const SESSION = 'bottow_jmpgjs';
const OUTPUT_FILE = path.join('C:', 'Users', 'mdedu', 'Downloads', 'bottow_jmpgjs_qr.png');

async function main() {
  try {
    console.log(`Fetching QR code for session ${SESSION}...`);
    const response = await fetch(`${BASE_URL}/api/${SESSION}/auth/qr?format=image`, {
      headers: {
        'X-Api-Key': API_KEY,
      },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Failed to get QR: ${response.status} ${response.statusText} - ${text}`);
    }

    const buffer = await response.buffer();
    fs.writeFileSync(OUTPUT_FILE, buffer);
    console.log(`QR code saved to: ${OUTPUT_FILE}`);
    console.log('Please open this file and scan it with WhatsApp.');

  } catch (error) {
    console.error('Error:', error.message);
  }
}

main();
