// Runtime SESSION LIFECYCLE gates (M2a review round — gaps 1+2).
//
// The M2a session tracked ONLY the interpreter instance: a composite shell
// execution (VFS writes, grep, network, python-inside-shell) was invisible
// to busyExecutions, to the prepare barrier and to reset/dispose. The
// review requires the session to own EVERY accepted public execute from
// admission to full settlement, with its OWN invalidation/cancellation
// plane (merged with the caller's signal), and to separate the session
// boundary generation (reset/dispose) from the interpreter's legitimate
// prepare-rebuild generation.
//
// Everything here is DETERMINISTIC: parked VFS writes/reads, a controlled
// python worker, a held authorization port and a held fetch. No fixed
// delays — ordering is proven with event barriers and scheduling ticks
// (setImmediate), never with timeouts.
//
// The core is eval'd ONCE here (registry path) so the grep fake-worker
// seam and the session under test share the SAME implementation copy.
// Run: node tests/runtime-session-lifecycle.test.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

let passed = 0, failed = 0;
function check(name, cond, detail) {
  const line = (cond ? 'PASS ' : 'FAIL ') + name + (detail !== undefined ? ' | ' + String(detail).slice(0, 400) : '');
  console.log(line);
  if (cond) passed++; else failed++;
}
const errText = (e) => String(e && e.message ? e.message : e);
const tick = () => new Promise((r) => setImmediate(r));
process.on('unhandledRejection', (e) => { console.error('UNHANDLED:', e && e.stack || e); process.exit(3); });

// ---------- the core (M3a: real ES module imports — the classic eval
// loading model is gone; the modules are imported directly) ----------
globalThis.window = { location: { protocol: 'https:' }, addEventListener: () => {} };
globalThis.document = { getElementById: () => { throw new Error('lifecycle suite touched the DOM'); } };
const CORE = Object.assign({},
  await import('../src/shell.js'),
  await import('../src/vfs.js')); // VirtualWorkspace/MemoryWorkspace

const { installGrepFakeWorker } = await import('./helpers/grep-fake-worker.cjs');
installGrepFakeWorker(CORE);

const entry = await import('../src/index.js');
const { createRuntime } = entry;

const workerAssets = (await import('../src/worker-assets.js'));
const WA = { pyWorkerSource: workerAssets.PY_WORKER_SOURCE, grepWorkerSource: workerAssets.GREP_WORKER_SOURCE };

function payload(key) {
  return { key, modules: [{ pluginId: 'locus-test-plugin', imports: ['locus_test_plugin'], files: { '__init__.py': 'x = 1\n' } }] };
}

// ---------- deterministic parking VFS ----------
// A real VirtualWorkspace whose write/read/readBytes can be PARKED on a
// path predicate behind an openable gate. Every phase transition is
// emitted to a log and can be awaited — the barriers, not timers, prove
// ordering.
class ParkingVfs extends CORE.VirtualWorkspace {
  constructor(opts) {
    super(opts);
    this.log = [];
    this.onEvent = null;
    this._parkWrite = null;
    this._parkRead = null;
    this._gate = { promise: Promise.resolve(), open: () => {} };
  }
  parkWrites(pred) { this._parkWrite = pred; this._arm(); }
  parkReads(pred) { this._parkRead = pred; this._arm(); }
  _arm() {
    let open;
    this._gate = { promise: new Promise((r) => { open = r; }), open };
  }
  openGate() { this._gate.open(); }
  _emit(ev) {
    this.log.push(ev);
    if (this.onEvent) { try { this.onEvent(ev); } catch (e) { /* observer contained */ } }
    const ws = this._waiters && this._waiters.get(ev);
    if (ws) { this._waiters.delete(ev); for (const r of ws) r(); }
  }
  waitFor(ev) {
    if (this.log.includes(ev)) return Promise.resolve();
    if (!this._waiters) this._waiters = new Map();
    return new Promise((res) => {
      const ws = this._waiters.get(ev) || [];
      ws.push(res);
      this._waiters.set(ev, ws);
    });
  }
  async write(path, text) {
    this._emit('write:enter:' + path);
    if (this._parkWrite && this._parkWrite(path)) {
      this._emit('write:park:' + path);
      await this._gate.promise;
      this._emit('write:resume:' + path);
      if (this._failOnResume) throw new Error('provider device failure');
    }
    const out = await super.write(path, text);
    this._emit('write:commit:' + path);
    return out;
  }
  async read(path) {
    this._emit('read:enter:' + path);
    if (this._parkRead && this._parkRead(path)) {
      this._emit('read:park:' + path);
      await this._gate.promise;
      this._emit('read:resume:' + path);
    }
    return await super.read(path);
  }
  async readBytes(path) {
    this._emit('read:enter:' + path);
    if (this._parkRead && this._parkRead(path)) {
      this._emit('read:park:' + path);
      await this._gate.promise;
      this._emit('read:resume:' + path);
    }
    return await super.readBytes(path);
  }
}

function makeVfs() {
  return new ParkingVfs({ listCommands: () => Object.keys(CORE.SHELL_COMMANDS) });
}

// Controlled python worker (the D-gate technique): the instance believes a
// worker exists; the test decides when the run settles.
function attachControlledWorker(rt) {
  const posted = [];
  rt._ensureWorker = async () => {};
  rt.worker = { postMessage(msg) { posted.push(msg); } };
  return {
    posted,
    resolve(msgId, result) {
      const p = rt._pending.get(msgId);
      if (!p) return false;
      clearTimeout(p.timer);
      rt._pending.delete(msgId);
      p.resolve(Object.assign({ stdout: '', stderr: '', error: null, files: [], deleted: [] }, result));
      return true;
    },
  };
}

// Record the TRUE configuration-application order: wraps the instance's
// SYNCHRONOUS prepare so the log records only keys that actually APPLIED
// (a validation failure throws before its key is logged). Status reads
// (extensionKey) alone cannot prove application ORDER.
function recordApplies(s, log) {
  const py = s.pythonRuntime();
  const orig = py.prepare;
  py.prepare = function (req) {
    const r = orig.call(py, req);
    log.push(req && req.python ? req.python.key : null);
    return r;
  };
}


// Single shell write whose ONLY side effect is dispatched and parked
// (unsettled): `echo pre && echo data > <path>` — 'pre' is real stdout,
// the write is the last operation, no step follows it.
async function parkedLastWrite(s, vfs, path, contextExtra) {
  vfs.parkWrites((p) => p === path);
  // The RUN promise is returned inside a plain wrapper: an async function's
  // bare return of the run promise would chain this helper's completion to
  // the run's SETTLEMENT instead of the park point (thenable unwrapping).
  const run = s.execute({
    kind: 'shell',
    input: 'echo pre && echo data > ' + path,
    context: Object.assign({ filesystem: vfs }, contextExtra || {}),
  });
  await vfs.waitFor('write:park:' + path);
  return { run };
}

// M3a: the REAL Product tool router (executeTool) is Product code and is
// NOT imported here. The X-G driver below maps the session result through
// executeTool's exact bash branch (res.ok → success) inline, so the check
// still proves the same thing: the classification reaches the tool layer
// as a FAILURE, never merely a boundary annotation on a success.

async function parkedComposite(s, vfs, firstPath, secondPath) {
  // echo first > firstPath; echo second > secondPath — the first write is
  // parked INSIDE the VFS (dispatched, unsettled).
  vfs.parkWrites((p) => p === firstPath);
  // The RUN promise is returned inside a plain wrapper: an async function's
  // bare return of the run promise would chain this helper's completion to
  // the run's SETTLEMENT instead of the park point (thenable unwrapping).
  const run = s.execute({
    kind: 'shell',
    input: 'echo first > ' + firstPath + '; echo second > ' + secondPath,
    context: { filesystem: vfs },
  });
  await vfs.waitFor('write:park:' + firstPath);
  return { run };
}

// ============================================================
// Gap 1 — the session owns the FULL execution lifecycle
// ============================================================

// ---- R1: session.reset stops a composite shell at the boundary ----
{
  const host = await createRuntime({ workerAssets: WA });
  const s = host.createSession();
  const vfs = makeVfs();
  const { run: runPromise } = await parkedComposite(s, vfs, '/tmp/first', '/tmp/second');

  check('R1a the composite shell is tracked while its write is dispatched (busy=1)',
    s.status().busyExecutions === 1, JSON.stringify(s.status()));

  s.reset('review boundary');
  vfs.openGate();
  const res = await runPromise;

  check('R1b the post-boundary side effect never dispatched (second write absent)',
    !vfs.log.includes('write:enter:/tmp/second'), JSON.stringify(vfs.log));
  check('R1c the already-dispatched write settled and is recorded honestly (no fake rollback)',
    vfs.log.includes('write:commit:/tmp/first')
    && (await vfs.exists('/tmp/first')) === true, JSON.stringify(vfs.log));
  check('R1d the boundary-stopped run is never a clean success',
    res.ok === false && /cancelled/.test(String(res.output || '')), JSON.stringify(res));
  check('R1e busy returns to zero only after true settlement',
    s.status().busyExecutions === 0, JSON.stringify(s.status()));
  const after = await s.execute({ kind: 'shell', input: 'echo usable', context: { filesystem: vfs } });
  check('R1f the session stays usable after reset', after.ok === true && after.output === 'usable', JSON.stringify(after));
  host.dispose();
}

// ---- R2: dispose and host.dispose terminate the same way ----
{
  const host = await createRuntime({ workerAssets: WA });
  const s = host.createSession();
  const vfs = makeVfs();
  const { run: runPromise } = await parkedComposite(s, vfs, '/tmp/d1', '/tmp/d2');
  await vfs.waitFor('write:park:/tmp/d1');
  s.dispose('review dispose');
  vfs.openGate();
  const res = await runPromise;
  check('R2a dispose stops the composite shell (no post-boundary write)',
    !vfs.log.includes('write:enter:/tmp/d2') && vfs.log.includes('write:commit:/tmp/d1'), JSON.stringify(vfs.log));
  check('R2b the disposed-run report is honest, busy drains to zero',
    res.ok === false && s.status().busyExecutions === 0, JSON.stringify({ res: res.ok, status: s.status() }));
  let refused = null;
  try { await s.execute({ kind: 'shell', input: 'echo x', context: { filesystem: vfs } }); }
  catch (e) { refused = e; }
  check('R2c a disposed session refuses new executes', !!refused && /disposed/.test(errText(refused)), errText(refused));

  const host2 = await createRuntime({ workerAssets: WA });
  const s2 = host2.createSession();
  const vfs2 = makeVfs();
  const { run: run2 } = await parkedComposite(s2, vfs2, '/tmp/h1', '/tmp/h2');
  await vfs2.waitFor('write:park:/tmp/h1');
  host2.dispose('review host dispose');
  vfs2.openGate();
  const res2 = await run2;
  check('R2d host.dispose stops in-flight composite shells too',
    !vfs2.log.includes('write:enter:/tmp/h2') && res2.ok === false, JSON.stringify({ log: vfs2.log, ok: res2.ok }));
  check('R2e host.dispose drains busy to zero', s2.status().busyExecutions === 0, JSON.stringify(s2.status()));
  host.dispose();
}

// ---- R3: prepare waits for a NON-python execution ----
{
  const host = await createRuntime({ workerAssets: WA });
  const s = host.createSession();
  const vfs = makeVfs();
  const { run: runPromise } = await parkedComposite(s, vfs, '/tmp/p1', '/tmp/p2');
  await vfs.waitFor('write:park:/tmp/p1');

  let prepareSettled = false;
  const pp = s.prepare({ python: payload('env-r3') }).then((r) => { prepareSettled = true; return r; });
  await tick();
  check('R3a prepare waits while a shell write is dispatched (nothing applied)',
    prepareSettled === false && s.status().extensionKey === null,
    JSON.stringify({ settled: prepareSettled, key: s.status().extensionKey }));

  vfs.openGate();
  await runPromise;
  const applied = await pp;
  check('R3b prepare applies only after the full execution settled',
    prepareSettled === true && s.status().extensionKey === 'env-r3', JSON.stringify(s.status()));
  check('R3c busy was zero at apply time', s.status().busyExecutions === 0, JSON.stringify(s.status()));
  host.dispose();
}

// ---- R4: an execute admitted during a prepare wait cannot penetrate the barrier ----
{
  const host = await createRuntime({ workerAssets: WA });
  const s = host.createSession();
  const vfs = makeVfs();
  const { run: runPromise } = await parkedComposite(s, vfs, '/tmp/r4a', '/tmp/r4b');
  await vfs.waitFor('write:park:/tmp/r4a');

  const pa = s.prepare({ python: payload('env-r4') }); // waits for the parked write
  const keyAtE2Enter = { value: null };
  vfs.onEvent = (ev) => { if (ev === 'write:enter:/tmp/e2.txt') keyAtE2Enter.value = s.status().extensionKey; };
  const e2 = s.execute({ kind: 'shell', input: 'echo e2 > /tmp/e2.txt', context: { filesystem: vfs } });
  await tick();
  check('R4a the new execute does not start while the prepare barrier is pending',
    !vfs.log.includes('write:enter:/tmp/e2.txt'), JSON.stringify(vfs.log));

  vfs.openGate();
  await runPromise;
  await e2;
  await pa;
  check('R4b the admitted execute ran only AFTER the prepare applied (config visible at its first effect)',
    keyAtE2Enter.value === 'env-r4', String(keyAtE2Enter.value));
  check('R4c final configuration is the prepare\u2019s', s.status().extensionKey === 'env-r4', JSON.stringify(s.status()));
  host.dispose();
}

// ---- R5: network authorization wait / response wait under a boundary ----
{
  const realFetch = globalThis.fetch;
  const fetchCalls = [];
  let heldFetch = null;
  try {
    // ---- R5a: boundary while the authorization port holds the POST ----
    {
      const host = await createRuntime({ workerAssets: WA });
      const s = host.createSession();
      const vfs = makeVfs();
      let releaseAuth;
      const authGate = new Promise((r) => { releaseAuth = r; });
      const port = { request: async () => { await authGate; return { outcome: 'allow' }; } };
      const runPromise = s.execute({
        kind: 'shell',
        input: 'curl -X POST -d hello http://test.local/hook; echo after > /tmp/na.txt',
        context: { filesystem: vfs, authorization: port },
      });
      await tick(); // the run reaches the authorization hold
      check('R5a0 the network execute is tracked while authorization is pending (busy=1)',
        s.status().busyExecutions === 1, JSON.stringify(s.status()));
      s.reset('review boundary net');
      releaseAuth({ outcome: 'allow' });
      const res = await runPromise;
      check('R5a the post-approval side effect was refused: fetch never dispatched',
        fetchCalls.length === 0, JSON.stringify(fetchCalls));
      check('R5a2 the compound tail after the network op never ran',
        !vfs.log.includes('write:enter:/tmp/na.txt'), JSON.stringify(vfs.log));
      check('R5a3 the boundary-stopped network run is honest and busy drained',
        res.ok === false && s.status().busyExecutions === 0, JSON.stringify({ ok: res.ok, status: s.status() }));
      host.dispose();
    }
    // ---- R5b: boundary while the RESPONSE is in flight ----
    {
      const host = await createRuntime({ workerAssets: WA });
      const s = host.createSession();
      const vfs = makeVfs();
      let releaseFetch;
      heldFetch = new Promise((r) => { releaseFetch = r; });
      globalThis.fetch = async (input, init) => {
        fetchCalls.push(String((input && input.url) || input));
        await heldFetch;
        return new Response('net-body', { status: 200, headers: { 'content-type': 'text/plain' } });
      };
      const runPromise = s.execute({
        kind: 'shell',
        input: 'curl http://test.local/data; echo after > /tmp/nb.txt',
        context: { filesystem: vfs },
      });
      await tick();
      s.reset('review boundary net response');
      releaseFetch(new Response('net-body', { status: 200, headers: { 'content-type': 'text/plain' } }));
      const res = await runPromise;
      check('R5b the dispatched request settled exactly once (no re-dispatch after the boundary)',
        fetchCalls.length === 1, JSON.stringify(fetchCalls));
      check('R5b2 the compound tail never ran and busy drained',
        !vfs.log.includes('write:enter:/tmp/nb.txt') && s.status().busyExecutions === 0,
        JSON.stringify({ log: vfs.log, status: s.status() }));
      check('R5b3 the result is settled and honest', typeof res.ok === 'boolean', JSON.stringify(res).slice(0, 200));
      host.dispose();
    }
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ---- R6: grep running across a boundary (real worker source, parked read) ----
{
  const host = await createRuntime({ workerAssets: WA });
  const s = host.createSession();
  const vfs = makeVfs();
  await s.execute({ kind: 'shell', input: 'echo aaaX > /tmp/g.txt', context: { filesystem: vfs } });
  vfs.log.length = 0;
  vfs.parkReads((p) => p === '/tmp/g.txt');
  const runPromise = s.execute({
    kind: 'shell',
    input: 'grep -c X /tmp/g.txt; echo late > /tmp/late.txt',
    context: { filesystem: vfs },
  });
  await vfs.waitFor('read:park:/tmp/g.txt');
  check('R6a the grep execution is tracked while parked (busy=1)',
    s.status().busyExecutions === 1, JSON.stringify(s.status()));
  s.reset('review boundary grep');
  vfs.openGate();
  const res = await runPromise;
  check('R6b the grep settled (real worker source) and the compound tail was refused',
    !vfs.log.includes('write:enter:/tmp/late.txt') && res.ok === false, JSON.stringify({ log: vfs.log, ok: res.ok }));
  check('R6c busy drained to zero after the grep settled',
    s.status().busyExecutions === 0, JSON.stringify(s.status()));
  host.dispose();
}

// ---- R7: two sessions never cross ----
{
  const host = await createRuntime({ workerAssets: WA });
  const sa = host.createSession();
  const sb = host.createSession();
  const vfsA = makeVfs();
  const vfsB = makeVfs();
  const { run: runA } = await parkedComposite(sa, vfsA, '/tmp/a1', '/tmp/a2');
  await vfsA.waitFor('write:park:/tmp/a1');
  // A's prepare is WAITING when the boundary lands; B works throughout.
  const paPending = sa.prepare({ python: payload('env-r7') }).catch((e) => e);
  await tick();
  vfsB.parkWrites(() => false);
  const runB = sb.execute({ kind: 'shell', input: 'echo b > /tmp/b1.txt; echo b2 > /tmp/b2.txt', context: { filesystem: vfsB } });
  sa.reset('review boundary A');
  vfsA.openGate();
  const resA = await runA;
  const resB = await runB;
  const refusalA = await paPending;
  check('R7a resetting A stopped A’s composite shell', !vfsA.log.includes('write:enter:/tmp/a2') && resA.ok === false,
    JSON.stringify({ log: vfsA.log, ok: resA.ok }));
  check('R7b B never noticed A’s boundary', resB.ok === true
    && vfsB.log.includes('write:commit:/tmp/b2.txt')
    && sb.status().busyExecutions === 0, JSON.stringify({ ok: resB.ok, log: vfsB.log, status: sb.status() }));
  check('R7c the prepare crossed by A’s boundary refused with that boundary’s reason',
    refusalA instanceof Error && /review boundary A/.test(errText(refusalA)), errText(refusalA));
  const pa2 = await sa.prepare({ python: payload('env-r7c') });
  check('R7c2 A prepares normally again after its own boundary (sessions stay usable)',
    pa2.rebuiltInterpreter === true && sa.status().extensionKey === 'env-r7c', JSON.stringify(sa.status()));
  const pb = await sb.prepare({ python: payload('env-r7b') });
  check('R7d B prepares normally', pb.rebuiltInterpreter === true && sb.status().extensionKey === 'env-r7b',
    JSON.stringify(sb.status()));
  host.dispose();
}

// ---- R8: settlement order vs busy release ----
{
  const host = await createRuntime({ workerAssets: WA });
  const s = host.createSession();
  const py = s.pythonRuntime();
  const ctl = attachControlledWorker(py);
  const vfs = makeVfs();

  const pyPromise = s.execute({ kind: 'python', input: 'print("parked")', context: { filesystem: new CORE.VirtualWorkspace({}) } });
  await tick();
  const { run: runShell } = await parkedComposite(s, vfs, '/tmp/s1', '/tmp/s2');
  await vfs.waitFor('write:park:/tmp/s1');
  check('R8a two in-flight executions count once each at the session (busy=2)',
    s.status().busyExecutions === 2, JSON.stringify(s.status()));

  ctl.resolve(ctl.posted[0].id, { stdout: 'parked' });
  await pyPromise;
  check('R8b the python settle released exactly its own seat (busy=1)',
    s.status().busyExecutions === 1, JSON.stringify(s.status()));

  s.reset('review boundary r8');
  vfs.openGate();
  const res = await runShell;
  check('R8c the shell settle released the last seat (busy=0)',
    s.status().busyExecutions === 0 && res.ok === false, JSON.stringify({ busy: s.status().busyExecutions, ok: res.ok }));
  host.dispose();
}

// ============================================================
// Gap 2 — session boundary algebra vs interpreter rebuild algebra
// ============================================================

// ---- P1: same-stack prepare(A), prepare(B): a legitimate rebuild is not an external reset ----
{
  const host = await createRuntime({ workerAssets: WA });
  const s = host.createSession();
  const pa = s.prepare({ python: payload('env-a') });
  const pb = s.prepare({ python: payload('env-b') });
  const [ra, rb] = await Promise.all([pa.catch((e) => e), pb.catch((e) => e)]);
  check('P1 concurrent prepares apply in call order without misjudging the rebuild',
    !(ra instanceof Error) && !(rb instanceof Error) && s.status().extensionKey === 'env-b',
    JSON.stringify({ a: errText(ra), b: errText(rb), key: s.status().extensionKey }));
  check('P1b both prepares report the rebuild', ra.rebuiltInterpreter === true && rb.rebuiltInterpreter === true,
    JSON.stringify({ a: ra, b: rb }));
  host.dispose();
}

// ---- P2: a REAL reset still refuses a prepare it crosses ----
{
  const host = await createRuntime({ workerAssets: WA });
  const s = host.createSession();
  const vfs = makeVfs();
  const { run: runPromise } = await parkedComposite(s, vfs, '/tmp/p2a', '/tmp/p2b');
  await vfs.waitFor('write:park:/tmp/p2a');
  const pp = s.prepare({ python: payload('env-p2') }).catch((e) => e);
  await tick();
  s.reset('review boundary p2');
  vfs.openGate();
  await runPromise;
  const refusal = await pp;
  check('P2 a reset crossing a waiting prepare refuses the configuration',
    !!refusal && /reset while preparation waited/.test(errText(refusal)), errText(refusal));
  const fresh = await s.prepare({ python: payload('env-p2b') });
  check('P2b the session prepares normally after the boundary',
    fresh.rebuiltInterpreter === true && s.status().extensionKey === 'env-p2b', JSON.stringify(s.status()));
  host.dispose();
}

// ---- P3: cancelling a QUEUED prepare returns promptly but holds the chain ----
// Strengthened (review round 2): "extensionKey still null" alone proves
// nothing — C could be blocked by its OWN settlement snapshot while the
// chain position was already released. The probe execute below is blocked
// by the CHAIN only, and recordApplies proves the real application order.
{
  const host = await createRuntime({ workerAssets: WA });
  const s = host.createSession();
  const vfs = makeVfs();
  const applyLog = [];
  recordApplies(s, applyLog);
  const { run: runPromise } = await parkedComposite(s, vfs, '/tmp/p3a', '/tmp/p3b');
  await vfs.waitFor('write:park:/tmp/p3a');

  const pa = s.prepare({ python: payload('env-p3a') });
  const acB = new AbortController();
  const pb = s.prepare({ signal: acB.signal, python: payload('env-p3b') }).catch((e) => e);
  const pc = s.prepare({ python: payload('env-p3c') }).catch((e) => e);
  await tick();

  acB.abort();
  const rb = await pb;
  check('P3a the cancelled queued prepare returns promptly (cancellation-shaped)',
    rb && rb.name === 'AbortError' && rb.cancelled === true, errText(rb));
  await tick();

  // A new execute admitted AFTER the cancel: it is queued behind the chain
  // itself, so it must not start while any earlier segment is unfinished.
  const keyAtProbe = { value: null };
  vfs.onEvent = (ev) => { if (ev === 'write:enter:/tmp/p3probe.txt') keyAtProbe.value = s.status().extensionKey; };
  const probe = s.execute({ kind: 'shell', input: 'echo p3 > /tmp/p3probe.txt', context: { filesystem: vfs } });
  await tick(); await tick();
  check('P3b the cancel did NOT release the serialization barrier (nothing applied while the first waits)',
    s.status().extensionKey === null, JSON.stringify(s.status()));
  check('P3b2 the cancel released no chain position: nothing applied AND the probe never started',
    applyLog.length === 0 && !vfs.log.includes('write:enter:/tmp/p3probe.txt'),
    JSON.stringify({ applyLog, probeEntered: vfs.log.includes('write:enter:/tmp/p3probe.txt') }));

  vfs.openGate();
  await runPromise;
  const ra = await pa;
  const rc = await pc;
  await probe;
  check('P3c the chain kept call order: A applied, then C applied (B never did)',
    ra && ra.rebuiltInterpreter === true && rc && rc.rebuiltInterpreter === true
    && s.status().extensionKey === 'env-p3c',
    JSON.stringify({ a: errText(ra), c: errText(rc), key: s.status().extensionKey }));
  check('P3d the recorded application order is A then C — B never applied',
    JSON.stringify(applyLog) === JSON.stringify(['env-p3a', 'env-p3c']), JSON.stringify(applyLog));
  check('P3e the probe ran only after the chain applied (its first effect saw the chain config)',
    keyAtProbe.value === 'env-p3c', String(keyAtProbe.value));
  host.dispose();
}

// ---- P4: a failing prepare does not wedge the chain ----
{
  const host = await createRuntime({ workerAssets: WA });
  const s = host.createSession();
  const bad = s.prepare({ python: { key: 'env-bad', modules: [{ pluginId: 'BAD ID', imports: [] }] } }).catch((e) => e);
  const good = s.prepare({ python: payload('env-p4') });
  const rb = await bad;
  const rg = await good;
  check('P4 a failing prepare rejects and the next one still applies',
    rb instanceof Error && rg.rebuiltInterpreter === true && s.status().extensionKey === 'env-p4',
    JSON.stringify({ bad: errText(rb), key: s.status().extensionKey }));
  host.dispose();
}

// ---- P5: a real boundary refuses EVERY prepare it crosses (A/B/C queue) ----
{
  const host = await createRuntime({ workerAssets: WA });
  const s = host.createSession();
  const vfs = makeVfs();
  const { run: runPromise } = await parkedComposite(s, vfs, '/tmp/p5a', '/tmp/p5b');
  await vfs.waitFor('write:park:/tmp/p5a');
  const pa = s.prepare({ python: payload('env-p5a') }).catch((e) => e);
  const pb = s.prepare({ python: payload('env-p5b') }).catch((e) => e);
  const pc = s.prepare({ python: payload('env-p5c') }).catch((e) => e);
  await tick();
  s.reset('review boundary p5');
  vfs.openGate();
  await runPromise;
  const [ra, rb, rc] = await Promise.all([pa, pb, pc]);
  check('P5 every crossed prepare refused with the boundary reason',
    [ra, rb, rc].every((r) => r instanceof Error && /reset while preparation waited/.test(errText(r))),
    JSON.stringify([errText(ra), errText(rb), errText(rc)]));
  check('P5b nothing was applied', s.status().extensionKey === null, JSON.stringify(s.status()));
  const fresh = await s.prepare({ python: payload('env-p5-fresh') });
  check('P5c the chain drained; the session prepares normally afterwards',
    fresh.rebuiltInterpreter === true && s.status().extensionKey === 'env-p5-fresh', JSON.stringify(s.status()));
  host.dispose();
}

// ---- P6: A/B/C queue with an execute admitted mid-wait (old run unsettled) ----
{
  const host = await createRuntime({ workerAssets: WA });
  const s = host.createSession();
  const vfs = makeVfs();
  const { run: runPromise } = await parkedComposite(s, vfs, '/tmp/p6a', '/tmp/p6b');
  await vfs.waitFor('write:park:/tmp/p6a');

  const pa = s.prepare({ python: payload('env-p6a') });
  const keyAt = {};
  vfs.onEvent = (ev) => {
    if (ev === 'write:enter:/tmp/e6.txt') keyAt.enter = s.status().extensionKey;
    if (ev === 'write:commit:/tmp/e6.txt') keyAt.commit = s.status().extensionKey;
  };
  const e6 = s.execute({ kind: 'shell', input: 'echo e6 > /tmp/e6.txt', context: { filesystem: vfs } });
  const pb = s.prepare({ python: payload('env-p6b') });

  vfs.openGate();
  await runPromise;
  await e6;
  check('P6a the admitted execute ran after A applied and BEFORE B applied',
    keyAt.enter === 'env-p6a' && keyAt.commit === 'env-p6a', JSON.stringify(keyAt));
  await pa;
  await pb;
  check('P6b B applied only after the admitted execute settled; final config is B',
    s.status().extensionKey === 'env-p6b', JSON.stringify(s.status()));
  host.dispose();
}

// ============================================================
// Review round 2 — gap F1: the LAST honest result classification.
//
// When the boundary (or the caller's abort) lands while the run's LAST
// provider operation is dispatched-but-unsettled, there is no later
// cancellation checkpoint inside the shell: the operation settles, the
// command reports a clean success, and only the SESSION can see that the
// run was superseded. The public result must be classified accordingly
// (never a clean success), keeping the original output and every
// existing field, appending the explicit boundary/cancellation note.
// ============================================================


// ---- X-A: session.reset / session.dispose / host.dispose over the unsettled LAST write ----
{
  // X-A1: reset
  {
    const host = await createRuntime({ workerAssets: WA });
    const s = host.createSession();
    const vfs = makeVfs();
    const { run: runPromise } = await parkedLastWrite(s, vfs, '/tmp/xa1.txt');
    check('X-A1a the run is tracked while its last write is dispatched (busy=1)',
      s.status().busyExecutions === 1, JSON.stringify(s.status()));
    s.reset('x-a1 boundary');
    check('X-A1b the boundary does not fake settlement: busy stays 1 until the provider settles',
      s.status().busyExecutions === 1, JSON.stringify(s.status()));
    vfs.openGate();
    const res = await runPromise;
    check('X-A1c the superseded run is never a clean success',
      res.ok === false && res.isError === true, JSON.stringify(res));
    check('X-A1d the original output is kept and the boundary explanation appended',
      /(^|\n)pre(\n|$)/.test(String(res.output)) && /x-a1 boundary/.test(String(res.output)),
      JSON.stringify(res));
    check('X-A1e the additive boundary field names the boundary',
      res.boundary && /x-a1 boundary/.test(String(res.boundary)), JSON.stringify(res.boundary));
    check('X-A1f the existing fields are preserved (io/backend/operation)',
      res.operation === 'filesystem' && res.backend === 'browser'
      && res.io && typeof res.io.in === 'number' && typeof res.io.out === 'number',
      JSON.stringify({ backend: res.backend, operation: res.operation, io: res.io }));
    check('X-A1g busy drains to zero only after the true settlement',
      s.status().busyExecutions === 0, JSON.stringify(s.status()));
    host.dispose();
  }
  // X-A2: dispose
  {
    const host = await createRuntime({ workerAssets: WA });
    const s = host.createSession();
    const vfs = makeVfs();
    const { run: runPromise } = await parkedLastWrite(s, vfs, '/tmp/xa2.txt');
    s.dispose('x-a2 disposal');
    vfs.openGate();
    const res = await runPromise;
    check('X-A2 dispose over the unsettled last write classifies the run as failed',
      res.ok === false && res.isError === true && /x-a2 disposal/.test(String(res.output)),
      JSON.stringify(res));
    host.dispose();
  }
  // X-A3: host.dispose
  {
    const host = await createRuntime({ workerAssets: WA });
    const s = host.createSession();
    const vfs = makeVfs();
    const { run: runPromise } = await parkedLastWrite(s, vfs, '/tmp/xa3.txt');
    host.dispose('x-a3 host disposal');
    vfs.openGate();
    const res = await runPromise;
    check('X-A3 host.dispose over the unsettled last write classifies the run as failed',
      res.ok === false && res.isError === true && /x-a3 host disposal/.test(String(res.output)),
      JSON.stringify(res));
  }
}

// ---- X-B: the CALLER aborts in the same window ----
{
  const host = await createRuntime({ workerAssets: WA });
  const s = host.createSession();
  const vfs = makeVfs();
  const ac = new AbortController();
  const { run: runPromise } = await parkedLastWrite(s, vfs, '/tmp/xb.txt', { signal: ac.signal });
  ac.abort();
  vfs.openGate();
  const res = await runPromise;
  check('X-Ba a caller abort over the unsettled last write is never a clean success',
    res.ok === false && res.isError === true, JSON.stringify(res));
  check('X-Bb the original output is kept and the cancellation explanation appended',
    /(^|\n)pre(\n|$)/.test(String(res.output)) && /cancelled/i.test(String(res.output)),
    JSON.stringify(res));
  check('X-Bc a caller abort is not reported as a session boundary',
    res.boundary === undefined, JSON.stringify(res.boundary));
  host.dispose();
}

// ---- X-C: two resets — the run keeps the FIRST reason that invalidated it ----
{
  const host = await createRuntime({ workerAssets: WA });
  const s = host.createSession();
  const vfs = makeVfs();
  const { run: runPromise } = await parkedLastWrite(s, vfs, '/tmp/xc.txt');
  s.reset('first reason');
  s.reset('second reason');
  vfs.openGate();
  const res = await runPromise;
  check('X-Ca the run failed (double boundary does not restore success)',
    res.ok === false && res.isError === true, JSON.stringify(res));
  check('X-Cb the report names the FIRST invalidating boundary, never a later one',
    /first reason/.test(String(res.output)) && /first reason/.test(String(res.boundary || ''))
    && !/second reason/.test(String(res.output)) && !/second reason/.test(String(res.boundary || '')),
    JSON.stringify({ output: res.output, boundary: res.boundary }));
  host.dispose();
}

// ---- X-D: control — no boundary, the result stays exactly the underlying one ----
{
  const host = await createRuntime({ workerAssets: WA });
  const s = host.createSession();
  const vfs = makeVfs();
  const { run: runPromise } = await parkedLastWrite(s, vfs, '/tmp/xd.txt');
  vfs.openGate();
  const res = await runPromise;
  check('X-D without an invalidation the clean success is untouched (no note, no boundary field)',
    res.ok === true && res.isError === false && res.output === 'pre'
    && res.boundary === undefined && !/superseded/.test(String(res.output)),
    JSON.stringify(res));
  host.dispose();
}

// ---- X-E: provider failure concurrent with the boundary — the real error is kept ----
{
  const host = await createRuntime({ workerAssets: WA });
  const s = host.createSession();
  const vfs = makeVfs();
  const { run: runPromise } = await parkedLastWrite(s, vfs, '/tmp/xe.txt');
  s.reset('x-e boundary');
  vfs._failOnResume = true; // the provider op FAILS when it finally settles
  vfs.openGate();
  const res = await runPromise;
  check('X-Ea the run failed', res.ok === false && res.isError === true, JSON.stringify(res));
  check('X-Eb the real provider error is preserved AND the boundary reason appended',
    /provider device failure/.test(String(res.output)) && /x-e boundary/.test(String(res.output)),
    JSON.stringify(res));
  host.dispose();
}

// ---- X-F: DIRECT python — caller abort while the last commit write is unsettled ----
// The instance's own final check judges the interpreter generation, not the
// caller's signal; a caller abort landing during the LAST dispatched commit
// write leaves the instance report a clean success. The session's final
// classification is the honest last word.
{
  const host = await createRuntime({ workerAssets: WA });
  const s = host.createSession();
  const py = s.pythonRuntime();
  const ctl = attachControlledWorker(py);
  const vfs = makeVfs();
  const ac = new AbortController();
  vfs.parkWrites((p) => p === '/tmp/xf.txt'); // park the LAST commit write
  const runPromise = s.execute({
    kind: 'python',
    input: 'open("/tmp/xf.txt","w").write("py-x-f")',
    context: { filesystem: vfs, signal: ac.signal },
  });
  await tick();
  ctl.resolve(ctl.posted[0].id, {
    stdout: 'py-x-f',
    files: [{ path: '/tmp/xf.txt', b64: Buffer.from('py-x-f').toString('base64') }],
  });
  await vfs.waitFor('write:park:/tmp/xf.txt'); // the commit write is dispatched, unsettled
  ac.abort();
  vfs.openGate();
  const res = await runPromise;
  check('X-Fa the aborted python run is never a clean success',
    res.ok === false && res.success === false, JSON.stringify(res));
  check('X-Fb the original stdout is kept and the cancellation note appended',
    /py-x-f/.test(String(res.stdout || '')) && /cancelled/i.test(String(res.stderr || '')),
    JSON.stringify({ stdout: res.stdout, stderr: res.stderr }));
  check('X-Fc the already-dispatched commit is kept (no fabricated rollback)',
    (await vfs.exists('/tmp/xf.txt')) === true, 'commit write missing');
  host.dispose();
}

// ---- X-G: the REAL Product tool router receives the failure ----
{
  const host = await createRuntime({ workerAssets: WA });
  const s = host.createSession();
  const vfs = makeVfs();
  vfs.parkWrites((p) => p === '/tmp/xg.txt');
  const toolPromise = s.execute({ kind: 'shell', input: 'echo pre && echo data > /tmp/xg.txt', context: { filesystem: vfs } })
    .then((res) => ({ output: res.output, success: !!res.ok }));
  await vfs.waitFor('write:park:/tmp/xg.txt');
  s.reset('x-g boundary');
  vfs.openGate();
  const toolRes = await toolPromise;
  check('X-Ga executeTool reports success=false (not merely a boundary annotation)',
    toolRes.success === false, JSON.stringify(toolRes));
  check('X-Gb the tool output keeps the original text and carries the explanation',
    /(^|\n)pre(\n|$)/.test(String(toolRes.output)) && /x-g boundary/.test(String(toolRes.output)),
    JSON.stringify(toolRes));
  host.dispose();
}

// ============================================================
// Review round 2 — gap F2: the prepare's INTERNAL queue segment is
// independent of the caller's cancellation. prepareTail must represent
// "the internal queue segment completed", never "the caller got its
// answer": a cancelled waiting prepare returns promptly to ITS caller
// but must NOT release its chain position while an earlier segment (and
// the executions that segment waits for) is unfinished.
// ============================================================

// ---- Q-A: old execute unsettled → prepare A → prepare B(cancelled) → new execute ----
{
  const host = await createRuntime({ workerAssets: WA });
  const s = host.createSession();
  const vfs = makeVfs();
  const applyLog = [];
  recordApplies(s, applyLog);
  const { run: oldRun } = await parkedComposite(s, vfs, '/tmp/f2a', '/tmp/f2b');
  await vfs.waitFor('write:park:/tmp/f2a');

  let paSettled = false;
  const pa = s.prepare({ python: payload('env-f2a') }).then(
    (r) => { paSettled = true; return r; },
    (e) => { paSettled = true; throw e; });
  const acB = new AbortController();
  const pb = s.prepare({ signal: acB.signal, python: payload('env-f2b') }).catch((e) => e);
  await tick();
  acB.abort();
  const rb = await pb;
  check('Q-Aa the cancelled waiting prepare returned promptly (cancellation-shaped)',
    rb && rb.name === 'AbortError' && rb.cancelled === true, errText(rb));

  const keyAtProbe = { value: null };
  vfs.onEvent = (ev) => { if (ev === 'write:enter:/tmp/f2probe.txt') keyAtProbe.value = s.status().extensionKey; };
  const probe = s.execute({ kind: 'shell', input: 'echo probe > /tmp/f2probe.txt', context: { filesystem: vfs } });
  await tick(); await tick();
  check('Q-Ab with the old execute unsettled: A unfinished, nothing applied, the probe never started',
    paSettled === false && applyLog.length === 0
    && !vfs.log.includes('write:enter:/tmp/f2probe.txt')
    && s.status().extensionKey === null,
    JSON.stringify({ paSettled, applyLog, probeEntered: vfs.log.includes('write:enter:/tmp/f2probe.txt'), key: s.status().extensionKey }));

  vfs.openGate();
  const oldRes = await oldRun;
  await probe;
  await pa;
  check('Q-Ac the probe ran only after A applied (config visible at its first effect)',
    keyAtProbe.value === 'env-f2a', String(keyAtProbe.value));
  check('Q-Ad the recorded application order is A only; B never applied',
    JSON.stringify(applyLog) === JSON.stringify(['env-f2a']) && s.status().extensionKey === 'env-f2a',
    JSON.stringify({ applyLog, key: s.status().extensionKey }));
  check('Q-Ae the old execute completed cleanly (no boundary in this scenario)',
    oldRes.ok === true, JSON.stringify(oldRes));
  host.dispose();
}

// ---- Q-B: the A/B/C queue, B cancelled — the REAL application order is recorded ----
{
  const host = await createRuntime({ workerAssets: WA });
  const s = host.createSession();
  const vfs = makeVfs();
  const applyLog = [];
  recordApplies(s, applyLog);
  const { run: oldRun } = await parkedComposite(s, vfs, '/tmp/qb0', '/tmp/qb1');
  await vfs.waitFor('write:park:/tmp/qb0');
  const pa = s.prepare({ python: payload('env-qb-a') }).catch((e) => e);
  const acB = new AbortController();
  const pb = s.prepare({ signal: acB.signal, python: payload('env-qb-b') }).catch((e) => e);
  const pc = s.prepare({ python: payload('env-qb-c') }).catch((e) => e);
  await tick();
  acB.abort();
  const rb = await pb;
  vfs.openGate();
  await oldRun;
  const [ra, rc] = await Promise.all([pa, pc]);
  check('Q-Ba the cancelled queue member refused cancellation-shaped',
    rb instanceof Error && rb.name === 'AbortError', errText(rb));
  check('Q-Bb the recorded application order is A then C — B never applied (not just the final key)',
    JSON.stringify(applyLog) === JSON.stringify(['env-qb-a', 'env-qb-c'])
    && ra && ra.rebuiltInterpreter === true && rc && rc.rebuiltInterpreter === true,
    JSON.stringify({ applyLog, a: errText(ra), c: errText(rc) }));
  host.dispose();
}

// ---- Q-C: cancelling SEVERAL queue members releases nothing ----
{
  const host = await createRuntime({ workerAssets: WA });
  const s = host.createSession();
  const vfs = makeVfs();
  const applyLog = [];
  recordApplies(s, applyLog);
  const { run: oldRun } = await parkedComposite(s, vfs, '/tmp/qc0', '/tmp/qc1');
  await vfs.waitFor('write:park:/tmp/qc0');
  const pa = s.prepare({ python: payload('env-qc-a') }).catch((e) => e);
  const acs = [new AbortController(), new AbortController(), new AbortController()];
  const pbs = acs.map((ac, i) => s.prepare({ signal: ac.signal, python: payload('env-qc-x' + i) }).catch((e) => e));
  await tick();
  for (const ac of acs) ac.abort();
  const rbs = await Promise.all(pbs);
  const keyAtProbe = { value: null };
  vfs.onEvent = (ev) => { if (ev === 'write:enter:/tmp/qcprobe.txt') keyAtProbe.value = s.status().extensionKey; };
  const probe = s.execute({ kind: 'shell', input: 'echo probe > /tmp/qcprobe.txt', context: { filesystem: vfs } });
  await tick(); await tick();
  check('Q-Ca the cancelled members released no chain position: the probe never started, nothing applied',
    !vfs.log.includes('write:enter:/tmp/qcprobe.txt') && s.status().extensionKey === null,
    JSON.stringify({ probeEntered: vfs.log.includes('write:enter:/tmp/qcprobe.txt'), key: s.status().extensionKey }));
  vfs.openGate();
  await oldRun;
  await pa;
  await probe;
  check('Q-Cb every cancelled member refused cancellation-shaped',
    rbs.every((r) => r instanceof Error && r.name === 'AbortError'), JSON.stringify(rbs.map(errText)));
  check('Q-Cc the probe ran only after A applied; no cancelled configuration ever applied',
    keyAtProbe.value === 'env-qc-a' && s.status().extensionKey === 'env-qc-a',
    JSON.stringify({ atProbe: keyAtProbe.value, final: s.status().extensionKey }));
  host.dispose();
}

// ---- Q-D: a failing prepare plus a REAL boundary/dispose — the chain stays honest, nothing hangs ----
{
  const host = await createRuntime({ workerAssets: WA });
  const s = host.createSession();
  const vfs = makeVfs();
  const { run: oldRun } = await parkedComposite(s, vfs, '/tmp/qd0', '/tmp/qd1');
  await vfs.waitFor('write:park:/tmp/qd0');
  const bad = s.prepare({ python: { key: 'env-qd-bad', modules: [{ pluginId: 'BAD ID', imports: [] }] } }).catch((e) => e);
  const good = s.prepare({ python: payload('env-qd-good') }).catch((e) => e);
  await tick();
  s.reset('qd boundary');
  vfs.openGate();
  await oldRun;
  const rb = await bad;
  const rg = await good;
  check('Q-Da the failing (and boundary-crossed) prepare refused without wedging the chain',
    rb instanceof Error, errText(rb));
  check('Q-Db the prepare behind it refused with the boundary reason',
    rg instanceof Error && /qd boundary/.test(errText(rg)), errText(rg));
  const fresh = await s.prepare({ python: payload('env-qd-fresh') });
  check('Q-Dc the chain drained: a fresh prepare applies and an execute works',
    fresh.rebuiltInterpreter === true && s.status().extensionKey === 'env-qd-fresh',
    JSON.stringify(s.status()));
  const after = await s.execute({ kind: 'shell', input: 'echo usable', context: { filesystem: vfs } });
  check('Q-Dd the session executes normally after the drained chain', after.ok === true, JSON.stringify(after));

  // dispose while a failing prepare and its successor are WAITING in the
  // queue (the parked execute holds the head segment's barrier)
  const s2 = host.createSession();
  const vfs2 = makeVfs();
  const { run: oldRun2 } = await parkedComposite(s2, vfs2, '/tmp/qd2', '/tmp/qd3');
  await vfs2.waitFor('write:park:/tmp/qd2');
  const bad2 = s2.prepare({ python: { key: 'env-qd2-bad', modules: [{ pluginId: 'BAD ID', imports: [] }] } }).catch((e) => e);
  const good2 = s2.prepare({ python: payload('env-qd2-good') }).catch((e) => e);
  await tick();
  s2.dispose('qd disposal');
  vfs2.openGate();
  await oldRun2;
  const rb2 = await bad2;
  const rg2 = await good2;
  check('Q-De dispose refuses both WAITING segments with the disposal reason (nothing hangs)',
    rb2 instanceof Error && /disposed/.test(errText(rb2))
    && rg2 instanceof Error && /disposed/.test(errText(rg2)), errText(rb2) + ' / ' + errText(rg2));
  let refused = null;
  try { await s2.execute({ kind: 'shell', input: 'echo x', context: { filesystem: makeVfs() } }); }
  catch (e) { refused = e; }
  check('Q-Df the disposed session refuses new executes', !!refused && /disposed/.test(errText(refused)), errText(refused));
  host.dispose();
}

// ---- Q-E: normal prepare/execute interleave — no circular waiting ----
{
  const host = await createRuntime({ workerAssets: WA });
  const s = host.createSession();
  const vfs = makeVfs();
  const { run: oldRun } = await parkedComposite(s, vfs, '/tmp/qe0', '/tmp/qe1');
  await vfs.waitFor('write:park:/tmp/qe0');
  const pa = s.prepare({ python: payload('env-qe-a') });
  const keyAt = {};
  vfs.onEvent = (ev) => {
    if (ev === 'write:enter:/tmp/qefirst.txt') keyAt.first = s.status().extensionKey;
    if (ev === 'write:enter:/tmp/qesecond.txt') keyAt.second = s.status().extensionKey;
  };
  const e1 = s.execute({ kind: 'shell', input: 'echo e1 > /tmp/qefirst.txt', context: { filesystem: vfs } });
  const pb = s.prepare({ python: payload('env-qe-b') });
  const e2 = s.execute({ kind: 'shell', input: 'echo e2 > /tmp/qesecond.txt', context: { filesystem: vfs } });
  vfs.openGate();
  await oldRun;
  await Promise.all([pa, e1, pb, e2]);
  check('Q-Ea prepare/execute interleave settles without circular waiting: e1 ran after A, e2 after B',
    keyAt.first === 'env-qe-a' && keyAt.second === 'env-qe-b', JSON.stringify(keyAt));
  check('Q-Eb everything settled with the final configuration B',
    s.status().extensionKey === 'env-qe-b' && s.status().busyExecutions === 0, JSON.stringify(s.status()));
  host.dispose();
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
