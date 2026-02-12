const fetch = require('node-fetch');

const API_KEY = 'e9457ca133cc4d73854ee0d43cee3bc5';
const BASE_URL = 'https://wahubbd.salesmanchatbot.online';
const SESSION = 'bottow_jmpgjs';

async function main() {
  try {
    console.log(`Checking session ${SESSION} status...`);
    const response = await fetch(`${BASE_URL}/api/sessions?all=true`, {
      headers: {
        'X-Api-Key': API_KEY,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`Status check failed: ${response.status} ${response.statusText}`);
    }

    const sessions = await response.json();
    const session = sessions.find(s => s.name === SESSION);
    
    if (session) {
      console.log('Session Status:', JSON.stringify(session, null, 2));
    } else {
      console.error(`Session ${SESSION} not found!`);
      console.log('Available sessions:', sessions.map(s => s.name));
    }

  } catch (error) {
    console.error('Error:', error.message);
  }
}

main();
