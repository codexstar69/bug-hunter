#!/usr/bin/env node

/**
 * Unified Documentation Lookup — Context Hub (chub) + Context7 fallback
 *
 * Tries chub first (curated, annotatable docs), falls back to Context7 API
 * when chub doesn't have the library.
 *
 * CLI interface (drop-in replacement for context7-api.cjs):
 *   doc-lookup.cjs search <library> <query>
 *   doc-lookup.cjs get    <library-or-id> <query> [--lang js|py]
 */

const { execSync } = require('child_process');
const https = require('https');
const fs = require('fs');
const path = require('path');

// ── Config ──────────────────────────────────────────────────────────────────

const CONTEXT7_API_BASE = 'https://context7.com/api/v2';
const CONTEXT7_TIMEOUT_MS = 15000;
const CHUB_TIMEOUT_MS = 10000;

// ── Context7 fallback (unchanged from context7-api.cjs) ────────────────────

function loadContext7Key() {
  if (process.env.CONTEXT7_API_KEY) return process.env.CONTEXT7_API_KEY;
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf8');
    const match = content.match(/CONTEXT7_API_KEY\s*=\s*(.+)/);
    if (match) return match[1].trim().replace(/^["']|["']$/g, '');
  }
  return null;
}

const CONTEXT7_KEY = loadContext7Key();

function context7Request(apiPath, params = {}) {
  return new Promise((resolve, reject) => {
    const qs = new URLSearchParams(params).toString();
    const url = `${CONTEXT7_API_BASE}${apiPath}?${qs}`;
    const headers = { 'User-Agent': 'BugHunter-DocLookup/2.0' };
    if (CONTEXT7_KEY) headers['Authorization'] = `Bearer ${CONTEXT7_KEY}`;

    const req = https.get(url, { headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        if (res.statusCode === 200) {
          try { resolve(JSON.parse(data)); } catch { resolve(data); }
        } else {
          reject(new Error(`Context7 ${res.statusCode}: ${data.slice(0, 200)}`));
        }
      });
    });
    req.setTimeout(CONTEXT7_TIMEOUT_MS, () => req.destroy(new Error('Context7 timeout')));
    req.on('error', reject);
  });
}

// ── chub helpers ────────────────────────────────────────────────────────────

function chubAvailable() {
  try {
    execSync('chub --help', { stdio: 'ignore', timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

function chubSearch(library) {
  try {
    const raw = execSync(`chub search "${library}" --json`, {
      encoding: 'utf8',
      timeout: CHUB_TIMEOUT_MS,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const parsed = JSON.parse(raw);
    return parsed.results || [];
  } catch {
    return [];
  }
}

function chubGet(id, lang) {
  try {
    const langFlag = lang ? ` --lang ${lang}` : '';
    const raw = execSync(`chub get ${id}${langFlag}`, {
      encoding: 'utf8',
      timeout: CHUB_TIMEOUT_MS,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return raw;
  } catch {
    return null;
  }
}

// ── Detect best language flag for chub ──────────────────────────────────────

function pickLang(entry, hint) {
  if (!entry.languages || entry.languages.length === 0) return null;
  const langs = entry.languages.map((l) => l.language || l);
  if (hint && langs.includes(hint)) return hint;
  // Prefer JS/TS for bug-hunter (most common web targets)
  for (const pref of ['javascript', 'typescript', 'python']) {
    if (langs.includes(pref)) return pref;
  }
  return langs[0];
}

// ── Main: search ────────────────────────────────────────────────────────────

async function search(library, query) {
  const source = { chub: null, context7: null };

  // 1. Try chub
  if (chubAvailable()) {
    const results = chubSearch(library);
    if (results.length > 0) {
      source.chub = results.map((r) => ({
        id: r.id,
        name: r.name,
        description: r.description,
        type: r._type || r.type || 'doc',
        languages: r.languages ? r.languages.map((l) => l.language || l) : [],
      }));
    }
  }

  // 2. Try Context7
  try {
    const c7 = await context7Request('/libs/search', { libraryName: library, query });
    if (c7 && (Array.isArray(c7) ? c7.length > 0 : c7.results?.length > 0)) {
      source.context7 = c7;
    }
  } catch (err) {
    source.context7_error = err.message;
  }

  // 3. Merge results
  const output = { library, query };
  if (source.chub) {
    output.chub_results = source.chub;
    output.recommended_source = 'chub';
    output.recommended_id = source.chub[0].id;
    output.hint = `Fetch with: doc-lookup.cjs get "${source.chub[0].id}" "${query}"`;
  }
  if (source.context7) {
    output.context7_results = source.context7;
    if (!source.chub) {
      output.recommended_source = 'context7';
      // Context7 returns different shapes — handle both
      const first = Array.isArray(source.context7) ? source.context7[0] : source.context7.results?.[0];
      if (first) {
        const c7Id = first.id || first.libraryId;
        output.recommended_id = c7Id;
        output.hint = `Fetch with: doc-lookup.cjs get "${c7Id}" "${query}" --source context7`;
      }
    }
  }

  if (!source.chub && !source.context7) {
    output.error = 'No results from either source';
    if (source.context7_error) output.context7_error = source.context7_error;
  }

  return output;
}

// ── Main: get (fetch docs) ──────────────────────────────────────────────────

async function get(idOrLibrary, query, opts = {}) {
  const forceSource = opts.source; // 'chub' | 'context7' | undefined
  const lang = opts.lang;

  // If forced to context7, skip chub
  if (forceSource === 'context7') {
    return getFromContext7(idOrLibrary, query);
  }

  // 1. Try chub first
  if (chubAvailable()) {
    // If id looks like a chub id (contains /), try direct get
    if (idOrLibrary.includes('/') && !idOrLibrary.startsWith('/')) {
      const content = chubGet(idOrLibrary, lang);
      if (content && content.trim().length > 50) {
        return {
          source: 'chub',
          id: idOrLibrary,
          content,
        };
      }
    }

    // Otherwise search chub for the library
    const results = chubSearch(idOrLibrary);
    if (results.length > 0) {
      const best = results[0];
      const bestLang = pickLang(best, lang);
      const content = chubGet(best.id, bestLang);
      if (content && content.trim().length > 50) {
        return {
          source: 'chub',
          id: best.id,
          lang: bestLang,
          content,
        };
      }
    }
  }

  // 2. Fallback to Context7
  if (forceSource === 'chub') {
    return { source: 'chub', error: `No chub docs found for "${idOrLibrary}"` };
  }

  return getFromContext7(idOrLibrary, query);
}

async function getFromContext7(libraryId, query) {
  try {
    // If it looks like a Context7 library ID (starts with /), use directly
    // Otherwise search first
    let resolvedId = libraryId;
    if (!libraryId.startsWith('/')) {
      const searchResult = await context7Request('/libs/search', {
        libraryName: libraryId,
        query,
      });
      const results = Array.isArray(searchResult) ? searchResult : searchResult?.results || [];
      if (results.length === 0) {
        return { source: 'context7', error: `No Context7 results for "${libraryId}"` };
      }
      resolvedId = results[0].id || results[0].libraryId;
    }

    const docs = await context7Request('/context', {
      libraryId: resolvedId,
      query,
      type: 'json',
    });

    return {
      source: 'context7',
      id: resolvedId,
      content: typeof docs === 'string' ? docs : JSON.stringify(docs, null, 2),
    };
  } catch (err) {
    return { source: 'context7', error: err.message };
  }
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const command = process.argv[2];
const args = process.argv.slice(3);

function parseCliOpts(args) {
  const opts = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--lang' && args[i + 1]) {
      opts.lang = args[++i];
    } else if (args[i] === '--source' && args[i + 1]) {
      opts.source = args[++i];
    } else {
      positional.push(args[i]);
    }
  }
  return { positional, opts };
}

(async () => {
  if (command === 'search') {
    const [library, ...queryParts] = args;
    const query = queryParts.join(' ');
    if (!library || !query) {
      console.error('Usage: doc-lookup.cjs search <library> <query>');
      process.exit(1);
    }
    const result = await search(library, query);
    console.log(JSON.stringify(result, null, 2));
  } else if (command === 'get' || command === 'context') {
    // 'context' alias for backward compat with context7-api.cjs
    const { positional, opts } = parseCliOpts(args);
    const [idOrLib, ...queryParts] = positional;
    const query = queryParts.join(' ');
    if (!idOrLib || !query) {
      console.error('Usage: doc-lookup.cjs get <library-or-id> <query> [--lang js|py] [--source chub|context7]');
      process.exit(1);
    }
    const result = await get(idOrLib, query, opts);
    if (result.content) {
      // If content is already a string (from chub), print directly
      // If it's an object, JSON-stringify
      if (typeof result.content === 'string') {
        console.log(`[Source: ${result.source} | ID: ${result.id}${result.lang ? ' | Lang: ' + result.lang : ''}]\n`);
        console.log(result.content);
      } else {
        console.log(JSON.stringify(result, null, 2));
      }
    } else {
      console.log(JSON.stringify(result, null, 2));
    }
  } else {
    console.error('Usage: doc-lookup.cjs <search|get> <args...>');
    console.error('  search <library> <query>         — find docs across chub + Context7');
    console.error('  get <id-or-lib> <query> [opts]   — fetch docs (chub first, Context7 fallback)');
    console.error('  context <id> <query>             — alias for get (backward compat)');
    process.exit(1);
  }
})();
