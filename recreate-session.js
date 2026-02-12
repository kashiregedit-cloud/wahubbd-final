const fetch = require('node-fetch');

const API_KEY = 'e9457ca133cc4d73854ee0d43cee3bc5';
const BASE_URL = 'https://wahubbd.salesmanchatbot.online';
const SESSION = 'bottow_jmpgjs';

async function recreateSession() {
  console.log(`Deleting session '${SESSION}'...`);
  try {
    // DELETE
    const delResponse = await fetch(`${BASE_URL}/api/sessions/${SESSION}`, {
      method: 'DELETE',
      headers: {
        'X-Api-Key': API_KEY,
        'Content-Type': 'application/json',
      },
    });
    console.log(`Delete Status: ${delResponse.status}`);
    
    // Wait a bit
    await new Promise(resolve => setTimeout(resolve, 2000));

    // CREATE
    const payload = {
      name: SESSION,
      config: {
        "proxy": null,
        "noweb": {
          "store": {
            "enabled": true,
            "fullSync": false
          }
        }
      }
    };

    console.log(`Creating session '${SESSION}'...`);
    const response = await fetch(`${BASE_URL}/api/sessions`, {
      method: 'POST',
      headers: {
        'X-Api-Key': API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const text = await response.text();
    console.log(`Create Status: ${response.status}`);
    console.log(`Create Body: ${text}`);

  } catch (error) {
    console.error('Error:', error.message);
  }
}

recreateSession();
