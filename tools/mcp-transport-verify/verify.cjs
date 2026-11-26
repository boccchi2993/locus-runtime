#!/usr/bin/env node
// MCP transport verification: {direct, relay} × {JSON, SSE} in a REAL browser.
//
//   node tools/mcp-transport-verify/verify.cjs [--product <locus-product checkout>]
//        [--chrome <path>] [--out <file>] [--hold-ms N] [--long-hold-ms N]
//        [--skip-long] [--control] [--bearer TOKEN]
//
// A measurement, not a gate: it never fails on an unfavorable verdict. It
// exits non-zero only when the environment could not be brought up (Chrome,
// the relay source), a probe crashed, or the positive control did not pass —
// so the outcome classes stay distinguishable:
//
//   supported         every criterion of the layer measured true
//   not_supported     a criterion measured false
//   env_unavailable   the piece of test environment that layer needs was not
//                     available (recorded with the reason)
//   not_verified      a required measurement is missing
//
// Two layers are measured per combination, because "does it work" has two
// different answers and the fix lives in a different file for each:
//
//   platform   raw browser fetch + ReadableStream: what the browser itself
//              can do on that path (through the relay: its POST envelope,
//              sent by hand)
//   runtime    locus-runtime src/network.js — the substrate every runtime
//              HTTP consumer, an MCP client included, is routed through.
//              On the relay path the REAL relay is in the loop as well:
//              locus-product functions/fetch.js at whatever commit the
//              product checkout is on.
//
// Topology (all loopback; nothing leaves the machine):
//
//   page origin   http://127.0.0.1:APP/tools/mcp-transport-verify/harness.html
//                 + /fetch  (functions/fetch.js handlers, see relayBridge)
//                 + /mcp/*  (the stand-in again, same-origin: the only
//                            direct POST request() can select today)
//   MCP stand-in  http://mcp.test.local:MCP/mcp/{json,sse}
//                 (mcp.test.local → 127.0.0.1: --host-resolver-rules for the
//                  browser, a fetch patch in this process for the relay's
//                  upstream leg — the technique tests/e2e-network.cjs uses.
//                  The name is not a private/loopback STRING, so the relay's
//                  SSRF policy accepts it; nothing else is bypassed.)
//
// Needs a locus-product checkout only for functions/fetch.js; without it the
// two relay combinations are reported env_unavailable and the direct ones
// still run. Needs headless Chrome (CHROME env or --chrome).
//
// --control re-measures the relay combinations with control-relay.mjs (a
// minimal STREAMING pass-through) in place of the real relay: the positive
// control that proves the instrument can report "supported" at all.
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { pathToFileURL } = require('url');

const chrome = require('../../tests/helpers/chrome.cjs');
const {
  DEFAULT_BEARER,
  DEFAULT_EVENT_DELAY_MS,
  PROTOCOL_VERSION,
  createMcpStandalone,
} = require('./mcp-test-server.cjs');

const ROOT = path.join(__dirname, '..', '..');
const PAGE_PATH = '/tools/mcp-transport-verify/harness.html';
const STATIC_PREFIXES = ['/tools/mcp-transport-verify/', '/src/'];
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};
const UPSTREAM_HOST = 'mcp.test.local';

// functions/fetch.js getTimeoutMs() default (FETCH_TIMEOUT_MS unset): the
// relay's own upstream deadline, covering headers AND the whole body.
const RELAY_UPSTREAM_TIMEOUT_MS = 30000;

// Verdict thresholds, all generous relative to the event timings:
const STREAM_MARGIN_MS = 100; // "arrived before the upstream closed" by at least this
const CANCEL_SETTLE_MAX_MS = 1000; // a cancelled read settles within this
const CANCEL_REACH_MAX_MS = 2000; // the upstream notices the cancel within this
const CANCEL_AT_MS = 1000; // cancel while the buffered response is outstanding
const SHORT_DEADLINE_MS = 1000; // a caller deadline shorter than the SSE hold
const DEFAULT_HOLD_MS = 5000; // SSE: connection held open AFTER the response event
const DEFAULT_LONG_HOLD_MS = RELAY_UPSTREAM_TIMEOUT_MS + 5000; // longer than the relay deadline

const COMBOS = ['direct-json', 'direct-sse', 'relay-json', 'relay-sse'];
const RELAY_COMBOS = ['relay-json', 'relay-sse'];

// What this harness deliberately does NOT exercise. Every one of these is
// "not verified", whatever the four verdicts say.
const NOT_VERIFIED = [
  'The deployed Cloudflare edge. functions/fetch.js ran as its real handlers dispatched in Node '
    + '(undici Request/Response — the technique tests/e2e-network.cjs uses). The workerd/Pages '
    + 'runtime (edge buffering, client-disconnect propagation, header handling at the edge) was not exercised.',
  'HTTPS / TLS and HTTP/2 / HTTP/3: the stand-in is plain HTTP/1.1 on loopback.',
  'Real MCP servers: the stand-in answers each POST with exactly one response for the request id. '
    + 'Servers that send notifications or server-initiated requests before the response, batches, '
    + 'or several events per stream were not exercised.',
  'The standalone server-to-client stream (GET <endpoint> with text/event-stream) and session '
    + 'termination (DELETE <endpoint>).',
  'A bearer resolved through the C3 credentials port ($NAME in the Authorization header, '
    + 'redirect:"manual", echo redaction): the probes send a literal TEST bearer header.',
  'Protocol-version negotiation failures (400/404 on MCP-Protocol-Version), 429/retry, '
    + 'resumability via Last-Event-ID, OAuth.',
  'Browsers other than the Chrome recorded in environment.chrome.',
];

function usage() {
  return [
    'usage: node tools/mcp-transport-verify/verify.cjs [options]',
    '',
    '  --product <dir>    locus-product checkout supplying functions/fetch.js',
    '                     (default: the sibling directory ../locus-product)',
    '  --chrome <path>    Chrome executable (default: CHROME env, then the standard location)',
    '  --out <file>       write the JSON report here ("-" = stdout; default: a file under the OS temp dir)',
    '  --hold-ms <n>      SSE hold after the response event (default ' + DEFAULT_HOLD_MS + ')',
    '  --long-hold-ms <n> SSE hold for the relay-deadline probes (default ' + DEFAULT_LONG_HOLD_MS + ',',
    '                     i.e. longer than the relay\'s ' + RELAY_UPSTREAM_TIMEOUT_MS + 'ms upstream timeout)',
    '  --skip-long        skip the two relay-deadline probes (those criteria become not_verified)',
    '  --control          also re-measure the relay combinations against control-relay.mjs',
    '                     (the positive control; adds about a minute)',
    '  --bearer <token>   TEST bearer the stand-in requires (default "' + DEFAULT_BEARER + '")',
    '  --help             this text',
    '',
    'exit codes: 0 measured · 2 harness failure / control did not pass · 3 environment unavailable',
  ].join('\n');
}

function parseArgs(argv) {
  const config = {
    product: path.join(ROOT, '..', 'locus-product'),
    chrome: process.env.CHROME || null,
    out: null,
    holdMs: DEFAULT_HOLD_MS,
    longHoldMs: DEFAULT_LONG_HOLD_MS,
    skipLong: false,
    control: false,
    bearer: DEFAULT_BEARER,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) throw new Error(a + ' requires a value');
      return argv[++i];
    };
    if (a === '--help' || a === '-h') config.help = true;
    else if (a === '--product') config.product = path.resolve(value());
    else if (a === '--chrome') config.chrome = value();
    else if (a === '--out') config.out = value();
    else if (a === '--hold-ms') config.holdMs = Number(value());
    else if (a === '--long-hold-ms') config.longHoldMs = Number(value());
    else if (a === '--skip-long') config.skipLong = true;
    else if (a === '--control') config.control = true;
    else if (a === '--bearer') config.bearer = value();
    else throw new Error('unknown option: ' + a + '\n\n' + usage());
  }
  if (!(config.holdMs >= CANCEL_AT_MS + 1000)) {
    throw new Error('--hold-ms must leave the buffered response outstanding at the cancel point '
      + '(>= ' + (CANCEL_AT_MS + 1000) + ')');
  }
  if (!(config.longHoldMs > RELAY_UPSTREAM_TIMEOUT_MS)) {
    throw new Error('--long-hold-ms must exceed the relay upstream timeout (' + RELAY_UPSTREAM_TIMEOUT_MS + ')');
  }
  return config;
}

// Thrown when a piece of test environment cannot be brought up. It is NOT a
// harness failure: every combination that needs it is reported
// env_unavailable with the reason, and the run exits 3.
class EnvUnavailable extends Error {}

// ------------------------------------------------------------
//  Environment facts for the report
// ------------------------------------------------------------
function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function gitText(dir, args) {
  const r = spawnSync('git', ['-C', dir].concat(args), { encoding: 'utf8', windowsHide: true });
  return r.status === 0 ? r.stdout.trim() : null;
}

function repoFacts(dir, head, files) {
  return {
    head,
    // a locally modified file would make "measured at commit X" untrue
    modified: (gitText(dir, ['status', '--porcelain', '--'].concat(files)) || '')
      .split('\n').filter(Boolean),
  };
}

// A Pages-Function-shaped module: onRequestPost / onRequestGet / onRequestOptions.
async function loadRelayModule(file, label) {
  if (!fs.existsSync(file)) return { error: label + ' not found' };
  let mod;
  try {
    mod = await import(pathToFileURL(file).href);
  } catch (e) {
    return { error: label + ' failed to import: ' + (e && e.message || e) };
  }
  for (const name of ['onRequestPost', 'onRequestGet', 'onRequestOptions']) {
    if (typeof mod[name] !== 'function') return { error: label + ' does not export ' + name };
  }
  return { mod, label, sha256: sha256(file), bytes: fs.statSync(file).size };
}

// ------------------------------------------------------------
//  Servers
// ------------------------------------------------------------
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// The browser → relay leg, standing in for the Pages runtime: the relay's
// REAL handlers, an undici Request carrying the browser's own headers (Origin
// included, so the same-origin enforcement runs for real), and the response
// body STREAMED through unchanged — a relay that streams is observed as
// streaming (control-relay.mjs proves this path). Two runtime services are
// reproduced on purpose:
//   - request.signal aborts when the browser goes away mid-request, so a
//     relay that consulted it would be seen to react (the bridge records
//     whether it was in fact aborted while the handler was still running);
//   - env {} = the production defaults (30s upstream timeout, …).
async function relayBridge(ctx, req, res) {
  if (!ctx.relay) {
    res.writeHead(503, { 'content-type': 'application/json', 'x-locus-relay-error': '1' });
    return res.end(JSON.stringify({ error: { code: 'network_relay_failed', message: 'relay source not loaded in this run' } }));
  }
  const rec = {
    probe: null,
    method: req.method,
    tBrowserReq: Date.now(),
    status: null,
    threw: null,
    tHandlerDone: null,
    handlerMs: null,
    // request.signal state when the handler finished: true = the browser
    // was already gone and the runtime HAD told the relay so
    signalAbortedAtDone: null,
    tBrowserClose: null,
    browserCloseMs: null,
    browserClosedBeforeDone: null,
  };
  ctx.bridgeLog.push(rec);
  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req);
  const headers = Object.assign({}, req.headers);
  delete headers.host;
  delete headers['content-length'];
  delete headers.connection;
  if (req.method === 'POST' && body) {
    // read-only: the probe tag inside the envelope, to line the record up
    try {
      const envelope = JSON.parse(body.toString('utf8'));
      const h = (envelope && envelope.headers) || {};
      rec.probe = h['x-locus-probe'] || h['X-Locus-Probe'] || null;
    } catch (e) { /* malformed envelope: the relay answers it */ }
  }
  const abort = new AbortController();
  res.on('close', () => {
    rec.tBrowserClose = Date.now();
    rec.browserCloseMs = rec.tBrowserClose - rec.tBrowserReq;
    rec.browserClosedBeforeDone = rec.tHandlerDone == null;
    if (!res.writableFinished) abort.abort();
  });
  const deploymentOrigin = 'http://' + (req.headers.host || '127.0.0.1');
  const request = new Request(deploymentOrigin + req.url, {
    method: req.method, headers, body, signal: abort.signal,
  });
  const handler = req.method === 'POST' ? ctx.relay.mod.onRequestPost
    : req.method === 'OPTIONS' ? ctx.relay.mod.onRequestOptions
      : ctx.relay.mod.onRequestGet;
  let resp;
  try {
    resp = await handler({ request, env: {}, waitUntil() {} });
  } catch (e) {
    rec.threw = String((e && e.message) || e);
    rec.tHandlerDone = Date.now();
    rec.handlerMs = rec.tHandlerDone - rec.tBrowserReq;
    rec.signalAbortedAtDone = abort.signal.aborted;
    if (res.destroyed) return;
    res.writeHead(500, { 'content-type': 'application/json', 'x-locus-relay-error': '1' });
    return res.end(JSON.stringify({ error: { code: 'network_relay_failed', message: 'relay handler threw: ' + rec.threw } }));
  }
  rec.tHandlerDone = Date.now();
  rec.handlerMs = rec.tHandlerDone - rec.tBrowserReq;
  rec.status = resp.status;
  rec.signalAbortedAtDone = abort.signal.aborted;
  if (res.destroyed) {
    try { if (resp.body) await resp.body.cancel(); } catch (e) { /* best effort */ }
    return;
  }
  // every header pair as its own line (never collapse duplicates here)
  const out = {};
  resp.headers.forEach((v, k) => {
    if (!Object.prototype.hasOwnProperty.call(out, k)) out[k] = [];
    out[k].push(v);
  });
  res.writeHead(resp.status, out);
  // writeHead() alone holds the header block until the first body write; a
  // relay that returned early must be seen returning early.
  res.flushHeaders();
  if (!resp.body) {
    rec.tBodyDone = Date.now();
    return res.end();
  }
  for await (const chunk of resp.body) {
    if (res.destroyed) break;
    res.write(chunk);
  }
  if (res.destroyed && resp.body) {
    try { await resp.body.cancel(); } catch (e) { /* best effort */ }
  }
  rec.tBodyDone = Date.now();
  res.end();
}

function serveStatic(res, pathname) {
  const rel = pathname === '/' ? PAGE_PATH : pathname;
  const allowed = STATIC_PREFIXES.some((p) => rel.startsWith(p));
  const file = path.normalize(path.join(ROOT, rel));
  if (!allowed || !file.startsWith(ROOT) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    return res.end('not found');
  }
  res.writeHead(200, {
    'content-type': MIME[path.extname(file)] || 'application/octet-stream',
    'cache-control': 'no-store',
  });
  fs.createReadStream(file).pipe(res);
}

function createAppServer(ctx) {
  return http.createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://placeholder').pathname.replace(/\/+$/, '') || '/';
    try {
      if (pathname === '/fetch') return await relayBridge(ctx, req, res);
      if (pathname.startsWith('/mcp/') || pathname === '/__health' || pathname === '/__log') {
        return await ctx.standIn.handler(req, res, 'same-origin');
      }
      if (req.method === 'GET') return serveStatic(res, pathname);
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    } catch (e) {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String((e && e.message) || e) }));
    }
  });
}

// The relay's upstream leg resolves mcp.test.local to the local stand-in.
// DNS mapping only — the relay's own code is untouched.
function installUpstreamMapping(port) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const raw = typeof input === 'string' ? input : (input && input.url) || String(input);
    const withPort = 'http://' + UPSTREAM_HOST + ':';
    const bare = 'http://' + UPSTREAM_HOST + '/';
    let mapped = null;
    if (raw.startsWith(withPort)) mapped = 'http://127.0.0.1:' + raw.slice(withPort.length);
    else if (raw.startsWith(bare)) mapped = 'http://127.0.0.1:' + port + '/' + raw.slice(bare.length);
    return mapped === null ? realFetch(input, init) : realFetch(mapped, init);
  };
}

// ------------------------------------------------------------
//  Browser
// ------------------------------------------------------------
async function evaluate(cdp, expression, timeoutMs) {
  const reply = await cdp.send('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true, timeout: timeoutMs,
  });
  if (reply.exceptionDetails) {
    const d = reply.exceptionDetails;
    throw new Error('page exception: ' + String((d.exception && d.exception.description) || d.text || JSON.stringify(d)).slice(0, 800));
  }
  return reply.result.value;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(predicate, timeoutMs, label) {
  const started = Date.now();
  for (;;) {
    if (predicate()) return;
    if (Date.now() - started >= timeoutMs) throw new Error('timed out waiting for ' + label);
    await sleep(50);
  }
}

// ------------------------------------------------------------
//  Probe plan
// ------------------------------------------------------------
function buildProbes(c) {
  let n = c.idBase;
  const spec = (combo, id, client, url, mode, extra) => Object.assign({
    combo, id, client, url, mode,
    rpcId: ++n,
    bearer: c.bearer,
    holdMs: mode === 'sse' ? c.holdMs : 0,
  }, extra || {});
  // raw fetch against the relay: the envelope by hand, target = the cross-origin stand-in
  const viaRelay = (id, mode, extra) => Object.assign(
    spec('relay-' + mode, id, 'fetch', '/fetch', mode, extra),
    { envelope: true, targetUrl: c.crossBase + '/mcp/' + mode });
  const cancelAt = { cancel: { type: 'at', ms: CANCEL_AT_MS } };
  const R = c.relayId;

  const direct = [
    // ---- direct × JSON ----
    [
      spec('direct-json', 'D-J1', 'fetch', c.crossBase + '/mcp/json', 'json'),
      spec('direct-json', 'D-J2', 'fetch', c.crossBase + '/mcp/json?expose=0', 'json'),
      spec('direct-json', 'D-J3', 'nr-direct', c.crossBase + '/mcp/json', 'json'),
      spec('direct-json', 'D-J4', 'nr-request', c.sameBase + '/mcp/json', 'json'),
    ],
    // ---- direct × SSE ----
    [
      spec('direct-sse', 'D-S1', 'fetch', c.crossBase + '/mcp/sse', 'sse'),
    ],
    [
      spec('direct-sse', 'D-S2', 'fetch', c.crossBase + '/mcp/sse', 'sse', { cancel: { type: 'after-response' } }),
    ],
    [
      spec('direct-sse', 'D-S3', 'nr-direct', c.crossBase + '/mcp/sse', 'sse'),
    ],
    [
      spec('direct-sse', 'D-S4', 'nr-direct', c.crossBase + '/mcp/sse', 'sse', cancelAt),
    ],
    [
      spec('direct-sse', 'D-S5', 'nr-direct', c.crossBase + '/mcp/sse', 'sse', { timeoutMs: SHORT_DEADLINE_MS }),
    ],
    [
      spec('direct-sse', 'D-S6', 'nr-request', c.sameBase + '/mcp/sse', 'sse'),
    ],
    [
      spec('direct-sse', 'D-S7', 'nr-request', c.sameBase + '/mcp/sse', 'sse', { timeoutMs: SHORT_DEADLINE_MS }),
    ],
  ];
  const relay = [
    // ---- relay × JSON ----
    [
      viaRelay(R + '-J1', 'json'),
      spec('relay-json', R + '-J2', 'nr-request', c.crossBase + '/mcp/json', 'json'),
    ],
    // ---- relay × SSE ----
    [
      viaRelay(R + '-S1', 'sse'),
    ],
    [
      viaRelay(R + '-S2', 'sse', cancelAt),
    ],
    [
      spec('relay-sse', R + '-S4', 'nr-request', c.crossBase + '/mcp/sse', 'sse'),
    ],
    [
      spec('relay-sse', R + '-S5', 'nr-request', c.crossBase + '/mcp/sse', 'sse', cancelAt),
    ],
  ];
  if (!c.skipLong) {
    // concurrent on purpose: both wait out the relay's upstream deadline
    const long = { holdMs: c.longHoldMs };
    relay.push([
      viaRelay(R + '-S3', 'sse', long),
      spec('relay-sse', R + '-S6', 'nr-request', c.crossBase + '/mcp/sse', 'sse', long),
    ]);
  }
  return c.onlyRelay ? relay : direct.concat(relay);
}

function groupTimeoutMs(group, eventDelayMs) {
  let worst = 0;
  for (const s of group) {
    // how long the PAGE side can be outstanding before it must have settled
    const buffered = s.holdMs + eventDelayMs + 15000;
    const cancelled = s.cancel && s.cancel.type === 'at' ? s.cancel.ms + 15000 : 0;
    worst = Math.max(worst, buffered, cancelled, 20000);
  }
  return worst;
}

async function runGroup(cdp, ctx, group) {
  // one stand-in hold per group (the stand-in reads it when a request lands)
  const holdMs = group[0].holdMs;
  ctx.standIn.options.holdMs = holdMs;
  const pages = await evaluate(cdp,
    'window.__mcpTransport.runProbes(' + JSON.stringify(group) + ')',
    groupTimeoutMs(group, ctx.standIn.options.eventDelayMs));
  // Let every upstream connection actually close before judging: when a
  // cancel does NOT propagate, the upstream stays open until its hold timer
  // fires, and that late 'server' close is exactly the evidence. A probe the
  // upstream never saw (refused before dispatch) must not stall the run: the
  // wait gives up and that probe is reported as not measured.
  let upstreamWait = 'all upstream connections closed';
  try {
    await waitUntil(() => group.every((s) => {
      const entry = ctx.standIn.log.find((e) => e.probe === s.id);
      return !!entry && entry.tClose != null;
    }), holdMs + ctx.standIn.options.eventDelayMs + RELAY_UPSTREAM_TIMEOUT_MS + 5000);
  } catch (e) {
    upstreamWait = 'gave up waiting for an upstream connection to close: ' + String(e && e.message || e);
  }
  await sleep(150); // let 'close' handlers and bridge records finish
  return group.map((spec, i) => ({
    spec,
    page: pages[i],
    upstreamWait,
    upstream: ctx.standIn.log.filter((e) => e.probe === spec.id),
    relay: ctx.bridgeLog.filter((b) => b.probe === spec.id),
  }));
}

async function runPlan(cdp, ctx, plan, env, into, failures) {
  for (const group of plan) {
    // a group whose environment is unavailable is skipped, not faked: its
    // probes stay absent and the verdict reports env_unavailable / not_verified
    const needsRelay = group.some((s) => s.combo.startsWith('relay'));
    if (needsRelay ? !env.relay.ok : !env.direct.ok) continue;
    console.error('running ' + group.map((s) => s.id).join(' '));
    try {
      for (const probe of await runGroup(cdp, ctx, group)) {
        const r = assess(probe);
        into.push(r);
        if (!r.facts.measured) failures.push(r.id + ': not measured (page harnessError='
          + JSON.stringify(r.browser.harnessError) + ', upstream entries=' + probe.upstream.length
          + (probe.upstreamWait === 'all upstream connections closed' ? '' : ', ' + probe.upstreamWait) + ')');
      }
    } catch (e) {
      failures.push(group.map((s) => s.id).join(',') + ': ' + String(e && e.message || e));
    }
  }
}

// ------------------------------------------------------------
//  Assessment
// ------------------------------------------------------------
function assess(probe) {
  const { page, upstream, relay } = probe;
  const spec = probe.spec;
  const server = upstream[0] || null;
  const bridge = relay[0] || null;
  const text = page.response && page.response.result && page.response.result.content
    ? String(page.response.result.content[0] && page.response.result.content[0].text || '') : '';
  const serverSentId = !!(server && server.sessionId);
  const hasHttpResponse = page.status != null;
  const facts = {
    measured: !page.harnessError && page.t.end != null && upstream.length === 1 && !!server.status,
    responseMatchesRequestId: !!page.response && page.response.id === spec.rpcId && text.includes('probe=' + spec.id),
    status: page.status,
    // null = there was no HTTP response to read a header from
    sessionIdReadable: !hasHttpResponse ? null : (serverSentId ? page.sessionId === server.sessionId : false),
    upstreamSawBearer: !!(server && server.auth === 'ok'),
    closedBy: server ? server.closedBy : null,
  };
  // browser timeline (ms after the page probe started)
  const t = page.t;
  const round = (x) => (x == null ? null : Math.round(x));
  // upstream timeline on the same wall clock
  const upstreamEventAt = server && server.tEvent != null ? server.tEvent - page.wallStart : null;
  const upstreamCloseAt = server && server.tClose != null ? server.tClose - page.wallStart : null;
  if (spec.mode === 'sse') {
    // same wall clock on both sides: did the response reach the browser
    // while the upstream was still holding the connection open?
    facts.responseBeforeUpstreamClose = !!(facts.responseMatchesRequestId && t.response != null
      && upstreamCloseAt != null && t.response < upstreamCloseAt - STREAM_MARGIN_MS);
  }
  if (page.cancelled && t.cancel != null) {
    facts.cancelToSettledMs = t.readSettled == null ? null : Math.round(t.readSettled - t.cancel);
    // did the cancellation reach the upstream before its own hold expired?
    const cancelWall = page.wallStart + t.cancel;
    facts.cancelReachedUpstream = !!(server && server.closedBy === 'client'
      && server.tClose >= cancelWall - STREAM_MARGIN_MS
      && server.tClose <= cancelWall + CANCEL_REACH_MAX_MS);
  }
  return {
    id: spec.id,
    combo: spec.combo,
    client: spec.client,
    mode: spec.mode,
    url: spec.envelope ? spec.targetUrl + ' (via POST /fetch envelope)' : spec.url,
    rpcId: spec.rpcId,
    holdMs: spec.holdMs || null,
    cancel: spec.cancel || null,
    timeoutMs: spec.timeoutMs || null,
    browser: {
      wallStart: page.wallStart,
      headersMs: round(t.headers),
      responseMs: round(t.response),
      cancelMs: round(t.cancel),
      readSettledMs: round(t.readSettled),
      endMs: round(t.end),
      status: page.status,
      contentType: page.contentType,
      sessionId: page.sessionId,
      relayErrorHeader: page.relayError || null,
      backend: page.backend,
      bytes: page.bytes,
      postCancelRead: page.postCancelRead || null,
      bodyPreview: page.bodyPreview || null,
      error: page.error || null,
      harnessError: page.harnessError || null,
    },
    upstream: server ? {
      wallReq: server.tReq,
      eventMs: round(upstreamEventAt),
      closeMs: round(upstreamCloseAt),
      closedBy: server.closedBy,
      auth: server.auth,
      status: server.status,
      sentSessionId: serverSentId,
      accept: server.accept,
      protocolVersion: server.protocolVersion,
      exposeSessionId: server.exposeSessionId,
    } : null,
    relayBridge: bridge ? {
      status: bridge.status,
      handlerMs: bridge.handlerMs,
      signalAbortedAtDone: bridge.signalAbortedAtDone,
      browserCloseMs: bridge.browserCloseMs,
      browserClosedBeforeDone: bridge.browserClosedBeforeDone,
      threw: bridge.threw,
    } : null,
    facts,
  };
}

// What each measured fact means when it is used as a criterion.
const CRITERIA = {
  responseMatchesRequestId: 'the JSON-RPC response for the request id reached the client',
  responseBeforeUpstreamClose: 'the response arrives BEFORE the upstream closes (streaming)',
  sessionIdReadable: 'MCP-Session-Id is readable by the client',
  upstreamSawBearer: 'the upstream received the bearer',
  cancelToSettledMs: 'the outstanding read settles after cancel',
  cancelReachedUpstream: 'the cancel closes the upstream connection',
};

// One layer's verdict from named criteria. ok === null = not measured.
function layerVerdict(env, criteria) {
  if (!env.ok) return { verdict: 'env_unavailable', reason: env.reason, criteria };
  const missing = criteria.filter((c) => c.ok === null).map((c) => c.id);
  const failed = criteria.filter((c) => c.ok === false).map((c) => c.id);
  if (failed.length) return { verdict: 'not_supported', failed, notMeasured: missing, criteria };
  if (missing.length) return { verdict: 'not_verified', notMeasured: missing, criteria };
  return { verdict: 'supported', criteria };
}

// The same rulebook for the real relay and for the control. A probe is
// addressed by <combination>#<suffix> — "relay-sse#S1" is R-S1 in the real
// run and C-S1 in the control run — so the rules never name a relay.
function verdictsFor(results, directEnv, relayEnv, combos) {
  const byKey = {};
  for (const r of results) byKey[r.combo + '#' + r.id.slice(2)] = r;
  // a criterion is "not measured" (null) unless its probe actually produced a
  // measurement in this run
  const fact = (key, name) => {
    const r = byKey[key];
    if (!r || !r.facts.measured) return null;
    const v = r.facts[name];
    return v === undefined || v === null ? null : v;
  };
  const rule = (key, name) => ({ id: key.replace('#', ': ') + ': ' + CRITERIA[name], ok: fact(key, name) });
  // "a response arrived although the stream outlived the deadline"
  const survives = (key) => rule(key, 'responseMatchesRequestId');
  const streaming = (key) => rule(key, 'responseBeforeUpstreamClose');
  const settles = (key) => {
    const r = rule(key, 'cancelToSettledMs');
    r.ok = r.ok === null ? null : r.ok <= CANCEL_SETTLE_MAX_MS;
    return r;
  };
  const reachesUpstream = (key) => rule(key, 'cancelReachedUpstream');
  const matches = (key) => rule(key, 'responseMatchesRequestId');
  const session = (key) => rule(key, 'sessionIdReadable');
  const bearer = (key) => rule(key, 'upstreamSawBearer');
  const c = (combo) => (suffix) => combo + '#' + suffix;

  const DJ = c('direct-json');
  const DS = c('direct-sse');
  const RJ = c('relay-json');
  const RS = c('relay-sse');
  const rules = {
    'direct-json': {
      platform: [directEnv, [matches(DJ('J1')), session(DJ('J1'))]],
      runtime: [directEnv, [matches(DJ('J3')), session(DJ('J3')), matches(DJ('J4')), session(DJ('J4'))]],
    },
    'direct-sse': {
      platform: [directEnv, [matches(DS('S1')), streaming(DS('S1')), session(DS('S1')), settles(DS('S2')), reachesUpstream(DS('S2'))]],
      runtime: [directEnv, [
        matches(DS('S3')), streaming(DS('S3')), settles(DS('S4')), reachesUpstream(DS('S4')), survives(DS('S5')),
        matches(DS('S6')), survives(DS('S7')),
      ]],
    },
    'relay-json': {
      platform: [relayEnv, [matches(RJ('J1')), bearer(RJ('J1')), session(RJ('J1'))]],
      runtime: [relayEnv, [matches(RJ('J2')), bearer(RJ('J2')), session(RJ('J2'))]],
    },
    'relay-sse': {
      platform: [relayEnv, [matches(RS('S1')), streaming(RS('S1')), session(RS('S1')), settles(RS('S2')), reachesUpstream(RS('S2')), survives(RS('S3'))]],
      runtime: [relayEnv, [matches(RS('S4')), streaming(RS('S4')), settles(RS('S5')), reachesUpstream(RS('S5')), survives(RS('S6'))]],
    },
  };
  const out = {};
  for (const combo of combos) {
    out[combo] = {};
    for (const layer of ['platform', 'runtime']) {
      const [env, criteria] = rules[combo][layer];
      out[combo][layer] = layerVerdict(env, criteria);
    }
  }
  return out;
}

// ------------------------------------------------------------
//  Report
// ------------------------------------------------------------
const ms = (v) => (v == null ? '-' : String(v));

function pad(text, width) {
  const s = String(text);
  return s.length >= width ? s + ' ' : s + ' '.repeat(width - s.length + 1);
}

function sessionLabel(r) {
  const v = r.facts.sessionIdReadable;
  if (v === null) return 'n/a (no response)';
  if (v === true) return 'readable';
  // false: who withheld it?
  if (r.upstream && r.upstream.exposeSessionId === false && !r.relayBridge) return 'HIDDEN (no expose header)';
  if (r.browser.relayErrorHeader) return 'none (relay error ' + r.browser.status + ')';
  return 'UNREADABLE';
}

function printHeader() {
  console.log([
    pad('id', 6), pad('client', 11), pad('mode', 5), pad('http', 8), pad('resp@ms', 9), pad('hdr@ms', 8),
    pad('end@ms', 8), pad('backend', 13), pad('upstream: event@ms  close@ms  closed by', 42),
    pad('MCP-Session-Id', 28), pad('bearer', 8), pad('cancel→settled ms', 19), 'error',
  ].join(''));
}

function printProbe(r) {
  const b = r.browser;
  const u = r.upstream;
  const cancel = b.cancelMs == null ? '-' : ms(b.cancelMs) + '→' + ms(r.facts.cancelToSettledMs);
  const err = b.harnessError ? 'HARNESS ' + b.harnessError.message
    : b.error ? (b.error.networkCode || b.error.name) : '';
  console.log([
    pad(r.id, 6), pad(r.client, 11), pad(r.mode, 5), pad(b.status == null ? '-' : b.status, 8),
    pad(ms(b.responseMs), 9), pad(ms(b.headersMs), 8), pad(ms(b.endMs), 8), pad(b.backend || '-', 13),
    pad(u ? ms(u.eventMs) + '  ' + ms(u.closeMs) + '  ' + u.closedBy : 'upstream not reached', 42),
    pad(sessionLabel(r), 28),
    pad(r.facts.upstreamSawBearer ? 'ok' : r.upstream ? r.upstream.auth : '-', 8),
    pad(cancel, 19), err,
  ].join(''));
}

function printVerdicts(verdicts, combos) {
  for (const combo of combos) {
    const v = (verdicts && verdicts[combo]) || {};
    for (const layer of ['platform', 'runtime']) {
      const l = v[layer] || { verdict: 'not_verified', notMeasured: ['no probes ran'] };
      console.log(pad(combo, 13) + pad(layer, 10) + l.verdict + (l.reason ? ' — ' + l.reason : ''));
      for (const f of l.failed || []) console.log('  failed:      ' + f);
      for (const m of l.notMeasured || []) console.log('  not measured: ' + m);
    }
  }
}

// ------------------------------------------------------------
//  Main
// ------------------------------------------------------------
async function main() {
  let config;
  try {
    config = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(String(e && e.message || e));
    return 2;
  }
  if (config.help) {
    console.log(usage());
    return 0;
  }

  const started = Date.now();
  const servers = [];
  let chromeHandle = null;
  let cdp = null;
  const ctx = { relay: null, bridgeLog: [], standIn: null };
  const results = [];
  const failures = [];
  const env = {
    direct: { ok: false, reason: 'the environment check did not run' },
    relay: { ok: false, reason: 'relay source not loaded' },
  };
  let unavailable = null; // EnvUnavailable message, for the report

  const report = {
    schema: 1,
    generatedAt: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: process.platform + ' ' + os.release(),
      chrome: null,
      pageOrigin: null,
      upstreamOrigin: null,
      unavailable: null,
      runtimeRepo: repoFacts(ROOT, gitText(ROOT, ['rev-parse', 'HEAD']), ['src/network.js', 'tools/mcp-transport-verify']),
      networkJsSha256: sha256(path.join(ROOT, 'src', 'network.js')),
      productRepo: null,
      standIn: {
        protocolVersion: PROTOCOL_VERSION,
        eventDelayMs: DEFAULT_EVENT_DELAY_MS,
        holdMs: config.holdMs,
        longHoldMs: config.skipLong ? null : config.longHoldMs,
      },
      thresholds: { STREAM_MARGIN_MS, CANCEL_SETTLE_MAX_MS, CANCEL_REACH_MAX_MS, CANCEL_AT_MS, SHORT_DEADLINE_MS, RELAY_UPSTREAM_TIMEOUT_MS },
    },
    probes: results,
    verdicts: null,
    control: null,
    notVerified: NOT_VERIFIED,
    harnessFailures: failures,
  };

  try {
    // ---- environment: relay source ----
    const relayFile = path.join(config.product, 'functions', 'fetch.js');
    const relay = await loadRelayModule(relayFile, 'functions/fetch.js');
    if (relay.error) {
      env.relay = { ok: false, reason: relay.error };
      console.error('relay source unavailable: ' + relay.error
        + ' (pass --product <locus-product checkout>; the relay combinations will be reported env_unavailable)');
    } else {
      ctx.relay = relay;
      report.environment.productRepo = Object.assign(
        repoFacts(config.product, gitText(config.product, ['rev-parse', 'HEAD']), ['functions/fetch.js']),
        { relaySha256: relay.sha256 },
      );
    }

    // ---- servers ----
    ctx.standIn = createMcpStandalone({ eventDelayMs: DEFAULT_EVENT_DELAY_MS, holdMs: config.holdMs });
    const mcp = await chrome.listenWithRetry(
      (port) => http.createServer((req, res) => ctx.standIn.handler(req, res, 'cross-origin')),
      await chrome.allocateFreePort());
    servers.push(mcp.server);
    installUpstreamMapping(mcp.port);

    const app = await chrome.listenWithRetry(() => createAppServer(ctx), await chrome.allocateFreePort());
    servers.push(app.server);

    const appUrl = 'http://127.0.0.1:' + app.port + PAGE_PATH;
    const crossBase = 'http://' + UPSTREAM_HOST + ':' + mcp.port;
    const sameBase = 'http://127.0.0.1:' + app.port;
    report.environment.pageOrigin = sameBase;
    report.environment.upstreamOrigin = crossBase;
    const probesOf = (extra) => buildProbes(Object.assign({
      crossBase, sameBase, bearer: config.bearer, holdMs: config.holdMs,
      longHoldMs: config.longHoldMs, skipLong: config.skipLong,
    }, extra));

    // ---- browser ----
    let version = null;
    try {
      chromeHandle = await chrome.launchChrome(appUrl, {
        chromePath: config.chrome,
        label: 'mcp-transport Chrome',
        extraArgs: [
          '--host-resolver-rules=MAP ' + UPSTREAM_HOST + ' 127.0.0.1',
          // the mapped name must be connected to directly, whatever the system proxy is
          '--no-proxy-server',
          '--disable-background-timer-throttling',
          '--disable-renderer-backgrounding',
          '--disable-backgrounding-occluded-windows',
        ],
      });
      version = await chrome.waitForCdp(chromeHandle);
      const target = await chrome.waitForPageTarget(chromeHandle, appUrl);
      cdp = await chrome.connectToTarget(target);
      await chrome.waitForRuntimeCondition(cdp, '!!(window.__mcpTransport && window.__mcpTransport.ready)', {
        process: chromeHandle, phase: 'harness-boot', description: 'harness page unavailable: module did not become ready', timeoutMs: 20000,
      });
    } catch (e) {
      // no browser = no measurement: an environment that is unavailable,
      // not one that failed
      throw new EnvUnavailable('browser environment unavailable: '
        + String((e && e.message) || e).split(/\r?\n/)[0]);
    }
    report.environment.chrome = { browser: version.Browser || null, userAgent: version['User-Agent'] || null };
    console.error('chrome: ' + (version.Browser || '?')
      + ' | runtime ' + (report.environment.runtimeRepo.head || '?') + (report.environment.runtimeRepo.modified.length ? ' (modified)' : ' (clean)')
      + ' | relay ' + (ctx.relay ? (report.environment.productRepo.head || '?') + ' ' + relay.sha256.slice(0, 12) : 'unavailable'));

    // ---- is the test environment usable at all? ----
    const sanityExpression = 'window.__mcpTransport.sanity(' + JSON.stringify(crossBase) + ')';
    const sanity = await evaluate(cdp, sanityExpression, 30000);
    report.environment.sanity = sanity;
    env.direct = sanity.direct.ok ? { ok: true }
      : { ok: false, reason: 'browser could not reach the cross-origin stand-in: ' + JSON.stringify(sanity.direct) };
    if (ctx.relay) {
      env.relay = sanity.relay.ok ? { ok: true }
        : { ok: false, reason: 'relay leg did not answer the sanity GET: ' + JSON.stringify(sanity.relay) };
    }
    if (!env.direct.ok) console.error('direct environment unavailable: ' + env.direct.reason);
    if (!env.relay.ok) console.error('relay environment unavailable: ' + env.relay.reason);

    // ---- the measurement: real relay ----
    await runPlan(cdp, ctx, probesOf({ idBase: 1000, relayId: 'R' }), env, results, failures);

    // ---- positive control: same probes, control relay ----
    if (config.control) {
      const control = await loadRelayModule(path.join(__dirname, 'control-relay.mjs'), 'control-relay.mjs');
      if (control.error) {
        failures.push('positive control unavailable: ' + control.error);
        report.control = { error: control.error };
      } else if (!env.relay.ok) {
        report.control = { skipped: 'relay environment unavailable' };
      } else {
        console.error('--- positive control: relay swapped for control-relay.mjs (relay combinations only) ---');
        ctx.relay = control;
        const controlSanity = await evaluate(cdp, sanityExpression, 30000);
        const controlEnv = {
          direct: env.direct,
          relay: controlSanity.relay.ok ? { ok: true }
            : { ok: false, reason: 'control relay leg did not answer the sanity GET: ' + JSON.stringify(controlSanity.relay) },
        };
        const controlResults = [];
        await runPlan(cdp, ctx, probesOf({ idBase: 2000, relayId: 'C', onlyRelay: true }), controlEnv, controlResults, failures);
        const controlVerdicts = verdictsFor(controlResults, controlEnv.direct, controlEnv.relay, RELAY_COMBOS);
        report.control = {
          relay: { label: control.label, sha256: control.sha256 },
          sanity: controlSanity.relay,
          probes: controlResults,
          verdicts: controlVerdicts,
        };
        // The control has no verdict of its own to defend: it exists to show
        // the platform layer CAN read supported here. A criterion measuring
        // FALSE against the control means the instrument is broken and the
        // real-relay verdicts are not verified. "not_verified" is acceptable
        // (--skip-long leaves the deadline probes unmeasured on both sides).
        for (const combo of RELAY_COMBOS) {
          const verdict = controlVerdicts[combo].platform.verdict;
          if (verdict === 'not_supported' || verdict === 'env_unavailable') {
            failures.push('positive control did not pass (' + combo + ', platform layer: ' + verdict
              + ') — the real-relay verdicts are NOT verified');
          }
        }
      }
    }
  } catch (e) {
    if (e instanceof EnvUnavailable) {
      unavailable = e.message;
      report.environment.unavailable = unavailable;
      if (!env.direct.ok) env.direct = { ok: false, reason: unavailable };
      // a relay source that was never found keeps its own, more specific reason
      if (!env.relay.ok && ctx.relay) env.relay = { ok: false, reason: unavailable };
      console.error(unavailable);
    } else {
      failures.push(String((e && e.stack) || e));
    }
  } finally {
    if (cdp) {
      try { cdp.close(); } catch (e) { /* best effort */ }
    }
    if (chromeHandle) {
      const cleanup = await chrome.closeChrome(chromeHandle);
      if (!cleanup.exited) console.error('Chrome did not exit after bounded cleanup');
    }
    for (const s of servers) {
      try { await new Promise((r) => s.close(r)); } catch (e) { /* best effort */ }
    }
  }

  // Verdicts come from whatever was measured. A missing relay source never
  // stops the direct probes, so the direct verdicts stand on their own.
  report.verdicts = verdictsFor(results, env.direct, env.relay, COMBOS);
  report.durationMs = Date.now() - started;

  console.log('\n=== probes (real relay: functions/fetch.js) ===');
  printHeader();
  for (const r of results) printProbe(r);
  console.log('\n=== verdicts (real relay) ===');
  printVerdicts(report.verdicts, COMBOS);
  if (report.control && report.control.probes) {
    console.log('\n=== probes (positive control: control-relay.mjs) ===');
    printHeader();
    for (const r of report.control.probes) printProbe(r);
    console.log('\n=== verdicts (positive control) ===');
    printVerdicts(report.control.verdicts, RELAY_COMBOS);
  }
  if (failures.length) {
    console.log('\n=== harness failures ===');
    for (const f of failures) console.log('  ' + f);
  }
  console.log('\nnot verified by this harness:');
  for (const item of NOT_VERIFIED) console.log('  - ' + item);

  const out = config.out || path.join(os.tmpdir(), 'locus-mcp-transport-report-' + Date.now() + '.json');
  const json = JSON.stringify(report, null, 2);
  if (out === '-') console.log(json);
  else {
    fs.writeFileSync(out, json);
    console.log('\nreport written to ' + out);
  }

  if (failures.length) return 2;
  return env.direct.ok && env.relay.ok ? 0 : 3;
}

main().then((code) => process.exit(code), (e) => {
  console.error(e && e.stack || e);
  process.exit(2);
});
