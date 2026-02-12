const fetch = require('node-fetch');

const API_KEY = 'e9457ca133cc4d73854ee0d43cee3bc5';
const BASE_URL = 'https://wahubbd.salesmanchatbot.online';
const SESSION = 'bottow_jmpgjs';
const CHAT_ID = '159167495024850@lid';

async function main() {
  try {
    console.log(`Checking chat labels for session: ${SESSION}, chat: ${CHAT_ID}...`);
    const url = `${BASE_URL}/api/${SESSION}/labels/chats/${CHAT_ID}`;
    console.log(`GET ${url}`);
    
    const response = await fetch(url, {
      headers: {
        'X-Api-Key': API_KEY,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      console.error(`Status check failed: ${response.status} ${response.statusText}`);
      const text = await response.text();
      console.error('Response:', text);
      return;
    }

    const labels = await response.json();
    console.log('Labels found:', JSON.stringify(labels, null, 2));

    if (labels.length === 0) {
      console.log('FAILURE: No labels returned for this chat.');
    } else {
      console.log('SUCCESS: Labels returned.');
    }

  } catch (error) {
    console.error('Error:', error.message);
  }
}

main();
