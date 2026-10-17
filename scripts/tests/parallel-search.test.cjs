const assert = require('node:assert/strict');
const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { get, search } = require('../doc-lookup.cjs');
const { makeSandbox, resolveSkillScript, runRaw } = require('./test-utils.cjs');

const DOC_URL = 'https://expressjs.com/en/guide/behind-proxies.html';
const RESULTS = [{ url: DOC_URL, title: 'Express behind proxies', excerpts: ['Set trust proxy to match the deployment.'] }];

function mockMcp(t, { toolResult, sse = false, failure } = {}) {
  const calls = [];
  t.mock.method(global, 'fetch', async (url, init) => {
    assert.equal(url, 'https://search.parallel.ai/mcp');
    assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers['User-Agent'], 'BugHunter-DocLookup/3.2.0 (+https://github.com/codexstar69/bug-hunter)');
    assert.equal(init.headers.Authorization, undefined);
    const body = JSON.parse(init.body);
    calls.push(body);
    if (failure) {
      const response = await failure(body, init);
      if (response) return response;
    }
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
    let result;
    if (body.method === 'initialize') {
      assert.equal(body.params.clientInfo.name, 'bug-hunter');
      result = { protocolVersion: '2025-03-26', capabilities: {} };
    } else {
      assert.equal(init.headers['MCP-Protocol-Version'], '2025-03-26');
      assert.equal(init.headers['Mcp-Session-Id'], 'test-session');
      result = body.method === 'tools/list'
        ? { tools: [{ name: 'web_search' }, { name: 'web_fetch' }] }
        : (toolResult || { structuredContent: { results: RESULTS } });
    }
    const message = JSON.stringify({ jsonrpc: '2.0', id: body.id, result });
    const text = sse ? `: keepalive\r\n\r\ndata: ${message}\r\n\r\n` : message;
    // Split UTF-8/SSE framing across reads, including CRLF boundaries.
    const bytes = new TextEncoder().encode(text);
    return new Response(new ReadableStream({ start(controller) {
      for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.slice(i, i + 3));
      controller.close();
    } }), { headers: { 'content-type': sse ? 'text/event-stream' : 'application/json', 'mcp-session-id': 'test-session' } });
  });
  return calls;
}

test('normal resolver searches anonymously and exposes cited results and fetch choice', async (t) => {
  const calls = mockMcp(t);
  const result = await search('express', 'trust proxy req.ip', { source: 'parallel' });
  assert.equal(result.recommended_source, 'parallel');
  assert.equal(result.recommended_id, DOC_URL);
  assert.deepEqual(result.parallel_results, RESULTS);
  assert.match(result.hint, /--source parallel$/);
  assert.deepEqual(calls.map((call) => call.method), ['initialize', 'notifications/initialized', 'tools/list', 'tools/call']);
  assert.deepEqual(calls[3].params, { name: 'web_search', arguments: {
    objective: 'Find authoritative documentation for express: trust proxy req.ip', search_queries: ['express trust proxy req.ip']
  } });
});

test('normal resolver consumes page excerpts and handles SSE and text MCP results', async (t) => {
  const calls = mockMcp(t, { sse: true, toolResult: { content: [{ type: 'text', text: JSON.stringify({ results: RESULTS }) }] } });
  const result = await get(DOC_URL, 'trust proxy', { source: 'parallel' });
  assert.equal(result.source, 'parallel');
  assert.match(result.content, /Set trust proxy/);
  assert.ok(result.content.includes(DOC_URL));
  assert.deepEqual(calls[3].params, { name: 'web_fetch', arguments: { urls: [DOC_URL], objective: 'trust proxy' } });
});

test('library get consumes search excerpts without fetching every result', async (t) => {
  const calls = mockMcp(t);
  assert.match((await get('express', 'trust proxy', { source: 'parallel' })).content, /Express behind proxies/);
  assert.equal(calls.filter((call) => call.method === 'tools/call').length, 1);
  assert.equal(calls[3].params.name, 'web_search');
});

test('explicit failures, empty results and malformed responses fail without fallback', async (t) => {
  for (const fixture of [
    { failure: async () => new Response('quota', { status: 429 }) },
    { failure: async () => new Response('{bad json') },
    { failure: async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 999, result: {} })) },
    { toolResult: { isError: true, content: [{ type: 'text', text: 'failed' }] } },
    { toolResult: { structuredContent: { results: [] } } },
    { toolResult: { structuredContent: { results: [{ url: 'javascript:alert(1)', excerpts: ['bad'] }] } } }
  ]) {
    await t.test(JSON.stringify(fixture), async (t) => {
      mockMcp(t, fixture);
      t.mock.method(https, 'get', () => { throw new Error('Unexpected Context7 fallback'); });
      const result = await get('express', 'trust proxy', { source: 'parallel' });
      assert.equal(result.source, 'parallel');
      assert.ok(result.error);
      assert.equal(result.content, undefined);
    });
  }
});

test('cancellation and total deadline reach the actual request', async (t) => {
  for (const timeout of [false, true]) {
    await t.test(timeout ? 'deadline' : 'caller cancellation', async (t) => {
      const controller = new AbortController();
      if (timeout) t.mock.method(AbortSignal, 'timeout', () => controller.signal);
      mockMcp(t, { failure: async (body, init) => new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
        setTimeout(() => controller.abort(new Error(timeout ? 'test timeout' : 'test cancellation')), 5);
      }) });
      const result = await get('express', 'trust proxy', { source: 'parallel', ...(timeout ? {} : { signal: controller.signal }) });
      assert.match(result.error, timeout ? /timeout/ : /cancellation/);
    });
  }
});

test('response output limit and invalid URLs fail closed', async (t) => {
  mockMcp(t, { failure: async () => new Response('x'.repeat(1024 * 1024 + 1)) });
  assert.match((await get('express', 'trust proxy', { source: 'parallel' })).error, /exceeded/);
  for (const url of ['file:///etc/passwd', 'https://user:secret@example.com', 'https://[invalid']) {
    assert.ok((await get(url, 'question', { source: 'parallel' })).error);
  }
});

test('disabled, unknown, and cancelled source selections make no request', async (t) => {
  const calls = mockMcp(t);
  const controller = new AbortController();
  controller.abort(new Error('already cancelled'));
  for (const source of ['none', 'unknown']) {
    assert.ok((await search('express', 'query', { source })).error);
    assert.ok((await get('express', 'query', { source })).error);
  }
  assert.match((await get('express', 'query', { source: 'parallel', signal: controller.signal })).error, /already cancelled/);
  assert.equal(calls.length, 0);
});

test('default and explicit Context7 selection retain result consumption', async (t) => {
  const calls = mockMcp(t);
  const requests = [];
  t.mock.method(https, 'get', (url, options, callback) => {
    requests.push({ url, options });
    const req = new EventEmitter();
    req.setTimeout = () => {};
    process.nextTick(() => {
      const res = new EventEmitter(); res.statusCode = 200;
      callback(res);
      res.emit('data', Buffer.from(JSON.stringify({ docs: 'original Context7 docs' })));
      res.emit('end');
    });
    return req;
  });
  assert.match((await get('/websites/expressjs', 'trust proxy')).content, /original Context7 docs/);
  assert.match((await get('/websites/expressjs', 'trust proxy', { source: 'context7' })).content, /original Context7 docs/);
  assert.equal(calls.length, 0);
  assert.equal(requests.length, 2);
  assert.ok(requests.every(({ url }) => url.startsWith('https://context7.com/api/v2/context?')));
});

test('cancellation while reading a response aborts without returning partial evidence', async (t) => {
  const controller = new AbortController();
  mockMcp(t, { failure: async (body, init) => {
    if (body.method !== 'tools/call') return;
    return new Response(new ReadableStream({ start(stream) {
      stream.enqueue(new TextEncoder().encode('{"jsonrpc":"2.0",'));
      init.signal.addEventListener('abort', () => stream.error(init.signal.reason), { once: true });
      setTimeout(() => controller.abort(new Error('cancelled body')), 5);
    } }));
  } });
  const result = await get('express', 'trust proxy', { source: 'parallel', signal: controller.signal });
  assert.match(result.error, /cancelled body/);
  assert.equal(result.content, undefined);
});

test('existing Context7 key is retained for default and forced source without reaching Parallel', () => {
  const sandbox = makeSandbox('context7-credentials-');
  const preload = path.join(sandbox, 'context7-fixture.cjs');
  fs.writeFileSync(preload, `
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
global.fetch = () => { throw new Error('Unexpected Parallel request'); };
require('node:child_process').execFileSync = () => { throw new Error('chub absent'); };
require('node:https').get = (url, options, callback) => {
  assert.equal(options.headers.Authorization, 'Bearer saved-test-key');
  assert.ok(url.startsWith('https://context7.com/api/v2/context?'));
  const req = new EventEmitter(); req.setTimeout = () => {};
  process.nextTick(() => {
    const res = new EventEmitter(); res.statusCode = 200; callback(res);
    res.emit('data', Buffer.from('{"docs":"saved provider content"}')); res.emit('end');
  });
  return req;
};`);
  for (const flags of [[], ['--source', 'context7']]) {
    const result = runRaw(process.execPath, ['--require', preload, resolveSkillScript('doc-lookup.cjs'), 'get', '/websites/expressjs', 'trust proxy', ...flags], {
      env: { ...process.env, CONTEXT7_API_KEY: 'saved-test-key' }
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /saved provider content/);
  }
});

test('CLI selects Parallel, renders citations, and reports disabled/missing sources', () => {
  const sandbox = makeSandbox('parallel-cli-');
  const preload = path.join(sandbox, 'mcp-fixture.cjs');
  fs.writeFileSync(preload, `
const assert = require('node:assert/strict');
global.fetch = async (url, init) => {
  assert.equal(url, 'https://search.parallel.ai/mcp');
  assert.match(init.headers['User-Agent'], /^BugHunter-DocLookup/);
  const m = JSON.parse(init.body);
  if (m.method === 'notifications/initialized') return new Response(null, {status:202});
  const result = m.method === 'initialize' ? {protocolVersion:'2025-03-26'}
    : m.method === 'tools/list' ? {tools:[{name:'web_search'},{name:'web_fetch'}]}
    : {structuredContent:{results:${JSON.stringify(RESULTS)}}};
  return new Response(JSON.stringify({jsonrpc:'2.0',id:m.id,result}));
};`);
  const script = resolveSkillScript('doc-lookup.cjs');
  for (const command of ['search', 'get', 'context']) {
    const result = runRaw(process.execPath, ['--require', preload, script, command, 'express', 'trust proxy', '--source', 'parallel']);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes(DOC_URL));
    assert.match(result.stdout, /Set trust proxy/);
  }
  for (const args of [['--source', 'none'], ['--source'], ['--source', 'typo']]) {
    const result = runRaw(process.execPath, [script, 'search', 'express', 'trust proxy', ...args]);
    assert.equal(result.status, 1);
    assert.match(result.stdout + result.stderr, /disabled|requires|Unknown/);
  }
});
