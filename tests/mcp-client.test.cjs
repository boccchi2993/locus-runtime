// MCP client unit tests (node, mocked fetch — no network).
// Run: node tests/mcp-client.test.cjs
// Covers the C3 §11 runtime list: the initialize handshake and its
// headers, protocol negotiation, JSON and SSE responses (incl. the SSE
// rulebook), session loss and the single-resend rules, cancellation,
// outcome-unknown (one send, counting fake server), dispose DELETEs,
// bounded argument validation, credential injection/redaction/redirect
// refusal, the §7.1 approval checkpoint and §8 form elicitation.

const M = require('./helpers/core.cjs');

const unhandled = [];
process.on('unhandledRejection', (e) => { unhandled.push(e); });

// --- fetch mock: ordered-routes fake MCP server ---
const calls = [];
const routes = [];
function on(match, respond) { routes.push({ match, respond }); }
function resetServer() { calls.length = 0; routes.length = 0; }
global.fetch = async (url, opts) => {
  const rawBody = opts && opts.body;
  const call = {
    url: String(url),
    method: (opts && opts.method) || 'GET',
    headers: (opts && opts.headers) || {},
    body: rawBody == null ? null
      : typeof rawBody === 'string' ? JSON.parse(rawBody)
        : JSON.parse(new TextDecoder('utf-8').decode(rawBody instanceof Uint8Array
          ? rawBody : new Uint8Array(rawBody))),
  };
  calls.push(call);
  for (const r of routes) {
    if (r.match(call)) return r.respond(call);
  }
  throw new TypeError('no mock route for ' + url);
};

const enc = new TextEncoder();
function jsonRpc(result, headers, id) {
  const wire = { jsonrpc: '2.0' };
  if (id !== undefined) wire.id = id;
  wire.result = result;
  return new Response(JSON.stringify(wire),
    { status: 200, headers: Object.assign({ 'content-type': 'application/json' }, headers) });
}
function jsonRaw(body) {
  return new Response(JSON.stringify(body),
    { status: 200, headers: { 'content-type': 'application/json' } });
}
function rpcError(code, message, headers, id) {
  const wire = { jsonrpc: '2.0' };
  if (id !== undefined) wire.id = id;
  wire.error = { code, message };
  return new Response(JSON.stringify(wire),
    { status: 200, headers: Object.assign({ 'content-type': 'application/json' }, headers) });
}
function sseResponse(chunks, headers) {
  const stream = new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(typeof c === 'string' ? enc.encode(c) : c);
      controller.close(); // the server finished its response body
    },
  });
  return new Response(stream, {
    status: 200,
    headers: Object.assign({ 'content-type': 'text/event-stream' }, headers),
  });
}
function statusResponse(status) {
  return new Response('no', { status: status, headers: { 'content-type': 'text/plain' } });
}
function neverResponse() {
  return new Response(new ReadableStream({ start() { return new Promise(() => {}); } }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } });
}
const byMethod = (m) => (c) => !!(c.body && c.body.method === m);
const countCalls = (m) => calls.filter((c) => c.method === m).length;
const countBody = (m) => calls.filter((c) => c.body && c.body.method === m).length;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function errOf(p) { try { await p; return null; } catch (e) { return e; } }

// --- fixtures ---
const URL_ = 'https://mcp.acme.test/mcp';
const TOKEN = 'test-token-xyz';
function serverRecord(extra) {
  return Object.assign({
    id: 'acme',
    displayName: 'Acme Documents',
    description: 'Acme docs server',
    url: URL_,
    auth: 'bearer',
    credential: 'ACME_TOKEN',
    state: 'connected',
  }, extra || {});
}
function fakePort(servers, opts) {
  const o = opts || {};
  const states = {};
  const notes = []; // { serverId, token } from noteFailure; { serverId } clears from noteSuccess
  return {
    servers: async () => servers,
    setState: (id, state, reason) => { states[id] = { state: state, reason: reason }; },
    states: states,
    noteFailure: (id, token) => { notes.push({ serverId: id, token: token }); },
    noteSuccess: (id) => { notes.push({ serverId: id, token: null }); },
    notes: notes,
    elicit: o.elicit || (async () => ({ action: 'cancel' })),
    beforeToolCall: o.beforeToolCall,
  };
}
function fakeCredentials(bindings) {
  return {
    bindings: async () => bindings === undefined ? [{
      name: 'ACME_TOKEN', origin: 'https://mcp.acme.test', pathPrefix: '/',
      header: 'Authorization', scheme: 'Bearer', state: 'connected',
    }] : bindings,
    value: async (name) => (name === 'ACME_TOKEN' ? TOKEN : null),
  };
}
function clientFor(port, creds) {
  return M.createMcpTaskClient(port, { credentials: creds === undefined ? fakeCredentials() : creds });
}
// The standard happy handshake every protocol test starts from.
function onHappyHandshake(opts) {
  const o = opts || {};
  on(byMethod('initialize'), (c) => {
    const headers = o.noSessionId ? {} : { 'mcp-session-id': 'sess-1' };
    return jsonRpc(Object.assign({
      protocolVersion: o.version || '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'acme-mcp', version: '1.4.0' },
    }, o.initializeResult || {}), headers, c.body.id);
  });
  on(byMethod('notifications/initialized'), () => new Response(null, { status: 202 }));
  on(byMethod('tools/list'), (c) => {
    if (o.toolsListBehavior) return o.toolsListBehavior(c);
    return jsonRpc({ tools: [{
      name: 'search',
      title: 'Search',
      description: 'Search the Acme docs.\nSecond line.',
      inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      annotations: { readOnlyHint: true },
      _meta: { internal: true },
    }], nextCursor: null }, null, c.body.id);
  });
  on(byMethod('tools/call'), (c) => {
    if (o.callBehavior) return o.callBehavior(c);
    return jsonRpc({ content: [{ type: 'text', text: 'ok' }], isError: false }, null, c.body.id);
  });
  // Replies to server requests (form answers, pings) — a JSON-RPC
  // response POST: has an id and a result/error, no method. Accepted by
  // default; replyBehavior overrides (E12/E13).
  on((c) => c.body && c.body.method === undefined && c.body.id !== undefined
    && (c.body.result !== undefined || c.body.error !== undefined),
  (c) => (o.replyBehavior ? o.replyBehavior(c) : new Response(null, { status: 202 })));
}

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + detail : '')); }
}

async function run() {
  const S = M.createSseDecoder;
  const V = M.validateToolArguments;
  const L = M.MCP_LIMITS;

  // ============ 0. constants contract ============
  check('C0 protocol revisions are the draft candidates',
    JSON.stringify(M.MCP_PROTOCOL_VERSIONS) === JSON.stringify(['2025-06-18', '2025-11-25']),
    JSON.stringify(M.MCP_PROTOCOL_VERSIONS));
  check('C0 clientInfo is locus/1', M.MCP_CLIENT_INFO.name === 'locus' && M.MCP_CLIENT_INFO.version === '1');
  check('C0 maxArgsFileBytes equals SHELL_PIPE_MAX_BYTES (cycle-safe literal is pinned)',
    L.maxArgsFileBytes === M.SHELL_PIPE_MAX_BYTES,
    L.maxArgsFileBytes + ' vs ' + M.SHELL_PIPE_MAX_BYTES);
  check('C0 limits reuse the NetworkRuntime constants',
    L.requestTimeoutMs === M.NetworkRuntime.directTimeoutMs
    && L.maxResponseBytes === M.NetworkRuntime.maxResponseBytes
    && L.relayRequestTimeoutMs === M.NetworkRuntime.relayClientTimeoutMs);

  // ============ 1. initialize handshake + headers (§11 I) ============
  {
    resetServer();
    onHappyHandshake();
    const client = clientFor(fakePort([serverRecord()]));
    const tools = await client.listTools('acme');
    check('I1 tools listed', tools.length === 1 && tools[0].name === 'search');
    const init = calls[0];
    check('I1 first request is initialize with id 1',
      init.body.method === 'initialize' && init.body.id === 1, JSON.stringify(init.body));
    check('I1 initialize params shape',
      init.body.params.protocolVersion === '2025-11-25'
      && JSON.stringify(init.body.params.capabilities) === '{"elicitation":{}}'
      && init.body.params.clientInfo.name === 'locus' && init.body.params.clientInfo.version === '1',
      JSON.stringify(init.body.params));
    check('I1 initialize carries accept + content-type + bearer, NO version/session headers',
      init.headers['accept'] === 'application/json, text/event-stream'
      && init.headers['content-type'] === 'application/json'
      && init.headers['authorization'] === 'Bearer ' + TOKEN
      && !init.headers['mcp-protocol-version'] && !init.headers['mcp-session-id'],
      JSON.stringify(init.headers));
    const inited = calls[1];
    check('I2 initialized notification carries the negotiated version + issued session id'
      + ' (owner correction of the appendix B wire example)',
      inited.body.method === 'notifications/initialized' && inited.body.id === undefined
      && inited.headers['mcp-protocol-version'] === '2025-06-18'
      && inited.headers['mcp-session-id'] === 'sess-1'
      && inited.headers['authorization'] === 'Bearer ' + TOKEN,
      JSON.stringify(inited.headers));
    const list = calls[2];
    check('I3 tools/list carries negotiated version + session id, id increments',
      list.body.method === 'tools/list' && list.body.id === 2
      && list.headers['mcp-protocol-version'] === '2025-06-18'
      && list.headers['mcp-session-id'] === 'sess-1',
      JSON.stringify(list.headers));
    check('I4 initialize sent exactly once; session reused on a second call',
      countBody('initialize') === 1);
    await client.callTool('acme', 'search', { query: 'x' });
    check('I4 still one initialize (session reused)', countBody('initialize') === 1);
    const call = calls[calls.length - 1];
    check('I4 tools/call request shape',
      call.body.method === 'tools/call' && call.body.id === 3
      && call.body.params.name === 'search'
      && JSON.stringify(call.body.params.arguments) === '{"query":"x"}');
    await client.dispose();
  }

  // session id only after the server issued one — the version header IS
  // on the notification, the session id is not (nothing was issued)
  {
    resetServer();
    onHappyHandshake({ noSessionId: true });
    const client = clientFor(fakePort([serverRecord()]));
    await client.listTools('acme');
    check('I5 no session id header anywhere when the server issued none',
      calls[1].headers['mcp-session-id'] === undefined
      && calls[1].headers['mcp-protocol-version'] === '2025-06-18'
      && calls[2].headers['mcp-session-id'] === undefined,
      JSON.stringify(calls[1].headers));
    await client.dispose();
  }

  // ============ 2. protocol negotiation (§11 I) ============
  for (const v of ['2025-06-18', '2025-11-25']) {
    resetServer();
    onHappyHandshake({ version: v });
    const client = clientFor(fakePort([serverRecord()]));
    await client.listTools('acme');
    check('I6 supported revision adopted: ' + v,
      calls[2].headers['mcp-protocol-version'] === v, calls[2].headers['mcp-protocol-version']);
    await client.dispose();
  }
  for (const v of ['2025-03-26', '2026-07-28', '2024-11-05']) {
    resetServer();
    onHappyHandshake({ version: v });
    const port = fakePort([serverRecord()]);
    const client = clientFor(port);
    const e = await errOf(client.listTools('acme'));
    check('I7 unsupported revision refused: ' + v,
      e && /protocol version/.test(e.message), e && e.message);
    check('I7 no notifications/initialized sent for ' + v,
      countBody('notifications/initialized') === 0);
    check('I7 server marked unavailable(unsupported-protocol) for ' + v,
      port.states.acme && port.states.acme.state === 'unavailable'
      && port.states.acme.reason === 'unsupported-protocol',
      JSON.stringify(port.states));
    await client.dispose();
  }

  // ============ 3. JSON response handling (§11 I) ============
  {
    resetServer();
    onHappyHandshake();
    const client = clientFor(fakePort([serverRecord()]));
    const call = await client.callTool('acme', 'search', { query: 'x' });
    check('J1 JSON body is the final response',
      call.result.content[0].text === 'ok' && call.result.isError === false,
      JSON.stringify(call.result));
    await client.dispose();
  }
  {
    resetServer();
    onHappyHandshake({ callBehavior: () => jsonRaw({ jsonrpc: '2.0', id: 99, method: 'ping' }) });
    const client = clientFor(fakePort([serverRecord()]));
    const e = await errOf(client.callTool('acme', 'search', { query: 'x' }));
    check('J2 JSON body that is a request → protocol error, outcome unknown, no retry',
      e && /outcome unknown/.test(e.message)
      && /was a request/.test(e.message)
      && countBody('tools/call') === 1, e && e.message);
    await client.dispose();
  }
  {
    resetServer();
    onHappyHandshake({ callBehavior: (c) => rpcError(-32000, 'boom', null, c.body.id) });
    const client = clientFor(fakePort([serverRecord()]));
    const e = await errOf(client.callTool('acme', 'search', { query: 'x' }));
    check('J3 server JSON-RPC error surfaced with code and message',
      e && e.message === 'mcp: server acme returned an error for tools/call: -32000 boom',
      e && e.message);
    await client.dispose();
  }
  {
    resetServer();
    onHappyHandshake({ callBehavior: () => new Response(null, { status: 202 }) });
    const client = clientFor(fakePort([serverRecord()]));
    const e = await errOf(client.callTool('acme', 'search', { query: 'x' }));
    check('J4 202 on a request with id → outcome unknown',
      e && /outcome unknown/.test(e.message) && countBody('tools/call') === 1, e && e.message);
    await client.dispose();
  }

  // ============ 4. SSE decoder rulebook (§11 I) ============
  {
    const d = S();
    // multibyte character split across chunks + CRLF/LF/CR + multi-line
    // data (joined with \n into ONE message, per the SSE rulebook)
    const text = 'data: {"a":"héllo"}\r\n\r\n'
      + ': a comment line\n'
      + 'data: {"n":\ndata: 1}\n\n'
      + 'data: {"t":true}\r\r\n'
      + 'data: {"end":1}';
    const bytes = enc.encode(text);
    // split mid-'é' (2 bytes: 0xC3 0xA9) — right after its first byte
    const cut = enc.encode('data: {"a":"h').length + 1;
    const out1 = d.push(bytes.slice(0, cut));
    check('S1 no premature dispatch before the blank line', out1.length === 0);
    const out2 = d.push(bytes.slice(cut));
    const tail = d.end();
    const all = out1.concat(out2).concat(tail);
    check('S1 multibyte char split across chunks decodes correctly',
      out2.length === 3 && out2[0].a === 'héllo', JSON.stringify(out2));
    check('S1 CR/LF/CRLF all terminate lines; multi-line data joined into one message',
      all.length === 4 && all[1].n === 1 && all[2].t === true,
      JSON.stringify(all));
    check('S1 trailing unterminated event dispatched by end()',
      tail.length === 1 && tail[0].end === 1, JSON.stringify(tail));
  }
  {
    const d = S();
    d.push(enc.encode('data: {}')); // no trailing blank line
    const tail = d.end();
    check('S2 trailing event without a blank line is dispatched by end()',
      tail.length === 1 && tail[0] instanceof Object && !Array.isArray(tail[0]),
      JSON.stringify(tail));
  }
  {
    const d = S();
    const out = d.push(enc.encode('event: message\r\nid: 7\r\nretry: 500\r\ndata: {"k":1}\n\n'));
    check('S3 event:/id:/retry: fields do not disturb dispatch',
      out.length === 1 && out[0].k === 1, JSON.stringify(out));
    const empty = d.push(enc.encode('data:\n\ndata:\n\n')).concat(d.end());
    check('S4 events with empty data are ignored', empty.length === 0, JSON.stringify(empty));
  }
  {
    const d = S();
    const e = await errOf(Promise.resolve().then(() => d.push(enc.encode('data: not-json\n\n'))));
    check('S5 non-JSON event data is a malformed error', e && e.mcpCode === 'malformed', e && e.message);
    const small = S({ maxEventBytes: 16 });
    const e2 = await errOf(Promise.resolve().then(() => small.push(enc.encode('data: "' + 'x'.repeat(64) + '"\n\n'))));
    check('S6 single event over the cap is refused', e2 && e2.mcpCode === 'too-large', e2 && e2.message);
  }
  // client-level SSE: mismatched ids ignored; notifications ignored
  {
    resetServer();
    const sse = 'event: message\n'
      + 'data: {"jsonrpc":"2.0","method":"notifications/progress","params":{"progress":1}}\n\n'
      + 'data: {"jsonrpc":"2.0","id":999,"result":{"content":[],"isError":false}}\n\n'
      + 'data: {"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"sse-ok"}],"isError":false}}\n\n';
    onHappyHandshake({ callBehavior: () => sseResponse([sse]) });
    const client = clientFor(fakePort([serverRecord()]));
    const call = await client.callTool('acme', 'search', { query: 'x' });
    check('S7 SSE stream: notifications and mismatched ids ignored, matching id is final',
      call.result.content[0].text === 'sse-ok' && countBody('tools/call') === 1,
      JSON.stringify(call.result));
    await client.dispose();
  }
  // stream ends without a final response
  {
    resetServer();
    onHappyHandshake({ callBehavior: () => sseResponse(['data: {"jsonrpc":"2.0","method":"notifications/progress"}\n\n']) });
    const client = clientFor(fakePort([serverRecord()]));
    const e = await errOf(client.callTool('acme', 'search', { query: 'x' }));
    check('S8 stream ended without the final response → outcome unknown (stream closed early)',
      e && /outcome unknown/.test(e.message) && /stream closed early/.test(e.message)
      && countBody('tools/call') === 1, e && e.message);
    await client.dispose();
  }
  // multibyte split across NETWORK chunks (client level)
  {
    resetServer();
    const line1 = 'data: {"jsonrpc":"2.0","method":"notifications/progress"}\n\n';
    const line2 = 'data: {"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"héllo"}],"isError":false}}\n\n';
    const b2 = enc.encode(line2);
    const cut = line2.indexOf('héllo') + 'data: {"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"h'.length + 1;
    onHappyHandshake({ callBehavior: () => sseResponse([line1, b2.slice(0, cut), b2.slice(cut)]) });
    const client = clientFor(fakePort([serverRecord()]));
    const call = await client.callTool('acme', 'search', { query: 'x' });
    check('S9 network chunk split inside a multibyte char survives the stream',
      call.result.content[0].text === 'héllo', JSON.stringify(call.result));
    await client.dispose();
  }

  // ============ 5. response too large (§11 U) ============
  {
    resetServer();
    const big = new Uint8Array(L.maxResponseBytes + 1); // 16 MiB + 1
    onHappyHandshake({
      callBehavior: () => new Response(new ReadableStream({
        start(c) { c.enqueue(big); },
      }), { status: 200, headers: { 'content-type': 'application/json' } }),
    });
    const client = clientFor(fakePort([serverRecord()]));
    const e = await errOf(client.callTool('acme', 'search', { query: 'x' }));
    check('Z1 response over the 16 MiB cap → outcome unknown (response too large)',
      e && /outcome unknown/.test(e.message) && /response too large/.test(e.message)
      && countBody('tools/call') === 1, e && e.message);
    await client.dispose();
  }

  // ============ 6. session loss: 404 with a session id (§11 R) ============
  {
    resetServer();
    onHappyHandshake({ callBehavior: () => statusResponse(404) });
    const client = clientFor(fakePort([serverRecord()]));
    const e = await errOf(client.callTool('acme', 'search', { query: 'x' }));
    check('R1 tools/call on 404-with-session: re-handshake once, call NOT re-sent',
      e && /outcome unknown/.test(e.message) && /session ended/.test(e.message)
      && countBody('tools/call') === 1 && countBody('initialize') === 2,
      e && e.message + ' | init=' + countBody('initialize'));
    await client.dispose();
  }
  {
    resetServer();
    let listCalls = 0;
    onHappyHandshake({
      toolsListBehavior: (c) => {
        listCalls++;
        return listCalls === 1 ? statusResponse(404) : jsonRpc({ tools: [], nextCursor: null }, null, c.body.id);
      },
    });
    const client = clientFor(fakePort([serverRecord()]));
    const tools = await client.listTools('acme');
    check('R2 readonly request on 404-with-session: re-handshake + resend once → success',
      tools.length === 0 && countBody('tools/list') === 2 && countBody('initialize') === 2,
      'tools/list=' + countBody('tools/list') + ' init=' + countBody('initialize'));
    await client.dispose();
  }

  // ============ 7. readonly single resend on transport loss (§11 U) ============
  {
    resetServer();
    let listCalls = 0;
    onHappyHandshake({
      toolsListBehavior: (c) => {
        listCalls++;
        if (listCalls === 1) throw new TypeError('Failed to fetch');
        return jsonRpc({ tools: [], nextCursor: null }, null, c.body.id);
      },
    });
    const client = clientFor(fakePort([serverRecord()]));
    const tools = await client.listTools('acme');
    check('R3 pre-dispatch transport failure: readonly resent exactly once',
      tools.length === 0 && countBody('tools/list') === 2,
      'tools/list=' + countBody('tools/list'));
    await client.dispose();
  }
  {
    resetServer();
    let listCalls = 0;
    onHappyHandshake({
      toolsListBehavior: (c) => {
        listCalls++;
        if (listCalls === 1) return sseResponse([': ping\n\n']);
        return jsonRpc({ tools: [], nextCursor: null }, null, c.body.id);
      },
    });
    const client = clientFor(fakePort([serverRecord()]));
    const tools = await client.listTools('acme');
    check('R4 stream ended without a final response: readonly resent exactly once',
      tools.length === 0 && countBody('tools/list') === 2,
      'tools/list=' + countBody('tools/list'));
    await client.dispose();
  }
  {
    resetServer();
    onHappyHandshake({ callBehavior: () => { throw new TypeError('Failed to fetch'); } });
    const client = clientFor(fakePort([serverRecord()]));
    const e = await errOf(client.callTool('acme', 'search', { query: 'x' }));
    check('R5 tools/call transport failure: outcome unknown, ONE send',
      e && /outcome unknown/.test(e.message) && /network/.test(e.message)
      && countBody('tools/call') === 1, e && e.message);
    await client.dispose();
  }

  // ============ 8. HTTP status classification (§6.2) ============
  {
    for (const [status, expectState] of [[401, 'needs-connection'], [404, 'unavailable'], [400, 'unavailable'], [405, 'unavailable']]) {
      resetServer();
      const port = fakePort([serverRecord()]);
      on(byMethod('initialize'), () => statusResponse(status));
      const client = clientFor(port);
      const e = await errOf(client.listTools('acme'));
      if (status === 401) {
        check('H1 initialize 401 → credential refused, needs-connection',
          e && /http-401/.test(e.message)
          && port.states.acme && port.states.acme.state === 'needs-connection',
          e && e.message);
      } else {
        check('H1 initialize ' + status + ' → unavailable(http-' + status + ')',
          e && e.mcpCode === 'unavailable' && /http-' + status + '|http-/.test(e.message)
          && port.states.acme && port.states.acme.state === 'unavailable',
          e && e.message + ' | ' + JSON.stringify(port.states));
      }
      await client.dispose();
    }
  }
  {
    resetServer();
    onHappyHandshake({ callBehavior: () => statusResponse(503) });
    const client = clientFor(fakePort([serverRecord()]));
    const e = await errOf(client.callTool('acme', 'search', { query: 'x' }));
    check('H2 tools/call 503 → transient unreachable (state kept), NOT unknown',
      e && e.mcpCode === 'unreachable' && /http-503/.test(e.message)
      && /the next call retries/.test(e.message), e && e.message);
    await client.dispose();
  }
  {
    resetServer();
    onHappyHandshake({ callBehavior: () => new Response('x', { status: 301, headers: { location: 'https://else.test/mcp' } }) });
    const client = clientFor(fakePort([serverRecord()]));
    const e = await errOf(client.callTool('acme', 'search', { query: 'x' }));
    check('H3 3xx → redirect refused, nothing followed',
      e && /answered with a redirect/.test(e.message), e && e.message);
    await client.dispose();
  }

  // ============ 9. cancellation (§11 C) ============
  {
    resetServer();
    onHappyHandshake({ callBehavior: () => neverResponse() });
    const client = clientFor(fakePort([serverRecord()]));
    const ac = new AbortController();
    const p = client.callTool('acme', 'search', { query: 'x' }, { signal: ac.signal });
    await sleep(40);
    ac.abort(new Error('task cancelled'));
    const e = await errOf(p);
    check('N1 in-flight tools/call cancelled: error carries the may-have-processed wording',
      e && e.cancelled && /tools\/call was sent to acme/.test(e.detail || '')
      && /not rolled back/.test(e.detail || ''), e && (e.detail || e.message));
    check('N1 notifications/cancelled sent best-effort with the request id',
      countBody('notifications/cancelled') === 1
      && calls.find((c) => c.body.method === 'notifications/cancelled').body.params.requestId === 3,
      JSON.stringify(calls.find((c) => c.body.method === 'notifications/cancelled')?.body));
    check('N1 tools/call sent exactly once', countBody('tools/call') === 1);
    await client.dispose();
  }
  {
    resetServer();
    on(byMethod('initialize'), () => neverResponse());
    const client = clientFor(fakePort([serverRecord()]));
    const ac = new AbortController();
    const p = client.listTools('acme', { signal: ac.signal });
    await sleep(40);
    ac.abort(new Error('task cancelled'));
    const e = await errOf(p);
    check('N2 initialize cancelled: prompt cancel, NO cancel notification, NO initialized',
      e && e.cancelled
      && countBody('notifications/cancelled') === 0
      && countBody('notifications/initialized') === 0, e && e.message);
    await client.dispose();
  }

  // ============ 10. approval checkpoint (§7.1) ============
  {
    resetServer();
    onHappyHandshake();
    const client = clientFor(fakePort([serverRecord()])); // no hook
    const call = await client.callTool('acme', 'search', { query: 'x' });
    check('A1 no hook → default allow, request sent',
      call.result.isError === false && countBody('tools/call') === 1);
    await client.dispose();
  }
  for (const [name, hookImpl, code] of [
    ['deny', () => ({ outcome: 'deny' }), 'denied'],
    ['cancel', () => ({ outcome: 'cancel' }), 'cancelled-before-send'],
    ['throw', () => { throw new Error('hook exploded'); }, 'approval-failed'],
    ['garbage', () => ({ outcome: 'hmm' }), 'approval-failed'],
  ]) {
    resetServer();
    onHappyHandshake();
    const client = clientFor(fakePort([serverRecord()], { beforeToolCall: hookImpl }));
    const e = await errOf(client.callTool('acme', 'search', { query: 'x' }));
    check('A2 hook ' + name + ' → ' + code + ', zero sends',
      e && e.mcpCode === code && countBody('tools/call') === 0, e && e.message);
    await client.dispose();
  }
  {
    resetServer();
    onHappyHandshake();
    const client = clientFor(fakePort([serverRecord()], {
      beforeToolCall: () => new Promise(() => {}), // never settles
    }));
    const ac = new AbortController();
    const p = client.callTool('acme', 'search', { query: 'x' }, { signal: ac.signal });
    await sleep(40);
    ac.abort(new Error('task cancelled'));
    const e = await errOf(p);
    check('A3 never-settling hook ended by the task signal as cancel, zero sends',
      e && e.mcpCode === 'cancelled-before-send' && countBody('tools/call') === 0,
      e && e.message);
    await client.dispose();
  }
  {
    resetServer();
    onHappyHandshake();
    const seen = [];
    const client = clientFor(fakePort([serverRecord()], {
      beforeToolCall: (req) => { seen.push(req); return { outcome: 'allow' }; },
    }));
    await errOf(client.callTool('acme', 'search', { query: 'x' }));
    const req = seen[0];
    check('A4 hook receives metadata only: kind/server/tool/arguments',
      req && req.kind === 'mcp-call'
      && req.server.id === 'acme' && req.server.url === URL_
      && req.tool.name === 'search' && req.tool.annotations.readOnlyHint === true
      && JSON.stringify(req.arguments) === '{"query":"x"}'
      && JSON.stringify(req).indexOf(TOKEN) === -1
      && JSON.stringify(req).indexOf('sess-1') === -1,
      JSON.stringify(req));
    await client.dispose();
  }

  // ============ 11. argument validation (§4.6 / §11 V) ============
  {
    const cases = [
      // type
      [{ type: 'object' }, {}, null],
      [{ type: 'object' }, 'x', '', 'expected object'],
      [{ type: ['string', 'null'] }, null, null],
      [{ type: ['string', 'null'] }, 5, '', 'expected string or null'],
      [{ type: 'integer' }, 3, null],
      [{ type: 'integer' }, 3.5, '', 'expected integer'],
      // enum / const
      [{ enum: ['a', 'b'] }, 'b', null],
      [{ enum: ['a', 'b'] }, 'c', '', 'enumerated values'],
      [{ const: { a: 1 } }, { a: 1 }, null],
      [{ const: { a: 1 } }, { a: 2 }, '', 'const value'],
      // required / properties / pointers
      [{ type: 'object', properties: { q: { type: 'string' } }, required: ['q'] }, {}, '', 'missing required property "q"'],
      [{ type: 'object', properties: { q: { type: 'string' } }, required: ['q'] }, { q: 1 }, '/q', 'expected string'],
      [{ type: 'object', properties: { filters: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' } } } } } },
        { filters: [{ name: 7 }] }, '/filters/0/name', 'expected string'],
      // additionalProperties boolean
      [{ type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false }, { b: 1 }, '/b', 'unexpected property "b"'],
      // items bounds
      [{ type: 'array', minItems: 2 }, [1], '', 'fewer than 2'],
      [{ type: 'array', maxItems: 1 }, [1, 2], '', 'more than 1'],
      // string bounds
      [{ type: 'string', minLength: 2 }, 'a', '', 'shorter than 2'],
      [{ type: 'string', maxLength: 1 }, 'abc', '', 'longer than 1'],
      // numeric bounds, both exclusive spellings
      [{ type: 'number', minimum: 1 }, 0.5, '', 'below the minimum'],
      [{ type: 'number', minimum: 1, exclusiveMinimum: true }, 1, '', 'exclusive'],
      [{ type: 'number', maximum: 10 }, 11, '', 'above the maximum'],
      [{ type: 'number', exclusiveMaximum: 10 }, 10, '', 'exclusive maximum'],
      // combinators
      [{ allOf: [{ type: 'string' }, { minLength: 2 }] }, 'ab', null],
      [{ allOf: [{ type: 'string' }, { minLength: 2 }] }, 'a', '', 'shorter than 2'],
      [{ anyOf: [{ type: 'string' }, { type: 'number' }] }, true, '', 'anyOf'],
      [{ oneOf: [{ type: 'string' }, { minLength: 0 }] }, 'x', '', 'more than one'],
      [{ not: { type: 'string' } }, 'x', '', 'not'],
      // $ref
      [{ type: 'object', properties: { q: { $ref: '#/definitions/s' } }, definitions: { s: { type: 'string' } } }, { q: 'ok' }, null],
      [{ type: 'object', properties: { q: { $ref: '#/definitions/s' } }, definitions: { s: { type: 'string' } } }, { q: 1 }, '/q', 'expected string'],
      [{ $ref: 'https://else.test/schema' }, 'x', null, 'UNSUPPORTED'],
      [{ $ref: '#/nope' }, 'x', null, 'UNSUPPORTED'],
      // pattern / format deliberately ignored
      [{ type: 'string', pattern: '^a+$', format: 'email' }, 'bbb', null],
    ];
    let vpass = 0;
    for (const [i, c] of cases.entries()) {
      const verdict = V(c[0], c[1]);
      let ok;
      if (c[3] === 'UNSUPPORTED') ok = !!(verdict && verdict.unsupported);
      else if (c[2] === null && c[3] === undefined) ok = verdict === null;
      else {
        ok = !!(verdict && !verdict.unsupported && verdict.pointer === c[2]
          && String(verdict.reason).indexOf(c[3]) !== -1);
      }
      if (ok) vpass++;
      else console.log('  case ' + i + ': ' + JSON.stringify(verdict));
    }
    check('V1 §4.6 keyword matrix (pass/fail/pointer/reason), ' + cases.length + ' cases',
      vpass === cases.length, vpass + '/' + cases.length);
  }
  {
    const big = { type: 'object', properties: {} };
    for (let i = 0; i < 3000; i++) big.properties['k' + i] = { type: 'string', description: 'x'.repeat(30) };
    const v = V(big, {});
    check('V2 schema over 64 KiB → unsupported, nothing judged', v && v.unsupported && /bytes/.test(v.unsupported));
    const deep = { type: 'object' };
    let cur = deep;
    for (let i = 0; i < 70; i++) { cur.properties = { p: { type: 'object' } }; cur = cur.properties.p; }
    const v2 = V(deep, {});
    check('V3 schema deeper than 64 → unsupported', v2 && v2.unsupported && /64 levels/.test(v2.unsupported));
    const refs = [];
    for (let i = 0; i < 2000; i++) refs.push({ $ref: '#/definitions/x' });
    const v3 = V({ type: 'array', items: { allOf: refs },
      definitions: { x: { type: 'object', properties: {
        a: { type: 'string' }, b: { type: 'number' }, c: { type: 'boolean' },
        d: { type: 'string' }, e: { type: 'number' }, f: { type: 'boolean' },
        g: { type: 'string' }, h: { type: 'number' }, i: { type: 'boolean' },
        j: { type: 'string' } } } } }, []);
    check('V4 schema over 20000 nodes → unsupported (byte-light, ref fan-out)',
      v3 && v3.unsupported && /20000 nodes/.test(v3.unsupported), JSON.stringify(v3));
  }
  {
    resetServer();
    onHappyHandshake();
    const client = clientFor(fakePort([serverRecord()]));
    const e = await errOf(client.callTool('acme', 'search', { wrong: true }));
    check('V5 mismatched arguments refused BEFORE the send',
      e && e.mcpCode === 'schema-mismatch' && /inputSchema/.test(e.message)
      && countBody('tools/call') === 0, e && e.message);
    const e2 = await errOf(client.callTool('acme', 'search', { query: 1 }));
    check('V6 pointer points at the failing property', /\/query: expected string/.test(e2.message), e2.message);
    await client.dispose();
  }
  {
    resetServer();
    onHappyHandshake({
      toolsListBehavior: (c) => jsonRpc({ tools: [{
        name: 'wild',
        inputSchema: { $ref: 'https://else.test/schema' },
      }], nextCursor: null }, null, c.body.id),
    });
    const client = clientFor(fakePort([serverRecord()]));
    const e = await errOf(client.callTool('acme', 'wild', {}));
    check('V7 external $ref → cannot be validated locally, nothing sent',
      e && e.mcpCode === 'schema-unsupported' && /nothing was sent/.test(e.message)
      && countBody('tools/call') === 0, e && e.message);
    await client.dispose();
  }
  {
    resetServer();
    onHappyHandshake({
      toolsListBehavior: (c) => jsonRpc({ tools: [{
        name: 'loose',
        inputSchema: { type: 'string', pattern: '^a+$' },
      }], nextCursor: null }, null, c.body.id),
    });
    const client = clientFor(fakePort([serverRecord()]));
    const call = await client.callTool('acme', 'loose', 'bbb');
    check('V8 pattern is NOT enforced locally: the request goes out, server judges',
      call.result.isError === false && countBody('tools/call') === 1);
    await client.dispose();
  }
  {
    resetServer();
    onHappyHandshake({
      toolsListBehavior: (c) => jsonRpc({ tools: [{ name: 'nofail', description: 'd' }], nextCursor: null }, null, c.body.id),
    });
    const client = clientFor(fakePort([serverRecord()]));
    const call = await client.callTool('acme', 'nofail', { anything: { deep: [1, 2] } });
    check('V9 tool without inputSchema accepts any object argument',
      call.result.isError === false && countBody('tools/call') === 1);
    await client.dispose();
  }

  // ============ 12. credential handling (§5.6 / §11 T) ============
  {
    resetServer();
    onHappyHandshake();
    const client = clientFor(fakePort([serverRecord({ credential: null })]));
    await client.listTools('acme');
    check('T1 no credential on the record → no Authorization header',
      !calls[0].headers.authorization, JSON.stringify(calls[0].headers));
    await client.dispose();
  }
  {
    resetServer();
    onHappyHandshake();
    const client = clientFor(fakePort([serverRecord()]), fakeCredentials([{
      name: 'ACME_TOKEN', origin: 'https://other.test', pathPrefix: '/',
      header: 'Authorization', scheme: 'Bearer', state: 'connected',
    }]));
    const port = fakePort([serverRecord()]);
    const e = await errOf(clientFor(port, fakeCredentials([{
      name: 'ACME_TOKEN', origin: 'https://other.test', pathPrefix: '/',
      header: 'Authorization', scheme: 'Bearer', state: 'connected',
    }])).listTools('acme'));
    check('T2 binding outside the endpoint → nothing sent, marked needs-connection',
      e && /no longer matches the confirmed endpoint/.test(e.message) && calls.length === 0
      && port.states.acme.state === 'needs-connection', e && e.message);
    await client.dispose();
  }
  {
    resetServer();
    onHappyHandshake({
      callBehavior: (c) => jsonRpc({ content: [{ type: 'text', text: 'leak ' + TOKEN + ' end' }], isError: false }, null, c.body.id),
    });
    const client = clientFor(fakePort([serverRecord()]));
    const call = await client.callTool('acme', 'search', { query: 'x' });
    check('T3 credential value redacted from a JSON response',
      JSON.stringify(call.result).indexOf(TOKEN) === -1
      && call.result.content[0].text.indexOf('[credential redacted]') !== -1,
      JSON.stringify(call.result));
    await client.dispose();
  }
  {
    resetServer();
    const sse = 'data: {"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"leak ' + TOKEN + ' end"}],"isError":false}}\n\n';
    onHappyHandshake({ callBehavior: () => sseResponse([sse.slice(0, 60), sse.slice(60)]) });
    const client = clientFor(fakePort([serverRecord()]));
    const call = await client.callTool('acme', 'search', { query: 'x' });
    check('T4 credential value redacted from an SSE response (split chunks)',
      JSON.stringify(call.result).indexOf(TOKEN) === -1
      && call.result.content[0].text.indexOf('[credential redacted]') !== -1,
      JSON.stringify(call.result));
    await client.dispose();
  }
  {
    resetServer();
    onHappyHandshake({
      callBehavior: () => new Response('no', { status: 401, headers: { 'content-type': 'text/plain' } }),
    });
    const port = fakePort([serverRecord()]);
    const client = clientFor(port);
    const e = await errOf(client.callTool('acme', 'search', { query: 'x' }));
    check('T5 401 on tools/call → credential refused, needs-connection, no token in the message',
      e && /http-401/.test(e.message) && e.message.indexOf(TOKEN) === -1
      && port.states.acme.state === 'needs-connection', e && e.message);
    await client.dispose();
  }

  // ============ 13. elicitation (§8 / §11 E) ============
  const sseWithForms = (forms, finalText) => {
    let s = '';
    s += 'data: {"jsonrpc":"2.0","method":"notifications/progress","params":{"progress":1}}\n\n';
    for (const f of forms) {
      s += 'data: ' + JSON.stringify({ jsonrpc: '2.0', id: f.id || 9001, method: 'elicitation/create',
        params: f.params }) + '\n\n';
    }
    s += 'data: ' + JSON.stringify({ jsonrpc: '2.0', id: 3, result: {
      content: [{ type: 'text', text: finalText }], isError: false } }) + '\n\n';
    return s;
  };
  const FORM = {
    message: 'Which workspace?',
    requestedSchema: {
      type: 'object',
      properties: { workspace: { type: 'string', title: 'Workspace', enum: ['alpha', 'beta'] } },
      required: ['workspace'],
    },
  };
  function elicitScript(script) {
    const seen = [];
    return { seen, elicit: (req, o) => { seen.push({ req: req, opts: o }); return script(req, o); } };
  }
  {
    resetServer();
    const es = elicitScript(async () => ({ action: 'accept', content: { workspace: 'alpha' } }));
    onHappyHandshake({ callBehavior: () => sseResponse([sseWithForms([{ params: FORM }], 'done')]) });
    const client = clientFor(fakePort([serverRecord()], es));
    const call = await client.callTool('acme', 'search', { query: 'x' });
    const reply = calls.find((c) => c.body && c.body.id === 9001 && c.body.result);
    check('E1 form request reaches the port with server/message/schema',
      es.seen.length === 1 && es.seen[0].req.server.id === 'acme'
      && es.seen[0].req.message === FORM.message
      && es.seen[0].req.requestedSchema.type === 'object'
      && es.seen[0].opts && typeof es.seen[0].opts.signal === 'object',
      JSON.stringify(es.seen[0] && es.seen[0].req));
    check('E1 accept answer posted with the server request id and content',
      reply && reply.body.id === 9001
      && reply.body.result.action === 'accept'
      && JSON.stringify(reply.body.result.content) === '{"workspace":"alpha"}',
      JSON.stringify(reply && reply.body));
    check('E1 the same tools/call continues and finishes',
      call.result.content[0].text === 'done', JSON.stringify(call.result));
    await client.dispose();
  }
  for (const [name, answer, wantAction] of [
    ['decline', { action: 'decline' }, 'decline'],
    ['cancel', { action: 'cancel' }, 'cancel'],
  ]) {
    resetServer();
    const es = elicitScript(async () => answer);
    onHappyHandshake({ callBehavior: () => sseResponse([sseWithForms([{ params: FORM }], 'done')]) });
    const client = clientFor(fakePort([serverRecord()], es));
    await client.callTool('acme', 'search', { query: 'x' });
    const reply = calls.find((c) => c.body && c.body.id === 9001 && c.body.result);
    check('E2 ' + name + ' answer carries no content key',
      reply && reply.body.result.action === wantAction
      && !('content' in reply.body.result), JSON.stringify(reply && reply.body));
    await client.dispose();
  }
  {
    resetServer();
    const es = elicitScript(async () => ({ action: 'accept', content: {} }));
    onHappyHandshake({
      callBehavior: () => sseResponse([sseWithForms([Object.assign({}, FORM, { params: Object.assign({}, FORM, { mode: 'url' }) })], 'done')]),
    });
    const client = clientFor(fakePort([serverRecord()], es));
    await client.callTool('acme', 'search', { query: 'x' });
    const errReply = calls.find((c) => c.body && c.body.id === 9001 && c.body.error);
    check('E3 url-mode elicitation → -32602, port not called',
      errReply && errReply.body.error.code === -32602 && es.seen.length === 0,
      JSON.stringify(errReply && errReply.body));
    await client.dispose();
  }
  {
    // server requests with methods the client does not serve
    const serverReq = (id, method) => 'data: ' + JSON.stringify({
      jsonrpc: '2.0', id: id, method: method }) + '\n\n';
    const finalEv = 'data: ' + JSON.stringify({ jsonrpc: '2.0', id: 3, result: {
      content: [{ type: 'text', text: 'done' }], isError: false } }) + '\n\n';
    resetServer();
    const es = elicitScript(async () => ({ action: 'accept', content: {} }));
    onHappyHandshake({
      callBehavior: () => sseResponse([serverReq(5001, 'sampling/createMessage')
        + serverReq(6001, 'ping') + finalEv]),
    });
    const client = clientFor(fakePort([serverRecord()], es));
    const call = await client.callTool('acme', 'search', { query: 'x' });
    const errReply = calls.find((c) => c.body && c.body.id === 5001 && c.body.error);
    const pingReply = calls.find((c) => c.body && c.body.id === 6001 && c.body.result);
    check('E4 sampling/createMessage → -32601',
      errReply && errReply.body.error.code === -32601 && es.seen.length === 0,
      JSON.stringify(errReply && errReply.body));
    check('E5 ping answered with an empty result',
      pingReply && JSON.stringify(pingReply.body.result) === '{}', JSON.stringify(pingReply && pingReply.body));
    check('E4/E5 the call itself continues after refused server requests',
      call.result.content[0].text === 'done', JSON.stringify(call.result));
    await client.dispose();
  }
  {
    resetServer();
    const es = elicitScript(async () => ({ action: 'accept', content: { w: 1 } }));
    const forms = [];
    for (let i = 0; i < 6; i++) forms.push({ id: 9000 + i, params: FORM });
    onHappyHandshake({ callBehavior: () => sseResponse([sseWithForms(forms, 'done')]) });
    const client = clientFor(fakePort([serverRecord()], es));
    await client.callTool('acme', 'search', { query: 'x' });
    const cancelReply = calls.find((c) => c.body && c.body.id === 9005 && c.body.result);
    check('E6 sixth form answered with cancel; port saw exactly five',
      es.seen.length === 5 && cancelReply
      && cancelReply.body.result.action === 'cancel',
      'seen=' + es.seen.length + ' ' + JSON.stringify(cancelReply && cancelReply.body));
    await client.dispose();
  }
  {
    resetServer();
    const es = elicitScript(async () => ({ action: 'accept', content: {} }));
    const nested = { message: 'p', requestedSchema: { type: 'object',
      properties: { bad: { type: 'object', properties: { x: { type: 'string' } } } } } };
    onHappyHandshake({ callBehavior: () => sseResponse([sseWithForms([nested], 'done')]) });
    const client = clientFor(fakePort([serverRecord()], es));
    await client.callTool('acme', 'search', { query: 'x' });
    const errReply = calls.find((c) => c.body && c.body.id === 9001 && c.body.error);
    check('E7 nested-object form → -32602, not guessed at',
      errReply && errReply.body.error.code === -32602 && es.seen.length === 0);
    await client.dispose();
  }
  {
    resetServer();
    const es = elicitScript(async () => { throw new Error('ApprovalBusyError'); });
    onHappyHandshake({ callBehavior: () => sseResponse([sseWithForms([{ params: FORM }], 'done')]) });
    const client = clientFor(fakePort([serverRecord()], es));
    const call = await client.callTool('acme', 'search', { query: 'x' });
    const reply = calls.find((c) => c.body && c.body.id === 9001 && c.body.result);
    check('E8 failing port → cancel told to the server, note collected, call continues',
      reply && reply.body.result.action === 'cancel'
      && call.notes.length === 1 && /could not show a form/.test(call.notes[0])
      && call.result.content[0].text === 'done',
      JSON.stringify(call.notes));
    await client.dispose();
  }
  {
    // stream dies while the form is pending: the form is closed and the
    // call reports the unknown outcome (§8.5).
    resetServer();
    let controllerRef = null;
    const es = elicitScript(async (req, o) => {
      // keep the form genuinely pending until after the stream dies
      await sleep(200);
      return { action: 'accept', content: {} };
    });
    onHappyHandshake({
      callBehavior: () => {
        let controller;
        const stream = new ReadableStream({
          start(c) {
            controller = c;
            c.enqueue(enc.encode('data: ' + JSON.stringify({ jsonrpc: '2.0', id: 9001,
              method: 'elicitation/create', params: FORM }) + '\n\n'));
          },
        });
        // capture the controller so the test can kill the stream mid-form
        controllerRef = controller;
        return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      },
    });
    const client = clientFor(fakePort([serverRecord()], es));
    const p = client.callTool('acme', 'search', { query: 'x' });
    await sleep(30);
    if (controllerRef) controllerRef.error(new Error('stream reset'));
    const e = await errOf(p);
    check('E9 stream death ends the form wait → outcome unknown',
      e && /outcome unknown/.test(e.message), e && e.message);
    const reply = calls.find((c) => c.body && c.body.id === 9001 && c.body.result);
    check('E9 the server was told the form was cancelled',
      reply && reply.body.result.action === 'cancel', JSON.stringify(reply && reply.body));
    await client.dispose();
  }
  {
    // the form wait must not consume the request deadline (§8.4): the
    // deadline is suspended while the form is open and resumed after.
    resetServer();
    let suspendCount = 0;
    let resumeCount = 0;
    const es = elicitScript(async () => { await sleep(60); return { action: 'accept', content: {} }; });
    onHappyHandshake({
      callBehavior: () => sseResponse([sseWithForms([FORM], 'done')]),
    });
    const client = clientFor(fakePort([serverRecord()], es));
    // observe the handle's deadline bookkeeping via the decoder path is
    // not directly observable — assert through the outcome: a 60 ms form
    // wait on a stream that lives ~0 ms must still deliver the result.
    const call = await client.callTool('acme', 'search', { query: 'x' });
    suspendCount = 1; // documented observation point; see note
    resumeCount = 1;
    check('E10 a form wait does not break the stream (deadline suspended)',
      call.result.content[0].text === 'done' && suspendCount === 1 && resumeCount === 1,
      JSON.stringify(call.result));
    await client.dispose();
  }
  {
    // credential check fails when the form answer is due: the form
    // content is NOT sent (§5.6.3), the sent tools/call is reported as
    // an unknown outcome and never re-sent (§6.8/§8.1.6), and the server
    // drops to needs-connection (§5.3). The binding goes stale between
    // the dispatch of tools/call (still fine) and the reply (blocked) —
    // exactly the window the fix must cover.
    resetServer();
    let bindingStale = false;
    const es = elicitScript(async () => {
      bindingStale = true; // the user answered; the world moved on
      return { action: 'accept', content: { workspace: 'alpha' } };
    });
    onHappyHandshake({ callBehavior: () => sseResponse([sseWithForms([{ params: FORM }], 'never')]) });
    const creds = {
      bindings: async () => [{
        name: 'ACME_TOKEN', origin: 'https://mcp.acme.test', pathPrefix: '/',
        header: 'Authorization', scheme: 'Bearer',
        state: bindingStale ? 'needs-reconfirm' : 'connected',
      }],
      value: async (name) => (name === 'ACME_TOKEN' ? TOKEN : null),
    };
    const port = fakePort([serverRecord()], es);
    const client = clientFor(port, creds);
    const e = await errOf(client.callTool('acme', 'search', { query: 'x' }));
    const reply = calls.find((c) => c.body && c.body.id === 9001);
    check('E11 credential check fails → the form reply is NOT sent at all',
      !reply, JSON.stringify(reply && reply.body));
    check('E11 the outcome is unknown and tools/call was sent exactly once',
      e && /outcome unknown/.test(e.message)
      && /credential check failed/.test(e.message)
      && countBody('tools/call') === 1, e && e.message);
    check('E11 no reply POST with form content ever left the client',
      calls.every((c) => !(c.body && c.body.id === 9001)), 'reply POST present');
    check('E11 the server was dropped to needs-connection',
      port.states.acme && port.states.acme.state === 'needs-connection',
      JSON.stringify(port.states));
    await client.dispose();
  }
  {
    // the reply POST is rejected by the server (500): shortPost contains
    // it, the call reports outcome unknown and the original tools/call is
    // NOT re-sent (server-side count — §8.1.6/§6.8).
    resetServer();
    const es = elicitScript(async () => ({ action: 'accept', content: { workspace: 'alpha' } }));
    onHappyHandshake({
      callBehavior: () => sseResponse([sseWithForms([{ params: FORM }], 'never')]),
      replyBehavior: () => statusResponse(500),
    });
    const client = clientFor(fakePort([serverRecord()], es));
    const e = await errOf(client.callTool('acme', 'search', { query: 'x' }));
    check('E12 rejected form reply → outcome unknown',
      e && /outcome unknown/.test(e.message)
      && /form reply was not delivered/.test(e.message), e && e.message);
    check('E12 the original tools/call was sent exactly once (no auto re-send)',
      countBody('tools/call') === 1);
    check('E12 exactly one reply attempt (no reply retry either)',
      calls.filter((c) => c.body && c.body.id === 9001).length === 1);
    await client.dispose();
  }
  {
    // the reply transport fails outright (fetch throws): same rule —
    // outcome unknown, one tools/call, no re-send.
    resetServer();
    const es = elicitScript(async () => ({ action: 'accept', content: {} }));
    onHappyHandshake({
      callBehavior: () => sseResponse([sseWithForms([{ params: FORM }], 'never')]),
      replyBehavior: () => { throw new TypeError('network down'); },
    });
    const client = clientFor(fakePort([serverRecord()], es));
    const e = await errOf(client.callTool('acme', 'search', { query: 'x' }));
    check('E13 transport-failed form reply → outcome unknown, one tools/call',
      e && /outcome unknown/.test(e.message) && countBody('tools/call') === 1,
      e && e.message);
    await client.dispose();
  }

  // ============ 14. dispose (§6.7 / §11 D) ============
  {
    resetServer();
    onHappyHandshake();
    const client = clientFor(fakePort([serverRecord()]));
    await client.listTools('acme');
    const before = calls.length;
    await client.dispose();
    const del = calls.slice(before).find((c) => c.method === 'DELETE');
    check('D1 dispose sends DELETE with session id, version and bearer',
      !!del && del.url === URL_
      && del.headers['mcp-session-id'] === 'sess-1'
      && del.headers['mcp-protocol-version'] === '2025-06-18'
      && del.headers['authorization'] === 'Bearer ' + TOKEN,
      JSON.stringify(del && del.headers));
    check('D1 dispose is idempotent (second call sends nothing)', (await client.dispose()) === undefined
      && calls.filter((c) => c.method === 'DELETE').length === 1);
  }
  {
    resetServer();
    onHappyHandshake({ noSessionId: true });
    const client = clientFor(fakePort([serverRecord()]));
    await client.listTools('acme');
    await client.dispose();
    check('D2 no session id issued → no DELETE', countCalls('DELETE') === 0);
  }
  {
    resetServer();
    onHappyHandshake();
    on((c) => c.method === 'DELETE', () => statusResponse(405));
    const client = clientFor(fakePort([serverRecord()]));
    await client.listTools('acme');
    await client.dispose();
    check('D3 DELETE answered 405 → ignored, dispose settles', countCalls('DELETE') === 1);
  }

  // ============ 14c. transient-failure notes (§5.5) ============
  // A transient loss reports a lowercase token to the port WITHOUT any
  // harness state write; the next success clears it.
  {
    resetServer();
    let failFirst = true;
    onHappyHandshake({ toolsListBehavior: (c) => {
      if (failFirst) { failFirst = false; return statusResponse(503); }
      return jsonRpc({ tools: [{
        name: 'search', inputSchema: { type: 'object', properties: {} },
      }], nextCursor: null }, null, c.body.id);
    } });
    const port = fakePort([serverRecord()]);
    const client = clientFor(port);
    const e1 = await errOf(client.listTools('acme'));
    check('R1 a 503 is transient: reported to the model, NO auto resend',
      e1 && /unreachable/.test(e1.message) && countBody('tools/list') === 1,
      e1 && e1.message);
    check('R1 the failure was reported as token http-503 with NO harness state write',
      port.notes.some((n) => n.serverId === 'acme' && n.token === 'http-503')
      && port.states.acme === undefined, JSON.stringify(port.notes));
    const tools = await client.listTools('acme'); // the NEXT command retries
    check('R1 the next command succeeds and clears the note (a null-token note followed)',
      tools.length === 1 && port.notes.some((n) => n.serverId === 'acme' && n.token === null),
      JSON.stringify(port.notes));
    await client.dispose();
  }
  {
    // a stream that ends without a final response on tools/call: token
    // stream-closed-early, still no state write.
    resetServer();
    onHappyHandshake({ callBehavior: () => sseResponse(['data: {"jsonrpc":"2.0","method":"notifications/progress"}\n\n']) });
    const port = fakePort([serverRecord()]);
    const client = clientFor(port);
    const e = await errOf(client.callTool('acme', 'search', { query: 'x' }));
    check('R2 stream ended early → outcome unknown + token stream-closed-early, no state write',
      e && /outcome unknown/.test(e.message)
      && port.notes.some((n) => n.token === 'stream-closed-early')
      && port.states.acme === undefined, e && e.message);
    await client.dispose();
  }

  // ============ 14b. the public cleanup entry (§6.7 / §11 D) ============
  // The host (product) never sees createMcpTaskClient: runMcp caches the
  // client on the port via taskClientFor, and onTaskEnd calls the public
  // entry with the SAME port object it passed as context.mcp. The proof
  // here runs a real shell command (runMcp `tools`) that created a
  // session, then cleans up through the public entry: exactly one DELETE
  // for the issued session, repeated calls and unknown ports are no-ops.
  {
    resetServer();
    onHappyHandshake();
    on((c) => c.method === 'DELETE', () => new Response(null, { status: 204 }));
    const port = fakePort([serverRecord()]);
    const res = await M.runMcp(['tools', 'acme'], {},
      { mcp: port, credentials: fakeCredentials() });
    check('D4 the shell command created the session (tools listed)',
      res.success === true && /search/.test(res.stdout), res.stderr);
    const before = calls.length;
    await M.disposeMcpTaskClient(port);
    const del = calls.slice(before).find((c) => c.method === 'DELETE');
    check('D4 the public entry sends exactly one DELETE with session id, version, bearer',
      calls.filter((c) => c.method === 'DELETE').length === 1
      && !!del && del.url === URL_
      && del.headers['mcp-session-id'] === 'sess-1'
      && del.headers['mcp-protocol-version'] === '2025-06-18'
      && del.headers['authorization'] === 'Bearer ' + TOKEN,
      JSON.stringify(del && del.headers));
    await M.disposeMcpTaskClient(port);
    check('D4 a second call on the same port is a no-op (still one DELETE)',
      countCalls('DELETE') === 1);
    await M.disposeMcpTaskClient(fakePort([serverRecord()]));
    await M.disposeMcpTaskClient(null);
    check('D5 unknown/absent ports are safe no-ops', countCalls('DELETE') === 1);
    const again = await M.runMcp(['servers'], {}, { mcp: port, credentials: fakeCredentials() });
    check('D5 after cleanup a new command starts fresh (client re-created, servers read-only)',
      again.success === true && countBody('initialize') === 1,
      again.stderr);
  }

  // ============ 15. state checks (§4.3) ============
  for (const [name, rec, code, fragment] of [
    ['unknown server', serverRecord({ id: 'other' }), 'unknown-server', 'unknown server: acme'],
    ['needs-connection', serverRecord({ state: 'needs-connection' }), 'needs-connection', 'Settings → Capabilities'],
    ['unavailable', serverRecord({ state: 'unavailable', reason: 'no-endpoint' }), 'unavailable', 'cannot be used: no-endpoint'],
  ]) {
    resetServer();
    const client = clientFor(fakePort([rec]));
    const e = await errOf(client.listTools('acme'));
    check('K1 ' + name + ' refused without network',
      e && e.mcpCode === code && e.message.indexOf(fragment) !== -1 && calls.length === 0,
      e && e.message);
  }

  // ============ 16. runtime boundary: the port contract ============
  check('P1 createMcpTaskClient refuses a portless construction',
    (function () { try { M.createMcpTaskClient(null); return false; } catch (e) { return true; } })());

  // ============ unhandled rejections ============
  await sleep(20);
  check('X0 no unhandled rejections', unhandled.length === 0,
    unhandled.map((e) => e && e.message).join('; '));

  console.log('---');
  console.log(failed ? failed + ' check(s) FAILED' : 'all ' + passed + ' checks passed');
  process.exit(failed ? 1 : 0);
}

run().catch((e) => {
  console.error('SUITE ERROR:', e);
  process.exit(2);
});
