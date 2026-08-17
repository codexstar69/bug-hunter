const SOURCE_EXTENSION_LIST = Object.freeze([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.go', '.rs', '.java', '.kt', '.rb', '.php',
  '.cs', '.cpp', '.c', '.h', '.hpp', '.swift', '.scala',
  '.ex', '.exs', '.erl', '.hs', '.ml', '.clj', '.lua'
]);

const SOURCE_EXTENSIONS = new Set(SOURCE_EXTENSION_LIST);
const DEFAULT_SOURCE_TOKEN_BUDGET = 48000;
const MAX_FILES_PER_CHUNK = 30;

module.exports = {
  DEFAULT_SOURCE_TOKEN_BUDGET,
  MAX_FILES_PER_CHUNK,
  SOURCE_EXTENSION_LIST,
  SOURCE_EXTENSIONS
};
