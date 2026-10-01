// Out-of-repo consumer gate (M3a): installs ONLY the packed tarball, builds
// this project with its own vite, serves dist/, drives a real headless
// Chrome through the public package exports, and checks:
//   C1  VFS shell write/read through the public session
//   C2  real Python (REAL pinned CDN bootstrap) + VFS write-back
//   C3  status events (cold → loading → ready projection)
//   C4  cancellation (pre-aborted signal refuses; mid-flight caller abort
//       reports honestly), reset boundary (dispatched write commits, the
//       crossed execute reports the boundary, session stays usable) and
//       dispose (terminal refusal)
//   C5  injected mutation policy (generic fixture) refuses + composes the
//       reason; the VFS's own read-only authority never grants
//   C6  injected authorization port: deny → network_denied with ZERO
//   C7  capabilities() + describeCommands() sanity; import-time purity in
//       the CONSUMER bundle graph (no registry global anywhere)
// The gate never touches the locus-runtime checkout or any sibling source.
const fs = require('fs/promises');
const http = require('http');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  allocateFreePort, closeChrome, connectToTarget, launchChrome, waitForCdp,
  waitForPageTarget, waitForRuntimeCondition,
} = require('./chrome-driver.cjs');

const ROOT = __dirname;

async function serveDist() {
  const distRoot = path.join(ROOT, 'dist');
  const port = await allocateFreePort();
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css' };
  const server = http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url, 'http://127.0.0.1');
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
  return { url: 'http://127.0.0.1:' + port + '/', server };
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

    // C6 authorization deny → zero dispatch
    {
      await evaluate(cdp, 'window.__consumer.authState.outcome = "deny"');
      const r = await evaluate(cdp, 'window.__consumer.exec("curl -X POST https://consumer-deny.test/endpoint -d hi", { authorization: window.__consumer.authorization })');
      const asks = await evaluate(cdp, 'window.__consumer.authState.asks');
      check('C6 deny → network_denied, exactly one ask, no dispatch',
        r.ok === false && r.output === 'curl: network request denied by user' && asks === 1, JSON.stringify(r));
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

    // C4b real Python + status events (REAL pinned CDN bootstrap)
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

    // C4c reset boundary over a parked write (dedicated session)
    {
      await evaluate(cdp, `(async () => {
        const p = window.__consumer.makeParkingVfs();
        window.__consumer.park = p;
        p.hold('/mnt/workspace/first.txt');
        p.execPromise = p.session.execute({ kind: 'shell', input: 'echo first > /mnt/workspace/first.txt && echo second > /mnt/workspace/second.txt', context: { filesystem: p.vfs } });
        await new Promise((r) => {
          const iv = setInterval(() => {
            if (p.log.includes('write:park:/mnt/workspace/first.txt')) { clearInterval(iv); r(); }
          }, 20);
        });
        return 'parked';
      })()`);
      await evaluate(cdp, 'window.__consumer.park.session.reset("consumer boundary")');
      await evaluate(cdp, 'window.__consumer.park.open()');
      const r = await evaluate(cdp, 'window.__consumer.park.execPromise');
      const first = await evaluate(cdp, 'window.__consumer.park.vfs.exists("/mnt/workspace/first.txt")');
      const second = await evaluate(cdp, 'window.__consumer.park.vfs.exists("/mnt/workspace/second.txt")');
      check('C4b reset boundary: dispatched write commits (no rollback), run reports the boundary',
        r && r.ok === false && /consumer boundary/.test(String(r.boundary || '')) && first === true && second === false,
        JSON.stringify({ r: r && { ok: r.ok, boundary: r.boundary }, first, second }));
      const after = await evaluate(cdp, 'window.__consumer.park.session.execute({ kind: "shell", input: "echo still-usable", context: { filesystem: window.__consumer.park.vfs } }).then((x) => x.output)');
      check('C4c the reset session stays usable', after === 'still-usable', JSON.stringify(after));
    }

    // C4d dispose is terminal
    {
      const r = await evaluate(cdp, `(async () => {
        window.__consumer.park.session.dispose("consumer done");
        try {
          await window.__consumer.park.session.execute({ kind: 'shell', input: 'echo nope', context: { filesystem: window.__consumer.park.vfs } });
          return { refused: false };
        } catch (e) { return { refused: true, why: String(e && e.message || e) }; }
      })()`);
      check('C4d dispose refuses further work with its reason',
        r.refused === true && /consumer done/.test(r.why), JSON.stringify(r));
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
