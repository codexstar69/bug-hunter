const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_KILL_GRACE_MS = 1000;
const DEFAULT_TIMEOUT_MS = 120000;

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function nowIso() {
  return new Date().toISOString();
}

function appendJournal(logPath, event) {
  ensureDir(path.dirname(logPath));
  const line = JSON.stringify({ at: nowIso(), ...event });
  fs.appendFileSync(logPath, `${line}\n`, 'utf8');
}

function runJsonScript(scriptPath, args) {
  const result = childProcess.spawnSync('node', [scriptPath, ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    maxBuffer: DEFAULT_MAX_OUTPUT_BYTES,
    timeout: DEFAULT_TIMEOUT_MS
  });
  if (result.error) {
    throw new Error(`Script failed: ${scriptPath}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = (result.stderr || '').trim();
    const stdout = (result.stdout || '').trim();
    throw new Error(stderr || stdout || `Script failed: ${scriptPath}`);
  }
  const output = (result.stdout || '').trim();
  if (!output) {
    return {};
  }
  return JSON.parse(output);
}

function runTextScript(scriptPath, args) {
  const result = childProcess.spawnSync('node', [scriptPath, ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    maxBuffer: DEFAULT_MAX_OUTPUT_BYTES,
    timeout: DEFAULT_TIMEOUT_MS
  });
  if (result.error) {
    throw new Error(`Script failed: ${scriptPath}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = (result.stderr || '').trim();
    const stdout = (result.stdout || '').trim();
    throw new Error(stderr || stdout || `Script failed: ${scriptPath}`);
  }
  return result.stdout || '';
}

function shellQuote(value) {
  const stringValue = String(value);
  if (stringValue.length === 0) {
    return "''";
  }
  return `'${stringValue.replace(/'/g, `'\\''`)}'`;
}

function fillTemplate(template, variables) {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, key) => {
    if (!(key in variables)) {
      throw new Error(`Unknown template placeholder: ${key}`);
    }
    return shellQuote(variables[key]);
  });
}

function parseCommand(command) {
  const tokens = [];
  let current = '';
  let quote = null;
  let escaped = false;
  let tokenStarted = false;

  for (const character of String(command)) {
    if (escaped) {
      current += character;
      escaped = false;
      tokenStarted = true;
      continue;
    }
    if (character === '\\' && quote !== "'") {
      escaped = true;
      tokenStarted = true;
      continue;
    }
    if (quote) {
      if (character === quote) {
        quote = null;
      } else {
        current += character;
      }
      tokenStarted = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      tokenStarted = true;
      continue;
    }
    if (/\s/.test(character)) {
      if (tokenStarted) {
        tokens.push(current);
        current = '';
        tokenStarted = false;
      }
      continue;
    }
    current += character;
    tokenStarted = true;
  }

  if (escaped || quote) {
    throw new Error('Worker command contains an incomplete escape or quote');
  }
  if (tokenStarted) {
    tokens.push(current);
  }
  if (tokens.length === 0 || !tokens[0]) {
    throw new Error('Worker command must name an executable');
  }
  return {
    executable: tokens[0],
    args: tokens.slice(1)
  };
}

function sendProcessTreeSignal(child, signal) {
  if (!child.pid) {
    return;
  }
  try {
    if (process.platform === 'win32') {
      child.kill(signal);
      return;
    }
    process.kill(-child.pid, signal);
  } catch (error) {
    if (!error || error.code !== 'ESRCH') {
      throw error;
    }
  }
}

function runCommandOnce({
  command,
  timeoutMs,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
  killGraceMs = DEFAULT_KILL_GRACE_MS
}) {
  return new Promise((resolve) => {
    let commandSpec;
    try {
      commandSpec = parseCommand(command);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      resolve({
        ok: false,
        code: null,
        signal: null,
        timeoutHit: false,
        outputLimitHit: false,
        stdout: '',
        stderr: message,
        spawnError: true
      });
      return;
    }

    const child = childProcess.spawn(commandSpec.executable, commandSpec.args, {
      cwd: process.cwd(),
      detached: process.platform !== 'win32',
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let timeoutHit = false;
    let outputLimitHit = false;
    let spawnError = null;
    let settled = false;
    let terminationStarted = false;
    let killTimer = null;
    let pendingClose = null;

    const settle = ({ code, signal }) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (killTimer) {
        clearTimeout(killTimer);
      }
      const errorMessage = (() => {
        if (spawnError) {
          return spawnError.message;
        }
        if (outputLimitHit) {
          return `Worker output exceeded ${maxOutputBytes} bytes`;
        }
        if (timeoutHit) {
          return `Worker timed out after ${timeoutMs}ms`;
        }
        return stderr.trim();
      })();
      resolve({
        ok: code === 0 && !timeoutHit && !outputLimitHit && !spawnError,
        code,
        signal: signal || null,
        timeoutHit,
        outputLimitHit,
        stdout: stdout.trim(),
        stderr: errorMessage,
        spawnError: Boolean(spawnError)
      });
    };

    const terminate = () => {
      if (terminationStarted) {
        return;
      }
      terminationStarted = true;
      try {
        sendProcessTreeSignal(child, 'SIGTERM');
      } catch (error) {
        spawnError = error instanceof Error ? error : new Error(String(error));
      }
      killTimer = setTimeout(() => {
        try {
          sendProcessTreeSignal(child, 'SIGKILL');
        } catch (error) {
          spawnError = error instanceof Error ? error : new Error(String(error));
        }
        killTimer = null;
        if (pendingClose) {
          const closeResult = pendingClose;
          pendingClose = null;
          setTimeout(() => {
            settle(closeResult);
          }, 25);
        }
      }, killGraceMs);
    };

    const timer = setTimeout(() => {
      timeoutHit = true;
      terminate();
    }, timeoutMs);

    const capture = ({ chunk, target }) => {
      if (outputLimitHit) {
        return;
      }
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = Math.max(0, maxOutputBytes - outputBytes);
      const kept = buffer.subarray(0, remaining).toString();
      outputBytes += Math.min(buffer.length, remaining);
      if (target === 'stdout') {
        stdout += kept;
      } else {
        stderr += kept;
      }
      if (buffer.length > remaining) {
        outputLimitHit = true;
        terminate();
      }
    };

    child.stdout.on('data', (chunk) => {
      capture({ chunk, target: 'stdout' });
    });
    child.stderr.on('data', (chunk) => {
      capture({ chunk, target: 'stderr' });
    });
    child.once('error', (error) => {
      spawnError = error;
      settle({ code: null, signal: null });
    });
    child.once('close', (code, signal) => {
      if (terminationStarted && killTimer) {
        pendingClose = { code, signal };
        return;
      }
      settle({ code, signal });
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runWithRetry({
  command,
  timeoutMs,
  maxRetries,
  backoffMs,
  journalPath,
  phase,
  chunkId,
  beforeAttempt,
  postAttempt,
  maxOutputBytes,
  killGraceMs
}) {
  const attempts = maxRetries + 1;
  let lastResult = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    appendJournal(journalPath, {
      event: 'attempt-start',
      phase,
      chunkId,
      attempt,
      attempts,
      timeoutMs
    });
    if (typeof beforeAttempt === 'function') {
      await beforeAttempt({ attempt });
    }
    const result = await runCommandOnce({
      command,
      timeoutMs,
      maxOutputBytes,
      killGraceMs
    });
    let finalResult = result;

    if (finalResult.ok && typeof postAttempt === 'function') {
      const postAttemptResult = await postAttempt({ attempt });
      if (!postAttemptResult.ok) {
        const validationMessage = String(postAttemptResult.errorMessage || 'post-attempt validation failed');
        appendJournal(journalPath, {
          event: 'attempt-post-check-failed',
          phase,
          chunkId,
          attempt,
          errorMessage: validationMessage.slice(0, 500)
        });
        finalResult = {
          ...finalResult,
          ok: false,
          stderr: validationMessage
        };
      }
    }

    appendJournal(journalPath, {
      event: 'attempt-end',
      phase,
      chunkId,
      attempt,
      ok: finalResult.ok,
      code: finalResult.code,
      signal: finalResult.signal,
      timeoutHit: finalResult.timeoutHit,
      outputLimitHit: finalResult.outputLimitHit,
      stderr: finalResult.stderr.slice(0, 500)
    });

    lastResult = finalResult;
    if (finalResult.ok) {
      return { ok: true, result: finalResult, attemptsUsed: attempt };
    }
    if (attempt < attempts) {
      const delayMs = backoffMs * 2 ** (attempt - 1);
      appendJournal(journalPath, {
        event: 'retry-backoff',
        phase,
        chunkId,
        attempt,
        delayMs
      });
      await sleep(delayMs);
    }
  }

  return {
    ok: false,
    result: lastResult,
    attemptsUsed: attempts
  };
}

module.exports = {
  DEFAULT_KILL_GRACE_MS,
  DEFAULT_MAX_OUTPUT_BYTES,
  appendJournal,
  fillTemplate,
  parseCommand,
  runCommandOnce,
  runJsonScript,
  runTextScript,
  runWithRetry
};
