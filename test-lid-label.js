const fetch = require('node-fetch');

const API_KEY = 'e9457ca133cc4d73854ee0d43cee3bc5';
const BASE_URL = 'https://wahubbd.salesmanchatbot.online';
const SESSION = 'bottow_jmpgjs';
const LABEL_NAME = 'bot2';
const TARGET_CHAT_LID = '159167495024850@lid';

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
    return text ? JSON.parse(text) : null;
  } catch (error) {
    console.error(`Fetch error for ${endpoint}:`, error.message);
    throw error;
  }
}

async function main() {
    try {
        console.log(`Checking labels for session: ${SESSION}...`);
        const labels = await request(`/api/${SESSION}/labels`);
        
        console.log(`Found ${labels.length} labels:`);
        labels.forEach(l => {
            console.log(` - [${l.id}] ${l.name} (Color: ${l.color})`);
        });

        let targetLabel = labels.find(l => l.name === LABEL_NAME);
        
        if (!targetLabel) {
            console.log(`\nLabel '${LABEL_NAME}' not found. Creating it...`);
            targetLabel = await request(`/api/${SESSION}/labels`, 'POST', {
                name: LABEL_NAME,
                color: 1 // Default color
            });
            console.log(`Created label '${LABEL_NAME}' with ID: ${targetLabel.id}`);
        } else {
            console.log(`\nFound label '${LABEL_NAME}' with ID: ${targetLabel.id}`);
        }

        console.log(`\nAssigning label to chat '${TARGET_CHAT_LID}'...`);
        // API: PUT /api/{session}/labels/{labelId}/chats
        // Body: { chatId: "..." }
        await request(`/api/${SESSION}/labels/${targetLabel.id}/chats`, 'PUT', {
            chatId: TARGET_CHAT_LID
        });
        console.log('Assignment request sent successfully.');

        console.log(`\nVerifying assignment...`);
        // Give it a moment to sync/persist
        await new Promise(r => setTimeout(r, 2000));

        const chats = await request(`/api/${SESSION}/labels/${targetLabel.id}/chats`);
        console.log('Chats with this label:', JSON.stringify(chats, null, 2));

        const found = chats.some(c => c.id === TARGET_CHAT_LID || c.lid === TARGET_CHAT_LID);
        if (found) {
            console.log(`\nSUCCESS: Chat '${TARGET_CHAT_LID}' is now associated with label '${LABEL_NAME}'!`);
            console.log(`\nNow please REMOVE this label from the chat using your mobile phone.`);
            console.log(`After removing, run this script again or ask me to verify.`);
        } else {
            console.log(`\nFAILURE: Chat '${TARGET_CHAT_LID}' was NOT found in the label's chat list.`);
            console.log('This indicates the LID-PN sync or storage issue persists.');
        }

    } catch (err) {
        console.error('Test failed:', err);
    }
}

main();
