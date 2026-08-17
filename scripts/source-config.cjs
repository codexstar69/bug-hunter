const fs = require('fs');
const path = require('path');

const SOURCE_EXTENSION_LIST = Object.freeze([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.go', '.rs', '.java', '.kt', '.rb', '.php',
  '.cs', '.cpp', '.c', '.h', '.hpp', '.swift', '.scala',
  '.ex', '.exs', '.erl', '.hs', '.ml', '.clj', '.lua'
]);

const SOURCE_EXTENSIONS = new Set(SOURCE_EXTENSION_LIST);
const DEFAULT_SOURCE_TOKEN_BUDGET = 48000;
const MAX_FILES_PER_CHUNK = 30;
const SOURCE_SHEBANG = /^#!.*\b(node|deno|bun|python(?:3)?|ruby|php|bash|sh|zsh|fish)\b/i;
const MINIFIED_SOURCE_PATTERN = /\.min\.(?:ts|tsx|js|jsx|mjs|cjs)$/i;
const TEST_DIRECTORY_PATTERN = /(?:^|\/)(?:__tests__|__test__|tests?|specs?|testing|e2e|integration|unit|cypress|playwright|jest)(?:\/|$)/i;
const TEST_FILE_PATTERN = /(?:\.(?:test|spec|e2e)\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|rb|php|cs|cpp|c|h|hpp|swift|scala|ex|exs|erl|hs|ml|clj|lua)|_test\.(?:go|py|rb)|Test\.(?:java|kt))$/i;

function normalizePathForMatch(filePath) {
  return String(filePath).replace(/\\/g, '/');
}

function isMinifiedSourcePath(filePath) {
  return MINIFIED_SOURCE_PATTERN.test(path.basename(String(filePath)));
}

function readShebangPrefix(filePath) {
  const fileDescriptor = fs.openSync(filePath, 'r');
  try {
    const prefix = Buffer.alloc(256);
    const bytesRead = fs.readSync(fileDescriptor, prefix, 0, prefix.length, 0);
    return prefix.toString('utf8', 0, bytesRead);
  } finally {
    fs.closeSync(fileDescriptor);
  }
}

function hasSourceShebang(filePath) {
  return SOURCE_SHEBANG.test(readShebangPrefix(filePath));
}

function inferSourceExtension(filePath, content) {
  const extension = path.extname(String(filePath)).toLowerCase();
  if (SOURCE_EXTENSIONS.has(extension)) {
    return extension;
  }
  const prefix = content === undefined
    ? readShebangPrefix(filePath)
    : String(content).slice(0, 256);
  const firstLine = prefix.split(/\r?\n/, 1)[0].toLowerCase();
  if (/\b(node|deno|bun)\b/.test(firstLine)) return '.js';
  if (/\bpython(?:3)?\b/.test(firstLine)) return '.py';
  if (/\bruby\b/.test(firstLine)) return '.rb';
  if (/\bphp\b/.test(firstLine)) return '.php';
  if (/\b(?:bash|sh|zsh|fish)\b/.test(firstLine)) return '.sh';
  return extension;
}

function isSupportedSourceFile(filePath) {
  const normalizedPath = String(filePath);
  if (isMinifiedSourcePath(normalizedPath)) {
    return false;
  }
  const extension = path.extname(normalizedPath).toLowerCase();
  if (SOURCE_EXTENSIONS.has(extension)) {
    return true;
  }
  if (extension !== '') {
    return false;
  }
  try {
    return hasSourceShebang(normalizedPath);
  } catch {
    return false;
  }
}

function isTestSourcePath(filePath) {
  const normalized = normalizePathForMatch(filePath);
  return TEST_DIRECTORY_PATTERN.test(normalized) || TEST_FILE_PATTERN.test(normalized);
}

function estimateSourceTokens(filePath) {
  try {
    const stat = fs.statSync(String(filePath));
    return Math.max(1, Math.ceil(stat.size / 4));
  } catch {
    return 1;
  }
}

function positiveInteger(value, fallback, label) {
  if (value === undefined || value === null) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function buildSourceChunks(files, options = {}) {
  const maxFiles = positiveInteger(
    options.maxFiles,
    MAX_FILES_PER_CHUNK,
    'maxFiles'
  );
  const maxSourceTokens = positiveInteger(
    options.maxSourceTokens,
    DEFAULT_SOURCE_TOKEN_BUDGET,
    'maxSourceTokens'
  );
  const enforceTokenBudget = options.enforceTokenBudget !== false;
  const normalizedFiles = [...new Set(
    (Array.isArray(files) ? files : []).map((filePath) => String(filePath))
  )];
  const chunks = [];
  let currentFiles = [];
  let currentTokens = 0;

  const flush = () => {
    if (currentFiles.length === 0) {
      return;
    }
    chunks.push({
      files: currentFiles,
      estimatedSourceTokens: currentTokens,
      oversized: enforceTokenBudget && currentTokens > maxSourceTokens
    });
    currentFiles = [];
    currentTokens = 0;
  };

  for (const filePath of normalizedFiles) {
    const fileTokens = estimateSourceTokens(filePath);
    const fileLimitHit = currentFiles.length >= maxFiles;
    const tokenLimitHit = enforceTokenBudget
      && currentFiles.length > 0
      && currentTokens + fileTokens > maxSourceTokens;
    if (fileLimitHit || tokenLimitHit) {
      flush();
    }
    currentFiles.push(filePath);
    currentTokens += fileTokens;
    if (currentFiles.length >= maxFiles) {
      flush();
    }
  }
  flush();
  return chunks;
}

module.exports = {
  DEFAULT_SOURCE_TOKEN_BUDGET,
  MAX_FILES_PER_CHUNK,
  SOURCE_EXTENSION_LIST,
  SOURCE_EXTENSIONS,
  buildSourceChunks,
  estimateSourceTokens,
  hasSourceShebang,
  inferSourceExtension,
  isMinifiedSourcePath,
  isSupportedSourceFile,
  isTestSourcePath
};
