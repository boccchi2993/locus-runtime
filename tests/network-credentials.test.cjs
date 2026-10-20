// C3 credential-variable tests (node, mocked fetch).
// Run: node tests/network-credentials.test.cjs
// No real internet access — global fetch is fully mocked.
//
// Covers the spec.credentials port of NetworkRuntime.request():
// validation (bindings), the single value() resolution, literal-key
// refusal, redirect refusal, response echo shielding, the approval
// detail line, and the shell/session pass-through.

// --- browser stubs ---
global.window = { location: { protocol: 'https:' } }; // hosted page → relay available

const M = require('./helpers/core.cjs');
const { createRuntime } = require('../src/index.js');

const VALUE = 'sk-test-c3-0123456789';
const NAME = 'DEEPSEEK_API_KEY';
const ORIGIN = 'https://api.deepseek.test';
const PREFIX = '/v1/tools/';
const BOUND_URL = ORIGIN + PREFIX + 'list';

function binding(overrides) {
  return Object.assign({
    name: NAME,
    header: 'Authorization',
    scheme: 'Bearer',
    origin: ORIGIN,
    pathPrefix: PREFIX,
    status: 'connected',
  }, overrides);
}

// A credentials port with spies; `valueBehavior` swaps the resolution
// outcome (value string, thrower) for NC11.
function makeCredentials(bindings, valueBehavior) {
  const port = {
    bindingsCalls: 0,
    valueCalls: [],
    bindings: typeof bindings === 'function' ? bindings : () => {
      port.bindingsCalls++;
      return Promise.resolve(bindings);
    },
    value: (n) => {
      port.valueCalls.push(n);
      if (typeof valueBehavior === 'function') return valueBehavior(n);
      return Promise.resolve(valueBehavior === undefined ? VALUE : valueBehavior);
    },
  };
  return port;
}

// Always-allow execution authorization port that records every ask.
function makeAllowPort(events) {
  return {
    asks: [],
    request(req) {
      if (events) events.push('ask');
      this.asks.push(req);
      return Promise.resolve({ outcome: 'allow', scope: 'session' });
    },
  };
}
function makeDenyPort() {
  return { asks: [], request() { return Promise.resolve({ outcome: 'deny', scope: 'once' }); } };
}

// --- fetch mock ---
let calls = [];        // every fetch() invocation {url, opts}
let relayEnvelopes = []; // parsed POST /fetch JSON bodies
let responders = [];   // [{match: (url)=>bool, respond: (url, opts)=>Response|any|throw}]
function on(match, respond) { responders.push({ match, respond }); }
function resetNet() { calls = []; relayEnvelopes = []; responders = []; }

global.fetch = async (url, opts) => {
  const u = String(url);
  calls.push({ url: u, opts: opts || {} });
  if (u === '/fetch' && (opts || {}).body) {
    relayEnvelopes.push(JSON.parse(opts.body));
  }
  for (const r of responders) {
    if (r.match(u)) return r.respond(u, opts || {});
  }
  throw new TypeError('Failed to fetch'); // default: genuine transport failure
};
function jsonResponse(body, headers) {
  return new Response(body, { status: 200, headers: Object.assign({ 'content-type': 'application/json' }, headers) });
}
// A Response-like object the runtime accepts for the DIRECT leg (lets a
// test control res.url, which a real Response exposes read-only).
function fakeDirectResponse(status, bodyText, headerPairs, url) {
  const headers = new Headers();
  for (const p of headerPairs) headers.set(p[0], p[1]);
  return {
    status: status,
    statusText: 'OK',
    headers: headers,
    url: url || '',
    type: 'default',
    body: null,
    arrayBuffer: async () => new TextEncoder().encode(bodyText).buffer,
  };
}

// Any unhandled rejection during the run is a test failure.
const unhandled = [];
process.on('unhandledRejection', (e) => { unhandled.push(e); });

// --- byte-exact in-memory workspace (session-level curl checks) ---
class MemWS extends M.WorkspaceAdapter {
  constructor() {
    super();
    this.files = {};
    this.name = 'mem';
  }
  async list() { return Object.keys(this.files).map((n) => ({ name: n, kind: 'file' })); }
  async read(p) { return new TextDecoder().decode(await this.readBytes(p)); }
  async readBytes(p) {
    if (!(p in this.files)) { const e = new Error('No such file: ' + p); e.name = 'NotFoundError'; throw e; }
    return this.files[p];
  }
  async write(p, data) {
    this.files[p] = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
  }
  async remove(p) { delete this.files[p]; }
  async mkdir() {}
  async exists(p) { return p in this.files; }
  async stat(p) {
    if (!(p in this.files)) { const e = new Error('No such file: ' + p); e.name = 'NotFoundError'; throw e; }
    return { kind: 'file', size: this.files[p].byteLength, modified: 0 };
  }
}

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + String(detail) : '')); }
}
async function netError(fn) {
  try { await fn(); return null; } catch (e) { return e; }
}
function isCode(err, code) { return !!err && err.networkCode === code; }

// NC15 sweep: every model-visible string collected across the suite is
// asserted value-free at the end.
const sweep = [];
const collect = (s) => { sweep.push(String(s)); return s; };

// ---------- session harness (shell pass-through, NC16) ----------
const __hostPromise = createRuntime({
  workerAssets: { pyWorkerSource: '/* not booted */', grepWorkerSource: '/* not booted */' },
});
let __session = null;
async function exec(cmd, opts) {
  const res = await __session.execute({
    kind: 'shell',
    input: cmd,
    context: Object.assign({ filesystem: new MemWS() }, opts || {}),
  });
  return { output: collect(res.output), isError: !!res.isError, ok: !!res.ok };
}

async function run() {
  __session = (await __hostPromise).createSession();

  // ---------- NC0: without the port, $NAME is sent verbatim ----------
  resetNet();
  on((u) => u === BOUND_URL, () => jsonResponse('{"ok":1}'));
  const r0 = await M.NetworkRuntime.request({
    method: 'GET', url: BOUND_URL, headers: { Authorization: 'Bearer $' + NAME },
  });
  check('NC0 no port: literal $NAME on the wire',
    r0.status === 200 && calls.length === 1
    && calls[0].opts.headers.authorization === 'Bearer $' + NAME,
    JSON.stringify(calls[0] && calls[0].opts.headers));

  // ---------- NC1: correct reference — direct GET + relay POST ----------
  resetNet();
  const creds1 = makeCredentials([binding()]);
  on((u) => u === BOUND_URL, () => jsonResponse('{"ok":1}'));
  const r1 = await M.NetworkRuntime.request({
    method: 'GET', url: BOUND_URL,
    headers: { Authorization: 'Bearer $' + NAME },
    credentials: creds1,
  });
  check('NC1 direct GET sends the resolved header',
    r1.status === 200 && calls[0].opts.headers.authorization === 'Bearer ' + VALUE,
    JSON.stringify(calls[0] && calls[0].opts.headers));
  check('NC1b direct GET calls value once', creds1.valueCalls.length === 1
    && creds1.valueCalls[0] === NAME, JSON.stringify(creds1.valueCalls));

  resetNet();
  const creds1b = makeCredentials([binding()]);
  const allow1 = makeAllowPort();
  on((u) => u === '/fetch', (u, o) => jsonResponse('{"ok":1}'));
  const r1b = await M.NetworkRuntime.request({
    method: 'POST', url: BOUND_URL,
    headers: { Authorization: 'Bearer $' + NAME },
    body: '{"x":1}',
    credentials: creds1b,
    authorization: allow1,
  });
  const env1 = relayEnvelopes[0] || {};
  check('NC1c relay POST sends the resolved header',
    r1b.status === 200 && env1.headers && env1.headers.authorization === 'Bearer ' + VALUE,
    JSON.stringify(env1));
  check('NC1d relay POST called value once after approval',
    creds1b.valueCalls.length === 1 && allow1.asks.length === 1,
    JSON.stringify(creds1b.valueCalls));

  // ---------- NC2: ${NAME} spelling is equally valid ----------
  resetNet();
  const creds2 = makeCredentials([binding()]);
  on((u) => u === BOUND_URL, () => jsonResponse('{"ok":1}'));
  const r2 = await M.NetworkRuntime.request({
    method: 'GET', url: BOUND_URL,
    headers: { Authorization: 'Bearer ${' + NAME + '}' },
    credentials: creds2,
  });
  check('NC2 ${NAME} form resolved', r2.status === 200
    && calls[0].opts.headers.authorization === 'Bearer ' + VALUE
    && creds2.valueCalls.length === 1,
    JSON.stringify(calls[0] && calls[0].opts.headers));

  // ---------- NC3: $foo / $1 are literal text ----------
  resetNet();
  const creds3 = makeCredentials([binding()]);
  on((u) => u === 'https://example.test/api', () => jsonResponse('{"ok":1}'));
  const r3 = await M.NetworkRuntime.request({
    method: 'GET', url: 'https://example.test/api',
    headers: { Authorization: 'Bearer $foo' },
    credentials: creds3,
  });
  check('NC3 lowercase $foo stays literal, no value call', r3.status === 200
    && calls[0].opts.headers.authorization === 'Bearer $foo'
    && creds3.valueCalls.length === 0,
    JSON.stringify(calls[0] && calls[0].opts.headers));
  resetNet();
  on((u) => u === 'https://example.test/api', () => jsonResponse('{"ok":1}'));
  const r3b = await M.NetworkRuntime.request({
    method: 'GET', url: 'https://example.test/api',
    headers: { 'X-N': 'v=$1' },
    credentials: creds3,
  });
  check('NC3b $1 stays literal', r3b.status === 200 && calls[0].opts.headers['x-n'] === 'v=$1',
    JSON.stringify(calls[0] && calls[0].opts.headers));

  // ---------- NC4: two references → network_credential_multiple ----------
  resetNet();
  const creds4 = makeCredentials([binding()]);
  const e4 = await netError(() => M.NetworkRuntime.request({
    method: 'GET', url: BOUND_URL,
    headers: { Authorization: 'Bearer $' + NAME + ' ${' + NAME + '}' },
    credentials: creds4,
  }));
  check('NC4 two refs in one value refused', isCode(e4, 'network_credential_multiple')
    && calls.length === 0 && creds4.valueCalls.length === 0,
    e4 && (e4.networkCode + ' ' + e4.message));
  sweep.push(collect(e4 && e4.message));
  resetNet();
  const creds4b = makeCredentials([binding()]);
  const e4b = await netError(() => M.NetworkRuntime.request({
    method: 'GET', url: BOUND_URL,
    headers: { Authorization: '$' + NAME, 'X-Other': '$' + NAME },
    credentials: creds4b,
  }));
  check('NC4b refs across two headers refused', isCode(e4b, 'network_credential_multiple')
    && calls.length === 0, e4b && e4b.networkCode);
  sweep.push(collect(e4b && e4b.message));

  // ---------- NC5: unknown / needs-connection / needs-reconfirm ----------
  resetNet();
  const creds5 = makeCredentials([binding()]);
  const e5 = await netError(() => M.NetworkRuntime.request({
    method: 'GET', url: BOUND_URL,
    headers: { Authorization: 'Bearer $NOPE_KEY' },
    credentials: creds5,
  }));
  check('NC5 unknown name refused', isCode(e5, 'network_credential_unknown')
    && calls.length === 0 && creds5.valueCalls.length === 0,
    e5 && e5.networkCode);
  sweep.push(collect(e5 && e5.message));

  resetNet();
  const creds5b = makeCredentials([binding({ status: 'needs-connection' })]);
  const e5b = await netError(() => M.NetworkRuntime.request({
    method: 'GET', url: BOUND_URL,
    headers: { Authorization: 'Bearer $' + NAME },
    credentials: creds5b,
  }));
  check('NC5b needs-connection refused with the Settings hint',
    isCode(e5b, 'network_credential_not_connected')
    && /connect it in Settings → Capabilities/.test(e5b && e5b.message)
    && calls.length === 0 && creds5b.valueCalls.length === 0,
    e5b && e5b.message);
  sweep.push(collect(e5b && e5b.message));

  resetNet();
  const creds5c = makeCredentials([binding({ status: 'needs-reconfirm' })]);
  const e5c = await netError(() => M.NetworkRuntime.request({
    method: 'GET', url: BOUND_URL,
    headers: { Authorization: 'Bearer $' + NAME },
    credentials: creds5c,
  }));
  check('NC5c needs-reconfirm refused', isCode(e5c, 'network_credential_needs_reconfirm')
    && calls.length === 0 && creds5c.valueCalls.length === 0,
    e5c && e5c.networkCode);
  sweep.push(collect(e5c && e5c.message));

  // ---------- NC6: wrong header / wrong form → form_invalid ----------
  const formCases = [
    ['NC6 ref in a foreign header', { 'X-Other': '$' + NAME }],
    ['NC6b token= prefix', { Authorization: 'token=$' + NAME }],
    ['NC6c two spaces after scheme', { Authorization: 'Bearer  $' + NAME }],
    ['NC6d lowercase scheme', { Authorization: 'bearer $' + NAME }],
  ];
  for (const [label, headers] of formCases) {
    resetNet();
    const creds = makeCredentials([binding()]);
    const err = await netError(() => M.NetworkRuntime.request({
      method: 'GET', url: BOUND_URL, headers: headers, credentials: creds,
    }));
    check(label, isCode(err, 'network_credential_form_invalid')
      && /must be used as: -H "Authorization: Bearer \$DEEPSEEK_API_KEY"/.test(err && err.message)
      && calls.length === 0 && creds.valueCalls.length === 0,
      err && err.message);
    sweep.push(collect(err && err.message));
  }
  resetNet();
  const nullBinding = binding({
    name: 'NULLSCHEME_KEY', header: 'X-Api-Key', scheme: null,
    origin: 'https://null.test', pathPrefix: '/v1/',
  });
  const creds6e = makeCredentials([nullBinding]);
  const e6e = await netError(() => M.NetworkRuntime.request({
    method: 'GET', url: 'https://null.test/v1/whoami',
    headers: { 'X-Api-Key': 'Bearer $NULLSCHEME_KEY' },
    credentials: creds6e,
  }));
  check('NC6e Bearer form with scheme:null binding refused',
    isCode(e6e, 'network_credential_form_invalid')
    && /-H "X-Api-Key: \$NULLSCHEME_KEY"/.test(e6e && e6e.message),
    e6e && e6e.message);
  sweep.push(collect(e6e && e6e.message));
  // ...and the bare form for scheme:null is accepted.
  resetNet();
  const creds6f = makeCredentials([nullBinding]);
  on((u) => u === 'https://null.test/v1/whoami', () => jsonResponse('{"ok":1}'));
  const r6f = await M.NetworkRuntime.request({
    method: 'GET', url: 'https://null.test/v1/whoami',
    headers: { 'X-Api-Key': '$NULLSCHEME_KEY' },
    credentials: creds6f,
  });
  check('NC6f bare form with scheme:null binding works',
    r6f.status === 200 && calls[0].opts.headers['x-api-key'] === VALUE,
    JSON.stringify(calls[0] && calls[0].opts.headers));

  // ---------- NC7: target outside the binding → binding_mismatch ----------
  const mismatchTargets = [
    ['NC7 http vs https', 'http://api.deepseek.test/v1/tools/list', /cannot be sent to http:\/\/api\.deepseek\.test\/v1\/tools\/list/],
    ['NC7b subdomain', 'https://api2.deepseek.test/v1/tools/list', /api2\.deepseek\.test/],
    ['NC7c different port', 'https://api.deepseek.test:8443/v1/tools/list', /:8443/],
    ['NC7d path outside prefix', 'https://api.deepseek.test/v1/toolsX/list', /v1\/toolsX\/list/],
    ['NC7e prefix only', 'https://api.deepseek.test/v1/', /cannot be sent to https:\/\/api\.deepseek\.test\/v1\//],
    ['NC7f dot-dot bypass (parsed pathname)', 'https://api.deepseek.test/v1/tools/../chat', /cannot be sent to https:\/\/api\.deepseek\.test\/v1\/chat/],
  ];
  for (const [label, target, msgRe] of mismatchTargets) {
    resetNet();
    const creds = makeCredentials([binding()]);
    const err = await netError(() => M.NetworkRuntime.request({
      method: 'GET', url: target,
      headers: { Authorization: 'Bearer $' + NAME },
      credentials: creds,
    }));
    check(label, isCode(err, 'network_credential_binding_mismatch')
      && new RegExp('credential DEEPSEEK_API_KEY is bound to https://api\\.deepseek\\.test/v1/tools/ and cannot be sent to').test(err && err.message)
      && msgRe.test(err && err.message)
      && calls.length === 0 && creds.valueCalls.length === 0,
      err && err.message);
    sweep.push(collect(err && err.message));
  }

  // ---------- NC8: literal key on the bound target refused ----------
  resetNet();
  const creds8 = makeCredentials([binding()]);
  const e8 = await netError(() => M.NetworkRuntime.request({
    method: 'GET', url: BOUND_URL,
    headers: { Authorization: 'Bearer sk-literal-not-secret' },
    credentials: creds8,
  }));
  check('NC8 literal key refused', isCode(e8, 'network_credential_literal_refused')
    && /write the variable instead/.test(e8 && e8.message)
    && calls.length === 0 && creds8.valueCalls.length === 0,
    e8 && e8.message);
  sweep.push(collect(e8 && e8.message));

  // ...even when the request ALSO carries a valid reference elsewhere.
  resetNet();
  const twin = binding({
    name: 'ORG_TOKEN', header: 'X-Org-Token',
  });
  const creds8b = makeCredentials([binding(), twin]);
  const e8b = await netError(() => M.NetworkRuntime.request({
    method: 'GET', url: BOUND_URL,
    headers: { Authorization: 'Bearer sk-literal-not-secret', 'X-Org-Token': 'Bearer $ORG_TOKEN' },
    credentials: creds8b,
  }));
  check('NC8b literal refused alongside a valid other reference',
    isCode(e8b, 'network_credential_literal_refused') && calls.length === 0,
    e8b && (e8b.networkCode + ' ' + e8b.message));
  sweep.push(collect(e8b && e8b.message));

  // ---------- NC9: failures never resolve, never ask, never send ----------
  const failurePosts = [
    ['NC9 unknown (POST)', { Authorization: 'Bearer $NOPE_KEY' }, 'network_credential_unknown'],
    ['NC9b multiple (POST)', { Authorization: '$' + NAME + ' ${' + NAME + '}' }, 'network_credential_multiple'],
    ['NC9c form (POST)', { Authorization: 'bearer $' + NAME }, 'network_credential_form_invalid'],
    ['NC9d mismatch (POST)', null, 'network_credential_binding_mismatch'],
    ['NC9e literal (POST)', { Authorization: 'Bearer sk-literal-not-secret' }, 'network_credential_literal_refused'],
  ];
  for (const [label, headers, code] of failurePosts) {
    resetNet();
    const creds = makeCredentials([binding()]);
    const allow = makeAllowPort();
    const err = await netError(() => M.NetworkRuntime.request({
      method: 'POST', url: label === 'NC9d mismatch (POST)'
        ? 'https://elsewhere.test/v1/x' : BOUND_URL,
      headers: headers || { Authorization: 'Bearer $' + NAME },
      body: '{"x":1}',
      credentials: creds,
      authorization: allow,
    }));
    check(label, isCode(err, code) && calls.length === 0
      && creds.valueCalls.length === 0 && allow.asks.length === 0,
      (err && err.networkCode) + ' sent=' + calls.length
      + ' value=' + creds.valueCalls.length + ' asks=' + allow.asks.length);
    sweep.push(collect(err && err.message));
  }

  // ---------- NC10: approval ordering, card content, denial ----------
  resetNet();
  const creds10 = makeCredentials([binding()]);
  const events10 = [];
  const allow10 = makeAllowPort(events10);
  creds10.bindings = (() => { events10.push('bindings'); creds10.bindingsCalls++; return Promise.resolve([binding()]); });
  const origValue = creds10.value.bind(creds10);
  creds10.value = (n) => { events10.push('value'); return origValue(n); };
  on((u) => u === '/fetch', () => { events10.push('send'); return jsonResponse('{"ok":1}'); });
  const r10 = await M.NetworkRuntime.request({
    method: 'POST', url: BOUND_URL,
    headers: { Authorization: 'Bearer $' + NAME },
    credentials: creds10,
    authorization: allow10,
  });
  const ask10 = allow10.asks[0] || {};
  check('NC10 order: bindings → ask → value → send',
    r10.status === 200
    && events10.join(',') === 'bindings,ask,value,send'
    && calls.length === 1,
    JSON.stringify({ events: events10, calls: calls.length }));
  check('NC10b approval card names the credential, never the value',
    ask10.action && ask10.action.detail === 'Uses credential: ' + NAME
    && !JSON.stringify(ask10).includes(VALUE),
    JSON.stringify(ask10));
  resetNet();
  const creds10b = makeCredentials([binding()]);
  const allow10b = makeAllowPort();
  on((u) => u === '/fetch', () => jsonResponse('{"ok":1}'));
  await M.NetworkRuntime.request({
    method: 'POST', url: BOUND_URL,
    headers: { Authorization: 'Bearer $' + NAME },
    body: '{"x":1}',
    credentials: creds10b,
    authorization: allow10b,
  });
  const detail10b = allow10b.asks[0] && allow10b.asks[0].action && allow10b.asks[0].action.detail;
  check('NC10c body-size detail kept, credential line appended',
    typeof detail10b === 'string'
    && detail10b.startsWith('Request body size:')
    && detail10b.indexOf('\nUses credential: ' + NAME) !== -1
    && !JSON.stringify(allow10b.asks[0]).includes(VALUE),
    JSON.stringify(detail10b));

  resetNet();
  const creds10d = makeCredentials([binding()]);
  const deny10 = makeDenyPort();
  const e10d = await netError(() => M.NetworkRuntime.request({
    method: 'POST', url: BOUND_URL,
    headers: { Authorization: 'Bearer $' + NAME },
    body: '{"x":1}',
    credentials: creds10d,
    authorization: deny10,
  }));
  check('NC10d denial happens before any value/send',
    isCode(e10d, 'network_denied') && creds10d.valueCalls.length === 0 && calls.length === 0,
    (e10d && e10d.networkCode) + ' value=' + creds10d.valueCalls.length);
  sweep.push(collect(e10d && e10d.message));

  // ---------- NC11: port failures → network_credential_unavailable ----------
  const portFailures = [
    ['NC11 empty value', [binding()], ''],
    ['NC11b newline in value', [binding()], 'bad\nvalue'],
    ['NC11c control char in value', [binding()], 'bad\tvalue'],
  ];
  for (const [label, bindings, value] of portFailures) {
    resetNet();
    const creds = makeCredentials(bindings, value);
    const err = await netError(() => M.NetworkRuntime.request({
      method: 'GET', url: BOUND_URL,
      headers: { Authorization: 'Bearer $' + NAME },
      credentials: creds,
    }));
    check(label, isCode(err, 'network_credential_unavailable')
      && calls.length === 0 && creds.valueCalls.length === 1,
      (err && err.networkCode) + ' sent=' + calls.length);
    sweep.push(collect(err && err.message));
  }
  resetNet();
  const creds11d = makeCredentials([binding()], () => Promise.reject(new Error('vault down')));
  const e11d = await netError(() => M.NetworkRuntime.request({
    method: 'GET', url: BOUND_URL,
    headers: { Authorization: 'Bearer $' + NAME },
    credentials: creds11d,
  }));
  check('NC11d throwing value() → unavailable', isCode(e11d, 'network_credential_unavailable')
    && calls.length === 0, e11d && e11d.networkCode);
  sweep.push(collect(e11d && e11d.message));

  const bindingsFailures = [
    ['NC11e bindings throws', () => Promise.reject(new Error('nope'))],
    ['NC11f bindings non-array', () => Promise.resolve('nope')],
    ['NC11g bindings bad element', () => Promise.resolve([{ name: 'X' }])],
  ];
  for (const [label, bindingsFn] of bindingsFailures) {
    resetNet();
    const creds = makeCredentials(null);
    creds.bindings = bindingsFn;
    const err = await netError(() => M.NetworkRuntime.request({
      method: 'GET', url: BOUND_URL,
      headers: { Authorization: 'Bearer $' + NAME },
      credentials: creds,
    }));
    check(label, isCode(err, 'network_credential_unavailable')
      && calls.length === 0 && creds.valueCalls.length === 0,
      err && err.networkCode);
    sweep.push(collect(err && err.message));
  }

  // ---------- NC12: redirects are refused for credentialed requests ----------
  resetNet();
  const creds12 = makeCredentials([binding()]);
  on((u) => u === BOUND_URL, () => new Response('', { status: 302, headers: { location: 'https://evil.test/x' } }));
  const e12 = await netError(() => M.NetworkRuntime.request({
    method: 'GET', url: BOUND_URL,
    headers: { Authorization: 'Bearer $' + NAME },
    credentials: creds12,
  }));
  check('NC12 direct 3xx refused, manual redirect requested',
    isCode(e12, 'network_credential_redirect_refused')
    && calls.length === 1 && calls[0].opts.redirect === 'manual',
    (e12 && e12.networkCode) + ' redirect=' + (calls[0] && calls[0].opts.redirect));
  sweep.push(collect(e12 && e12.message));

  resetNet();
  const creds12b = makeCredentials([binding()]);
  on((u) => u === BOUND_URL, () => ({ type: 'opaqueredirect', status: 0, headers: new Headers() }));
  const e12b = await netError(() => M.NetworkRuntime.request({
    method: 'GET', url: BOUND_URL,
    headers: { Authorization: 'Bearer $' + NAME },
    credentials: creds12b,
  }));
  check('NC12b opaqueredirect refused', isCode(e12b, 'network_credential_redirect_refused'),
    e12b && e12b.networkCode);
  sweep.push(collect(e12b && e12b.message));

  resetNet();
  const creds12c = makeCredentials([binding()]);
  on((u) => u === '/fetch', () => jsonResponse('{"ok":1}'));
  const r12c = await M.NetworkRuntime.request({
    method: 'POST', url: BOUND_URL,
    headers: { Authorization: 'Bearer $' + NAME },
    body: '{"x":1}',
    credentials: creds12c,
    authorization: makeAllowPort(),
  });
  check('NC12c relay envelope carries redirect:"manual"',
    r12c.status === 200 && relayEnvelopes.length === 1
    && JSON.stringify(relayEnvelopes[0]).includes('"redirect":"manual"'),
    JSON.stringify(relayEnvelopes[0]));

  resetNet();
  const creds12d = makeCredentials([binding()]);
  on((u) => u === '/fetch', () =>
    jsonResponse('SHOULD-NOT-SEE', { 'x-locus-final-url': 'https://evil.test/final' }));
  const e12d = await netError(() => M.NetworkRuntime.request({
    method: 'POST', url: BOUND_URL,
    headers: { Authorization: 'Bearer $' + NAME },
    body: '{"x":1}',
    credentials: creds12d,
    authorization: makeAllowPort(),
  }));
  check('NC12d relay final-URL hop refused, body not handed over',
    isCode(e12d, 'network_credential_redirect_refused')
    && !(e12d && e12d.message && e12d.message.includes('SHOULD-NOT-SEE')),
    e12d && (e12d.networkCode + ' ' + e12d.message));
  sweep.push(collect(e12d && e12d.message));

  resetNet();
  const creds12e = makeCredentials([binding()]);
  on((u) => u === '/fetch', () => new Response('', { status: 302, headers: {} }));
  const e12e = await netError(() => M.NetworkRuntime.request({
    method: 'POST', url: BOUND_URL,
    headers: { Authorization: 'Bearer $' + NAME },
    body: '{"x":1}',
    credentials: creds12e,
    authorization: makeAllowPort(),
  }));
  check('NC12e relay 3xx refused', isCode(e12e, 'network_credential_redirect_refused'),
    e12e && e12e.networkCode);
  sweep.push(collect(e12e && e12e.message));

  // ---------- NC13: without credentials, redirect behavior unchanged ----------
  resetNet();
  on((u) => u === BOUND_URL, () => new Response('moved on', { status: 302, headers: { location: 'https://evil.test/x' } }));
  const r13 = await M.NetworkRuntime.request({ method: 'GET', url: BOUND_URL });
  check('NC13 no credentials: 3xx is an ordinary response',
    r13.status === 302 && !r13.credentialRedacted && calls[0].opts.redirect === 'follow',
    JSON.stringify({ status: r13.status, redirect: calls[0] && calls[0].opts.redirect }));

  // ---------- NC14: echo shielding (body bytes, headers, finalUrl) ----------
  resetNet();
  const creds14 = makeCredentials([binding()]);
  on((u) => u === BOUND_URL, () => fakeDirectResponse(200,
    'ok "Bearer ' + VALUE + '" end',
    [['x-echo', 'leak ' + VALUE + ' leak'], ['content-type', 'text/plain']],
    BOUND_URL + '?e=' + VALUE));
  const r14 = await M.NetworkRuntime.request({
    method: 'GET', url: BOUND_URL,
    headers: { Authorization: 'Bearer $' + NAME },
    credentials: creds14,
  });
  const body14 = new TextDecoder().decode(r14.bytes);
  check('NC14 body bytes redacted', body14.indexOf(VALUE) === -1
    && body14.includes('Bearer [credential redacted]'), JSON.stringify(body14));
  check('NC14b response header redacted', r14.headers['x-echo'] === 'leak [credential redacted] leak',
    JSON.stringify(r14.headers));
  check('NC14c finalUrl redacted', r14.finalUrl === BOUND_URL + '?e=[credential redacted]',
    r14.finalUrl);
  check('NC14d credentialRedacted flag set', r14.credentialRedacted === true,
    JSON.stringify(r14.credentialRedacted));
  sweep.push(collect(body14), collect(r14.finalUrl), collect(JSON.stringify(r14.headers)));

  // a clean response stays byte-identical, flag still marks the scan
  resetNet();
  const creds14b = makeCredentials([binding()]);
  on((u) => u === BOUND_URL, () => jsonResponse('{"clean":true}'));
  const r14b = await M.NetworkRuntime.request({
    method: 'GET', url: BOUND_URL,
    headers: { Authorization: 'Bearer $' + NAME },
    credentials: creds14b,
  });
  check('NC14e no value in response: bytes unchanged, flag set',
    new TextDecoder().decode(r14b.bytes) === '{"clean":true}' && r14b.credentialRedacted === true,
    new TextDecoder().decode(r14b.bytes));

  // ---------- NC16: shell pass-through + literal echo ----------
  resetNet();
  const creds16 = makeCredentials([binding()]);
  on((u) => u === BOUND_URL, () => jsonResponse('{"via":"shell"}'));
  const t16 = await exec('curl -H "Authorization: Bearer $' + NAME + '" ' + BOUND_URL,
    { credentials: creds16 });
  check('NC16 shell passes the port through (resolved header on the wire)',
    t16.ok && calls.length === 1
    && calls[0].opts.headers.authorization === 'Bearer ' + VALUE,
    JSON.stringify(t16.output) + ' | ' + JSON.stringify(calls[0] && calls[0].opts.headers));
  check('NC16b value resolved exactly once through the shell',
    creds16.valueCalls.length === 1 && creds16.valueCalls[0] === NAME,
    JSON.stringify(creds16.valueCalls));

  const t16c = await exec('echo $' + NAME, {});
  check('NC16c echo prints the literal variable',
    t16c.ok && t16c.output === '$' + NAME, JSON.stringify(t16c.output));

  // shell-level: redaction notice on stderr, -o writes shielded bytes
  resetNet();
  const creds16d = makeCredentials([binding()]);
  on((u) => u === BOUND_URL, () => jsonResponse('{"leak":"' + VALUE + '"}'));
  const vfs16 = shellVfs();
  const ctx16 = { vfs: vfs16, opts: { credentials: creds16d }, cwd: vfs16.defaultCwd() };
  const p16 = await M.runPipeline([simpleCommand('curl', '-H', 'Authorization: Bearer $' + NAME, BOUND_URL)], ctx16);
  check('NC16d stdout carries the placeholder',
    p16.success && p16.stdout.includes('"leak":"[credential redacted]"')
    && !p16.stdout.includes(VALUE), JSON.stringify(p16.stdout));
  check('NC16e stderr carries the redaction notice',
    p16.stderr.includes('[curl: credential value redacted from the response]'),
    JSON.stringify(p16.stderr));
  sweep.push(collect(p16.stdout), collect(p16.stderr));

  resetNet();
  const creds16f = makeCredentials([binding()]);
  on((u) => u === BOUND_URL, () => jsonResponse('{"leak":"' + VALUE + '"}'));
  const vfs16f = shellVfs();
  const ctx16f = { vfs: vfs16f, opts: { credentials: creds16f }, cwd: vfs16f.defaultCwd() };
  const p16f = await M.runPipeline([simpleCommand('curl', '-o', 'out.json', '-H', 'Authorization: Bearer $' + NAME, BOUND_URL)], ctx16f);
  const file16f = new TextDecoder().decode(await vfs16f.readBytes('/home/locus/out.json'));
  check('NC16f -o writes shielded bytes',
    p16f.success && file16f.includes('[credential redacted]') && file16f.indexOf(VALUE) === -1,
    JSON.stringify(file16f));
  sweep.push(collect(p16f.stdout), collect(p16f.stderr), collect(file16f));

  // shell-level failures surface the taxonomy message, never the value
  resetNet();
  const creds16g = makeCredentials([binding()]);
  const t16g = await exec('curl -H "Authorization: Bearer sk-literal-not-secret" ' + BOUND_URL,
    { credentials: creds16g });
  check('NC16g literal refusal through curl',
    !t16g.ok && t16g.output.includes('refusing to send a literal value')
    && t16g.output.includes('write the variable instead')
    && calls.length === 0,
    t16g.output);

  resetNet();
  on((u) => u === BOUND_URL, () => jsonResponse('{"ok":1}'));
  const t16h = await exec('curl -H "Authorization: Bearer $' + NAME + '" ' + BOUND_URL, {});
  check('NC16h without the port the shell sends the literal (unchanged behavior)',
    t16h.ok && calls.length === 1 && calls[0].opts.headers
      && calls[0].opts.headers.authorization === 'Bearer $' + NAME,
    JSON.stringify(calls[0] && calls[0].opts.headers));

  // ---------- NC15: the collected sweep is value-free ----------
  const leaks = sweep.filter((s) => s.includes(VALUE));
  check('NC15 no credential value in any error/output/file', leaks.length === 0,
    JSON.stringify(leaks.slice(0, 3)));
  check('NC15b sweep exercised every scenario', sweep.length >= 20, String(sweep.length));

  await new Promise((r) => setTimeout(r, 50)); // let any stray rejection surface
  check('NC-unhandled no unhandled rejections', unhandled.length === 0,
    unhandled.map((e) => String(e)).join(' | '));

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0)
}

// A bare shell VFS (its own machine: /home/locus writable, no mounts) for
// driving runPipeline directly.
function shellVfs() {
  return new M.VirtualWorkspace({ listCommands: () => Object.keys(M.SHELL_COMMANDS) });
}

// Token-shaped simple command for runPipeline.
function simpleCommand() {
  const argv = [];
  for (const a of arguments) argv.push({ text: a, quoted: false, op: false });
  return { argv: argv };
}

run().catch((e) => { console.error('TEST RUNNER FAIL', e); process.exit(1); });
