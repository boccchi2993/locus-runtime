// Network/curl/tool-routing regression tests (node, mocked fetch).
// Run: node tests/network.test.cjs
// No real internet access — global fetch is fully mocked.

// --- browser stubs ---
global.window = { location: { protocol: 'https:' } }; // hosted page → relay available

const M = require('./helpers/core.cjs');

// M2a: bash routes through the PUBLIC runtime entry. The eval'd shell.js
// published the declared core registry, so a real host+session can be
// built here exactly the way a standalone host does (worker sources are
// never booted — this suite runs text commands only).
const { createRuntime } = require('../src/index.js');
// M2a review: the public entry assembles asynchronously — the host and
// session are resolved before the checks drive them.
const __hostPromise = createRuntime({
  workerAssets: { pyWorkerSource: '/* not booted in this suite */', grepWorkerSource: '/* not booted in this suite */' },
});
let __host = null;
let __session = null;
const exec = (tool, input, workspace, opts) => {
  if (tool !== 'bash') throw new Error('runtime suites drive the bash tool only');
  return __session.execute({
    kind: 'shell',
    input,
    context: Object.assign({ filesystem: workspace }, opts || {}),
  }).then((res) => ({ output: res.output, success: !!res.ok, isError: !!res.isError, backend: res.backend, operation: res.operation }));
};

// Any unhandled rejection during the run is a test failure (cleanup paths
// must attach rejection handlers — see N25/N29).
const unhandled = [];
process.on('unhandledRejection', (e) => { unhandled.push(e); });

// --- byte-exact in-memory workspace ---
class MemWS extends M.WorkspaceAdapter {
  constructor(files) {
    super();
    this.name = 'mem';
    this.files = {};
    for (const k in (files || {})) this.files[k] = new TextEncoder().encode(files[k]);
  }
  async list() { return Object.keys(this.files).map((n) => ({ name: n, kind: 'file' })); }
  async read(p) { return new TextDecoder().decode(await this.readBytes(p)); }
  async readBytes(p) {
    p = M.normalizeWorkspacePath(p);
    if (!(p in this.files)) { const e = new Error('No such file: ' + p); e.name = 'NotFoundError'; throw e; }
    return this.files[p];
  }
  async write(p, data) {
    p = M.normalizeWorkspacePath(p);
    this.files[p] = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
  }
  async remove(p) { p = M.normalizeWorkspacePath(p); delete this.files[p]; }
  async mkdir(p) { p = M.normalizeWorkspacePath(p); if (p && p in this.files) { const e = new Error('type mismatch'); e.name = 'TypeMismatchError'; throw e; } }
  async exists(p) { try { p = M.normalizeWorkspacePath(p); } catch (e) { return false; } return p in this.files; }
  async stat(p) {
    p = M.normalizeWorkspacePath(p);
    if (!(p in this.files)) { const e = new Error('No such file: ' + p); e.name = 'NotFoundError'; throw e; }
    return { kind: 'file', size: this.files[p].byteLength, modified: 0 };
  }
}

// --- fetch mock ---
let calls = []; // every fetch() invocation: {url}
let routes = []; // [{match: (url)=>bool, respond: (url)=>Response|throw}]
function on(match, respond) { routes.push({ match, respond }); }
global.fetch = async (url, opts) => {
  calls.push({ url: String(url), opts: opts || {} });
  for (const r of routes) {
    if (r.match(String(url))) return r.respond(String(url));
  }
  throw new Error('no mock route for ' + url);
};
function jsonResponse(body, headers) {
  return new Response(body, { status: 200, headers: Object.assign({ 'content-type': 'application/json' }, headers) });
}
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0xFF, 0xFE, 0x80]);

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + detail : '')); }
}
function reset() { calls = []; routes = []; }
// M3a: the Telemetry sink helper (lastRec) is gone with the Product tool adapter; attribution checks read the execution result.

async function run() {
  __host = await __hostPromise;
  __session = __host.createSession();
  const ws = new MemWS();

  // ---------- 1. curl text → stdout ----------
  reset();
  on((u) => u === 'https://example.test/data.json', () => jsonResponse('{"hello":"world"}'));
  const t1 = await exec('bash', 'curl https://example.test/data.json', ws);
  check('N1 curl text stdout', t1.success && t1.output.includes('{"hello":"world"}'), JSON.stringify(t1.output));
  check('N1b backend browser-direct', t1.backend === 'browser-direct', t1.backend);
  // M3a: the Telemetry record is the Product tool-adapter sink; the Runtime pins the same attribution on the execution result.
  check('N1c telemetry operation=network (result attribution)', t1.operation === 'network' && t1.backend === 'browser-direct'
    && t1.success === true, JSON.stringify(t1));

  // ---------- 2. curl -o text file → workspace bytes ----------
  reset();
  on((u) => u === 'https://example.test/data.json', () => jsonResponse('{"hello":"world"}'));
  const t2 = await exec('bash', 'curl -o raw.json https://example.test/data.json', ws);
  check('N2 curl -o text written', t2.success && t2.output === '[written to /mnt/workspace/raw.json, 17 bytes]',
    JSON.stringify(t2.output));
  check('N2b workspace content exact', new TextDecoder().decode(ws.files['raw.json'] || []) === '{"hello":"world"}');

  // ---------- 3. curl -o binary → byte-perfect ----------
  reset();
  on((u) => u === 'https://example.test/i.png', () =>
    new Response(PNG_BYTES, { status: 200, headers: { 'content-type': 'image/png' } }));
  const t3 = await exec('bash', 'curl -o image.png https://example.test/i.png', ws);
  const written = ws.files['image.png'];
  check('N3 curl -o binary written', t3.success && !!written, JSON.stringify(t3.output));
  check('N3b bytes byte-perfect', !!written && written.length === PNG_BYTES.length
    && written.every((b, i) => b === PNG_BYTES[i]),
    written ? Array.from(written).join(',') : 'missing');

  // ---------- 4. binary to stdout → no garbage, hint to use -o ----------
  reset();
  on((u) => u === 'https://example.test/i.png', () =>
    new Response(PNG_BYTES, { status: 200, headers: { 'content-type': 'image/png' } }));
  const t4 = await exec('bash', 'curl https://example.test/i.png', ws);
  check('N4 binary stdout hint', t4.output.includes('binary response') && t4.output.includes('image/png')
    && t4.output.includes('use curl -o') && !t4.output.includes('PNG\r\n'),
    JSON.stringify(t4.output));

  // ---------- 5. scheme policy: http(s) only ----------
  reset();
  on(() => { throw new Error('no fetch allowed for unsupported schemes'); });
  const t5 = await exec('bash', 'curl file:///etc/passwd', ws);
  check('N5 file: rejected', !t5.success && t5.output.includes('unsupported URL scheme: file:'), t5.output);
  const t5b = await exec('bash', 'curl ftp://example.com/x', ws);
  check('N5b-1 ftp: rejected', !t5b.success && t5b.output.includes('unsupported URL scheme: ftp:'), t5b.output);
  const t5c = await exec('bash', 'curl data:text/html,hello', ws);
  check('N5b-2 data: rejected', !t5c.success && t5c.output.includes('unsupported URL scheme: data:'), t5c.output);
  check('N5b no fetch attempted for unsupported schemes', calls.length === 0, 'calls=' + calls.length);
  // http: is a supported scheme in v1 — an ordinary request is attempted.
  reset();
  on((u) => u === 'http://example.com/', () => jsonResponse('{"plain":1}'));
  const t5d = await exec('bash', 'curl http://example.com', ws);
  check('N5c http: is an ordinary request now', t5d.success && t5d.output.includes('{"plain":1}'), t5d.output);

  // ---------- 6. headers are sent; methods need an approval consumer ----------
  reset();
  on((u) => u === 'https://example.com/h', () => jsonResponse('{"ok":1}'));
  const t6 = await exec('bash', 'curl -H "X-Test: 1" https://example.com/h', ws);
  check('N6 -H accepted and forwarded', t6.success && calls[0].opts.headers && calls[0].opts.headers['x-test'] === '1',
    JSON.stringify(t6.output) + ' | ' + JSON.stringify(calls[0].opts.headers));
  reset();
  const t6b = await exec('bash', 'curl -X POST https://example.com', ws);
  check('N6b side-effecting without approval consumer fails closed',
    !t6b.success && t6b.output.includes('require an execution authorization port') && calls.length === 0,
    t6b.output + ' | calls=' + calls.length);

  // ---------- 7/8. network/CORS failure → transparent edge relay ----------
  reset();
  on((u) => u === 'https://blocked.test/data.json', () => { throw new TypeError('Failed to fetch'); });
  on((u) => u.startsWith('/fetch?'), (u) => {
    check('N8 relay URL encodes target', u === '/fetch?url=' + encodeURIComponent('https://blocked.test/data.json'), u);
    return jsonResponse('{"via":"relay"}', { 'x-locus-final-url': 'https://blocked.test/data.json' });
  });
  const t7 = await exec('bash', 'curl https://blocked.test/data.json', ws);
  check('N7 CORS failure falls back to relay', t7.success && t7.output.includes('{"via":"relay"}'), JSON.stringify(t7.output));
  // M3a: the Telemetry record is the Product tool-adapter sink; the Runtime pins the same attribution on the execution result.
  check('N7b backend edge-relay (result attribution)', t7.backend === 'edge-relay' && t7.operation === 'network', t7.backend);
  check('N7c exactly 2 fetches (direct + relay)', calls.length === 2, calls.map((c) => c.url).join(','));

  // ---------- 8b. file:// + CORS failure → clear error, no relay ----------
  reset();
  global.window.location.protocol = 'file:';
  on((u) => u === 'https://blocked.test/x', () => { throw new TypeError('Failed to fetch'); });
  const t8 = await exec('bash', 'curl https://blocked.test/x', ws);
  check('N8b file:// clear error (no backend internals in the wording)',
    !t8.success && t8.output.includes('no request-forwarding service is available')
    && !/relay|browser|Cloudflare|CORS/i.test(t8.output), t8.output);
  check('N8c no relay attempted from file://', calls.length === 1, calls.map((c) => c.url).join(','));
  global.window.location.protocol = 'https:';

  // ---------- 9. HTTP 404 is authoritative — never relayed ----------
  reset();
  on((u) => u === 'https://example.test/missing', () =>
    new Response('{"error":"not found"}', { status: 404, headers: { 'content-type': 'application/json' } }));
  on((u) => u.startsWith('/fetch?'), () => { throw new Error('relay must NOT be called'); });
  const t9 = await exec('bash', 'curl https://example.test/missing', ws);
  check('N9 404 reported, not relayed', !t9.success && t9.output.includes('HTTP 404')
    && calls.length === 1 && t9.backend === 'browser-direct',
    t9.output + ' | calls=' + calls.length + ' | backend=' + t9.backend);

  // ---------- 10. relay binary safety ----------
  reset();
  on((u) => u === 'https://blocked.test/i.png', () => { throw new TypeError('Failed to fetch'); });
  on((u) => u.startsWith('/fetch?'), () =>
    new Response(PNG_BYTES, { status: 200, headers: { 'content-type': 'image/png', 'x-locus-final-url': 'https://blocked.test/i.png' } }));
  const t10 = await exec('bash', 'curl -o r.png https://blocked.test/i.png', ws);
  const wb = ws.files['r.png'];
  check('N10 relay binary byte-perfect', t10.success && t10.backend === 'edge-relay' && !!wb
    && wb.length === PNG_BYTES.length && wb.every((b, i) => b === PNG_BYTES[i]),
    t10.output + ' | backend=' + t10.backend);

  // ---------- relay's own errors surface clearly ----------
  reset();
  on((u) => u === 'https://blocked.test/slow', () => { throw new TypeError('Failed to fetch'); });
  on((u) => u.startsWith('/fetch?'), () =>
    new Response(JSON.stringify({ error: { message: 'Upstream timed out after 30000ms' } }),
      { status: 504, headers: { 'content-type': 'application/json', 'x-locus-relay-error': '1' } }));
  const t11 = await exec('bash', 'curl https://blocked.test/slow', ws);
  check('N11 relay error surfaced', !t11.success && t11.output.includes('Upstream timed out after 30000ms'), t11.output);
  check('N11b model-facing wording hides the backend topology',
    !/relay|browser|Cloudflare|CORS/i.test(t11.output), t11.output);

  // ---------- 13. cloud_bash still unsuccessful ----------
  // M3a: the cloud_bash tool adapter (output 'Cloud execution is not configured.' and its backend=cloud attribution) is the Product tool-adapter layer; the Runtime drives the bash tool only (pinned by the exec helper in this suite).

  // ---------- ordinary commands keep backend=browser ----------
  // M3a: N14 moved to the Product tool-adapter suite (executeTool telemetry sink): the 'browser' backend default is the Product adapter's own tool label — the Runtime result carries no backend/operation for plain non-network, non-filesystem commands.

  // ---------- 15. direct requests are anonymous by construction (F13) ----------
  reset();
  on((u) => u === 'https://example.test/anon', () => jsonResponse('{"ok":1}'));
  await exec('bash', 'curl https://example.test/anon', ws);
  check('N15 direct fetch omits credentials', calls[0].opts.credentials === 'omit', JSON.stringify(calls[0].opts));

  reset();
  const t15b = await exec('bash', 'curl https://user:pass@example.test/x', ws);
  check('N15b URL userinfo rejected', !t15b.success && t15b.output.includes('credentials in URLs')
    && calls.length === 0, t15b.output);

  // ---------- 16. client deadline: timeout is NOT a CORS failure, never relayed ----------
  reset();
  on((u) => u === 'https://slow.test/x', () => new Promise((resolve, reject) => {
    // hangs until the runtime's own deadline aborts it
    const sig = calls[calls.length - 1].opts.signal;
    if (sig) sig.addEventListener('abort', () => {
      const e = new Error('aborted'); e.name = 'AbortError'; reject(e);
    });
  }));
  on((u) => u.startsWith('/fetch?'), () => { throw new Error('relay must NOT be called on timeout'); });
  let t16Err = null;
  try { await M.NetworkRuntime.fetch('https://slow.test/x', { timeoutMs: 30 }); } catch (e) { t16Err = e; }
  check('N16 timeout reported, not relayed', t16Err && t16Err.timeout === true && t16Err.message.includes('timed out')
    && calls.length === 1, (t16Err && t16Err.message) + ' | calls=' + calls.length);

  // ---------- 17. oversized response rejected by client cap ----------
  reset();
  on((u) => u === 'https://example.test/huge', () =>
    new Response('x', { status: 200, headers: { 'content-type': 'text/plain', 'content-length': String(20 * 1024 * 1024) } }));
  on((u) => u.startsWith('/fetch?'), () => { throw new Error('relay must NOT be called on size cap'); });
  const t17 = await exec('bash', 'curl https://example.test/huge', ws);
  check('N17 oversized response rejected, not relayed', !t17.success && t17.output.includes('too large')
    && calls.length === 1, t17.output + ' | calls=' + calls.length);

  // ---------- 18. curl -o target authority is checked BEFORE any network request ----------
  reset();
  on((u) => true, () => { throw new Error('no fetch allowed'); });
  const bare18 = new M.VirtualWorkspace({ listCommands: () => Object.keys(M.SHELL_COMMANDS) });
  // an unmounted /mnt/workspace target fails BEFORE the fetch
  const t18 = await exec('bash', 'curl -o /mnt/workspace/file.bin https://example.test/x', bare18);
  check('N18 curl -o unmounted workspace: fails before network', !t18.success && t18.output.includes('not mounted')
    && calls.length === 0, t18.output + ' | calls=' + calls.length);
  // a read-only target fails BEFORE the fetch too
  const t18b = await exec('bash', 'curl -o /mnt/upload/file.bin https://example.test/x', bare18);
  check('N18b curl -o read-only mount: fails before network', !t18b.success
    && t18b.output.includes('read-only filesystem') && calls.length === 0, t18b.output + ' | calls=' + calls.length);
  // but the bare machine CAN download: /mnt/download works without a workspace
  reset();
  on((u) => true, () => new Response('downloaded', { status: 200, headers: { 'content-type': 'application/octet-stream' } }));
  const t18c = await exec('bash', 'curl -o /mnt/download/file.bin https://example.test/x', bare18);
  check('N18c curl -o /mnt/download succeeds WITHOUT a workspace', t18c.success && calls.length === 1
    && new TextDecoder().decode(await bare18.readBytes('/mnt/download/file.bin')) === 'downloaded'
    && t18c.output === '[written to /mnt/download/file.bin, 10 bytes]',
    t18c.output + ' | calls=' + calls.length);

  // ---------- 19. pre-aborted cancellation is not misread as CORS ----------
  reset();
  const ac = new AbortController();
  ac.abort();
  let cancelErr = null;
  try { await M.NetworkRuntime.fetch('https://example.test/x', { signal: ac.signal }); } catch (e) { cancelErr = e; }
  check('N19 cancelled request → AbortError, no fetch, no relay',
    cancelErr && cancelErr.name === 'AbortError' && calls.length === 0,
    (cancelErr && cancelErr.name) + ' | calls=' + calls.length);

  // ---------- 20. deadline covers the BODY, not just headers (Finding 2) ----------
  // headers arrive immediately, body never completes → must still time out
  reset();
  on((u) => u === 'https://stall.test/x', () => new Response(
    new ReadableStream({ start() { /* never enqueues, never closes */ } }),
    { status: 200, headers: { 'content-type': 'text/plain' } }));
  on((u) => u.startsWith('/fetch?'), () => { throw new Error('relay must NOT be called on timeout'); });
  let t20Err = null;
  const t20start = Date.now();
  try { await M.NetworkRuntime.fetch('https://stall.test/x', { timeoutMs: 40 }); } catch (e) { t20Err = e; }
  check('N20 body stall times out', t20Err && t20Err.timeout === true && t20Err.message.includes('timed out'),
    (t20Err && t20Err.message) + ' after ' + (Date.now() - t20start) + 'ms');
  check('N20b body-stall timeout is not relayed', calls.length === 1, 'calls=' + calls.length);

  // ---------- 21. external cancel during body read ----------
  reset();
  on((u) => u === 'https://slowbody.test/x', () => new Response(
    new ReadableStream({
      start(ctrl) { ctrl.enqueue(new TextEncoder().encode('chunk1')); /* then stalls */ },
    }),
    { status: 200, headers: { 'content-type': 'text/plain' } }));
  const ac21 = new AbortController();
  setTimeout(() => ac21.abort(), 30);
  let t21Err = null;
  try { await M.NetworkRuntime.fetch('https://slowbody.test/x', { signal: ac21.signal, timeoutMs: 5000 }); } catch (e) { t21Err = e; }
  check('N21 cancel during body read → AbortError', t21Err && t21Err.name === 'AbortError',
    t21Err && t21Err.name + '/' + t21Err.message);

  // ---------- 22. slow body INSIDE the deadline completes fine ----------
  reset();
  on((u) => u === 'https://trickle.test/x', () => new Response(
    new ReadableStream({
      async start(ctrl) {
        for (let i = 0; i < 5; i++) {
          ctrl.enqueue(new TextEncoder().encode('c' + i));
          await new Promise((r) => setTimeout(r, 15));
        }
        ctrl.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'text/plain' } }));
  const t22 = await M.NetworkRuntime.fetch('https://trickle.test/x', { timeoutMs: 5000 });
  check('N22 slow body within deadline completes', new TextDecoder().decode(t22.bytes) === 'c0c1c2c3c4'
    && t22.backend === 'browser-direct', new TextDecoder().decode(t22.bytes));

  // ---------- 23. relay body stall times out at the PASSED relay deadline ----------
  // relayTimeoutMs is a supported fetch() option: it must actually reach
  // the relay attempt. Proof is the elapsed time (40ms deadline vs the
  // 45000ms default), not merely that some timeout is eventually thrown.
  reset();
  on((u) => u === 'https://blocked2.test/x', () => { throw new TypeError('Failed to fetch'); });
  on((u) => u.startsWith('/fetch?'), () => new Response(
    new ReadableStream({ start() { /* stalls */ } }),
    { status: 200, headers: { 'content-type': 'text/plain' } }));
  let t23Err = null;
  const t23start = Date.now();
  try { await M.NetworkRuntime.fetch('https://blocked2.test/x', { timeoutMs: 40, relayTimeoutMs: 40 }); } catch (e) { t23Err = e; }
  const t23elapsed = Date.now() - t23start;
  check('N23 relay body stall → timeout error (not unreachable, not retry loop)',
    t23Err && t23Err.timeout === true && !t23Err.message.includes('unreachable'),
    t23Err && t23Err.message);
  check('N23b the PASSED 40ms deadline was actually used (not the 45s default)',
    t23elapsed < 5000, 'elapsed=' + t23elapsed + 'ms');
  check('N23c default relay deadline retained', M.RELAY_CLIENT_TIMEOUT_MS === 45000,
    'RELAY_CLIENT_TIMEOUT_MS=' + M.RELAY_CLIENT_TIMEOUT_MS);

  // ---------- 24. stream cleanup must not block the timeout exit (cancel never settles) ----------
  reset();
  on((u) => u === 'https://hangcancel.test/x', () => new Response(
    new ReadableStream({
      start() { /* read stalls */ },
      cancel() { return new Promise(() => {}); }, // cleanup hangs forever
    }),
    { status: 200, headers: { 'content-type': 'text/plain' } }));
  let t24Err = null;
  const t24start = Date.now();
  try { await M.NetworkRuntime.fetch('https://hangcancel.test/x', { timeoutMs: 40 }); } catch (e) { t24Err = e; }
  const t24elapsed = Date.now() - t24start;
  check('N24 hanging reader.cancel() does not block the timeout exit',
    t24Err && t24Err.timeout === true && t24elapsed < 5000,
    (t24Err && t24Err.message) + ' after ' + t24elapsed + 'ms');

  // ---------- 25. stream cleanup rejection is swallowed (no unhandled rejection) ----------
  reset();
  on((u) => u === 'https://rejectcancel.test/x', () => new Response(
    new ReadableStream({
      start() { /* read stalls */ },
      cancel() { return Promise.reject(new Error('cleanup blew up')); },
    }),
    { status: 200, headers: { 'content-type': 'text/plain' } }));
  let t25Err = null;
  try { await M.NetworkRuntime.fetch('https://rejectcancel.test/x', { timeoutMs: 40 }); } catch (e) { t25Err = e; }
  check('N25 rejecting reader.cancel() keeps the timeout classification',
    t25Err && t25Err.timeout === true, t25Err && t25Err.message);

  // ---------- 26. normal cleanup still works (cancel resolves) ----------
  reset();
  let t26cancelled = false;
  on((u) => u === 'https://okcancel.test/x', () => new Response(
    new ReadableStream({
      start() { /* read stalls */ },
      cancel() { t26cancelled = true; return Promise.resolve(); },
    }),
    { status: 200, headers: { 'content-type': 'text/plain' } }));
  let t26Err = null;
  try { await M.NetworkRuntime.fetch('https://okcancel.test/x', { timeoutMs: 40 }); } catch (e) { t26Err = e; }
  check('N26 resolving reader.cancel() → timeout error, cleanup ran',
    t26Err && t26Err.timeout === true && t26cancelled === true,
    (t26Err && t26Err.message) + ' cancelled=' + t26cancelled);

  // ---------- 27. size-cap exit is also not blocked by hanging cleanup ----------
  reset();
  on((u) => u === 'https://bigcancel.test/x', () => new Response(
    new ReadableStream({
      start(ctrl) {
        const mb = new Uint8Array(1024 * 1024);
        for (let i = 0; i < 17; i++) ctrl.enqueue(mb); // 17 MiB > 16 MiB cap
      },
      cancel() { return new Promise(() => {}); }, // cleanup hangs forever
    }),
    { status: 200, headers: { 'content-type': 'application/octet-stream' } }));
  let t27Err = null;
  const t27start = Date.now();
  try { await M.NetworkRuntime.fetch('https://bigcancel.test/x', { timeoutMs: 5000 }); } catch (e) { t27Err = e; }
  const t27elapsed = Date.now() - t27start;
  check('N27 too-large exit not blocked by hanging reader.cancel()',
    t27Err && t27Err.tooLarge === true && t27elapsed < 5000,
    (t27Err && t27Err.message) + ' after ' + t27elapsed + 'ms');

  // ---------- 28. external cancel + hanging cleanup → AbortError promptly ----------
  reset();
  on((u) => u === 'https://extcancel.test/x', () => new Response(
    new ReadableStream({
      start() { /* read stalls */ },
      cancel() { return new Promise(() => {}); },
    }),
    { status: 200, headers: { 'content-type': 'text/plain' } }));
  const ac28 = new AbortController();
  setTimeout(() => ac28.abort(), 30);
  let t28Err = null;
  const t28start = Date.now();
  try { await M.NetworkRuntime.fetch('https://extcancel.test/x', { signal: ac28.signal, timeoutMs: 60000 }); } catch (e) { t28Err = e; }
  const t28elapsed = Date.now() - t28start;
  check('N28 external cancel + hanging cleanup → AbortError, not blocked',
    t28Err && t28Err.name === 'AbortError' && t28elapsed < 5000,
    (t28Err && t28Err.name) + ' after ' + t28elapsed + 'ms');

  // ---------- 30. GET/HEAD + body is an explicit local error (no silent drop) ----------
  reset();
  on(() => { throw new Error('no fetch allowed for GET/HEAD + body'); });
  const t30 = await exec('bash', "curl -X GET -d 'x=1' https://example.test/x", ws);
  check('G1 -X GET -d → explicit local error, zero attempts',
    !t30.success && t30.output.includes('unsupported request combination')
    && t30.output.includes('GET') && calls.length === 0, t30.output + ' calls=' + calls.length);
  const t30b = await exec('bash', "curl -I -d 'x=1' https://example.test/x", ws);
  check('G2 -I -d → explicit local error, zero attempts',
    !t30b.success && t30b.output.includes('unsupported request combination')
    && t30b.output.includes('HEAD') && calls.length === 0, t30b.output + ' calls=' + calls.length);
  const t30c = await exec('bash', "curl -d 'x=1' https://example.test/x", ws);
  check('G3 POST -d is NOT caught by the GET-body guard (fails later at approvals)',
    !t30c.success && t30c.output.includes('require an execution authorization port'), t30c.output);

  // ---------- 31. curl -I shows HEAD response headers ----------
  reset();
  on((u) => u === 'https://example.test/h', () => new Response(null, {
    status: 200,
    headers: { 'content-type': 'text/plain', 'x-test-header': 'yes', 'content-length': '123' },
  }));
  const t31 = await exec('bash', 'curl -I https://example.test/h', ws);
  check('H1 direct HEAD → headers shown, backend browser-direct',
    t31.success && t31.output.includes('HTTP 200') && t31.output.includes('x-test-header: yes')
      && t31.output.includes('content-length: 123') && t31.backend === 'browser-direct',
    JSON.stringify(t31.output) + ' backend=' + t31.backend);
  check('H1b no body fetch round-trips beyond the HEAD', calls.length === 1, 'calls=' + calls.length);

  reset();
  on((u) => u === 'https://example.test/h', () => new Response(null, { status: 404, headers: {} }));
  on(() => { throw new Error('relay must NOT be called for a HEAD 404'); });
  const t31b = await exec('bash', 'curl -I https://example.test/h', ws);
  check('H3 HEAD 404 → headers reported, no fallback',
    !t31b.success && t31b.output.includes('HTTP 404') && calls.length === 1, t31b.output + ' calls=' + calls.length);

  reset();
  on((u) => u === 'https://blocked.test/h', () => { throw new TypeError('Failed to fetch'); });
  on((u) => u === '/fetch', () => {
    const sent = JSON.parse(calls[calls.length - 1].opts.body);
    check('H2 HEAD fallback keeps method HEAD in the envelope', sent.method === 'HEAD',
      JSON.stringify(sent));
    return new Response(null, { status: 200, headers: { 'content-type': 'text/plain', 'x-head': 'relay' } });
  });
  const t31c = await exec('bash', 'curl -I https://blocked.test/h', ws);
  check('H2b HEAD fallback shows headers via the envelope leg', t31c.success
    && t31c.output.includes('HTTP 200') && t31c.output.includes('x-head: relay')
    && t31c.backend === 'edge-relay', JSON.stringify(t31c.output) + ' backend=' + t31c.backend);

  reset();
  // A non-conforming server sends a BODY on HEAD: the shell must not output it.
  on((u) => u === 'https://example.test/h', () => new Response('SHOULD-NOT-SHOW', {
    status: 200, headers: { 'content-type': 'text/plain' },
  }));
  const t31d = await exec('bash', 'curl -I https://example.test/h', ws);
  check('H5 HEAD body from a buggy server is never output',
    t31d.success && t31d.output.includes('HTTP 200') && !t31d.output.includes('SHOULD-NOT-SHOW'),
    JSON.stringify(t31d.output));

  // ---------- 32. query secrets never reach output/telemetry (N-F04) ----------
  reset();
  on((u) => u === 'https://example.test/missing?token=SECRET_QUERY_123', () =>
    new Response('{"error":"nf"}', { status: 404, headers: { 'content-type': 'application/json' } }));
  const t32 = await exec('bash', 'curl "https://example.test/missing?token=SECRET_QUERY_123"', ws);
  check('N-F04a wire request still carries the query', calls.length === 1
    && calls[0].url.includes('token=SECRET_QUERY_123'), calls[0] && calls[0].url);
  check('N-F04b tool output hides the query secret',
    !t32.output.includes('SECRET_QUERY_123') && t32.output.includes('HTTP 404')
    && t32.output.includes('https://example.test/missing'), t32.output);
  // M3a: telemetry-record non-leak moved to the Product tool-adapter suite; the Runtime has no execution telemetry (pinned by runtime-boundary).

  reset();
  on((u) => u === 'https://blocked.test/s?token=SECRET_QUERY_123', () => { throw new TypeError('Failed to fetch'); });
  on((u) => u.startsWith('/fetch?'), () =>
    new Response(JSON.stringify({ error: { message: 'Upstream timed out after 30000ms' } }),
      { status: 504, headers: { 'content-type': 'application/json', 'x-locus-relay-error': '1' } }));
  const t32b = await exec('bash', 'curl "https://blocked.test/s?token=SECRET_QUERY_123"', ws);
  // M3a: telemetry-record non-leak moved to the Product tool-adapter suite; the Runtime has no execution telemetry (pinned by runtime-boundary).
  check('N-F04d relay-leg error output/telemetry hide the query secret',
    !t32b.output.includes('SECRET_QUERY_123'), t32b.output);

  await new Promise((r) => setTimeout(r, 50)); // let any stray rejection surface
  check('N29 no unhandled rejections from stream cleanup', unhandled.length === 0,
    unhandled.map((e) => String(e)).join(' | '));

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.error('TEST RUNNER FAIL', e); process.exit(1); });
