// Python interpreter lifecycle tests (M1b, repository split): the
// interpreter is an INSTANCE built by createPythonRuntime(), and its
// lifecycle is explicit (prepare / run / reset / dispose / snapshot).
//
//  LC1  prepare is pure configuration: no worker, no creator iframe, no
//       asset download; same key = no-op rebuild; key change = reset +
//       reconfigure; a null payload returns to the core-only runtime.
//  LC2  prepare is all-or-nothing: an invalid payload throws and leaves
//       the previously configured payload fully intact (never a
//       half-applied reset); a cancelled prepare applies nothing.
//  LC3  two instances share NOTHING mutable: pending map, queue, queued-run
//       set, plugin payload, disposed flag are per instance; reset(A) does
//       not touch B, dispose(A) does not touch B.
//  LC4  execution state: a run driven through a controlled worker fixture
//       resolves on ITS instance; reset during execution invalidates the
//       in-flight run (honest error, never committed into new state) and
//       drains queued runs; late worker messages after reset are dropped
//       and never resolve or mutate anything; the instance stays reusable.
//  LC5  dispose is idempotent, permanently refuses prepare/run/
//       configureExtensions, and keeps dropping late arrivals.
//  LC6  the shell executes python on the INJECTED instance (opts.
//       pythonRuntime), converges with prepare on the SAME object, and
//       fails loudly without one — no page-global anywhere.
//  LC7  snapshot() reports interpreter status, busy executions, extension
//       key and disposal state.
//
// Reset/contract notes these tests pin down: a reset/dispose kills the
// worker stack SYNCHRONOUSLY; the in-flight run's promise settles at its
// next await boundary — without a task signal it RESOLVES with `error` set
// (an honest failure report), with an aborted task signal it REJECTS as
// cancelled; a queued-but-unstarted run REJECTS with the boundary reason.
// The worker boundary is stubbed at the message level (same technique as
// shell.test.cjs); REAL browser python behavior is gated by the e2e python
// suites, which drive the SAME production instance through the app seam.
// Run: node tests/python-lifecycle.test.cjs

global.window = { location: { protocol: 'https:' }, addEventListener: () => {} };
global.document = { getElementById: () => null };

const M = require('./helpers/core.cjs');
const { freshRuntime } = require('./helpers/runtime.cjs');

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + detail : '')); }
}
const errText = (e) => String(e && e.message ? e.message : e);
process.on('unhandledRejection', (e) => { console.error('UNHANDLED:', e && e.stack || e); process.exit(3); });
const tick = () => new Promise((r) => setTimeout(r, 10));

// A payload matching the documented PluginPayload shape (extensions.js
// identity rules) with LEGACY synthetic files — enough for configure-time
// validation; no worker ever sees it in this suite.
function payload(key, pluginId) {
  return {
    key: key,
    modules: [{
      pluginId: pluginId || 'locus-test-plugin',
      imports: ['locus_test_plugin'],
      files: { '__init__.py': 'x = 1\n' },
    }],
  };
}

// Controlled worker fixture: the runtime believes a booted worker exists;
// the test decides when (and with what) each posted request resolves.
function attachControlledWorker(rt) {
  const log = [];
  rt._ensureWorker = async () => {};
  rt.worker = {
    postMessage(msg) { if (!rt.worker) { console.error(String(new Error().stack)); process.exit(3); } log.push(msg); },
  };
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

async function run() {
  // ================= LC1. prepare is pure configuration =================
  {
    const domCalls = [];
    global.document = {
      getElementById: (id) => { domCalls.push('get:' + id); return null; },
      createElement: () => { throw new Error('prepare must not create DOM'); },
      body: { appendChild: () => { throw new Error('prepare must not attach DOM'); } },
    };
    const fetchCalls = [];
    const realFetch = global.fetch;
    global.fetch = (url) => { fetchCalls.push(String(url)); return Promise.reject(new Error('prepare must not fetch')); };
    try {
      const rt = freshRuntime(M);
      const first = await rt.prepare({ python: payload('env-a') });
      check('LC1 first prepare configures and reports the rebuild',
        first.rebuiltInterpreter === true && rt.extensionKey() === 'env-a', JSON.stringify(first));
      check('LC1b prepare never booted: status cold, no worker, no creator',
        rt.status === 'cold' && rt.worker === null && rt._creator === null && rt._boot === null,
        JSON.stringify(rt.snapshot()));
      check('LC1c prepare performed zero downloads', fetchCalls.length === 0, JSON.stringify(fetchCalls));
      // The only permitted DOM touch is the legacy #sb-python status write
      // (M2 replaces it with the status event); creating the creator iframe
      // or reading #py-worker-src is a boot — forbidden in prepare.
      check('LC1d prepare performed no boot-DOM work (no creator, no worker-src)',
        domCalls.every((c) => c === 'get:sb-python'), JSON.stringify(domCalls));

      const same = await rt.prepare({ python: payload('env-a') });
      check('LC1e same-key prepare is a no-op (no rebuild, config untouched)',
        same.rebuiltInterpreter === false && rt.extensionKey() === 'env-a', JSON.stringify(same));

      const changed = await rt.prepare({ python: payload('env-b') });
      check('LC1f key change rebuilds configuration',
        changed.rebuiltInterpreter === true && rt.extensionKey() === 'env-b', JSON.stringify(changed));

      const core = await rt.prepare({ python: null });
      check('LC1g null payload returns to the core-only runtime',
        core.rebuiltInterpreter === true && rt.extensionKey() === null && rt._extensions === null,
        JSON.stringify(core));
    } finally {
      global.fetch = realFetch;
      global.document = { getElementById: () => null };
    }
  }

  // ================= LC2. prepare is all-or-nothing =================
  {
    const rt = freshRuntime(M);
    await rt.prepare({ python: payload('env-good') });

    let threw = null;
    try {
      await rt.prepare({ python: { key: 'env-bad', modules: [{ pluginId: 'BAD ID WITH SPACES', imports: [] }] } });
    } catch (e) { threw = e; }
    check('LC2 invalid payload throws at configure time', !!threw, errText(threw));
    check('LC2b the previously configured payload survives intact',
      rt.snapshot().extensionKey === 'env-good'
        && rt._extensions.modules.length === 1
        && rt._extensions.modules[0].pluginId === 'locus-test-plugin',
      JSON.stringify(rt.snapshot()));

    // A cancelled prepare applies nothing (signal already aborted).
    const ac = new AbortController();
    ac.abort();
    let cancelled = null;
    try { await rt.prepare({ signal: ac.signal, python: payload('env-late') }); }
    catch (e) { cancelled = e; }
    check('LC2c a cancelled prepare is refused', !!cancelled, errText(cancelled));
    check('LC2c2 the refusal is cancellation-shaped (AbortError, existing classification)',
      !!cancelled && cancelled.name === 'AbortError' && cancelled.cancelled === true,
      cancelled && cancelled.name);
    check('LC2d a cancelled apply never lands',
      rt.snapshot().extensionKey === 'env-good', JSON.stringify(rt.snapshot()));

    // Both refusal paths leave the instance REUSABLE.
    const after = await rt.prepare({ python: payload('env-next') });
    check('LC2e the instance stays reusable after refused prepares',
      after.rebuiltInterpreter === true && rt.extensionKey() === 'env-next', JSON.stringify(after));
  }

  // ============ LC3. two instances share nothing mutable ============
  {
    const a = freshRuntime(M);
    const b = freshRuntime(M);
    check('LC3 pending maps, queues, queued-run sets are distinct objects',
      a._pending !== b._pending && a._queue !== b._queue && a._queuedRuns !== b._queuedRuns,
      'state must be per instance');
    await a.prepare({ python: payload('env-a') });
    check('LC3b plugin configuration is per instance',
      a.extensionKey() === 'env-a' && b.extensionKey() === null && b._extensions === null,
      JSON.stringify({ a: a.extensionKey(), b: b.extensionKey() }));

    // Park one run on each instance, then reset A: B's run must stay
    // pending and resolvable, B's configuration untouched.
    const ctlA = attachControlledWorker(a);
    const ctlB = attachControlledWorker(b);
    const runA = a.run('A_CODE', null, { cwd: '/tmp' });
    const runB = b.run('B_CODE', null, { cwd: '/tmp' });
    await tick(); // both seats taken: the runs are IN FLIGHT on their instance
    check('LC3c both instances took their own request (ids are per-instance sequences)',
      ctlA.log.length === 1 && ctlB.log.length === 1,
      JSON.stringify({ a: ctlA.log.length, b: ctlB.log.length }));
    a.reset('lc3 reset A');
    const runAOut = await runA;
    check('LC3d A\u2019s in-flight run fails honestly with the reset reason (no throw, no commit)',
      runAOut && runAOut.error === 'lc3 reset A' && runAOut.written.length === 0,
      JSON.stringify(runAOut));
    check('LC3e B is untouched by reset(A): still pending',
      b._pending.size === 1 && b._queuedRuns.size === 0,
      JSON.stringify({ bPending: b._pending.size, bQueued: b._queuedRuns.size }));
    check('LC3f B\u2019s plugin payload is still null, A\u2019s still env-a',
      b.extensionKey() === null && a.extensionKey() === 'env-a',
      JSON.stringify({ a: a.extensionKey(), b: b.extensionKey() }));
    const resolvedB = ctlB.resolve(ctlB.log[0].id, { stdout: 'B-ok' });
    const runBOut = await runB;
    check('LC3g B\u2019s run still resolves normally after reset(A)',
      resolvedB === true && runBOut.stdout === 'B-ok', JSON.stringify(runBOut));

    // dispose(A) leaves B fully operational.
    a.dispose('lc3 dispose A');
    const runB2 = b.run('B_CODE_2', null, { cwd: '/tmp' });
    await tick();
    check('LC3h dispose(A) does not touch B: new run accepted on B',
      ctlB.log.length === 2 && b._pending.size === 1, JSON.stringify({ msgs: ctlB.log.length }));
    let disposedRunErr = null;
    try { await a.run('MORE', null, {}); } catch (e) { disposedRunErr = e; }
    check('LC3i A refuses runs after dispose while B keeps working',
      !!disposedRunErr && /disposed/.test(errText(disposedRunErr)), errText(disposedRunErr));
    ctlB.resolve(ctlB.log[1].id, { stdout: 'B2-ok' });
    check('LC3j B\u2019s second run resolves', (await runB2).stdout === 'B2-ok');
  }

  // ============ LC4. execution state, reset, late messages ============
  {
    const rt = freshRuntime(M);
    await rt.prepare({ python: payload('env-x') });
    let ctl = attachControlledWorker(rt);
    rt.status = 'ready';

    const run1 = rt.run('CODE1', null, { cwd: '/tmp' });
    await tick();
    const id1 = ctl.log[0].id;

    // A queued second run waits for the seat (serialization preserved).
    const run2 = rt.run('CODE2', null, { cwd: '/tmp' });
    check('LC4 second run is queued while the first holds the seat',
      ctl.log.length === 1 && rt._queuedRuns.size === 1,
      JSON.stringify({ msgs: ctl.log.length, queued: rt._queuedRuns.size }));
    check('LC4b a message for an unknown id resolves nothing',
      ctl.resolve(99999, {}) === false);

    // Reset DURING execution: the in-flight run settles with an honest
    // error report (its signal never aborted, so nothing was cancelled —
    // and nothing committed), the queued run is DRAINED with the boundary
    // reason, and the late worker reply for the old request can neither
    // resolve nor mutate anything.
    rt.reset('lc4 boundary');
    const out1 = await run1;
    const e2 = await run2.then(() => null, (e) => e);
    check('LC4c the in-flight run settles with the reset reason as its error',
      out1 && out1.error === 'lc4 boundary' && out1.written.length === 0 && out1.notPersisted.length === 0,
      JSON.stringify(out1));
    check('LC4d the queued run is drained with the reset reason (rejects)',
      !!e2 && /lc4 boundary/.test(errText(e2)), errText(e2));
    check('LC4e reset tears the interpreter down: no worker, nothing pending',
      rt.worker === null && rt.status === 'cold' && rt._pending.size === 0 && rt._queuedRuns.size === 0,
      JSON.stringify(rt.snapshot()));

    // The stale result for the OLD request id has nowhere to land.
    check('LC4f the stale result resolves nothing', ctl.resolve(id1, { stdout: 'STALE' }) === false);

    // The real late-message drop path: no creator iframe, so
    // _onWindowMessage must drop everything without state changes.
    let statusWrites = 0;
    const realSetStatus = rt._setStatus.bind(rt);
    rt._setStatus = (s) => { statusWrites++; return realSetStatus(s); };
    rt._onWindowMessage({ data: { type: 'result', id: id1, stdout: 'STALE' } });
    rt._onWindowMessage({ data: { type: 'status', status: 'ready' } });
    check('LC4g late window messages after reset mutate nothing',
      statusWrites === 0 && rt._pending.size === 0,
      JSON.stringify({ statusWrites, pending: rt._pending.size }));

    // The instance is reusable: a fresh run completes normally on the new
    // interpreter generation.
    ctl = attachControlledWorker(rt); // reassign: the old fixture’s log belongs to the previous worker generation
    const run3 = rt.run('CODE3', null, { cwd: '/tmp' });
    await tick();
    const id3 = ctl.log[0].id;
    ctl.resolve(id3, { stdout: 'fresh-ok' });
    const r3 = await run3;
    check('LC4h the instance is reusable after reset', r3.stdout === 'fresh-ok', JSON.stringify(r3));

    // Cancellation through the task signal: the run REJECTS as cancelled
    // (the signal's listener kills the worker; the post-await guard throws).
    const ac = new AbortController();
    const run4 = rt.run('CODE4', null, { cwd: '/tmp', signal: ac.signal });
    ac.abort();
    const e4 = await run4.then(() => null, (e) => e);
    check('LC4i cancellation through the task signal rejects the run', !!e4, errText(e4));
  }

  // ================= LC5. dispose is terminal and idempotent =================
  {
    const rt = freshRuntime(M);
    await rt.prepare({ python: payload('env-d') });
    const ctl = attachControlledWorker(rt);
    rt.status = 'ready';
    const run1 = rt.run('CODE1', null, { cwd: '/tmp' });
    const queued = rt.run('CODE2', null, { cwd: '/tmp' });
    await tick();
    const id1 = ctl.log[0].id;

    rt.dispose('lc5 teardown');
    const out1 = await run1;
    const e2 = await queued.then(() => null, (e) => e);
    check('LC5 dispose fails the in-flight run and drains the queued one',
      out1 && out1.error === 'python runtime disposed: lc5 teardown'
        && !!e2 && /lc5 teardown/.test(errText(e2)),
      JSON.stringify(out1) + ' | ' + errText(e2));
    check('LC5b the disposed snapshot reports the reason',
      rt.snapshot().disposed === 'python runtime disposed: lc5 teardown'
        && rt.status === 'cold' && rt.worker === null,
      JSON.stringify(rt.snapshot()));

    // Idempotent: a second dispose keeps the FIRST reason and does not throw.
    rt.dispose('a different reason');
    check('LC5c dispose is idempotent (first reason stands)',
      rt.snapshot().disposed === 'python runtime disposed: lc5 teardown',
      JSON.stringify(rt.snapshot().disposed));

    // Every entry refuses from here on.
    const refusals = {};
    try { await rt.prepare({ python: payload('env-after') }); } catch (e) { refusals.prepare = errText(e); }
    try { await rt.run('MORE', null, {}); } catch (e) { refusals.run = errText(e); }
    try { rt.configureExtensions(payload('env-after')); } catch (e) { refusals.configure = errText(e); }
    try { await freshRuntime(M)._ensureWorker.call(rt, null, null); } catch (e) { refusals.boot = errText(e); }
    check('LC5d prepare/run/configureExtensions/boot all refuse after dispose',
      /disposed/.test(refusals.prepare || '') && /disposed/.test(refusals.run || '')
        && /disposed/.test(refusals.configure || '') && /disposed/.test(refusals.boot || ''),
      JSON.stringify(refusals));
    check('LC5e the configuration never changed after dispose',
      rt.extensionKey() === 'env-d', rt.extensionKey());

    // Old messages do not revive the instance: a late worker result has no
    // pending entry to land in, and no status write can flip it back.
    check('LC5f the old pending id no longer resolves', ctl.resolve(id1, { stdout: 'GHOST' }) === false);
    let statusWrites = 0;
    const realSetStatus2 = rt._setStatus.bind(rt);
    rt._setStatus = (s) => { statusWrites++; return realSetStatus2(s); };
    rt._onWindowMessage({ data: { type: 'result', id: id1, stdout: 'GHOST' } });
    rt._onWindowMessage({ data: { type: 'status', status: 'ready' } });
    check('LC5g late messages after dispose revive nothing',
      statusWrites === 0 && rt.snapshot().interpreter === 'cold'
        && rt.snapshot().busyExecutions === 0,
      JSON.stringify(rt.snapshot()));

    // Dispose without a live worker (cold instance) is also safe.
    const cold = freshRuntime(M);
    cold.dispose('cold dispose');
    check('LC5h disposing a never-booted instance is safe and terminal',
      cold.snapshot().disposed === 'python runtime disposed: cold dispose'
        && cold.snapshot().interpreter === 'cold',
      JSON.stringify(cold.snapshot()));
  }

  // ============ LC6. shell executes on the injected instance ============
  {
    const shared = freshRuntime(M);
    const other = freshRuntime(M);
    const ctlShared = attachControlledWorker(shared);
    const ctlOther = attachControlledWorker(other);
    const vfs = new M.VirtualWorkspace({ listCommands: () => Object.keys(M.SHELL_COMMANDS) });

    const shellRun1 = M.runShellCommand("python -c 'print(1)'", vfs, { pythonRuntime: shared, cwd: '/tmp' });
    await tick();
    check('LC6 the shell routes python to the INJECTED instance only',
      ctlShared.log.length === 1 && ctlOther.log.length === 0,
      JSON.stringify({ shared: ctlShared.log.length, other: ctlOther.log.length }));
    ctlShared.resolve(ctlShared.log[0].id, { stdout: '1' });
    const res1 = await shellRun1;
    check('LC6b the injected instance\u2019s answer comes back through the shell',
      !res1.isError && res1.output.includes('1'), JSON.stringify(res1));

    const shellRun2 = M.runShellCommand("python -c 'print(2)'", vfs, { pythonRuntime: shared, cwd: '/tmp' });
    await tick();
    check('LC6c the second shell python call hits the same instance',
      ctlShared.log.length === 2 && ctlOther.log.length === 0,
      JSON.stringify({ shared: ctlShared.log.length, other: ctlOther.log.length }));
    ctlShared.resolve(ctlShared.log[1].id, { stdout: '2' });
    const res2 = await shellRun2;
    check('LC6d second answer resolves', !res2.isError && res2.output.includes('2'), JSON.stringify(res2));

    // Without an injected instance the shell fails loudly — no silent
    // fallback to any global (there is none).
    const noRt = await M.runShellCommand("python -c 'print(1)'", vfs, { cwd: '/tmp' });
    check('LC6e missing injection is an honest failure, never a fallback',
      !noRt.success && noRt.output.includes('no runtime instance injected'),
      JSON.stringify(noRt.output));
    const noRt2 = await M.runShellCommand('echo hi', vfs, {});
    check('LC6f non-python shell work never needs an instance',
      !noRt2.isError && noRt2.output === 'hi', JSON.stringify(noRt2.output));

    // prepare + shell execution converge on ONE instance (the product's
    // wiring contract, proven at the seam the store uses).
    const rt = freshRuntime(M);
    await rt.prepare({ python: payload('env-shared') });
    const ctl = attachControlledWorker(rt); // attach AFTER prepare: a rebuild kills any attached interpreter
    const vfs2 = new M.VirtualWorkspace({ listCommands: () => Object.keys(M.SHELL_COMMANDS) });
    const shellRun3 = M.runShellCommand("python <<'PY'\nprint('hi')\nPY", vfs2, { pythonRuntime: rt, cwd: '/tmp' });
    await tick();
    check('LC6g the shell python request reaches the SAME instance prepare configured',
      ctl.log.length === 1 && rt.extensionKey() === 'env-shared' && rt._pending.size === 1,
      JSON.stringify({ msgs: ctl.log.length, key: rt.extensionKey(), status: rt.status }));
    ctl.resolve(ctl.log[0].id, { stdout: 'hi' });
    const shellOut = await shellRun3;
    check('LC6h the prepared instance executes the shell command',
      !shellOut.isError && shellOut.output.includes('hi'), JSON.stringify(shellOut));
    rt.reset();
    check('LC6i the same object\u2019s reset is what the session boundary calls',
      rt.snapshot().interpreter === 'cold' && rt.worker === null, JSON.stringify(rt.snapshot()));
  }

  // ================= LC7. snapshot() =================
  {
    const rt = freshRuntime(M);
    check('LC7 cold snapshot', JSON.stringify(rt.snapshot())
      === JSON.stringify({ interpreter: 'cold', busyExecutions: 0, extensionKey: null, disposed: null }),
      JSON.stringify(rt.snapshot()));
    await rt.prepare({ python: payload('env-s') });
    const ctl = attachControlledWorker(rt);
    rt.status = 'ready';
    rt.status = 'ready';
    const r = rt.run('CODE', null, { cwd: '/tmp' });
    const q = rt.run('CODE2', null, { cwd: '/tmp' });
    await tick();
    check('LC7b busy snapshot counts in-flight + queued',
      rt.snapshot().busyExecutions === 2 && rt.snapshot().interpreter === 'ready'
        && rt.snapshot().extensionKey === 'env-s',
      JSON.stringify(rt.snapshot()));
    ctl.resolve(ctl.log[0].id, { stdout: 'ok' });
    await r;
    // A boundary landing AFTER the seat was taken but BEFORE the post still
    // invalidates the run (generation check): q rejects with the reason and
    // never reaches the (removed) worker.
    rt.reset();
    const qErr = await q.then(() => null, (e) => e);
    check('LC7c the boundary invalidated the not-yet-posted run',
      !!qErr && /python runtime reset/.test(errText(qErr)), errText(qErr));
    check('LC7d drained snapshot', rt.snapshot().busyExecutions === 0
      && rt.snapshot().interpreter === 'cold', JSON.stringify(rt.snapshot()));
  }

  // ===== LC8. reset/dispose invalidate the COMMIT phase (stale writeback) =====
  // The gap this pins: once the worker has answered, a run parked at an
  // async pre-commit VFS check used to keep committing mkdir/write/remove
  // and could even return error:null — the boundary was only enforced
  // BEFORE the worker post. The runtime itself must honor reset/dispose
  // through the whole write-back (no caller-side abort is involved in any
  // LC8 check), busyExecutions must cover the ENTIRE run lifetime, and a
  // synchronous boundary must not masquerade as the run's settlement.
  {
    // Minimal provider+VFS with a barrier at ONE commit-phase vfs call.
    // Mirror-in collection reads the PROVIDER (list/stat/readBytes on the
    // provider object); the commit phases consult the VFS itself
    // (stat before mkdir, readBytes for external-write/delete
    // verification), so a barrier on the VFS never pauses collection.
    function barrierVfs(files, authority, barrier) {
      const enc = new TextEncoder();
      const store = new Map(Object.keys(files).map((p) => [p, enc.encode(files[p])]));
      const sideEffects = [];
      let gatePromise = null, gateRelease = null;
      const gate = () => {
        if (!gatePromise) gatePromise = new Promise((r) => { gateRelease = r; });
        return gatePromise;
      };
      const notFound = () => { const e = new Error('not found: barrier fixture'); e.name = 'NotFoundError'; throw e; };
      const provider = {
        list: async () => [...store.keys()].map((p) => ({ name: p.slice('/mnt/workspace/'.length), kind: 'file' })),
        stat: async (rel) => { const b = store.get('/mnt/workspace/' + rel); return b ? { kind: 'file', size: b.length } : notFound(); },
        readBytes: async (rel) => { const b = store.get('/mnt/workspace/' + rel); return b ? b : notFound(); },
      };
      const vfs = {
        dataMounts: () => [{ root: '/mnt/workspace', provider: provider, authority: authority }],
        resolveMount: (p) => String(p).indexOf('/mnt/workspace') === 0
          ? { path: '/mnt/workspace', authority: authority } : null,
        stat: async (p) => {
          if (barrier && barrier.method === 'stat' && p === barrier.path) await gate();
          const b = store.get(p); return b ? { kind: 'file', size: b.length } : notFound();
        },
        readBytes: async (p) => {
          if (barrier && barrier.method === 'readBytes' && p === barrier.path) await gate();
          const b = store.get(p); return b ? b : notFound();
        },
        exists: async (p) => store.has(p),
        mkdir: async (p) => { sideEffects.push('mkdir ' + p); },
        write: async (p, bytes) => { sideEffects.push('write ' + p); store.set(p, bytes); },
        remove: async (p) => { sideEffects.push('remove ' + p); store.delete(p); },
      };
      return { vfs: vfs, sideEffects: sideEffects, release: () => { if (gateRelease) gateRelease(); } };
    }

    // ---- LC8-a: reset lands while the run is parked at the mkdir pre-check
    const rtA = freshRuntime(M);
    const ctlA = attachControlledWorker(rtA);
    rtA.status = 'ready';
    const fbA = barrierVfs({ '/mnt/workspace/in.txt': 'data' }, 'read-write',
      { method: 'stat', path: '/mnt/workspace/newdir' });
    const runA = rtA.run('CODE', fbA.vfs, { cwd: '/tmp' });
    await tick();
    check('LC8 active execution is counted while the worker holds it',
      rtA.snapshot().busyExecutions === 1, JSON.stringify(rtA.snapshot()));
    ctlA.resolve(ctlA.log[0].id, {
      files: [], deleted: [], createdDirs: ['/mnt/workspace/newdir'],
    });
    await tick(); // parked at the async mkdir pre-check (vfs.stat)
    check('LC8b worker answered, run still committing → busy stays 1 (not 0)',
      rtA.snapshot().busyExecutions === 1, JSON.stringify(rtA.snapshot()));
    rtA.reset('lc8 boundary');
    check('LC8c synchronous invalidation does not masquerade as settlement',
      rtA.snapshot().busyExecutions === 1, JSON.stringify(rtA.snapshot()));
    fbA.release();
    const outA = await runA;
    check('LC8d the stale run performs NO mkdir after the boundary',
      fbA.sideEffects.length === 0, JSON.stringify(fbA.sideEffects));
    check('LC8e honest report: boundary reason + not-persisted accounting (never error:null)',
      outA.error === 'lc8 boundary' && outA.mkdirs.length === 0
        && outA.notPersisted.some((s) => s.indexOf('/mnt/workspace/newdir') !== -1 && s.indexOf('lc8 boundary') !== -1),
      JSON.stringify({ error: outA.error, notPersisted: outA.notPersisted }));
    check('LC8f the run releases its tracking exactly once at settlement',
      rtA.snapshot().busyExecutions === 0, JSON.stringify(rtA.snapshot()));
    // Reusable after reset: a fresh run on the next generation completes.
    const ctlA2 = attachControlledWorker(rtA);
    const againA = rtA.run('AGAIN', fbA.vfs, { cwd: '/tmp' });
    await tick();
    ctlA2.resolve(ctlA2.log[0].id, { stdout: 'ok-again' });
    check('LC8g the instance is reusable after the boundary',
      (await againA).stdout === 'ok-again');

    // ---- LC8-b: dispose lands while parked at the write pre-check
    // (external mount → optimistic-concurrency readBytes gate).
    const rtB = freshRuntime(M);
    const ctlB = attachControlledWorker(rtB);
    rtB.status = 'ready';
    const fbB = barrierVfs({ '/mnt/workspace/in.txt': 'data' }, 'external-read-write',
      { method: 'readBytes', path: '/mnt/workspace/in.txt' });
    const runB = rtB.run('CODE', fbB.vfs, { cwd: '/tmp' });
    await tick();
    ctlB.resolve(ctlB.log[0].id, {
      files: [{ path: '/mnt/workspace/in.txt', b64: 'aGVsbG8=' }], deleted: [],
    });
    await tick(); // parked at detectExternalChange's readBytes
    rtB.dispose('lc8 dispose');
    check('LC8h dispose keeps the committing run counted until it settles',
      rtB.snapshot().busyExecutions === 1, JSON.stringify(rtB.snapshot()));
    fbB.release();
    const outB = await runB;
    check('LC8i the stale run performs NO write after dispose',
      fbB.sideEffects.length === 0, JSON.stringify(fbB.sideEffects));
    check('LC8j honest disposed report (reason + not-persisted, nothing written)',
      outB.error === 'python runtime disposed: lc8 dispose' && outB.written.length === 0
        && outB.notPersisted.some((s) => s.indexOf('/mnt/workspace/in.txt') !== -1),
      JSON.stringify({ error: outB.error, notPersisted: outB.notPersisted }));
    check('LC8k tracking released, disposed terminal state intact',
      rtB.snapshot().busyExecutions === 0
        && rtB.snapshot().disposed === 'python runtime disposed: lc8 dispose',
      JSON.stringify(rtB.snapshot()));

    // ---- LC8-c: reset lands at the delete-verification read; BOTH the
    // pending file deletion and the directory deletion must stay unstarted.
    const rtC = freshRuntime(M);
    const ctlC = attachControlledWorker(rtC);
    rtC.status = 'ready';
    const fbC = barrierVfs({ '/mnt/workspace/file.txt': 'data', '/mnt/workspace/sub/x.txt': 'x' }, 'external-read-write',
      { method: 'readBytes', path: '/mnt/workspace/file.txt' });
    const runC = rtC.run('CODE', fbC.vfs, { cwd: '/tmp' });
    await tick();
    ctlC.resolve(ctlC.log[0].id, {
      files: [], deleted: ['/mnt/workspace/file.txt'], deletedDirs: ['/mnt/workspace/sub'],
    });
    await tick(); // parked at the delete-phase verification readBytes
    rtC.reset('lc8 boundary-c');
    fbC.release();
    const outC = await runC;
    check('LC8l neither the file NOR the directory removal starts after the boundary',
      fbC.sideEffects.length === 0
        && outC.notPersisted.some((s) => s.indexOf('delete /mnt/workspace/file.txt') !== -1)
        && outC.notPersisted.some((s) => s.indexOf('rmdir /mnt/workspace/sub') !== -1),
      JSON.stringify({ sideEffects: fbC.sideEffects, notPersisted: outC.notPersisted }));
    check('LC8m honest report with the boundary reason',
      outC.error === 'lc8 boundary-c' && outC.deleted.length === 0, JSON.stringify(outC.error));

    // ---- LC8-d: queued vs active are counted once each; every settle path
    // (boundary, failure, cancellation) releases exactly once.
    const rtD = freshRuntime(M);
    const ctlD = attachControlledWorker(rtD);
    rtD.status = 'ready';
    const fbD = barrierVfs({ '/mnt/workspace/in.txt': 'data' }, 'read-write',
      { method: 'stat', path: '/mnt/workspace/newdir' });
    const runD1 = rtD.run('D1', fbD.vfs, { cwd: '/tmp' });
    await tick();
    ctlD.resolve(ctlD.log[0].id, { files: [], deleted: [], createdDirs: ['/mnt/workspace/newdir'] });
    const runD2 = rtD.run('D2', null, { cwd: '/tmp' }); // queued behind the committing run
    const runD2caught = runD2.then(() => null, (e) => e); // handler BEFORE any boundary can reject it
    await tick();
    check('LC8n queued + committing runs count as TWO (no double counting, no drop)',
      rtD.snapshot().busyExecutions === 2, JSON.stringify(rtD.snapshot()));
    rtD.reset('lc8 boundary-d');
    check('LC8o boundary does not falsify either count',
      rtD.snapshot().busyExecutions === 2, JSON.stringify(rtD.snapshot()));
    fbD.release();
    const outD1 = await runD1;
    const errD2 = await runD2caught;
    check('LC8p both stale runs settle honestly (report + rejection) and release once',
      outD1.error === 'lc8 boundary-d' && !!errD2 && /lc8 boundary-d/.test(errText(errD2))
        && rtD.snapshot().busyExecutions === 0,
      JSON.stringify({ out: outD1.error, queued: errText(errD2), busy: rtD.snapshot().busyExecutions }));

    // A failing run (worker error) releases its tracking too.
    const rtD2 = freshRuntime(M);
    const ctlD2 = attachControlledWorker(rtD2);
    rtD2.status = 'ready';
    const failRun = rtD2.run('FAIL', null, { cwd: '/tmp' });
    await tick();
    ctlD2.resolve(ctlD2.log[0].id, { stdout: '', error: 'python exploded' });
    const outFail = await failRun;
    check('LC8q a failing run settles with the error and releases once',
      outFail.error === 'python exploded' && rtD2.snapshot().busyExecutions === 0,
      JSON.stringify({ error: outFail.error, busy: rtD2.snapshot().busyExecutions }));

    // A task-signal cancellation releases its tracking too.
    const rtD3 = freshRuntime(M);
    const ctlD3 = attachControlledWorker(rtD3);
    rtD3.status = 'ready';
    const acD3 = new AbortController();
    const cancelRun = rtD3.run('CANCEL', null, { cwd: '/tmp', signal: acD3.signal });
    const cancelCaught = cancelRun.then(() => null, (e) => e);
    await tick();
    acD3.abort();
    const errD3 = await cancelCaught;
    check('LC8r a cancelled run settles and releases once',
      !!errD3 && rtD3.snapshot().busyExecutions === 0,
      errText(errD3) + ' | ' + JSON.stringify(rtD3.snapshot()));

    // ---- LC8-e: an in-flight run whose worker NEVER answers is failed by
    // the boundary (provider operation already dispatched — no rollback,
    // but also no continuation, and never reported as success).
    const rtE = freshRuntime(M);
    attachControlledWorker(rtE);
    rtE.status = 'ready';
    const runE = rtE.run('NEVER-ANSWERS', null, { cwd: '/tmp' });
    await tick();
    check('LC8s the in-flight run is counted at the worker boundary',
      rtE.snapshot().busyExecutions === 1, JSON.stringify(rtE.snapshot()));
    rtE.reset('lc8 boundary-e');
    const outE = await runE;
    check('LC8t the boundary fails the dispatched-but-unanswered run honestly',
      outE.error === 'lc8 boundary-e' && outE.written.length === 0
        && rtE.snapshot().busyExecutions === 0,
      JSON.stringify({ error: outE.error, busy: rtE.snapshot().busyExecutions }));
  }

  // ===== LC9. boundary lands while the LAST commit side effect is IN FLIGHT =====
  // The complement of LC8: there the boundary paused runs at async PRE-checks
  // (stat/readBytes gates) so no side effect ever dispatched. Here the final
  // provider call has ENTERED but not settled when reset()/dispose() lands.
  // Settlement of that call is NOT validation — the run's generation is gone
  // and the final report must say so (error = the boundary reason), while
  // what the in-flight operation really committed stays reported in written/
  // mkdirs/deleted: no fake rollback, no fabricated notPersisted entry. Every
  // operation kind is pinned as the LAST (only) changeset entry, so the
  // result never depends on a later loop iteration re-checking the boundary.
  {
    // Fake VFS whose SIDE-EFFECT methods (write/mkdir/remove) park at entry
    // until the test releases the gate — the provider operation is already
    // dispatched, exactly like a slow OPFS/FS handle in production. Mirror-in
    // collection only reads the provider; the commit phases call the VFS.
    function dispatchBarrierVfs(files, opts) {
      const enc = new TextEncoder();
      const store = new Map(Object.keys(files).map((p) => [p, enc.encode(files[p])]));
      const dirs = new Set(opts && opts.dirs ? opts.dirs : []);
      const sideEffects = [];
      let entered = false, gateRelease = null;
      const gate = () => new Promise((r) => { gateRelease = r; });
      const gated = (method, path, perform) => async (...args) => {
        const hit = opts && opts.gate === method && path === opts.path;
        if (hit) { entered = true; await gate(); }
        if (hit && opts.failWith) throw opts.failWith;
        return perform(...args);
      };
      const notFound = () => { const e = new Error('not found'); e.name = 'NotFoundError'; throw e; };
      const provider = {
        list: async () => [...store.keys()].map((p) => ({ name: p.slice('/mnt/workspace/'.length), kind: 'file' })),
        stat: async (rel) => { const b = store.get('/mnt/workspace/' + rel); return b ? { kind: 'file', size: b.length } : notFound(); },
        readBytes: async (rel) => { const b = store.get('/mnt/workspace/' + rel); return b ? b : notFound(); },
      };
      const vfs = {
        dataMounts: () => [{ root: '/mnt/workspace', provider: provider, authority: 'read-write' }],
        resolveMount: (p) => String(p).indexOf('/mnt/workspace') === 0
          ? { path: '/mnt/workspace', authority: 'read-write' } : null,
        isProtectedRoot: () => false,
        stat: async (p) => {
          const b = store.get(p);
          if (b) return { kind: 'file', size: b.length };
          if (dirs.has(p)) return { kind: 'directory', size: 0 };
          notFound();
        },
        exists: async (p) => store.has(p) || dirs.has(p),
        mkdir: gated('mkdir', opts && opts.path, (p) => { dirs.add(p); sideEffects.push('mkdir ' + p); }),
        write: gated('write', opts && opts.path, (p, bytes) => { store.set(p, bytes); sideEffects.push('write ' + p); }),
        remove: gated('remove', opts && opts.path, (p) => {
          store.delete(p); dirs.delete(p); sideEffects.push('remove ' + p);
        }),
      };
      return {
        vfs: vfs, sideEffects: sideEffects,
        entered: () => entered,
        release: () => { if (gateRelease) gateRelease(); },
      };
    }

    // Drive one run to its parked last side effect: real runtime.run entry,
    // controlled worker answering with `reply`, then wait for the gate.
    async function parkAtLastEffect(reply, files, opts) {
      const rt = freshRuntime(M);
      const ctl = attachControlledWorker(rt);
      rt.status = 'ready';
      const fb = dispatchBarrierVfs(files, opts);
      const runP = rt.run('CODE', fb.vfs, { cwd: '/tmp' });
      await tick();
      ctl.resolve(ctl.log[0].id, reply);
      for (let i = 0; i < 20 && !fb.entered(); i++) await tick();
      return { rt: rt, fb: fb, runP: runP };
    }

    // ---- LC9-a: reset lands while the ONLY changeset write is in flight
    const a = await parkAtLastEffect(
      { files: [{ path: '/mnt/workspace/out.txt', b64: 'aGVsbG8=' }], deleted: [] },
      { '/mnt/workspace/in.txt': 'seed' },
      { gate: 'write', path: '/mnt/workspace/out.txt' });
    check('LC9 the dispatched write is parked inside the provider call',
      a.fb.entered() && a.fb.sideEffects.length === 0, JSON.stringify(a.fb.sideEffects));
    check('LC9b the run stays counted while its side effect is unsettled',
      a.rt.snapshot().busyExecutions === 1, JSON.stringify(a.rt.snapshot()));
    a.rt.reset('lc9 reset mid-write');
    check('LC9c the synchronous reset does not masquerade as settlement',
      a.rt.snapshot().busyExecutions === 1, JSON.stringify(a.rt.snapshot()));
    a.fb.release();
    const outA = await a.runP;
    check('LC9d the settled run reports the boundary as its error (never error:null)',
      outA.error === 'lc9 reset mid-write',
      JSON.stringify({ error: outA.error, written: outA.written, notPersisted: outA.notPersisted }));
    check('LC9e the write that really completed stays in written — no fake rollback',
      outA.written.length === 1 && outA.written[0] === '/mnt/workspace/out.txt'
        && a.fb.sideEffects.indexOf('write /mnt/workspace/out.txt') !== -1,
      JSON.stringify({ written: outA.written, sideEffects: a.fb.sideEffects }));
    check('LC9f the committed file is not fabricated into notPersisted',
      outA.notPersisted.length === 0, JSON.stringify(outA.notPersisted));
    check('LC9g tracking released exactly at settlement',
      a.rt.snapshot().busyExecutions === 0, JSON.stringify(a.rt.snapshot()));

    // ---- LC9-b: dispose lands while the only write is in flight
    const b = await parkAtLastEffect(
      { files: [{ path: '/mnt/workspace/out.txt', b64: 'aGVsbG8=' }], deleted: [] },
      { '/mnt/workspace/in.txt': 'seed' },
      { gate: 'write', path: '/mnt/workspace/out.txt' });
    b.rt.dispose('lc9 dispose mid-write');
    check('LC9h dispose keeps the unsettled run counted',
      b.rt.snapshot().busyExecutions === 1, JSON.stringify(b.rt.snapshot()));
    b.fb.release();
    const outB = await b.runP;
    check('LC9i the disposed run reports the disposal as its error and keeps the commit',
      outB.error === 'python runtime disposed: lc9 dispose mid-write'
        && outB.written.length === 1 && outB.notPersisted.length === 0,
      JSON.stringify({ error: outB.error, written: outB.written, notPersisted: outB.notPersisted }));
    check('LC9j tracking released, terminal state intact',
      b.rt.snapshot().busyExecutions === 0
        && b.rt.snapshot().disposed === 'python runtime disposed: lc9 dispose mid-write',
      JSON.stringify(b.rt.snapshot()));

    // ---- LC9-c: reset lands while the only MKDIR is in flight
    const c = await parkAtLastEffect(
      { files: [], deleted: [], createdDirs: ['/mnt/workspace/newdir'] },
      {},
      { gate: 'mkdir', path: '/mnt/workspace/newdir' });
    check('LC9k the mkdir run is parked inside the provider call',
      c.fb.entered() && c.rt.snapshot().busyExecutions === 1, JSON.stringify(c.fb.sideEffects));
    c.rt.reset('lc9 reset mid-mkdir');
    c.fb.release();
    const outC = await c.runP;
    check('LC9l the settled mkdir run reports the boundary (not error:null), commit kept',
      outC.error === 'lc9 reset mid-mkdir' && outC.mkdirs.length === 1
        && outC.mkdirs[0] === '/mnt/workspace/newdir' && outC.notPersisted.length === 0,
      JSON.stringify({ error: outC.error, mkdirs: outC.mkdirs, notPersisted: outC.notPersisted }));

    // ---- LC9-d: reset lands while the only FILE DELETION is in flight
    const d = await parkAtLastEffect(
      { files: [], deleted: ['/mnt/workspace/gone.txt'] },
      { '/mnt/workspace/gone.txt': 'data' },
      { gate: 'remove', path: '/mnt/workspace/gone.txt' });
    check('LC9m the deletion run is parked inside the provider call',
      d.fb.entered() && d.rt.snapshot().busyExecutions === 1, JSON.stringify(d.fb.sideEffects));
    d.rt.reset('lc9 reset mid-delete');
    d.fb.release();
    const outD = await d.runP;
    check('LC9n the settled deletion run reports the boundary, deletion kept in deleted',
      outD.error === 'lc9 reset mid-delete' && outD.deleted.length === 1
        && outD.deleted[0] === '/mnt/workspace/gone.txt' && outD.notPersisted.length === 0,
      JSON.stringify({ error: outD.error, deleted: outD.deleted, notPersisted: outD.notPersisted }));

    // ---- LC9-e: reset lands while the only DIRECTORY DELETION is in flight
    const e = await parkAtLastEffect(
      { files: [], deleted: [], deletedDirs: ['/mnt/workspace/sub'] },
      { '/mnt/workspace/keep.txt': 'data' },
      { gate: 'remove', path: '/mnt/workspace/sub', dirs: ['/mnt/workspace/sub'] });
    check('LC9o the rmdir run is parked inside the provider call',
      e.fb.entered() && e.rt.snapshot().busyExecutions === 1, JSON.stringify(e.fb.sideEffects));
    e.rt.reset('lc9 reset mid-rmdir');
    e.fb.release();
    const outE = await e.runP;
    check('LC9p the settled rmdir run reports the boundary, removal kept in deleted',
      outE.error === 'lc9 reset mid-rmdir' && outE.deleted.length === 1
        && outE.deleted[0] === '/mnt/workspace/sub' && outE.notPersisted.length === 0,
      JSON.stringify({ error: outE.error, deleted: outE.deleted, notPersisted: outE.notPersisted }));

    // ---- LC9-f: no boundary — the same single-write run completes clean
    const f = await parkAtLastEffect(
      { files: [{ path: '/mnt/workspace/out.txt', b64: 'aGVsbG8=' }], deleted: [] },
      { '/mnt/workspace/in.txt': 'seed' },
      { gate: 'write', path: '/nowhere' }); // gate never hit
    f.fb.release();
    const outF = await f.runP;
    check('LC9q a boundary-free run of the same shape still succeeds',
      outF.error === null && outF.written.length === 1
        && f.rt.snapshot().busyExecutions === 0,
      JSON.stringify({ error: outF.error, written: outF.written }));

    // ---- LC9-g: a REAL worker error keeps precedence over the boundary
    const g = await parkAtLastEffect(
      { error: 'worker exploded', files: [{ path: '/mnt/workspace/out.txt', b64: 'aGVsbG8=' }], deleted: [] },
      { '/mnt/workspace/in.txt': 'seed' },
      { gate: 'write', path: '/mnt/workspace/out.txt' });
    g.rt.reset('lc9 reset after worker error');
    g.fb.release();
    const outG = await g.runP;
    check('LC9r the worker\u2019s own error is not overwritten by the boundary reason',
      outG.error === 'worker exploded', JSON.stringify({ error: outG.error }));

    // ---- LC9-h: a provider failure message survives the boundary report
    const quotaErr = new Error('provider refused: quota exceeded');
    const h = await parkAtLastEffect(
      { files: [{ path: '/mnt/workspace/out.txt', b64: 'aGVsbG8=' }], deleted: [] },
      { '/mnt/workspace/in.txt': 'seed' },
      { gate: 'write', path: '/mnt/workspace/out.txt', failWith: quotaErr });
    h.rt.reset('lc9 reset mid-failing-write');
    h.fb.release();
    const outH = await h.runP;
    check('LC9s the provider failure text survives in writeFailed while the boundary is the error',
      outH.error === 'lc9 reset mid-failing-write'
        && outH.writeFailed.length === 1
        && outH.writeFailed[0].indexOf('provider refused: quota exceeded') !== -1,
      JSON.stringify({ error: outH.error, writeFailed: outH.writeFailed }));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.error('TEST RUNNER FAIL', e); process.exit(1); });
