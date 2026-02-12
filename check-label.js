const fetch = require('node-fetch');

const API_KEY = 'e9457ca133cc4d73854ee0d43cee3bc5';
const BASE_URL = 'https://wahubbd.salesmanchatbot.online';
const SESSION = 'bottow_jmpgjs';
const LABEL_NAME = 'bot2';

async function request(endpoint, method = 'GET', body = null) {
  const headers = {
    'X-Api-Key': API_KEY,
    'Content-Type': 'application/json',
  };
  
  const config = {
    method,
    headers,
  };
  
  if (body) {
    config.body = JSON.stringify(body);
  }

  try {
    const response = await fetch(`${BASE_URL}${endpoint}`, config);
    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Request failed: ${response.status} ${response.statusText} - ${text}`);
    }
    
    const text = await response.text();
    if (!text) {
        return null;
    }
    return JSON.parse(text);
  } catch (error) {
    console.error(`Fetch error for ${endpoint}:`, error.message);
    throw error;
  }
}

async function main() {
    try {
        console.log(`Checking labels for session: ${SESSION}...`);
        const labels = await request(`/api/${SESSION}/labels`);
        
        if (labels) {
            console.log(`Found ${labels.length} labels:`);
            labels.forEach(l => {
                console.log(` - [${l.id}] ${l.name} (Color: ${l.color})`);
            });
            
            const targetLabel = labels.find(l => l.name === LABEL_NAME);
            if (targetLabel) {
                console.log(`\nSUCCESS: Found label '${LABEL_NAME}' with ID: ${targetLabel.id}`);
                console.log(`Checking chats for label '${LABEL_NAME}'...`);
                const chats = await request(`/api/${SESSION}/labels/${targetLabel.id}/chats`);
                console.log('Chats with this label:', JSON.stringify(chats, null, 2));
            } else {
                console.log(`\nWARNING: Label '${LABEL_NAME}' NOT found in the list.`);
            }
        } else {
            console.log('No labels returned (null or empty).');
        }

    } catch (err) {
        console.error('Script failed:', err);
    }
}

main();
