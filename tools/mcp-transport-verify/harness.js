// Browser half of the MCP transport verification harness
// (tools/mcp-transport-verify/README.md). Runs in a REAL Chrome page and
// issues one MCP-style JSON-RPC POST per probe through three clients:
//
//   fetch        raw browser fetch + a ReadableStream reader — the platform
//                control group: what a purpose-built browser MCP client
//                could observe. `envelope: true` posts the relay's
//                { method, url, headers } envelope to /fetch by hand.
//   nr-direct    NetworkRuntime._direct() — the runtime's direct backend
//                code (src/network.js), pointed at the cross-origin server.
//                INTERNAL on purpose: at this baseline request() only
//                selects the direct backend for a same-origin POST, so this
//                is the only way to measure that code cross-origin.
//   nr-request   NetworkRuntime.request() — the public substrate every
//                runtime HTTP consumer is routed through. Cross-origin
//                targets take the relay; a same-origin target goes direct.
//
// Every probe reports when the browser saw the response headers, when the
// JSON-RPC response for the request id became readable, and — for cancel
// probes — how long a read took to settle after AbortController.abort().
// All offsets are ms since the probe start; wallStart lines the page clock
// up with the stand-in server's log.
import { NetworkRuntime } from '../../src/network.js';

const PROTOCOL_VERSION = '2025-06-18';
const decoder = new TextDecoder();
const encoder = new TextEncoder();

// A scripted execution-authorization port (REPOSITORY-SPLIT-CONTRACTS §3.5):
// the POST is a side-effecting method, so request() requires the port and
// would otherwise ask for approval. Allow once, for every ask.
const ALLOW_ONCE = { request: async () => ({ outcome: 'allow', scope: 'once' }) };

function rpcBody(spec) {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: spec.rpcId,
    method: 'tools/call',
    params: { name: 'echo', arguments: { probe: spec.id } },
  });
}

// Exactly the headers an MCP Streamable HTTP client sends, plus the probe
// tag the stand-in logs. Names are lowercase because _direct() takes
// already-normalized headers (request() lowercases them itself).
function requestHeaders(spec) {
  return {
    authorization: 'Bearer ' + spec.bearer,
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': PROTOCOL_VERSION,
    'x-locus-probe': spec.id,
  };
}

// The relay's POST envelope, as src/network.js _relayRequest() builds it
// for an uncredentialed request: method, url, the headers, and the request
// body base64-encoded (no redirect field).
function relayEnvelope(spec) {
  const bytes = encoder.encode(rpcBody(spec));
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return {
    method: 'POST',
    url: spec.targetUrl,
    headers: requestHeaders(spec),
    bodyBase64: btoa(binary),
  };
}

function errorInfo(e) {
  return {
    name: (e && e.name) || null,
    message: (e && e.message) || String(e),
    networkCode: (e && e.networkCode) || null,
    timeout: !!(e && e.timeout),
    cancelled: !!(e && e.cancelled),
    ambiguous: !!(e && e.ambiguous),
  };
}

// Split an SSE byte stream into events and hand each `data:` payload to
// onJson once its terminating blank line has arrived.
function createSseScanner(onJson) {
  let buffer = '';
  const emit = (frame) => {
    const data = frame.split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n');
    if (!data) return;
    try { onJson(JSON.parse(data)); } catch (e) { /* not JSON: ignored */ }
  };
  return {
    push(text) {
      buffer += text;
      for (;;) {
        const lf = buffer.indexOf('\n\n');
        const crlf = buffer.indexOf('\r\n\r\n');
        if (lf === -1 && crlf === -1) return;
        if (crlf !== -1 && (lf === -1 || crlf < lf)) {
          emit(buffer.slice(0, crlf));
          buffer = buffer.slice(crlf + 4);
        } else {
          emit(buffer.slice(0, lf));
          buffer = buffer.slice(lf + 2);
        }
      }
    },
    flush() {
      if (buffer.trim()) emit(buffer);
      buffer = '';
    },
  };
}

function firstSseJson(text) {
  let found = null;
  const scanner = createSseScanner((msg) => { if (!found) found = msg; });
  scanner.push(text);
  scanner.flush();
  return found;
}

function armCancel(spec, out, now, ac) {
  if (!spec.cancel || spec.cancel.type !== 'at') return;
  setTimeout(() => {
    out.cancelled = true;
    out.t.cancel = now();
    ac.abort();
  }, spec.cancel.ms);
}

// ---- fetch (platform control group) --------------------------------------
async function probeFetch(spec, out, now) {
  const ac = new AbortController();
  const init = spec.envelope
    ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(relayEnvelope(spec)) }
    : { method: 'POST', credentials: 'omit', redirect: 'manual', headers: requestHeaders(spec), body: rpcBody(spec) };
  init.signal = ac.signal;
  armCancel(spec, out, now, ac);

  let res;
  try {
    res = await fetch(spec.url, init);
  } catch (e) {
    // No Response: a transport/CORS failure, or the cancel landed while the
    // headers were still outstanding.
    out.t.readSettled = now();
    out.t.end = now();
    out.error = errorInfo(e);
    return;
  }
  out.t.headers = now();
  out.status = res.status;
  out.contentType = res.headers.get('content-type');
  // null = absent OR hidden by CORS (the server log says which)
  out.sessionId = res.headers.get('mcp-session-id');
  out.relayError = res.headers.get('x-locus-relay-error');

  const reader = res.body.getReader();
  let text = '';
  let bytes = 0;
  let cancelled = false;
  const accept = (msg) => {
    if (out.response || !msg || msg.id !== spec.rpcId) return;
    out.response = msg;
    out.t.response = now();
    if (spec.cancel && spec.cancel.type === 'after-response') {
      cancelled = true;
      out.cancelled = true;
      out.t.cancel = now();
      ac.abort();
    }
  };
  const scanner = createSseScanner(accept);
  for (;;) {
    let chunk;
    try {
      chunk = await reader.read();
    } catch (e) {
      out.t.readSettled = now();
      out.t.end = now();
      out.error = errorInfo(e);
      break;
    }
    if (chunk.done) {
      out.t.end = now();
      break;
    }
    bytes += chunk.value.byteLength;
    const piece = decoder.decode(chunk.value, { stream: true });
    text += piece;
    if (spec.mode === 'sse') scanner.push(piece);
    if (cancelled) {
      // The stream must be dead now: the next read has to settle at once.
      try {
        const again = await reader.read();
        out.postCancelRead = again.done ? 'resolved(done)' : 'resolved(data)';
      } catch (e) {
        out.postCancelRead = 'rejected:' + ((e && e.name) || 'Error');
        out.error = out.error || errorInfo(e);
      }
      out.t.readSettled = now();
      out.t.end = now();
      break;
    }
  }
  if (spec.mode === 'sse') scanner.flush();
  else if (!out.error) {
    try { accept(JSON.parse(text)); } catch (e) { /* non-JSON body: reported via out.response === null */ }
  }
  out.bytes = bytes;
  out.bodyPreview = text.slice(0, 400);
}

// ---- NetworkRuntime._direct (the direct backend code) --------------------
async function probeDirect(spec, out, now) {
  const ac = new AbortController();
  armCancel(spec, out, now, ac);
  try {
    const result = await NetworkRuntime._direct('POST', spec.url, requestHeaders(spec),
      encoder.encode(rpcBody(spec)), ac.signal,
      spec.timeoutMs || NetworkRuntime.directTimeoutMs, false);
    // _direct resolves only after the WHOLE body has been read: the
    // response can never be readable before this moment.
    out.t.end = now();
    out.t.response = out.t.end;
    out.status = result.status;
    out.backend = result.backend;
    out.bytes = result.bytes.byteLength;
    out.contentType = result.headers['content-type'] || null;
    out.sessionId = result.headers['mcp-session-id'] || null;
    const text = decoder.decode(result.bytes);
    out.bodyPreview = text.slice(0, 400);
    try {
      out.response = spec.mode === 'sse' ? firstSseJson(text) : JSON.parse(text);
    } catch (e) { /* non-JSON body */ }
  } catch (e) {
    out.t.end = now();
    out.error = errorInfo(e);
    if (out.cancelled) out.t.readSettled = out.t.end;
  }
}

// ---- NetworkRuntime.request (the public substrate) -----------------------
async function probeRequest(spec, out, now) {
  const ac = new AbortController();
  armCancel(spec, out, now, ac);
  try {
    const result = await NetworkRuntime.request({
      method: 'POST',
      url: spec.url,
      headers: requestHeaders(spec),
      body: rpcBody(spec),
      signal: ac.signal,
      authorization: ALLOW_ONCE,
      timeoutMs: spec.timeoutMs,
      relayTimeoutMs: spec.relayTimeoutMs,
    });
    out.t.end = now();
    out.t.response = out.t.end;
    out.status = result.status;
    out.backend = result.backend;
    out.bytes = result.bytes.byteLength;
    out.contentType = result.headers['content-type'] || null;
    out.sessionId = result.headers['mcp-session-id'] || null;
    const text = decoder.decode(result.bytes);
    out.bodyPreview = text.slice(0, 400);
    try {
      out.response = spec.mode === 'sse' ? firstSseJson(text) : JSON.parse(text);
    } catch (e) { /* non-JSON body */ }
  } catch (e) {
    out.t.end = now();
    out.error = errorInfo(e);
    if (out.cancelled) out.t.readSettled = out.t.end;
  }
}

const CLIENTS = { fetch: probeFetch, 'nr-direct': probeDirect, 'nr-request': probeRequest };

async function runProbe(spec) {
  const startedAt = performance.now();
  const now = () => performance.now() - startedAt;
  const out = {
    id: spec.id,
    client: spec.client,
    mode: spec.mode,
    wallStart: Date.now(),
    cancelled: false,
    t: { headers: null, response: null, cancel: null, readSettled: null, end: null },
  };
  try {
    await CLIENTS[spec.client](spec, out, now);
  } catch (e) {
    out.harnessError = errorInfo(e);
  }
  return out;
}

// Environment probes for "test environment available": the browser must
// reach the stand-in through the host mapping (direct) and through the
// relay's legacy GET form (relay), with no probe logic in the way.
async function sanity(crossOriginBase) {
  const out = {};
  try {
    const r = await fetch(crossOriginBase + '/__health', { credentials: 'omit' });
    out.direct = { ok: r.status === 200, status: r.status };
  } catch (e) {
    out.direct = { ok: false, error: errorInfo(e) };
  }
  try {
    const r = await fetch('/fetch?url=' + encodeURIComponent(crossOriginBase + '/__health'), { credentials: 'omit' });
    out.relay = { ok: r.status === 200, status: r.status, relayError: r.headers.get('x-locus-relay-error') };
  } catch (e) {
    out.relay = { ok: false, error: errorInfo(e) };
  }
  return out;
}

window.__mcpTransport = {
  ready: true,
  sanity,
  runProbe,
  runProbes: (specs) => Promise.all(specs.map(runProbe)),
  env: {
    userAgent: navigator.userAgent,
    isSecureContext: window.isSecureContext,
    pageOrigin: location.origin,
    relayPath: NetworkRuntime.relayPath,
  },
};
