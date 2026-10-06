// NetworkRuntime v1 unit tests (node, mocked fetch, real ApprovalController).
// Run: node tests/network-runtime.test.cjs
// Covers the v1 matrix (docs/NETWORK-RUNTIME.md): URL/scheme/origin
// canonicalization, method classification, route planning, GET fallback,
// side-effect no-retry, approval consumer semantics (deny/cancel/grant/
// TOCTOU), redirect policy, request/response bounds, abort/timeout,
// header filtering, private-target detection and the error taxonomy.

// --- browser stubs ---
global.window = { location: { protocol: 'https:' } }; // hosted page → relay available

const M = require('./helpers/core.cjs');
const { FakeApprovalPort } = require('./helpers/approval-port.cjs');

const unhandled = [];
process.on('unhandledRejection', (e) => { unhandled.push(e); });

// --- fetch mock ---
let calls = [];
let routes = [];
function on(match, respond) { routes.push({ match, respond }); }
global.fetch = async (url, opts) => {
  calls.push({ url: String(url), opts: opts || {} });
  for (const r of routes) {
    if (r.match(String(url), opts || {})) return r.respond(String(url), opts || {});
  }
  throw new Error('no mock route for ' + url);
};
function jsonResponse(body, headers) {
  return new Response(body, { status: 200, headers: Object.assign({ 'content-type': 'application/json' }, headers) });
}

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + detail : '')); }
}
function reset() { calls = []; routes = []; }
async function errOf(p) { try { await p; return null; } catch (e) { return e; } }
function pageLoc(loc) { global.window.location = loc; }
const tick = () => new Promise((r) => setTimeout(r, 0));

// A scripted approval provider (unit-level); the REAL controller is used
// in the dedicated integration section below.
function fakeApprovals(script) {
  const asks = [];
  return {
    asks,
    request(spec, opts) {
      asks.push(spec);
      return Promise.resolve(script ? script(spec, opts) : { outcome: 'allow', scope: 'once' });
    },
  };
}

async function run() {
  const RT = M.NetworkRuntime;

  // ============ 1. URL parsing / scheme policy / canonicalization ============
  reset();
  let e = await errOf(RT.request({ url: 'not a url' }));
  check('U1 invalid URL → network_invalid_url', e && e.networkCode === 'network_invalid_url', e && e.message);

  for (const bad of ['ftp://example.com/x', 'file:///etc/passwd', 'data:text/html,hi',
    'javascript:alert(1)', 'ws://example.com/', 'wss://example.com/', 'about:blank', 'chrome://settings']) {
    e = await errOf(RT.request({ url: bad }));
    check('U2 scheme refused: ' + bad, e && e.networkCode === 'network_unsupported_scheme' && calls.length === 0,
      e && e.networkCode);
  }

  e = await errOf(RT.request({ url: 'https://user:pass@example.test/x' }));
  check('U3 URL userinfo rejected', e && /credentials in URLs/.test(e.message) && calls.length === 0, e && e.message);

  // fragment never reaches the wire
  reset();
  on((u) => u === 'https://example.test/doc', () => jsonResponse('{}'));
  await RT.request({ url: 'https://example.test/doc#section-2' });
  check('U4 fragment stripped from request URL', calls.length === 1 && calls[0].url === 'https://example.test/doc',
    calls[0] && calls[0].url);

  // ============ 2. method classification ============
  e = await errOf(RT.request({ url: 'https://example.test/x', method: 'TRACE' }));
  check('M1 TRACE refused', e && e.networkCode === 'network_unsupported_method', e && e.networkCode);
  e = await errOf(RT.request({ url: 'https://example.test/x', method: 'CONNECT' }));
  check('M2 CONNECT refused', e && e.networkCode === 'network_unsupported_method', e && e.networkCode);
  e = await errOf(RT.request({ url: 'https://example.test/x', method: 'PURGE' }));
  check('M3 custom verb refused', e && e.networkCode === 'network_unsupported_method', e && e.networkCode);
  e = await errOf(RT.request({ url: 'https://example.test/x', method: 'NOT A METHOD' }));
  check('M4 non-token refused', e && e.networkCode === 'network_unsupported_method', e && e.networkCode);

  // ============ 3. route planning ============
  // read-like: direct first; relay only on genuine TypeError
  reset();
  on((u) => u === 'https://example.test/ok', () => jsonResponse('{"direct":1}'));
  const r3 = await RT.request({ url: 'https://example.test/ok' });
  check('R1 GET → browser-direct', r3.backend === 'browser-direct' && calls.length === 1, r3.backend);

  reset();
  on((u) => u === 'https://blocked.test/a', () => { throw new TypeError('Failed to fetch'); });
  on((u) => u.startsWith('/fetch?'), () =>
    jsonResponse('{"via":"relay"}', { 'x-locus-final-url': 'https://blocked.test/a' }));
  const r3b = await RT.request({ url: 'https://blocked.test/a' });
  check('R2 GET TypeError → relay once (legacy form)', r3b.backend === 'edge-relay'
    && calls.length === 2 && calls[1].url.startsWith('/fetch?') && calls[1].opts.method === 'GET',
    calls.map((c) => c.url).join(' -> '));

  reset();
  on((u) => u === 'https://blocked.test/h', () => { throw new TypeError('Failed to fetch'); });
  on((u, o) => u === '/fetch' && o.method === 'POST', () => jsonResponse('{"via":"envelope"}'));
  const r3c = await RT.request({ url: 'https://blocked.test/h', headers: { 'x-a': '1' } });
  check('R3 GET with headers → relay envelope', r3c.backend === 'edge-relay'
    && calls.length === 2 && calls[1].url === '/fetch' && calls[1].opts.method === 'POST',
    calls.map((c) => c.method + ' ' + c.url).join(' -> '));

  // side-effecting cross-origin → relay FIRST, exactly one upstream send
  reset();
  on((u, o) => u === '/fetch' && o.method === 'POST', () => jsonResponse('{"posted":1}'));
  const approvals = fakeApprovals();
  const r3d = await RT.request({ method: 'POST', url: 'https://api.example.test/submit',
    body: 'hello', authorization: { request: approvals.request.bind(approvals) } });
  check('R4 cross-origin POST → relay first', r3d.backend === 'edge-relay' && calls.length === 1
    && calls[0].url === '/fetch' && calls[0].opts.method === 'POST', JSON.stringify(calls));

  // side-effecting same-origin → direct
  pageLoc({ protocol: 'https:', host: 'app.test' });
  reset();
  on((u, o) => u === 'https://app.test/api' && o.method === 'POST', () => jsonResponse('{"same":1}'));
  const r3e = await RT.request({ method: 'POST', url: 'https://app.test/api', authorization: { request: approvals.request.bind(approvals) } });
  check('R5 same-origin POST → direct', r3e.backend === 'browser-direct' && calls.length === 1, JSON.stringify(calls));
  pageLoc({ protocol: 'https:' });

  // ============ 4. GET fallback rules ============
  // a real HTTP response is authoritative — never re-sent via relay
  reset();
  on((u) => u === 'https://example.test/missing', () => new Response('{"error":"nf"}', { status: 404 }));
  on(() => { throw new Error('relay must NOT be called'); });
  e = await errOf(RT.request({ url: 'https://example.test/missing' }));
  check('F1 404 is authoritative, no relay', e === null && calls.length === 1, 'calls=' + calls.length);

  // timeout is not a network failure — never relayed
  reset();
  on((u) => u === 'https://slow.test/x', () => new Promise((resolve, reject) => {
    const sig = calls[calls.length - 1].opts.signal;
    if (sig) sig.addEventListener('abort', () => { const er = new Error('aborted'); er.name = 'AbortError'; reject(er); });
  }));
  on(() => { throw new Error('relay must NOT be called on timeout'); });
  e = await errOf(RT.request({ url: 'https://slow.test/x', timeoutMs: 30 }));
  check('F2 timeout not relayed', e && e.timeout === true && e.networkCode === 'network_timeout' && calls.length === 1,
    e && e.networkCode + ' calls=' + calls.length);

  // response cap is not a network failure — never relayed
  reset();
  on((u) => u === 'https://example.test/huge', () => new Response('x', {
    status: 200, headers: { 'content-type': 'text/plain', 'content-length': String(20 * 1024 * 1024) },
  }));
  on(() => { throw new Error('relay must NOT be called on size cap'); });
  e = await errOf(RT.request({ url: 'https://example.test/huge' }));
  check('F3 response cap not relayed', e && e.tooLarge === true && e.networkCode === 'network_response_too_large'
    && calls.length === 1, e && e.networkCode + ' calls=' + calls.length);

  // private target: direct failure is NOT retried via the relay
  reset();
  on((u) => u === 'http://127.0.0.1:9/x', () => { throw new TypeError('Failed to fetch'); });
  on(() => { throw new Error('relay must NOT be called for private targets'); });
  e = await errOf(RT.request({ url: 'http://127.0.0.1:9/x' }));
  check('F4 private GET failure → network_private_address_blocked, no relay',
    e && e.networkCode === 'network_private_address_blocked' && calls.length === 1,
    e && e.networkCode + ' calls=' + calls.length);

  // ============ 5. side-effect no-retry invariants ============
  // ambiguous relay failure: exactly one dispatch, never a second attempt
  reset();
  on((u, o) => u === '/fetch' && o.method === 'POST', () => { throw new TypeError('relay connection lost'); });
  e = await errOf(RT.request({ method: 'POST', url: 'https://api.example.test/pay',
    body: 'x', authorization: { request: fakeApprovals().request } }));
  check('S1 ambiguous POST failure → one attempt only, ambiguous flag',
    e && e.networkCode === 'network_relay_failed' && e.ambiguous === true && calls.length === 1
    && /NOT retried/.test(e.message), e && e.networkCode + ' calls=' + calls.length);

  // same-origin ambiguous failure: also never retried
  pageLoc({ protocol: 'https:', host: 'app.test' });
  reset();
  on((u) => u === 'https://app.test/pay', () => { throw new TypeError('Failed to fetch'); });
  e = await errOf(RT.request({ method: 'POST', url: 'https://app.test/pay',
    authorization: { request: fakeApprovals().request } }));
  check('S2 same-origin POST TypeError → network_direct_failed, one attempt',
    e && e.networkCode === 'network_direct_failed' && e.ambiguous === true && calls.length === 1,
    e && e.networkCode + ' calls=' + calls.length);
  pageLoc({ protocol: 'https:' });

  // relay structured 502 (upstream failed AFTER dispatch) → ambiguous, one attempt
  reset();
  on((u, o) => u === '/fetch' && o.method === 'POST', () =>
    Response.json({ error: { code: 'network_relay_failed', message: 'fetch: upstream request failed' } },
      { status: 502, headers: { 'x-locus-relay-error': '1' } }));
  e = await errOf(RT.request({ method: 'POST', url: 'https://api.example.test/pay2',
    body: 'x', authorization: { request: fakeApprovals().request } }));
  check('S1b relay upstream failure → ambiguous, one attempt',
    e && e.networkCode === 'network_relay_failed' && e.ambiguous === true && calls.length === 1,
    e && e.networkCode + ' ambiguous=' + !!(e && e.ambiguous) + ' calls=' + calls.length);

  // POST with a real HTTP error status is authoritative, no retry
  reset();
  on((u, o) => u === '/fetch' && o.method === 'POST', () => new Response('{"err":"no"}', { status: 403 }));
  const r5 = await RT.request({ method: 'POST', url: 'https://api.example.test/submit',
    authorization: { request: fakeApprovals().request } });
  check('S3 relay POST 403 is authoritative', r5.status === 403 && calls.length === 1, 'calls=' + calls.length);

  // ============ 6. approval consumer semantics (real controller) ============
  // deny → network_denied, zero network attempts, task continues
  {
    reset();
    const c = new FakeApprovalPort();
    const p = RT.request({ method: 'PUT', url: 'https://api.example.test/v1/thing',
      body: '{"a":1}', authorization: { request: c.request.bind(c) } });
    check('A1 pending approval is registered', !!c.pending && c.pending.kind === 'permission', c.pending && c.pending.id);
    c.resolve(c.pending.id, { outcome: 'deny', scope: 'once' });
    e = await errOf(p);
    check('A2 deny → network_denied, zero fetches', e && e.networkCode === 'network_denied' && calls.length === 0,
      e && e.networkCode + ' calls=' + calls.length);
  }
  // allow once → exactly one request; next write asks again
  {
    reset();
    on((u, o) => u === '/fetch' && o.method === 'POST', () => jsonResponse('{"ok":1}'));
    const c = new FakeApprovalPort();
    const p = RT.request({ method: 'POST', url: 'https://api.example.test/v1/thing',
      authorization: { request: c.request.bind(c) } });
    c.resolve(c.pending.id, { outcome: 'allow', scope: 'once' });
    const ok = await p;
    check('A3 allow once → one relay request', ok.backend === 'edge-relay' && calls.length === 1, 'calls=' + calls.length);
    const p2 = RT.request({ method: 'POST', url: 'https://api.example.test/v1/thing',
      authorization: { request: c.request.bind(c) } });
    await tick();
    check('A4 next write asks again (no grant)', !!c.pending, 'pending=' + !!c.pending);
    c.resolve(c.pending.id, { outcome: 'deny', scope: 'once' });
    e = await errOf(p2);
    check('A4b second ask deny → denied, no extra fetch', e && e.networkCode === 'network_denied' && calls.length === 1,
      e && e.networkCode + ' calls=' + calls.length);
  }
  // allow for session → exact-origin grant; other origins still ask
  {
    reset();
    on((u, o) => u === '/fetch' && o.method === 'POST', () => jsonResponse('{"ok":1}'));
    const c = new FakeApprovalPort();
    const p = RT.request({ method: 'POST', url: 'https://api.example.test/v1/a',
      authorization: { request: c.request.bind(c) } });
    c.resolve(c.pending.id, { outcome: 'allow', scope: 'session' });
    await p;
    check('A5 policyKey is canonical network-write origin', c.hasSessionGrant('network-write:https://api.example.test'),
      Object.keys({}).length ? '' : 'grant lookup failed');
    const p2 = RT.request({ method: 'DELETE', url: 'https://api.example.test/v1/a/1',
      authorization: { request: c.request.bind(c) } });
    const ok2 = await p2;
    check('A6 session grant covers other methods on the SAME origin without ask',
      ok2.backend === 'edge-relay' && calls.length === 2, 'calls=' + calls.length);
    const p3 = RT.request({ method: 'POST', url: 'https://other.example.test/v1/b',
      authorization: { request: c.request.bind(c) } });
    await tick();
    check('A7 other origin still asks', !!c.pending, 'pending=' + !!c.pending);
    c.resolve(c.pending.id, { outcome: 'deny', scope: 'once' });
    await errOf(p3);
  }
  // grant exactness: sibling origins never inherit
  {
    const c = new FakeApprovalPort();
    c.resolve((c.request({
      kind: 'permission', action: { type: 'network-request', summary: 'probe' },
      resource: { type: 'network-origin', key: 'https://api.example.test', label: 'x' },
      policyKey: 'network-write:https://api.example.test',
    }), c.pending.id), { outcome: 'allow', scope: 'session' });
    const tries = ['https://api.example.test.evil.test/', 'https://evil.test/api.example.test',
      'https://api.example.test:444/', 'http://api.example.test/'];
    let leaked = 0;
    for (const t of tries) {
      const approvals = { request: () => { leaked++; return Promise.resolve({ outcome: 'allow' }); } };
      reset();
      on((u, o) => u === '/fetch' && o.method === 'POST', () => jsonResponse('{}'));
      await RT.request({ method: 'POST', url: t, authorization: { request: approvals.request.bind(approvals) } });
    }
    check('A8 sibling/variant origins never inherit the grant', leaked === tries.length,
      'asked=' + leaked + '/' + tries.length);
  }
  // cancel while pending → cancelled, NOT a denial; zero fetches
  {
    reset();
    const c = new FakeApprovalPort();
    const p = RT.request({ method: 'POST', url: 'https://api.example.test/x',
      authorization: { request: c.request.bind(c) } });
    c.cancel(c.pending.id, 'task cancelled');
    e = await errOf(p);
    check('A9 cancel while pending → network_aborted (not denied), zero fetches',
      e && e.networkCode === 'network_aborted' && e.cancelled === true && calls.length === 0,
      e && e.networkCode + ' calls=' + calls.length);
  }
  // no approval consumer → fail closed
  {
    reset();
    e = await errOf(RT.request({ method: 'POST', url: 'https://api.example.test/x' }));
    check('A10 missing approval consumer fails closed', e && e.networkCode === 'network_approval_unavailable'
      && calls.length === 0, e && e.networkCode);
  }
  // TOCTOU: allow resolves, task aborts before dispatch → zero fetches
  {
    reset();
    const controller = new AbortController();
    const approvals = { request: () => { controller.abort(); return Promise.resolve({ outcome: 'allow' }); } };
    e = await errOf(RT.request({ method: 'POST', url: 'https://api.example.test/x',
      signal: controller.signal, authorization: { request: approvals.request.bind(approvals) } }));
    check('A11 TOCTOU: abort between allow and dispatch → zero fetches',
      e && e.networkCode === 'network_aborted' && calls.length === 0, e && e.networkCode + ' calls=' + calls.length);
  }
  // approval request shape: canonical policyKey, summary without body/auth, size detail
  {
    reset();
    on((u, o) => u === '/fetch' && o.method === 'POST', () => jsonResponse('{"ok":1}'));
    const approvals = fakeApprovals();
    await RT.request({ method: 'POST', url: 'https://Api.Example.TEST:443/v1/thing?key=secret',
      headers: { authorization: 'Bearer sekrit' }, body: 'hello world',
      authorization: { request: approvals.request.bind(approvals) } });
    const a = approvals.asks[0];
    check('A12 policyKey canonicalized (default port, lowercased host)',
      a.policyKey === 'network-write:https://api.example.test', a.policyKey);
    check('A13 summary is METHOD origin path (no query, no headers)',
      a.action.summary === 'POST https://api.example.test/v1/thing' && !/sekrit/.test(JSON.stringify(a)),
      a.action.summary);
    check('A14 body-size detail present, body content absent',
      /Request body size: 11 B/.test(a.action.detail || '') && !/hello world/.test(JSON.stringify(a)),
      a.action.detail);
    check('A15 resource is the canonical network-origin', a.resource && a.resource.type === 'network-origin'
      && a.resource.key === 'https://api.example.test', JSON.stringify(a.resource));
  }
  // oversized body fails BEFORE the approval
  {
    reset();
    const approvals = fakeApprovals();
    e = await errOf(RT.request({ method: 'POST', url: 'https://api.example.test/x',
      body: new Uint8Array(M.NETWORK_MAX_REQUEST_BYTES + 1), authorization: { request: approvals.request.bind(approvals) } }));
    check('A16 oversized body → network_request_too_large before approval',
      e && e.networkCode === 'network_request_too_large' && approvals.asks.length === 0 && calls.length === 0,
      e && e.networkCode + ' asks=' + approvals.asks.length);
  }

  // ============ 7. redirect policy ============
  // GET: the browser is asked to follow redirects (native fetch behavior
  // — the finalUrl/final-scheme guarantees are covered by the relay tests
  // and the browser e2e, since a mocked fetch cannot set Response.url)
  reset();
  let followMode = null;
  on((u, o) => u === 'https://example.test/old', (u, o) => { followMode = o.redirect; return jsonResponse('{"ok":1}'); });
  await RT.request({ url: 'https://example.test/old' });
  check('D1 read-like requests use redirect: follow', followMode === 'follow', followMode);

  // side-effecting + redirect: blocked, no second request (direct backend)
  pageLoc({ protocol: 'https:', host: 'app.test' });
  reset();
  on((u, o) => u === 'https://app.test/r' && o.method === 'POST', () =>
    new Response(null, { status: 307, headers: { location: 'https://elsewhere.test/catch' } }));
  e = await errOf(RT.request({ method: 'POST', url: 'https://app.test/r',
    authorization: { request: fakeApprovals().request } }));
  check('D2 direct POST 3xx → network_redirect_blocked, one attempt',
    e && e.networkCode === 'network_redirect_blocked' && calls.length === 1,
    e && e.networkCode + ' calls=' + calls.length);
  pageLoc({ protocol: 'https:' });

  // relay-reported cross-origin redirect block surfaces the relay's code
  reset();
  on((u, o) => u === '/fetch' && o.method === 'POST', () =>
    Response.json({ error: { code: 'network_redirect_blocked', message: 'Cross-origin redirect blocked' } },
      { status: 403, headers: { 'x-locus-relay-error': '1' } }));
  e = await errOf(RT.request({ method: 'POST', url: 'https://api.example.test/r',
    authorization: { request: fakeApprovals().request } }));
  check('D3 relay redirect block → network_redirect_blocked',
    e && e.networkCode === 'network_redirect_blocked', e && e.networkCode);

  // ============ 8. header policy ============
  reset();
  on((u) => u === 'https://example.test/hdr', () => jsonResponse('{}'));
  await RT.request({ url: 'https://example.test/hdr', headers: {
    'accept': 'application/json', 'Authorization': 'Bearer sekrit', 'x-custom': 'v',
    'host': 'evil.test', 'cookie': 'a=b', 'content-length': '999', 'connection': 'close',
    'transfer-encoding': 'chunked', 'upgrade': 'h2c', 'sec-fetch-mode': 'nope',
    'proxy-authorization': 'nope', 'X-Forwarded-For': 'nope',
  } });
  const sent = calls[0].opts.headers || {};
  const sentKeys = Object.keys(sent instanceof Headers ? Object.fromEntries(sent) : sent);
  check('H1 authorization + custom headers sent', sentKeys.includes('authorization') && sentKeys.includes('x-custom'),
    JSON.stringify(sentKeys));
  check('H2 forbidden headers dropped', !sentKeys.some((k) => ['host', 'cookie', 'content-length', 'connection',
    'transfer-encoding', 'upgrade', 'sec-fetch-mode', 'proxy-authorization'].includes(k)),
    JSON.stringify(sentKeys));

  e = await errOf(RT.request({ url: 'https://example.test/hdr', headers: { 'x-bad': 'a\rb' } }));
  check('H3 CR/LF injection refused', e && e.networkCode === 'network_invalid_header', e && e.networkCode);

  // ============ 9. abort / timeout composition ============
  {
    reset();
    const ac = new AbortController();
    ac.abort();
    e = await errOf(RT.request({ url: 'https://example.test/x', signal: ac.signal }));
    check('T1 pre-aborted signal → AbortError, zero fetches',
      e && e.name === 'AbortError' && e.networkCode === 'network_aborted' && calls.length === 0,
      e && e.networkCode);
  }
  {
    reset();
    on(() => true, () => new Response(new ReadableStream({ start() { /* stall */ } }), { status: 200 }));
    e = await errOf(RT.request({ url: 'https://stall.test/x', timeoutMs: 40 }));
    check('T2 body stall times out (deadline covers body)', e && e.timeout === true, e && e.message);
  }
  {
    reset();
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 30);
    on(() => true, () => new Response(new ReadableStream({ start() { /* stall */ } }), { status: 200 }));
    e = await errOf(RT.request({ url: 'https://stall.test/x', signal: ac.signal, timeoutMs: 60000 }));
    check('T3 external cancel during body read → AbortError', e && e.name === 'AbortError', e && e.message);
  }

  // ============ 10. bounds + binary fidelity ============
  {
    reset();
    on((u, o) => u === '/fetch' && o.method === 'POST', () => jsonResponse('{"ok":1}'));
    e = await errOf(RT.request({ method: 'POST', url: 'https://api.example.test/x',
      body: new Uint8Array(M.NETWORK_MAX_REQUEST_BYTES).fill(1),
      authorization: { request: fakeApprovals().request } }));
    check('B1 request body at limit is accepted', e === null && calls.length === 1, e && e.networkCode);
  }
  {
    reset();
    const big = new Uint8Array(M.NETWORK_MAX_RESPONSE_BYTES + 1);
    on((u, o) => u === '/fetch' && o.method === 'POST', () => new Response(big, { status: 200 }));
    e = await errOf(RT.request({ method: 'POST', url: 'https://api.example.test/x',
      authorization: { request: fakeApprovals().request } }));
    check('B2 streaming response over cap → network_response_too_large (no crash)',
      e && e.networkCode === 'network_response_too_large', e && e.networkCode);
  }
  {
    // binary request body survives the envelope base64 round-trip byte-exact
    reset();
    let envelopeSeen = null;
    on(async (u, o) => u === '/fetch' && o.method === 'POST', (u, o) => {
      envelopeSeen = JSON.parse(o.body);
      return jsonResponse('{"ok":1}');
    });
    const png = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0xFF, 0xFE, 0x80]);
    await RT.request({ method: 'PUT', url: 'https://api.example.test/blob', body: png,
      authorization: { request: fakeApprovals().request } });
    check('B3 binary body byte-exact through envelope',
      envelopeSeen && envelopeSeen.bodyBase64 && btoa(String.fromCharCode(...png)) === envelopeSeen.bodyBase64,
      envelopeSeen && envelopeSeen.bodyBase64);
  }
  {
    // binary response byte-exact through the relay
    reset();
    const png = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0xFF, 0xFE, 0x80]);
    on((u, o) => u === '/fetch' && o.method === 'POST', () =>
      new Response(png, { status: 200, headers: { 'content-type': 'image/png' } }));
    const r10 = await RT.request({ method: 'POST', url: 'https://api.example.test/blob',
      authorization: { request: fakeApprovals().request } });
    check('B4 binary response byte-exact', r10.bytes.length === png.length
      && r10.bytes.every((b, i) => b === png[i]) && r10.headers['content-type'] === 'image/png', '');
  }
  {
    // duplicate response headers survive in headerList
    reset();
    on((u) => u === 'https://example.test/multi', () =>
      new Response('x', { status: 200, headers: { 'content-type': 'text/plain', 'x-tag': 'a' } }));
    const r11 = await RT.request({ url: 'https://example.test/multi' });
    check('B5 headerList preserves pair form', Array.isArray(r11.headerList)
      && r11.headerList.some((p) => p[0] === 'content-type'), JSON.stringify(r11.headerList));
    check('B6 headers object form retained', r11.headers['content-type'] === 'text/plain', '');
  }
  {
    // GET with a body is refused
    e = await errOf(RT.request({ url: 'https://example.test/x', body: 'nope' }));
    check('B7 GET with body refused', e && /cannot carry a body/.test(e.message), e && e.message);
  }
  {
    // v0 fetch() wrapper keeps its shape
    reset();
    on((u) => u === 'https://example.test/legacy', () => jsonResponse('{"legacy":1}'));
    const leg = await RT.fetch('https://example.test/legacy');
    check('B8 legacy fetch() shape (bytes + headers object)',
      leg.backend === 'browser-direct' && leg.bytes && leg.headers['content-type'] === 'application/json', '');
  }

  // ============ 11. private-address classification (N-F02/N-F07) ============
  // The SAME attack-vector table runs against the relay in
  // tests/fetch.test.mjs (F2c) — keep the two tables in sync.
  {
    const PRIVATE = [
      'localhost', 'localhost.', 'sub.localhost', 'localhost.localdomain',
      'sub.localhost.localdomain', '127.0.0.1', '127.254.9.9', '0.0.0.0', '0.1.2.3',
      '10.0.0.1', '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.168.1.1',
      '::1', '::',
      // IPv4-mapped IPv6, dotted and WHATWG-canonical hex spellings
      '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:192.168.1.1', '::ffff:169.254.169.254',
      '::ffff:7f00:1', '::ffff:a00:1', '::ffff:c0a8:101', '::ffff:a9fe:a9fe',
      '[::ffff:7f00:1]', '[::ffff:c0a8:101]',
      // WHATWG scalar normalizations
      '2130706433', '0x7f000001', '0177.0.0.1', '127.1', '127.9.9.9',
      '0xC0A80101', // 192.168.1.1
    ];
    for (const v of PRIVATE) {
      check('S private: ' + v, M.isPrivateHostname(v) === true, 'classified public');
    }
    const PUBLIC = [
      'example.com', 'api.example.test', 'localhost.com', 'notlocalhost',
      '93.184.216.34', '172.32.0.1', '172.15.255.255', '192.169.0.1', '11.0.0.1',
      '2606:2800:220:1:248:1893:25c8:1946',
      'fe00::1', 'fec0::1', // start with fe/fc hex but OUTSIDE fc00::/7 and fe80::/10
      '::ffff:93.184.216.34', '::ffff:5dc8:d822', // mapped PUBLIC address stays public
    ];
    for (const v of PUBLIC) {
      check('S public: ' + v, M.isPrivateHostname(v) === false, 'classified private');
    }
    // request-level: a mapped-IPv6 loopback target is refused on the relay
    // leg (direct attempt first for reads, then the fallback pre-check)
    reset();
    on((u) => u === 'http://[::ffff:7f00:1]:9/x', () => { throw new TypeError('Failed to fetch'); });
    on(() => { throw new Error('relay must NOT be called for mapped-private targets'); });
    e = await errOf(RT.request({ url: 'http://[::ffff:7f00:1]:9/x' }));
    check('S mapped-IPv6 loopback request → network_private_address_blocked, no relay leg',
      e && e.networkCode === 'network_private_address_blocked' && calls.length === 1,
      e && e.networkCode + ' calls=' + calls.length);
    // side-effecting mapped-IPv6 target: refused BEFORE the approval
    reset();
    const approvalsS = fakeApprovals();
    e = await errOf(RT.request({ method: 'POST', url: 'http://[::ffff:a00:1]/x',
      body: 'x', authorization: { request: approvalsS.request.bind(approvalsS) } }));
    check('S mapped-IPv6 POST refused pre-approval, zero attempts',
      e && e.networkCode === 'network_private_address_blocked' && approvalsS.asks.length === 0
      && calls.length === 0, e && e.networkCode + ' asks=' + approvalsS.asks.length);
    // safe URL display: origin + path only, secrets dropped, bounded fallback
    check('SD query dropped', M.safeNetworkUrlForDisplay('https://example.test/p?token=x') === 'https://example.test/p',
      M.safeNetworkUrlForDisplay('https://example.test/p?token=x'));
    check('SD userinfo+fragment dropped',
      M.safeNetworkUrlForDisplay('https://user:pw@example.test:8443/p#frag') === 'https://example.test:8443/p',
      M.safeNetworkUrlForDisplay('https://user:pw@example.test:8443/p#frag'));
    check('SD IPv6 bracketed', M.safeNetworkUrlForDisplay('http://[::1]:8080/p?q=1') === 'http://[::1]:8080/p',
      M.safeNetworkUrlForDisplay('http://[::1]:8080/p?q=1'));
    check('SD unparseable input never echoed', M.safeNetworkUrlForDisplay('http://exa mple') === '(unparseable URL)'
      && M.safeNetworkUrlForDisplay(null) === '(unparseable URL)', M.safeNetworkUrlForDisplay('http://exa mple'));
  }

  // ============ 12. fallback boundary (N-F06): only the initial fetch()
  // transport failure may hand GET/HEAD to the relay ============
  {
    // F1: fetch() itself throws TypeError → GET relay exactly once
    reset();
    on((u) => u === 'https://blocked.test/b', () => { throw new TypeError('Failed to fetch'); });
    on((u) => u.startsWith('/fetch?'), () => jsonResponse('{"via":"relay"}'));
    const rF1 = await RT.request({ url: 'https://blocked.test/b' });
    check('F1 transport TypeError → relay once', rF1.backend === 'edge-relay' && calls.length === 2,
      'calls=' + calls.length);

    // F2: header processing throws TypeError AFTER the Response exists → no fallback
    reset();
    on((u) => u === 'https://example.test/badhdr', () => {
      const res = new Response('ok');
      Object.defineProperty(res, 'headers', { get() { throw new TypeError('boom'); } });
      return res;
    });
    on(() => { throw new Error('relay must NOT be called for post-Response failures'); });
    e = await errOf(RT.request({ url: 'https://example.test/badhdr' }));
    check('F2 post-Response header TypeError → no relay (calls=1)', calls.length === 1
      && !(e && e.message && /unreachable/.test(e.message)), 'calls=' + calls.length + ' ' + (e && e.networkCode));

    // F3: body reader constructor throws TypeError → no fallback
    reset();
    on((u) => u === 'https://example.test/badbody', () => ({
      status: 200, statusText: '', url: 'https://example.test/badbody',
      headers: new Headers({ 'content-type': 'text/plain' }),
      get body() { throw new TypeError('reader boom'); },
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    }));
    on(() => { throw new Error('relay must NOT be called for post-Response failures'); });
    e = await errOf(RT.request({ url: 'https://example.test/badbody' }));
    check('F3 body-reader TypeError → network_direct_failed, no relay',
      e && e.networkCode === 'network_direct_failed' && calls.length === 1,
      (e && e.networkCode) + ' calls=' + calls.length);

    // F4: mid-stream body read rejects with TypeError → no fallback
    reset();
    on((u) => u === 'https://example.test/midstream', () => new Response(
      new ReadableStream({
        start(ctrl) { ctrl.enqueue(new TextEncoder().encode('half')); },
        pull() { throw new TypeError('network error'); },
      }),
      { status: 200, headers: { 'content-type': 'text/plain' } }));
    on(() => { throw new Error('relay must NOT be called for post-Response failures'); });
    e = await errOf(RT.request({ url: 'https://example.test/midstream' }));
    check('F4 mid-stream TypeError → network_direct_failed, no relay',
      e && e.networkCode === 'network_direct_failed' && calls.length === 1,
      (e && e.networkCode) + ' calls=' + calls.length);

    // F5: POST fetch TypeError → no fallback (side effect is never re-sent)
    pageLoc({ protocol: 'https:', host: 'app.test' });
    reset();
    on((u, o) => u === 'https://app.test/pay' && o.method === 'POST', () => { throw new TypeError('Failed to fetch'); });
    on(() => { throw new Error('relay must NOT be called for side effects'); });
    e = await errOf(RT.request({ method: 'POST', url: 'https://app.test/pay',
      authorization: { request: fakeApprovals().request } }));
    check('F5 POST transport TypeError → network_direct_failed, one attempt',
      e && e.networkCode === 'network_direct_failed' && e.ambiguous === true && calls.length === 1,
      (e && e.networkCode) + ' calls=' + calls.length);
    pageLoc({ protocol: 'https:' });
  }

  // ============ 13. HEAD method fidelity (N-F09) ============
  {
    // H1: direct HEAD is exact
    reset();
    on((u, o) => u === 'https://example.test/h' && o.method === 'HEAD', () =>
      new Response(null, { status: 200, headers: { 'content-type': 'text/plain', 'x-head': 'direct' } }));
    const rH1 = await RT.request({ method: 'HEAD', url: 'https://example.test/h' });
    check('H1 direct HEAD exact: headers present, body empty, one call',
      rH1.status === 200 && rH1.headers['x-head'] === 'direct' && rH1.bytes.byteLength === 0
      && rH1.backend === 'browser-direct' && calls.length === 1,
      JSON.stringify({ s: rH1.status, b: rH1.bytes.byteLength, c: calls.length }));

    // H2: HEAD transport failure falls back with method HEAD (never GET)
    reset();
    on((u, o) => u === 'https://blocked.test/h' && o.method === 'HEAD', () => { throw new TypeError('Failed to fetch'); });
    on((u, o) => u === '/fetch' && o.method === 'POST', (u, o) => {
      const envelope = JSON.parse(o.body);
      check('H2 fallback envelope preserves method HEAD', envelope.method === 'HEAD', JSON.stringify(envelope));
      return new Response(null, { status: 200, headers: { 'content-type': 'text/plain', 'x-head': 'relay' } });
    });
    const rH2 = await RT.request({ method: 'HEAD', url: 'https://blocked.test/h' });
    check('H2b HEAD fallback result: headers kept, body empty, exactly two calls',
      rH2.backend === 'edge-relay' && rH2.headers['x-head'] === 'relay' && rH2.bytes.byteLength === 0
      && calls.length === 2, 'calls=' + calls.length + ' bytes=' + rH2.bytes.byteLength);

    // H3: HEAD 404 is authoritative — no fallback
    reset();
    on((u, o) => u === 'https://example.test/h' && o.method === 'HEAD', () =>
      new Response(null, { status: 404 }));
    on(() => { throw new Error('relay must NOT be called for a HEAD 404'); });
    const rH3 = await RT.request({ method: 'HEAD', url: 'https://example.test/h' });
    check('H3 HEAD 404 authoritative, no fallback', rH3.status === 404 && calls.length === 1,
      'calls=' + calls.length);

    // H4: a buggy server sends a BODY on HEAD — the platform hands the
    // Response to the runtime (unavoidable at the transport boundary), and
    // every consumer surface (shell -I, relay leg) keeps it non-content.
    // Here: one call only, status authoritative, no relay re-send.
    reset();
    on((u, o) => u === 'https://example.test/h' && o.method === 'HEAD', () =>
      new Response('SHOULD-NOT-SURFACE', { status: 200, headers: { 'content-type': 'text/plain' } }));
    const rH4 = await RT.request({ method: 'HEAD', url: 'https://example.test/h' });
    check('H4 HEAD response reported without a relay re-send',
      rH4.status === 200 && calls.length === 1, 'calls=' + calls.length);
  }

  await tick();
  check('Z1 no unhandled rejections', unhandled.length === 0, unhandled.map((x) => String(x)).join(' | '));

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.error('TEST RUNNER FAIL', e); process.exit(1); });
