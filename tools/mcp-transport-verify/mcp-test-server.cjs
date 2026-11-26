// MCP Streamable HTTP stand-in for the transport verification harness
// (tools/mcp-transport-verify/README.md). TEST ONLY — it is never shipped
// and never talks to a real MCP server or a real credential.
//
// It speaks just enough of the MCP "Streamable HTTP" transport
// (C3-CREDENTIALS-MCP §7 names it as the phase-2 client transport) to measure
// what a browser can observe through the two Locus backends:
//
//   POST <mount>/json   → 200 application/json, one JSON-RPC response whose
//                         id equals the request id, connection closed at once
//   POST <mount>/sse    → 200 text/event-stream, headers flushed at once,
//                         ONE SSE `message` event carrying the JSON-RPC
//                         response for the request id, then the connection is
//                         HELD OPEN for `holdMs` before the server closes it
//
// Every request is logged with server-side timestamps so the harness can line
// the browser's view up against the upstream's: when the request arrived,
// when headers went out, when the event went out, and — the number the relay
// verdicts hinge on — when the connection closed and WHO closed it
// ('server' = the hold timer / an ordinary end(); 'client' = the peer went
// away first, i.e. the browser or the relay aborted it).
//
// Guardrails mirror what a conforming server does, so header forwarding is
// verified rather than assumed:
// - Authorization must be exactly `Bearer <bearer>` (401 otherwise)
// - Accept must name both application/json and text/event-stream (406)
// - MCP-Session-Id is issued per request, as a unique value
// - CORS: reflective allow-origin / allow-headers, so a cross-origin browser
//   client works; `?expose=0` withholds Access-Control-Expose-Headers to show
//   what the browser then hides (MCP-Session-Id is not a safelisted header)
'use strict';

const http = require('http');
const crypto = require('crypto');

const PROTOCOL_VERSION = '2025-06-18';
const DEFAULT_BEARER = 'locus-mcp-transport-test-bearer';
const DEFAULT_EVENT_DELAY_MS = 300;
const DEFAULT_HOLD_MS = 5000;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function wantsType(accept, type) {
  return String(accept || '')
    .split(',')
    .some((part) => part.split(';')[0].trim().toLowerCase() === type);
}

function sendJson(res, status, body, headers) {
  const text = JSON.stringify(body);
  res.writeHead(status, Object.assign({
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(text)),
  }, headers || {}));
  res.end(text);
}

// CORS headers for one request. The expose list is the browser-visibility
// switch the direct probes toggle: without it a cross-origin page cannot read
// MCP-Session-Id off the Response, whatever the server sent.
function corsHeaders(req, url) {
  const origin = req.headers.origin;
  const requested = req.headers['access-control-request-headers'];
  const out = {
    'access-control-allow-origin': origin || '*',
    vary: 'Origin',
    'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
    'access-control-allow-headers': requested
      || 'Authorization, Content-Type, Accept, MCP-Protocol-Version, Last-Event-ID, X-Locus-Probe',
    'access-control-max-age': '86400',
  };
  if (url.searchParams.get('expose') !== '0') {
    out['access-control-expose-headers'] = 'MCP-Session-Id, MCP-Protocol-Version';
  }
  return out;
}

// Create the stand-in. Returns { handler, log, options }:
//   handler(req, res, mount) — Node http request listener fragment; `mount`
//     ('cross-origin' | 'same-origin') only labels the log entry, so the same
//     instance can be served from two origins
//   log — append-only array of per-request records (newest last)
function createMcpStandalone(rawOptions = {}) {
  const options = {
    bearer: rawOptions.bearer || process.env.MCP_TEST_BEARER || DEFAULT_BEARER,
    eventDelayMs: rawOptions.eventDelayMs != null ? Number(rawOptions.eventDelayMs) : DEFAULT_EVENT_DELAY_MS,
    holdMs: rawOptions.holdMs != null ? Number(rawOptions.holdMs) : DEFAULT_HOLD_MS,
  };
  if (!(options.eventDelayMs >= 0) || !(options.holdMs >= 0)) {
    throw new Error('eventDelayMs and holdMs must be >= 0');
  }
  const log = [];
  let seq = 0;

  function rpcResponse(id, entry) {
    return {
      jsonrpc: '2.0',
      id: id,
      result: {
        content: [{ type: 'text', text: 'pong mode=' + entry.mode + ' probe=' + (entry.probe || '(none)') }],
        isError: false,
      },
    };
  }

  async function handler(req, res, mount) {
    const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
    const pathname = url.pathname.replace(/\/+$/, '') || '/';
    const isMcp = pathname.endsWith('/json') || pathname.endsWith('/sse');
    const cors = corsHeaders(req, url);

    if (req.method === 'GET' && pathname.endsWith('/__health')) {
      return sendJson(res, 200, { ok: true, mount: mount || null, server: 'locus-mcp-transport-stand-in' }, cors);
    }
    if (req.method === 'GET' && pathname.endsWith('/__log')) {
      return sendJson(res, 200, { log: log }, cors);
    }
    if (req.method === 'OPTIONS' && isMcp) {
      res.writeHead(204, cors);
      return res.end();
    }
    if (!isMcp) return sendJson(res, 404, { error: 'no such endpoint' }, cors);
    if (req.method !== 'POST') {
      res.writeHead(405, Object.assign({ allow: 'POST, OPTIONS' }, cors));
      return res.end();
    }

    const entry = {
      seq: ++seq,
      probe: req.headers['x-locus-probe'] || null,
      mount: mount || null,
      mode: pathname.endsWith('/sse') ? 'sse' : 'json',
      exposeSessionId: url.searchParams.get('expose') !== '0',
      // server wall-clock stamps (ms since the Unix epoch) — the harness
      // compares them with the page's Date.now() on the same machine
      tReq: Date.now(),
      tHeaders: null,
      tEvent: null,
      tServerEnd: null,
      tClose: null,
      closedBy: null, // 'server' | 'client'
      writableFinishedAtClose: null,
      auth: null, // 'ok' | 'missing' | 'wrong'
      authorization: null, // the exact header value (TEST bearer only)
      accept: req.headers.accept || null,
      contentType: req.headers['content-type'] || null,
      protocolVersion: req.headers['mcp-protocol-version'] || null,
      rpcId: null,
      sessionId: null,
      status: null,
      bodyBytes: 0,
      eventDelayMs: options.eventDelayMs,
      holdMs: options.holdMs,
    };
    log.push(entry);

    const body = await readBody(req);
    entry.bodyBytes = body.byteLength;
    let msg = null;
    try { msg = JSON.parse(body.toString('utf8')); } catch (e) { /* handled below */ }

    // Who closed the connection: `writableEnded` is true only when THIS code
    // called end(); a close before that means the peer went away.
    res.on('close', () => {
      entry.tClose = Date.now();
      entry.closedBy = res.writableEnded ? 'server' : 'client';
      entry.writableFinishedAtClose = !!res.writableFinished;
    });

    const authorization = req.headers.authorization;
    if (authorization == null) entry.auth = 'missing';
    else entry.auth = authorization === 'Bearer ' + options.bearer ? 'ok' : 'wrong';
    if (entry.auth !== 'ok') {
      // only ever a TEST value: whatever the peer sent (or nothing)
      entry.authorization = authorization;
      entry.status = 401;
      return sendJson(res, 401, { jsonrpc: '2.0', id: msg && msg.id != null ? msg.id : null,
        error: { code: -32001, message: 'Unauthorized: a test bearer is required' } }, cors);
    }
    if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || msg.id == null) {
      entry.status = 400;
      return sendJson(res, 400, { jsonrpc: '2.0', id: null,
        error: { code: -32700, message: 'Parse error: expected a JSON-RPC 2.0 request with an id' } }, cors);
    }
    if (!wantsType(entry.accept, 'application/json') || !wantsType(entry.accept, 'text/event-stream')) {
      entry.status = 406;
      return sendJson(res, 406, { jsonrpc: '2.0', id: msg.id,
        error: { code: -32600, message: 'Not Acceptable: Accept must include both application/json and text/event-stream' } }, cors);
    }

    entry.rpcId = msg.id;
    entry.sessionId = 'sess-' + entry.seq + '-' + crypto.randomBytes(4).toString('hex');
    entry.status = 200;
    const headers = Object.assign({
      'content-type': entry.mode === 'sse' ? 'text/event-stream; charset=utf-8' : 'application/json',
      'mcp-session-id': entry.sessionId,
      'mcp-protocol-version': PROTOCOL_VERSION,
    }, cors);
    const payload = JSON.stringify(rpcResponse(msg.id, entry));

    if (entry.mode === 'json') {
      res.writeHead(200, Object.assign({ 'content-length': String(Buffer.byteLength(payload)) }, headers));
      res.end(payload);
      entry.tHeaders = Date.now();
      entry.tServerEnd = entry.tHeaders;
      return;
    }

    // SSE: headers now, the response event after eventDelayMs, close after
    // eventDelayMs + holdMs — unless the peer closes first.
    res.writeHead(200, headers);
    res.flushHeaders();
    entry.tHeaders = Date.now();
    const eventTimer = setTimeout(() => {
      if (res.destroyed || res.writableEnded) return;
      res.write('event: message\ndata: ' + payload + '\n\n');
      entry.tEvent = Date.now();
    }, options.eventDelayMs);
    const holdTimer = setTimeout(() => {
      if (res.destroyed || res.writableEnded) return;
      res.end();
      entry.tServerEnd = Date.now();
    }, options.eventDelayMs + options.holdMs);
    res.on('close', () => {
      clearTimeout(eventTimer);
      clearTimeout(holdTimer);
    });
  }

  return { handler, log, options };
}

// Standalone form: node mcp-test-server.cjs [--port N] [--hold-ms N]
// [--event-delay-ms N] [--bearer TOKEN]. Prints one JSON line per request to
// stdout as the connection CLOSES (the browser-facing half is driven by
// verify.cjs; this form is for pointing a browser at the server by hand).
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--hold-ms') out.holdMs = Number(argv[++i]);
    else if (a === '--event-delay-ms') out.eventDelayMs = Number(argv[++i]);
    else if (a === '--bearer') out.bearer = argv[++i];
  }
  return out;
}

function startMcpServer(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port || 0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve(server.address().port);
    });
  });
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  const standIn = createMcpStandalone(args);
  const server = http.createServer(async (req, res) => {
    const before = standIn.log.length;
    await standIn.handler(req, res, 'standalone').catch((e) => console.error(e && e.stack || e));
    if (standIn.log.length > before) {
      // the handler's own listener (registered first) fills tClose/closedBy
      res.on('close', () => console.log(JSON.stringify(standIn.log[standIn.log.length - 1])));
    }
  });
  startMcpServer(server, args.port).then((port) => {
    console.log(JSON.stringify({
      listening: 'http://127.0.0.1:' + port,
      endpoints: { json: '/mcp/json', sse: '/mcp/sse', health: '/__health', log: '/__log' },
      eventDelayMs: standIn.options.eventDelayMs,
      holdMs: standIn.options.holdMs,
    }));
  }).catch((e) => { console.error(e && e.stack || e); process.exit(1); });
}

module.exports = {
  DEFAULT_BEARER,
  DEFAULT_EVENT_DELAY_MS,
  DEFAULT_HOLD_MS,
  PROTOCOL_VERSION,
  createMcpStandalone,
};
