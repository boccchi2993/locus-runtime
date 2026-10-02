// Runtime STANDALONE independence gates (M2a origin; M3a extraction form).
//
// Gate A — the runtime package imports and works with ZERO Harness,
//          Product, Vue or Locus-page files in scope. M3a: the
//          implementation modules are real ES modules, so the eval-scope
//          independence proof became a direct-import proof; the module
//          graph itself is pinned Runtime-only by
//          tests/runtime-boundary.test.cjs.
// Gate C — two hosts/sessions in one process: status, execution and
//          disposal never cross.
// Gate D — session prepare waits for in-flight executions; a cancel,
//          reset or dispose landing during the wait refuses the
//          configuration (barrier tests; no timers, no polling).
// Gate F — status subscription semantics: initial read, edge events,
//          unsubscribe, observer-exception containment, late events of
//          a disposed instance.
//
// A hidden dependency on any absent module would throw right here.
// Run: node tests/runtime-standalone.test.mjs

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + String(detail).slice(0, 300) : '')); }
}
const errText = (e) => String(e && e.message ? e.message : e);
const tick = () => new Promise((r) => setTimeout(r, 10));
process.on('unhandledRejection', (e) => { console.error('UNHANDLED:', e && e.stack || e); process.exit(3); });

// ============ Gate A1: the entry imports with NO page loaded ============
// No document/window/network global is defined here at all: any DOM or
// page dependency would throw during import.
let entryImports = false;
let entry = null;
try {
  entry = await import('../src/index.js');
  entryImports = typeof entry.createRuntime === 'function';
} catch (e) { console.error('entry import threw:', e); }
check('A1 the runtime entry imports standalone (no DOM, no page)', entryImports, '');

let assets = null;
try { assets = await import('../src/worker-assets.js'); } catch (e) { console.error(e); }
check('A1b the worker-asset module imports standalone',
  !!assets && typeof assets.PY_WORKER_SOURCE === 'string' && assets.PY_WORKER_SOURCE.includes('ensureLockedPyodide')
  && typeof assets.GREP_WORKER_SOURCE === 'string' && assets.GREP_WORKER_SOURCE.length > 100,
  JSON.stringify({ py: !!(assets && assets.PY_WORKER_SOURCE), grep: !!(assets && assets.GREP_WORKER_SOURCE) }));

// M3a (A1c replacement): the declared __LOCUS_RUNTIME_CORE__ registry no
// longer exists and must not be readable — a hostile or leftover global
// table can never steer the entry. The remaining legal-configuration
// error (missing worker assets) is checked in A1d.
check('A1c the entry ignores a leftover/broken global core registry (no registry seam remains)',
  (async () => {
    globalThis.__LOCUS_RUNTIME_CORE__ = { createPythonRuntime() {} };
    try {
      const h = await entry.createRuntime({ workerAssets: { pyWorkerSource: 'x', grepWorkerSource: 'y' } });
      return typeof h.createSession === 'function';
    } catch (e) { return /incomplete/.test(errText(e)) ? false : false; }
    finally { delete globalThis.__LOCUS_RUNTIME_CORE__; }
  })(), '');
check('A1d createRuntime without worker assets is refused before anything else',
  (async () => {
    globalThis.__LOCUS_RUNTIME_CORE__ = { createPythonRuntime() {}, runShellCommand() {}, runPythonCode() {}, VirtualWorkspace() {} };
    try { await entry.createRuntime({}); return false; }
    catch (e) { return /workerAssets\.pyWorkerSource/.test(errText(e)); }
    finally { delete globalThis.__LOCUS_RUNTIME_CORE__; }
  })(), '');

// ============ Gate A2: the implementation modules directly ============
// Import ONLY the runtime modules. Anything referencing Harness or
// Product modules (agent/store/persistence/extensions/tools/…) would
// fail here — they do not exist in this package.
globalThis.window = { location: { protocol: 'https:' }, addEventListener: () => {} };
globalThis.document = { getElementById: () => { throw new Error('standalone runtime touched the DOM'); } };
const shellMod = await import('../src/shell.js');
const vfsMod = await import('../src/vfs.js');
const CORE = Object.assign({}, shellMod, vfsMod);

const { createRuntime } = entry;
const host = await createRuntime({
  workerAssets: { pyWorkerSource: assets.PY_WORKER_SOURCE, grepWorkerSource: assets.GREP_WORKER_SOURCE },
});
check('A2 a host builds over the module set', typeof host.createSession === 'function' && host.contractVersion === 1, '');
const caps = host.capabilities();
check('A2b capabilities are declared (kinds, sha-pinned bootstrap, policy mechanisms)',
  Array.isArray(caps.executionKinds) && caps.executionKinds.includes('shell') && caps.executionKinds.includes('python')
  && caps.bootstrap && caps.bootstrap.shaPinned === true
  && caps.policyMechanisms.includes('mutationPolicy') && caps.policyMechanisms.includes('authorization'),
  JSON.stringify(caps));
check('A2c capabilities.commands come from the REAL registry and limits from the REAL constants',
  Array.isArray(caps.commands) && caps.commands.length > 0 && caps.commands.includes('echo')
  && caps.limits && caps.limits.shellPipeMaxBytes === shellMod.SHELL_PIPE_MAX_BYTES
  && caps.limits.headTailMaxOutputBytes === shellMod.HEAD_TAIL_MAX_OUTPUT_BYTES
  && caps.limits.pythonTimeoutMs === shellMod.PYTHON_TIMEOUT_MS,
  JSON.stringify({ commands: caps.commands && caps.commands.length, limits: caps.limits }));

const session = host.createSession();
check('A2e a session constructs with NO boot (cold, zero DOM, lazy python)',
  session.status().interpreter === 'cold' && session.status().busyExecutions === 0,
  JSON.stringify(session.status()));

// Text/shell work never starts Python: the document stub above THROWS on
// any touch, and no fetch exists to download with.
{
  const vfs = new CORE.VirtualWorkspace({ listCommands: () => Object.keys(CORE.SHELL_COMMANDS) });
  const echo = await session.execute({ kind: 'shell', input: 'echo hello-standalone', context: { filesystem: vfs } });
  check('A3 shell echo runs through the public entry (no Python, no DOM)', echo.ok === true && echo.output === 'hello-standalone', JSON.stringify(echo));
  const ls = await session.execute({ kind: 'shell', input: 'ls /usr/bin', context: { filesystem: vfs } });
  check('A3b ls lists the injected command surface', ls.ok === true && ls.output.includes('echo'), JSON.stringify(ls.output));
  const wr = await session.execute({ kind: 'shell', input: 'echo data > /tmp/standalone.txt && cat /tmp/standalone.txt', context: { filesystem: vfs } });
  check('A3c VFS write + read run standalone', wr.ok === true && wr.output === 'data\n', JSON.stringify(wr));
  check('A3d the interpreter stayed cold through text work', session.status().interpreter === 'cold', JSON.stringify(session.status()));
}

// ============ Gate F: status subscription semantics ============
{
  const py = session.pythonRuntime();
  const events = [];
  let observerThrows = 0;
  const unsubBad = session.onStatus(() => { observerThrows++; throw new Error('observer boom'); });
  const seen = [];
  const unsub = session.onStatus((snap) => seen.push(snap));
  check('F subscribe delivers the CURRENT snapshot immediately (no poll, no missed edge)',
    seen.length === 1 && seen[0].interpreter === 'cold', JSON.stringify(seen.length));
  check('Fb a throwing observer is contained at delivery',
    observerThrows === 1, String(observerThrows));
  // Drive a real transition through the instance's setStatus boundary path:
  // a fake worker boot failure flips loading → cold.
  const realEnsure = py._ensureWorker;
  py._ensureWorker = async () => { py._setStatus('loading'); py._setStatus('ready'); return; };
  await py.run('1', null, {}).catch(() => {});
  py._ensureWorker = realEnsure;
  await tick();
  check('Fc edge events flow to subscribers in order',
    seen.length === 3 && seen[1].interpreter === 'loading' && seen[2].interpreter === 'ready',
    JSON.stringify(seen.map((s) => s.interpreter)));
  check('Fd the throwing observer received every event too (and never broke the stream)',
    observerThrows === 3, String(observerThrows));
  unsub();
  unsubBad();
  py._setStatus('cold');
  await tick();
  check('Fe after unsubscribe no events are delivered', seen.length === 3, JSON.stringify(seen.length));
}

// ============ Gate D: prepare waits for in-flight executions ============
// Controlled worker: the runtime believes a worker exists; the test
// decides when the run settles.
function attachControlledWorker(rt) {
  const log = [];
  rt._ensureWorker = async () => {};
  rt.worker = { postMessage(msg) { log.push(msg); } };
  return {
    log,
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
function payload(key) {
  return { key, modules: [{ pluginId: 'locus-test-plugin', imports: ['locus_test_plugin'], files: { '__init__.py': 'x = 1\n' } }] };
}

{
  const hostD = await createRuntime({ workerAssets: { pyWorkerSource: assets.PY_WORKER_SOURCE, grepWorkerSource: assets.GREP_WORKER_SOURCE } });
  const sD = hostD.createSession();
  const pyD = sD.pythonRuntime();
  const ctl = attachControlledWorker(pyD);

  // Start a python execution and park it inside the worker call.
  const runPromise = sD.execute({
    kind: 'python',
    input: 'print("parked")',
    context: { filesystem: new CORE.VirtualWorkspace({}) },
  });
  await tick();
  check('D1 the execution reached the worker (busy=1)',
    ctl.log.length === 1 && sD.status().busyExecutions === 1,
    JSON.stringify({ posted: ctl.log.length, busy: sD.status().busyExecutions }));

  // prepare called WHILE the run is in flight: it must WAIT, not apply.
  let prepareSettled = false;
  const preparePromise = sD.prepare({ python: payload('env-d1') })
    .then((r) => { prepareSettled = true; return r; });
  await tick();
  check('D2 prepare waits while an execution is in flight (nothing applied yet)',
    prepareSettled === false && sD.status().extensionKey === null,
    JSON.stringify({ settled: prepareSettled, key: sD.status().extensionKey }));

  // Cancel the prepare's signal during the wait → the configuration is
  // refused, cancellation-shaped, and the in-flight run is untouched.
  const ac = new AbortController();
  const cancelledPrepare = sD.prepare({ signal: ac.signal, python: payload('env-d2') }).catch((e) => e);
  await tick();
  ac.abort();
  const refusal = await cancelledPrepare;
  check('D3 a cancel during the wait refuses the prepare (cancellation-shaped)',
    refusal && refusal.name === 'AbortError' && refusal.cancelled === true, errText(refusal));

  // A reset during the wait also refuses the pending prepare — even though
  // the barrier then resolves (the killed run settles honestly).
  const resetPrepare = sD.prepare({ python: payload('env-d4') }).catch((e) => e);
  await tick();
  sD.reset('boundary while prepare waits');
  const resetRefusal = await resetPrepare;
  check('D4 a reset during the wait refuses the pending configuration',
    !!resetRefusal && /reset while preparation waited/.test(errText(resetRefusal)), errText(resetRefusal));

  // Settle the ORIGINAL run: its own generation was superseded by the
  // reset, so it reports the boundary honestly instead of succeeding.
  const workerMsgId = ctl.log[0].id;
  ctl.resolve(workerMsgId, { stdout: 'parked' });
  const runOutcome = await runPromise;
  check('D5 the in-flight run superseded by the boundary settles honestly (never a clean success)',
    runOutcome.ok === false && /boundary while prepare waits/.test(String(runOutcome.boundary || '')),
    JSON.stringify({ ok: runOutcome.ok, boundary: runOutcome.boundary, stderr: runOutcome.stderr }));

  // Once quiet, EVERY prepare that the boundary overtook has refused
  // (no-late-effect); a FRESH prepare applies.
  const overtaken = await preparePromise.catch((e) => e);
  check('D6 the prepare overtaken by the boundary refused (no late configuration)',
    !!overtaken && /reset while preparation waited/.test(errText(overtaken)), errText(overtaken));
  const applied = await sD.prepare({ python: payload('env-d1') });
  check('D6b a fresh prepare after the boundary applies',
    applied.rebuiltInterpreter === true && sD.status().extensionKey === 'env-d1',
    JSON.stringify({ key: sD.status().extensionKey }));

  // Quiet-session prepare is immediate (the common between-tasks case).
  const t0 = Date.now();
  await sD.prepare({ python: null });
  check('D7 a quiet session prepares without any wait', Date.now() - t0 < 50, String(Date.now() - t0));
  hostD.dispose('gate D done');
}

// ============ Gate C: two hosts never cross ============
{
  const hostA = await createRuntime({ workerAssets: { pyWorkerSource: assets.PY_WORKER_SOURCE, grepWorkerSource: assets.GREP_WORKER_SOURCE } });
  const hostB = await createRuntime({ workerAssets: { pyWorkerSource: assets.PY_WORKER_SOURCE, grepWorkerSource: assets.GREP_WORKER_SOURCE } });
  const sa = hostA.createSession();
  const sb = hostB.createSession();
  const pa = sa.pythonRuntime();
  const pb = sb.pythonRuntime();
  check('C1 two sessions own distinct interpreter instances', pa !== pb, '');

  const eventsA = [];
  const eventsB = [];
  sa.onStatus((s) => eventsA.push(s));
  sb.onStatus((s) => eventsB.push(s));
  pa._setStatus('loading');
  await tick();
  check('C2 status events are instance-scoped (B got only its initial snapshot, no edge)',
    eventsA.length === 2 && eventsB.length === 1,
    JSON.stringify({ a: eventsA.map((s) => s.interpreter), b: eventsB.map((s) => s.interpreter) }));

  const vfsA = new CORE.VirtualWorkspace({});
  const vfsB = new CORE.VirtualWorkspace({});
  await sa.execute({ kind: 'shell', input: 'echo A > /tmp/which.txt', context: { filesystem: vfsA } });
  await sb.execute({ kind: 'shell', input: 'echo B > /tmp/which.txt', context: { filesystem: vfsB } });
  const ra = await sa.execute({ kind: 'shell', input: 'cat /tmp/which.txt', context: { filesystem: vfsA } });
  const rb = await sb.execute({ kind: 'shell', input: 'cat /tmp/which.txt', context: { filesystem: vfsB } });
  check('C3 executions are filesystem-scoped per session', ra.output === 'A\n' && rb.output === 'B\n',
    JSON.stringify({ a: ra.output, b: rb.output }));

  sa.dispose('host A done');
  check('C4 disposing A leaves B fully operational',
    sa.status().disposed !== null && sb.status().disposed === null, JSON.stringify(sb.status()));
  const rb2 = await sb.execute({ kind: 'shell', input: 'echo still-alive', context: { filesystem: vfsB } });
  check('C4b B still executes after A is disposed', rb2.ok === true && rb2.output === 'still-alive', JSON.stringify(rb2));
  let refusedA = null;
  try { await sa.execute({ kind: 'shell', input: 'echo nope', context: { filesystem: vfsA } }); }
  catch (e) { refusedA = e; }
  check('C5 a disposed session refuses new work with its reason',
    !!refusedA && /host A done/.test(errText(refusedA)), errText(refusedA));
  hostA.dispose();
  hostB.dispose();
}

// ============ Gate A4: cold import of a SECOND entry copy ============
{
  const entry2 = await import('../src/index.js?standalone-gate');
  check('A8 a fresh entry import shares no mutable host state',
    typeof entry2.createRuntime === 'function',
    '');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
