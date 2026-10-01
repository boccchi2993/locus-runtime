// Out-of-repo consumer gate (M3a; review round 1): installs ONLY the packed
// tarball, builds this project with its own vite, serves dist/, drives a
// real headless Chrome through the public package exports, and checks:
//   C0  the bundle carries no file:/absolute/sibling-source references, and
//       the package RESOLVES inside this consumer directory (no checkout
//       fallback) — the resolved path is printed for the build log
//   C1  VFS shell write/read through the public session
//   C4a pre-aborted signal refuses; F2 mid-flight gates over a PARKED
//       provider write with explicit entered/release barriers:
//         C4b reset boundary (busy TRUE until release, dispatched write
//             commits, the crossed run reports the boundary, session stays
//             usable)
//         C4e mid-flight CALLER abort (unsettled before release, committed
//             write kept, second write never dispatched, cancellation-
//             shaped honest failure, NOT reported as a session boundary,
//             session reusable)
//         C4f mid-flight dispose (busy stays true, terminal refusal for
//             execute AND prepare, idempotent dispose keeps the first
//             reason)
//         C4g the LAST side effect parks and a caller abort lands in the
//             dispatched-but-unsettled window: the run FAILS even though
//             the underlying write commits (result classification), with
//             a no-invalidation CONTROL proving the park itself downgrades
//             nothing
//   C5  injected mutation policy (generic fixture) refuses + composes the
//       reason; the VFS's own read-only authority never grants
//   C6  F3 network dispatch counting through a NARROW fetch recorder on a
//       fixed synthetic https target (deterministic response, never really
//       fetched): C6a ALLOW positive control — the real execution chain
//       dispatches EXACTLY ONCE and the recorder sees it; C6b DENY — the
//       recorded dispatch count does NOT move (zero dispatch proven by a
//       real oracle, not by the failure text), with the historic text/ask
//       assertions kept
//   C7  capabilities() + describeCommands() sanity; import-time purity in
//       the CONSUMER bundle graph (no registry global anywhere)
//   C9  F1 the workspace PROVIDER subpath export ('locus-runtime/workspace'):
//       C9a import + surface; C9b purity (no new globals); C9c
//       LocalDirectoryWorkspace over a CONTROLLED directory handle (no
//       picker): write/read/list, shared path-escape rules, permission
//       helper outcomes, honest NotAllowedError propagation; C9d
//       OPFSWorkspace over a TEMPORARY test-owned OPFS directory: session
//       shell writes, a FRESH provider instance reads the bytes back
//       (durable, not a memory double), cleanup removes the directory;
//       C9e a minimal HOST-CUSTOM provider built only from the public
//       surface mounts, runs shell work, refuses escapes through the
//       shared normalization and classifies NotFoundError
//   C8  no unhandled page errors
// The gate never touches the locus-runtime checkout or any sibling source.
const fs = require('fs/promises');
const http = require('http');
const path = require('path');
const { createRequire } = require('module');
const { spawnSync } = require('child_process');
const {
  allocateFreePort, closeChrome, connectToTarget, launchChrome, waitForCdp,
  waitForPageTarget, waitForRuntimeCondition,
} = require('./chrome-driver.cjs');

const ROOT = __dirname;

// The synthetic https target the network-counting gate (F3/C6) uses. Kept
// in ONE place: the page's fetch recorder and this server's relay-stub
// counter both match against it. Never really contacted — .test is a
// reserved TLD and both oracles answer deterministically.
const NET_TARGET = 'https://consumer-gate-counted.test';

async function serveDist() {
  const distRoot = path.join(ROOT, 'dist');
  const port = await allocateFreePort();
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css' };
  // F3/C6: relay-stub counter. The runtime routes cross-origin
  // side-effecting requests through the SAME-ORIGIN POST /fetch envelope
  // (its documented backend decision — read-like GET/HEAD go
  // browser-direct). This stub COUNTS envelopes addressed to the synthetic
  // test target and answers them deterministically; it forwards nothing
  // anywhere and leaves every other path (including /fetch for any other
  // target) exactly as it was — 404.
  const relay = { hits: [] };
  const server = http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url, 'http://127.0.0.1');
      if (u.pathname === '/fetch' && req.method === 'POST') {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        let envelope = null;
        try { envelope = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { /* not JSON */ }
        if (envelope && typeof envelope.url === 'string' && envelope.url.startsWith(NET_TARGET)) {
          relay.hits.push(envelope.method + ' ' + envelope.url);
          res.setHeader('content-type', 'text/plain');
          res.end('counted-ok');
          return;
        }
        res.statusCode = 404; res.end('not found'); return;
      }
      let rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
      if (!rel || rel.endsWith('/')) rel += 'index.html';
      const file = path.join(distRoot, rel);
      if (!file.startsWith(distRoot) || !(await fs.stat(file).catch(() => null))) {
        res.statusCode = 404; res.end('not found'); return;
      }
      res.setHeader('content-type', types[path.extname(file)] || 'application/octet-stream');
      res.end(await fs.readFile(file));
    } catch (e) {
      res.statusCode = 500; res.end('server error');
    }
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return { url: 'http://127.0.0.1:' + port + '/', server, relay };
}

async function evaluate(cdp, expression, timeout) {
  const result = await cdp.send('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true, timeout: timeout || 60000,
  });
  if (result?.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails).slice(0, 600));
  return result?.result?.value;
}

async function main() {
  let passed = 0, failed = 0;
  const check = (name, cond, detail) => {
    if (cond) { passed++; console.log('PASS ' + name); }
    else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + String(detail).slice(0, 300) : '')); }
  };
  let chrome = null;
  let profileDir = null;
  let server = null;
  try {
    // 0. where does the package actually resolve from? (printed for the
    // build log; asserted to stay inside THIS consumer directory). The
    // exports map deliberately does not expose './package.json', so the
    // ROOT ENTRY is resolved and the package root derived from it.
    const consumerRequire = createRequire(path.join(ROOT, 'index.html'));
    let resolvedEntry = null;
    let resolveError = null;
    try { resolvedEntry = consumerRequire.resolve('locus-runtime'); }
    catch (e) { resolveError = String(e && e.message || e); }
    const resolvedRoot = resolvedEntry ? path.dirname(path.dirname(resolvedEntry)) : null;
    console.log('locus-runtime entry resolves from: ' + (resolvedEntry || ('UNRESOLVED: ' + resolveError)));
    check('C0b the package resolves inside the consumer directory (no checkout/symlink fallback)',
      !!resolvedRoot && path.resolve(resolvedRoot).startsWith(path.resolve(ROOT, 'node_modules')), resolvedRoot || resolveError);

    // 1. build with the consumer's OWN toolchain
    const build = spawnSync(process.execPath, [path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'build'], {
      stdio: 'inherit', cwd: ROOT,
    });
    if (build.status !== 0) throw new Error('consumer vite build failed');
    // 2. the bundle must not reference outside paths
    const assets = (await fs.readdir(path.join(ROOT, 'dist', 'assets'))).filter((f) => f.endsWith('.js'));
    let bundle = '';
    for (const a of assets) bundle += await fs.readFile(path.join(ROOT, 'dist', 'assets', a), 'utf8');
    check('C0 bundle carries no file:/absolute/sibling-source references',
      !/file:\.\.|file:\/\/\/|Locus-runtime-m3a|Locus-browser-agent-runtime/.test(bundle),
      assets.join(','));

    // 3. serve + drive
    const served = await serveDist();
    server = served.server;
    profileDir = await fs.mkdtemp(path.join(require('os').tmpdir(), 'locus-consumer-'));
    chrome = await launchChrome(served.url, {
      chromePath: process.env.CHROME,
      label: 'consumer Chrome',
      profileDir,
      extraArgs: ['--window-size=1280,800'],
    });
    await waitForCdp(chrome, { timeoutMs: 15000 });
    const target = await waitForPageTarget(chrome, served.url, { timeoutMs: 15000 });
    const cdp = await connectToTarget(target);
    await waitForRuntimeCondition(cdp, '!!(window.__consumer && window.__consumer.ready)',
      { process: chrome, phase: 'consumer-boot', timeoutMs: 20000 });

    // C7 sanity + purity
    const caps = await evaluate(cdp, 'window.__consumer.capabilities()');
    check('C7 capabilities() declares the public contract',
      caps && caps.contractVersion === 1 && caps.executionKinds.includes('shell')
      && caps.executionKinds.includes('python') && caps.bootstrap.shaPinned === true
      && caps.policyMechanisms.includes('mutationPolicy') && caps.policyMechanisms.includes('authorization')
      && caps.commands.length > 0 && caps.limits && caps.limits.pythonTimeoutMs > 0,
      JSON.stringify(caps).slice(0, 200));
    check('C7b describeCommands() generates from the real registry',
      /echo/.test(await evaluate(cdp, 'window.__consumer.describeCommands()')), '');
    check('C7c the consumer bundle defines no runtime registry global (purity)',
      (await evaluate(cdp, 'window.__consumer.purity.registry')) === false, '');

    // C1 VFS shell write/read
    {
      const r = await evaluate(cdp, 'window.__consumer.exec("echo consumer-ok > /mnt/workspace/c1.txt && cat /mnt/workspace/c1.txt")');
      check('C1 VFS shell write/read through the public session', r.ok === true && r.output === 'consumer-ok\n', JSON.stringify(r));
    }

    // C5 mutation policy + authority
    {
      const r = await evaluate(cdp, `window.__consumer.session.execute({
        kind: 'shell',
        input: 'mv /mnt/workspace/x.txt /home/locus/keep/x.txt',
        context: {
          filesystem: window.__consumer.vfs,
          mutationPolicy: window.__consumer.policy,
        },
      }).then((res) => ({ output: res.output, isError: res.isError }))`).catch((e) => ({ err: String(e) }));
      check('C5 injected mutation policy refuses with the composed reason',
        r && r.isError === true && r.output === 'mv: /mnt/workspace/x.txt: kept tree is immutable',
        JSON.stringify(r));
      const r2 = await evaluate(cdp, 'window.__consumer.exec("echo x > /mnt/upload/nope.txt")');
      check('C5b read-only mount authority is never granted by the policy port',
        r2.isError === true && /read-only/.test(r2.output), JSON.stringify(r2));
    }

    // C6 authorization: real dispatch counting (F3).
    // The runtime's documented backend decision splits dispatch into TWO
    // paths: read-like GET/HEAD go browser-direct (visible to the page's
    // narrow fetch recorder); cross-origin side-effecting requests go
    // through the SAME-ORIGIN POST /fetch envelope (visible to this
    // server's relay-stub counter). Zero dispatch is only honest when BOTH
    // oracles are proven blind-able first:
    //   C6a ALLOW positive control, GET (browser-direct): the recorder
    //       sees EXACTLY ONE dispatch through the real execution chain.
    //   C6b ALLOW positive control, POST (relay path): the relay stub
    //       sees EXACTLY ONE forwarded envelope through the real chain.
    //   C6c DENY, POST: NEITHER counter moves (page delta 0 AND relay
    //       delta 0) — zero dispatch proven by two real oracles, with the
    //       historic denial-text and single-ask assertions kept.
    {
      await evaluate(cdp, 'window.__consumer.authState.outcome = "allow"');
      const a = await evaluate(cdp, `(async () => {
        const before = window.__consumer.net.dispatched.length;
        const asksBefore = window.__consumer.authState.asks;
        const r = await window.__consumer.exec('curl https://consumer-gate-counted.test/allow-get', { authorization: window.__consumer.authorization });
        return {
          ok: r.ok, output: r.output,
          dispatchDelta: window.__consumer.net.dispatched.length - before,
          asksDelta: window.__consumer.authState.asks - asksBefore,
          log: window.__consumer.net.dispatched.slice(before),
        };
      })()`);
      check('C6a allow control (GET, browser-direct): the recorder sees EXACTLY ONE real dispatch',
        a && a.ok === true && a.output === 'counted-ok' && a.dispatchDelta === 1,
        JSON.stringify(a));

      const b = await evaluate(cdp, `(async () => {
        const r = await window.__consumer.exec('curl -X POST https://consumer-gate-counted.test/allow-post -d hi', { authorization: window.__consumer.authorization });
        return { ok: r.ok, output: r.output };
      })()`);
      check('C6b allow control (POST, relay path): the relay stub sees the forwarded envelope; the run succeeds',
        b && b.ok === true && b.output === 'counted-ok' && served.relay.hits.length === 1,
        JSON.stringify({ r: b, relayHits: served.relay.hits }));

      await evaluate(cdp, 'window.__consumer.authState.outcome = "deny"');
      const beforeDenyRelay = served.relay.hits.length;
      const d = await evaluate(cdp, `(async () => {
        const before = window.__consumer.net.dispatched.length;
        const asksBefore = window.__consumer.authState.asks;
        const r = await window.__consumer.exec('curl -X POST https://consumer-gate-counted.test/deny -d hi', { authorization: window.__consumer.authorization });
        return {
          ok: r.ok, output: r.output,
          dispatchDelta: window.__consumer.net.dispatched.length - before,
          asksDelta: window.__consumer.authState.asks - asksBefore,
        };
      })()`);
      const relayDelta = served.relay.hits.length - beforeDenyRelay;
      check('C6c deny → network_denied, exactly one ask, ZERO dispatch on BOTH paths (page recorder + relay stub)',
        d && d.ok === false && d.output === 'curl: network request denied by user'
        && d.dispatchDelta === 0 && relayDelta === 0 && d.asksDelta === 1,
        JSON.stringify({ r: d, relayDelta }));
      await evaluate(cdp, 'window.__consumer.authState.outcome = "allow"');
    }

    // C4a pre-aborted signal refuses cancellation-shaped
    {
      const r = await evaluate(cdp, `(async () => {
        const ac = new AbortController();
        ac.abort();
        try {
          await window.__consumer.session.execute({ kind: 'shell', input: 'echo never', context: { filesystem: window.__consumer.vfs, signal: ac.signal } });
          return { refused: false };
        } catch (e) { return { refused: true, name: e.name, cancelled: !!e.cancelled }; }
      })()`);
      check('C4a pre-aborted execute refuses cancellation-shaped', r.refused === true && r.name === 'AbortError', JSON.stringify(r));
    }

    // C4b reset boundary over a parked write (F2-strengthened: explicit
    // pre-release unsettled/busy assertions before the honest report)
    {
      const r = await evaluate(cdp, 'window.__consumer.scenarioResetBoundary()');
      check('C4b-i the parked composite is unsettled with busy=1 before the boundary',
        r && r.busyAtPark === 1 && r.settledAtPark === false && r.busyAfterReset === 1,
        JSON.stringify({ busyAtPark: r && r.busyAtPark, settled: r && r.settledAtPark, busyAfterReset: r && r.busyAfterReset }));
      check('C4b-ii the dispatched write commits (no rollback), the crossed run reports the boundary',
        r && r.committedFirst === true && r.dispatchedSecond === false
        && r.res.ok === false && /consumer boundary/.test(String(r.res.boundary || '') + String(r.res.output || '')),
        JSON.stringify({ res: r && r.res, committedFirst: r && r.committedFirst, dispatchedSecond: r && r.dispatchedSecond }));
      check('C4b-iii busy drains to zero only after true settlement; the session stays usable',
        r && r.busyFinal === 0 && r.after && r.after.ok === true && r.after.output === 'still-usable',
        JSON.stringify({ busyFinal: r && r.busyFinal, after: r && r.after }));
    }

    // C4e mid-flight CALLER abort over the parked write (F2)
    {
      const r = await evaluate(cdp, 'window.__consumer.scenarioMidFlightAbort()');
      check('C4e-i the run stays unsettled with busy=1 across the abort (abort does not settle early)',
        r && r.busyAtPark === 1 && r.settledAtPark === false && r.busyAfterAbort === 1,
        JSON.stringify({ busyAtPark: r && r.busyAtPark, settled: r && r.settledAtPark, busyAfterAbort: r && r.busyAfterAbort }));
      check('C4e-ii the dispatched write commits, the second write never dispatches',
        r && r.committedFirst === true && r.dispatchedSecond === false,
        JSON.stringify({ committedFirst: r && r.committedFirst, dispatchedSecond: r && r.dispatchedSecond, log: r && r.log }));
      check('C4e-iii the result fails cancellation-shaped and is NOT reported as a session boundary',
        r && r.res && r.res.ok === false && /cancelled/i.test(String(r.res.output || '')) && r.res.boundary === undefined,
        JSON.stringify(r && r.res));
      check('C4e-iv busy drains to zero; the same session still executes normally',
        r && r.busyFinal === 0 && r.after && r.after.ok === true && r.after.output === 'still-usable',
        JSON.stringify({ busyFinal: r && r.busyFinal, after: r && r.after }));
    }

    // C4f mid-flight dispose over the parked write (F2)
    {
      const r = await evaluate(cdp, 'window.__consumer.scenarioMidFlightDispose()');
      check('C4f-i busy stays TRUE across dispose until the parked op truly settles',
        r && r.busyAtPark === 1 && r.busyAfterDispose === 1 && r.busyFinal === 0,
        JSON.stringify({ busyAtPark: r && r.busyAtPark, busyAfterDispose: r && r.busyAfterDispose, busyFinal: r && r.busyFinal }));
      check('C4f-ii the settled write is kept; zero dispatches after the boundary',
        r && r.committedFirst === true && r.dispatchedSecond === false,
        JSON.stringify({ committedFirst: r && r.committedFirst, dispatchedSecond: r && r.dispatchedSecond }));
      check('C4f-iii the run fails with the disposal boundary named',
        r && r.res && r.res.ok === false && r.res.isError === true
        && /consumer mid-flight dispose/.test(String(r.res.boundary || '') + String(r.res.output || '')),
        JSON.stringify(r && r.res));
      check('C4f-iv execute AND prepare refuse forever with the same first reason; dispose is idempotent',
        r && /consumer mid-flight dispose/.test(String(r.executeRejection || ''))
        && /consumer mid-flight dispose/.test(String(r.prepareRejection || ''))
        && r.secondDisposeError === null
        && !/second dispose call/.test(String(r.executeRejection || '') + String(r.prepareRejection || '')),
        JSON.stringify({ executeRejection: r && r.executeRejection, prepareRejection: r && r.prepareRejection, secondDisposeError: r && r.secondDisposeError }));
    }

    // C4g the LAST side effect parks + caller abort in the unsettled window
    // (F2): the public result must FAIL even though the write itself lands.
    {
      const r = await evaluate(cdp, 'window.__consumer.scenarioLastWrite(false)');
      check('C4g the aborted last-write run fails honestly: committed fact kept, failure explained, never ok',
        r && r.res && r.res.ok === false && r.res.isError === true
        && /(^|\n)pre(\n|$)/.test(String(r.res.output || '')) && /cancelled/i.test(String(r.res.output || ''))
        && r.res.boundary === undefined
        && r.committedFact === 'data\n',
        JSON.stringify(r));
      // CONTROL: the same park without an invalidation stays a clean success
      // — the failure above comes from the abort's classification, not from
      // the parking mechanism.
      const c = await evaluate(cdp, 'window.__consumer.scenarioLastWrite(true)');
      check('C4g-control without an invalidation the parked run is untouched (clean success, no note)',
        c && c.res && c.res.ok === true && c.res.isError === false && c.res.output === 'pre'
        && c.res.boundary === undefined && c.committedFact === 'data\n',
        JSON.stringify(c));
    }

    // C4a/…: real Python + status events (REAL pinned CDN bootstrap)
    {
      const py = await evaluate(cdp, 'window.__consumer.runPython("import sys\\nprint(\\"py\\", sys.version_info[0])\\nopen(\'/mnt/workspace/py.txt\',\'w\').write(\'from-python\')\\nprint(\\"w\\")")', 300000);
      check('C2 real Python boots from the pinned CDN manifest and executes',
        py.ok === true && /py 3/.test(py.output) && /w/.test(py.output), JSON.stringify(py).slice(0, 200));
      const catBack = await evaluate(cdp, 'window.__consumer.exec("cat /mnt/workspace/py.txt")');
      check('C2b python write-back lands in the consumer VFS', catBack.ok === true && catBack.output === 'from-python', JSON.stringify(catBack));
      const evs = await evaluate(cdp, 'window.__consumer.statusEvents');
      check('C3 status events project cold → … → ready',
        evs[0] === 'cold' && evs.includes('loading') && evs[evs.length - 1] === 'ready', JSON.stringify(evs));
    }

    // C9 the workspace provider subpath (F1)
    {
      // C9a import + surface (the round's FIRST-FAILURE point: the baseline
      // package has no './workspace' export — this import fails there)
      const imp = await evaluate(cdp, 'window.__consumer.importWorkspaceSubpath()');
      check('C9a the workspace provider subpath imports with the full surface',
        imp && imp.ok === true
        && imp.kinds.WorkspaceAdapter === 'function' && imp.kinds.LocalDirectoryWorkspace === 'function'
        && imp.kinds.OPFSWorkspace === 'function' && imp.kinds.normalizeWorkspacePath === 'function'
        && imp.kinds.ensureWorkspacePermission === 'function' && imp.kinds.vfsError === 'function',
        JSON.stringify(imp));
      check('C9b the subpath import stays pure in the consumer bundle (zero new globals)',
        imp && imp.ok === true && imp.newGlobals.length === 0, JSON.stringify(imp && imp.newGlobals));

      // C9c LocalDirectoryWorkspace over a CONTROLLED handle (no picker)
      const ld = await evaluate(cdp, 'window.__consumer.f1LocalDirectory()');
      check('C9c LocalDirectoryWorkspace writes/reads/lists through a controlled handle',
        ld && ld.readBack === 'hello-local' && ld.providerName === 'picked-folder'
        && ld.listRoot.includes('a:directory') && ld.listRoot.includes('c.txt:file'),
        JSON.stringify(ld));
      check('C9c-ii the shared normalization refuses escapes and drive letters, resolves inner ..',
        ld && ld.escapeRejected === true && ld.driveRejected === true && ld.dotdotResolved === 'resolved',
        JSON.stringify({ escapeRejected: ld && ld.escapeRejected, driveRejected: ld && ld.driveRejected, dotdot: ld && ld.dotdotResolved }));
      check('C9c-iii ensureWorkspacePermission: denied false / prompt→granted true / no-API true',
        ld && ld.permissionDenied === true && ld.permissionPromptGranted === true && ld.permissionNoApi === true,
        JSON.stringify({ denied: ld && ld.permissionDenied, granted: ld && ld.permissionPromptGranted, naive: ld && ld.permissionNoApi }));
      check('C9c-iv a handle NotAllowedError propagates honestly (never swallowed)',
        ld && ld.blockedWriteName === 'NotAllowedError', JSON.stringify(ld && ld.blockedWriteName));

      // C9d OPFSWorkspace over a temporary test-owned OPFS directory
      const op = await evaluate(cdp, 'window.__consumer.f1Opfs()', 60000);
      check('C9d OPFSWorkspace: session shell writes durably; a FRESH provider reads the same bytes',
        op && op.shellWriteRead && op.shellWriteRead.ok === true && op.shellWriteRead.output === 'durable-opfs\n'
        && op.freshRead === 'durable-opfs\n' && op.freshList.includes('probe.txt') && op.mountedProvider === true,
        JSON.stringify(op));
      check('C9d-ii the temporary OPFS directory is really removed after the probe',
        op && op.cleaned === true, JSON.stringify(op && op.dirName));

      // C9e a minimal HOST-CUSTOM provider from the public surface only
      const cp = await evaluate(cdp, 'window.__consumer.f1CustomProvider()');
      check('C9e a host-custom WorkspaceAdapter mounts and runs shell work',
        cp && cp.shellWriteRead && cp.shellWriteRead.ok === true && cp.shellWriteRead.output === 'boxed\n'
        && cp.providerReceivedWrite === true && cp.vfsReadsProvider === true,
        JSON.stringify(cp));
      check('C9e-ii the custom provider refuses escapes via the shared normalization and classifies NotFoundError',
        cp && cp.providerEscapeRejected === true && cp.missingIsFalse === true && cp.removedThroughVfs === true,
        JSON.stringify({ escape: cp && cp.providerEscapeRejected, missing: cp && cp.missingIsFalse, removed: cp && cp.removedThroughVfs }));
    }

    const pageErrors = await evaluate(cdp, 'window.__consumer.errors.length');
    check('C8 browser reported no unhandled errors', pageErrors === 0, String(pageErrors));
  } catch (e) {
    console.error('CONSUMER GATE FAIL: ' + (e && e.stack || e));
    process.exitCode = 1;
  } finally {
    if (chrome) await closeChrome(chrome);
    if (profileDir) { try { await fs.rm(profileDir, { recursive: true, force: true }); } catch (e) {} }
    if (server) { try { await new Promise((r) => server.close(r)); } catch (e) {} }
  }
  console.log('---');
  console.log('consumer gate: ' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exitCode = 1;
}

main();
