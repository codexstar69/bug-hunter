// Anonymous Parallel Search MCP over Streamable HTTP. No host configuration or
// credentials are read: callers must explicitly select this documentation source.
const MCP_URL = 'https://search.parallel.ai/mcp';
const USER_AGENT = 'BugHunter-DocLookup/3.2.0 (+https://github.com/codexstar69/bug-hunter)';
const TIMEOUT_MS = 15000;
const MAX_RESPONSE_BYTES = 1024 * 1024;

async function readResponse(response, id) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Parallel MCP returned an empty response');
  const decoder = new TextDecoder();
  const sse = response.headers.get('content-type')?.includes('text/event-stream');
  let bytes = 0;
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      bytes += value?.byteLength || 0;
      if (bytes > MAX_RESPONSE_BYTES) throw new Error('Parallel MCP response exceeded 1048576 bytes');
      buffer += decoder.decode(value, { stream: !done });
      if (sse) {
        buffer = buffer.replace(/\r\n/g, '\n');
        let boundary;
        while ((boundary = buffer.indexOf('\n\n')) !== -1) {
          const event = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = event.split('\n').filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).replace(/^ /, '')).join('\n');
          if (data) {
            const message = JSON.parse(data);
            if (message.id === id) return message;
          }
        }
      }
      if (done) break;
    }
    if (sse) throw new Error('Parallel MCP stream ended without a matching response');
    return JSON.parse(buffer);
  } finally {
    await reader.cancel().catch(() => {});
  }
}

async function callTool(name, args, opts = {}) {
  // One deadline bounds initialization, discovery and execution together. The
  // caller's cancellation signal also reaches every request and response reader.
  const signal = AbortSignal.any([AbortSignal.timeout(TIMEOUT_MS), ...(opts.signal ? [opts.signal] : [])]);
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'User-Agent': USER_AGENT
  };
  let sequence = 0;
  async function rpc(method, params, notification = false) {
    signal.throwIfAborted();
    const id = notification ? undefined : ++sequence;
    const response = await fetch(MCP_URL, {
      method: 'POST', headers, signal, redirect: 'error',
      body: JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id }), method, ...(params ? { params } : {}) })
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Parallel MCP HTTP ${response.status}`);
    }
    const session = response.headers.get('mcp-session-id');
    if (session) headers['Mcp-Session-Id'] = session;
    if (notification) {
      await response.body?.cancel();
      return;
    }
    const message = await readResponse(response, id);
    if (message.jsonrpc !== '2.0' || message.id !== id) throw new Error('Invalid Parallel MCP response');
    if (message.error) throw new Error(`Parallel MCP: ${message.error.message || 'request failed'}`);
    if (!message.result || typeof message.result !== 'object') throw new Error('Missing Parallel MCP result');
    return message.result;
  }
  const initialized = await rpc('initialize', {
    protocolVersion: '2025-03-26', capabilities: {},
    clientInfo: { name: 'bug-hunter', version: '3.2.0' }
  });
  if (!['2025-03-26', '2025-06-18', '2025-11-25'].includes(initialized.protocolVersion)) {
    throw new Error('Unsupported Parallel MCP protocol version');
  }
  headers['MCP-Protocol-Version'] = initialized.protocolVersion;
  await rpc('notifications/initialized', null, true);
  const listing = await rpc('tools/list', {});
  if (!listing.tools?.some((tool) => tool.name === name)) throw new Error(`Parallel MCP tool unavailable: ${name}`);
  const result = await rpc('tools/call', { name, arguments: args });
  if (result.isError) throw new Error('Parallel MCP tool returned an error');
  const data = result.structuredContent || JSON.parse(
    (result.content || []).filter((item) => item.type === 'text').map((item) => item.text).join('\n')
  );
  if (!Array.isArray(data.results)) throw new Error('Invalid Parallel documentation results');
  return data.results.filter((item) => {
    try {
      const url = new URL(item.url);
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
        && Array.isArray(item.excerpts) && item.excerpts.every((text) => typeof text === 'string');
    } catch {
      return false;
    }
  }).map(({ url, title, excerpts }) => ({ url, title: typeof title === 'string' ? title : url, excerpts }));
}

async function search(library, query, opts = {}) {
  return callTool('web_search', {
    objective: `Find authoritative documentation for ${library}: ${query}`,
    search_queries: [`${library} ${query}`]
  }, opts);
}

async function get(idOrLibrary, query, opts = {}) {
  let results;
  if (/^[a-z][a-z0-9+.-]*:/i.test(idOrLibrary)) {
    const url = new URL(idOrLibrary);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
      throw new Error('Parallel documentation URL must use HTTP(S) without credentials');
    }
    results = await callTool('web_fetch', { urls: [url.href], objective: query.slice(0, 200) }, opts);
  } else {
    // Search excerpts often answer the claim directly; do not fetch every result.
    results = await search(idOrLibrary, query, opts);
  }
  const content = results.filter((item) => item.excerpts.some((text) => text.trim()))
    .map((item) => `${item.title}\n${item.url}\n\n${item.excerpts.join('\n\n')}`).join('\n\n');
  if (!content) throw new Error('No Parallel documentation excerpts found');
  return { source: 'parallel', id: idOrLibrary, content };
}

module.exports = { get, search };
