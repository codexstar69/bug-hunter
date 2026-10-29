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
const GENERATED_PATH_PATTERN = /(?:^|\/)(?:generated(?:-[^/]+)?|[^/]+\.generated)\.[^/]+$|(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.lock|Gemfile\.lock|poetry\.lock)$/i;
const GENERATED_HEADER_PATTERN = /^\s*(?:\/\/|\/\*+|\*|#|--|<!--)[^\r\n]*(?:@generated\b|\bgenerated\b[^\r\n]*(?:\bby\b|do not edit|automatically)|\b(?:auto[- ]|automatically )generated\b|do not edit[^\r\n]*\bgenerated\b)/im;
const LOW_VALUE_DIRS = new Set('docs doc documentation assets public static images img icons fonts styles css scss less locales i18n l10n translations migrations seeds fixtures snapshots __snapshots__ scripts tools devtools examples samples demo storybook .storybook stories'.split(' '));
const CRITICAL_IDENTIFIERS = new Set('auth authentication authorization security session token jwt oauth saml permission permissions acl rbac crypto secret credential password login signup register verify middleware gateway proxy server payment payments billing checkout charge subscription stripe paypal webhook callback'.split(' '));
const HIGH_IDENTIFIERS = new Set('api route routes router controller controllers handler handlers endpoint endpoints resolver service services model models schema database db repository store state queue worker job cron consumer producer cache redis mongo prisma sequelize typeorm knex sql graphql trpc grpc socket websocket sse stream upload download file storage s3 email notification sms'.split(' '));
const MEDIUM_IDENTIFIERS = new Set('util utils helper helpers lib common shared core config env logger error exception validator sanitize transform format parse convert serialize'.split(' '));
const BOUNDARY_IDENTIFIERS = {
  'external-input': new Set('api route routes router controller controllers handler handlers endpoint endpoints webhook gateway proxy server graphql trpc grpc socket websocket'.split(' ')),
  auth: new Set('auth authentication authorization security middleware session token jwt oauth saml permission permissions acl rbac login password credential'.split(' ')),
  'data-store': new Set('db database model models repository query prisma sql mongo mongodb redis sequelize typeorm knex'.split(' ')),
  'async-boundary': new Set('queue worker cron job kafka rabbitmq sqs pubsub bullmq'.split(' '))
};
const BOUNDARY_MODULES = {
  'external-input': new Set(['express', 'fastify', 'koa', 'hono', '@hapi/hapi', 'http', 'http2', 'https', 'node:http', 'node:http2', 'node:https', 'flask', 'django']),
  auth: new Set(['jsonwebtoken', 'jose', 'passport', 'express-session', 'next-auth', '@auth/core', 'bcrypt', 'bcryptjs', 'argon2']),
  'data-store': new Set(['pg', 'mysql', 'mysql2', 'sqlite3', 'better-sqlite3', '@prisma/client', 'prisma', 'mongoose', 'mongodb', 'redis', 'ioredis', 'sequelize', 'typeorm', 'knex', 'psycopg', 'psycopg2', 'sqlalchemy']),
  'async-boundary': new Set(['bull', 'bullmq', 'amqplib', 'kafkajs', '@aws-sdk/client-sqs', '@google-cloud/pubsub', 'celery'])
};

function normalizePathForMatch(filePath) {
  return String(filePath).replace(/\\/g, '/');
}

function isMinifiedSourcePath(filePath) {
  return MINIFIED_SOURCE_PATTERN.test(path.basename(String(filePath)));
}

function readShebangPrefix(filePath, length = 256) {
  const fileDescriptor = fs.openSync(filePath, 'r');
  try {
    const prefix = Buffer.alloc(length);
    const bytesRead = fs.readSync(fileDescriptor, prefix, 0, prefix.length, 0);
    return prefix.toString('utf8', 0, bytesRead);
  } finally {
    fs.closeSync(fileDescriptor);
  }
}

function isGeneratedSourceFile(filePath, content) {
  if (isMinifiedSourcePath(filePath) || GENERATED_PATH_PATTERN.test(normalizePathForMatch(filePath))) return true;
  const prefix = content === undefined ? readShebangPrefix(filePath, 2048) : String(content).slice(0, 2048);
  return GENERATED_HEADER_PATTERN.test(prefix);
}

function extractImports(content, extension) {
  const imports = new Set();
  if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(extension)) {
    const regexes = [
      /import\s+[^'"]*?from\s+['"]([^'"]+)['"]/g,
      /import\s*['"]([^'"]+)['"]/g,
      /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
      /require\(\s*['"]([^'"]+)['"]\s*\)/g,
      /export\s+[^'"]*?from\s+['"]([^'"]+)['"]/g
    ];
    for (const regex of regexes) {
      let match = regex.exec(content);
      while (match) {
        imports.add(match[1]);
        match = regex.exec(content);
      }
    }
  } else if (extension === '.py') {
    const importRegex = /^\s*import\s+([a-zA-Z0-9_\.]+)/gm;
    const fromRegex = /^\s*from\s+([a-zA-Z0-9_\.]+)\s+import\s+/gm;
    let match = importRegex.exec(content);
    while (match) {
      imports.add(match[1]);
      match = importRegex.exec(content);
    }
    match = fromRegex.exec(content);
    while (match) {
      imports.add(match[1]);
      match = fromRegex.exec(content);
    }
  }
  return [...imports];
}


function pathIdentifiers(filePath) {
  return normalizePathForMatch(filePath)
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function classifySourcePath(relativePath, importSpecifiers = []) {
  if (isTestSourcePath(relativePath)) return { riskHint: 'context-only', trustBoundaries: [] };
  const identifiers = new Set(pathIdentifiers(relativePath));
  const hasAny = (values) => [...values].some((value) => identifiers.has(value));
  const modules = new Set(importSpecifiers.filter((specifier) => !specifier.startsWith('.')).map((specifier) => {
    const parts = specifier.split('/');
    return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0].split('.')[0];
  }));
  const boundaries = new Set();
  for (const [boundary, values] of Object.entries(BOUNDARY_IDENTIFIERS)) {
    if (hasAny(values) || [...BOUNDARY_MODULES[boundary]].some((name) => modules.has(name))) boundaries.add(boundary);
  }
  // Runtime and security signals take precedence over directories such as scripts/.
  let riskHint = 'medium';
  if (hasAny(CRITICAL_IDENTIFIERS) || boundaries.has('auth')) riskHint = 'critical';
  else if (hasAny(HIGH_IDENTIFIERS) || boundaries.size > 0) riskHint = 'high';
  else if (hasAny(MEDIUM_IDENTIFIERS)) riskHint = 'medium';
  else if (normalizePathForMatch(relativePath).split('/').slice(0, -1).some((part) => LOW_VALUE_DIRS.has(part.toLowerCase()))) riskHint = 'low';
  return { riskHint, trustBoundaries: [...boundaries].sort() };
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
    return !isGeneratedSourceFile(normalizedPath);
  }
  if (extension !== '') {
    return false;
  }
  try {
    return hasSourceShebang(normalizedPath) && !isGeneratedSourceFile(normalizedPath);
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
    const fileTokens = options.tokensByFile && options.tokensByFile.has(filePath)
      ? options.tokensByFile.get(filePath)
      : estimateSourceTokens(filePath);
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
  classifySourcePath,
  estimateSourceTokens,
  extractImports,
  hasSourceShebang,
  inferSourceExtension,
  isMinifiedSourcePath,
  isGeneratedSourceFile,
  isSupportedSourceFile,
  isTestSourcePath
};
