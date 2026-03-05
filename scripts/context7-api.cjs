#!/usr/bin/env node

/**
 * Context7 API Helper Script
 * Provides simple CLI interface to Context7 API for skill integration
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const API_BASE = 'https://context7.com/api/v2';

// Load API key from environment variable or .env file
function loadApiKey() {
  // First try environment variable
  if (process.env.CONTEXT7_API_KEY) {
    return process.env.CONTEXT7_API_KEY;
  }

  // Then try .env file next to this script
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf8');
    const match = envContent.match(/CONTEXT7_API_KEY\s*=\s*(.+)/);
    if (match) {
      return match[1].trim().replace(/^["']|["']$/g, '');
    }
  }

  return null;
}

const API_KEY = loadApiKey();

function makeRequest(path, params = {}) {
  return new Promise((resolve, reject) => {
    const queryString = new URLSearchParams(params).toString();
    const url = `${API_BASE}${path}?${queryString}`;

    const options = {
      headers: {
        'Authorization': API_KEY ? `Bearer ${API_KEY}` : '',
        'User-Agent': 'Context7-Skill/1.0'
      }
    };

    https.get(url, options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            resolve(data);
          }
        } else {
          reject(new Error(`API Error ${res.statusCode}: ${data}`));
        }
      });
    }).on('error', reject);
  });
}

async function searchLibrary(libraryName, query) {
  try {
    const result = await makeRequest('/libs/search', {
      libraryName,
      query
    });
    return result;
  } catch (error) {
    console.error(`Error searching library: ${error.message}`);
    return null;
  }
}

async function getContext(libraryId, query) {
  try {
    const result = await makeRequest('/context', {
      libraryId,
      query,
      type: 'json'
    });
    return result;
  } catch (error) {
    console.error(`Error getting context: ${error.message}`);
    return null;
  }
}

// CLI Interface
const command = process.argv[2];
const args = process.argv.slice(3);

(async () => {
  if (command === 'search') {
    const [libraryName, query] = args;
    if (!libraryName || !query) {
      console.error('Usage: context7-api.cjs search <libraryName> <query>');
      process.exit(1);
    }
    const result = await searchLibrary(libraryName, query);
    console.log(JSON.stringify(result, null, 2));
  } else if (command === 'context') {
    const [libraryId, query] = args;
    if (!libraryId || !query) {
      console.error('Usage: context7-api.cjs context <libraryId> <query>');
      process.exit(1);
    }
    const result = await getContext(libraryId, query);
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.error('Usage: context7-api.cjs <search|context> <args...>');
    process.exit(1);
  }
})();
