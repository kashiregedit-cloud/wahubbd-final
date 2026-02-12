const fetch = require('node-fetch');

const API_KEY = 'e9457ca133cc4d73854ee0d43cee3bc5';
const BASE_URL = 'https://wahubbd.salesmanchatbot.online';
const SESSION = 'bottow_jmpgjs';

async function main() {
  try {
    console.log(`Starting session ${SESSION}...`);
    const response = await fetch(`${BASE_URL}/api/sessions/${SESSION}/start`, {
      method: 'POST',
      headers: {
        'X-Api-Key': API_KEY,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Start failed: ${response.status} ${response.statusText} - ${text}`);
    }

    const session = await response.json();
    console.log('Session started:', JSON.stringify(session, null, 2));

  } catch (error) {
    console.error('Error:', error.message);
  }
}

main();
