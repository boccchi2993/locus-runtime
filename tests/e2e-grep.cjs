// Grep regex worker isolation browser e2e (F03; M3a extraction form). Real
// Chrome, real build, REAL Web Workers. Proves that a catastrophic-backtracking grep pattern:
//   - runs ONLY inside a dedicated worker (main-thread heartbeat keeps
//     firing while the regex burns the worker),
//   - is killed at the hard timeout and reports a bounded failure,
//   - can be cancelled through the task AbortSignal faster than the
//     timeout, without stale results,
//   - leaves no poisoned state (the next ordinary grep succeeds), and
//   - fails CLOSED with no main-thread fallback when workers are unavailable.
const fs = require('fs/promises');
const http = require('http');
const os = require('os');
const path = require('path');
const {
  allocateFreePort, closeChrome, connectToTarget, launchChrome, waitForCdp,
  waitForPageTarget, waitForRuntimeCondition,
} = require('./helpers/chrome.cjs');

// M3a: drives the PACKAGED standalone runtime host (dist/tests/runtime-host.html).
// When E2E_HOST_URL is unset this suite serves dist/ itself, so
// `npm run build && node tests/e2e-grep.cjs` is self-contained.
const HOST_URL = process.env.E2E_HOST_URL || null;

async function serveDist() {
  const distRoot = path.join(__dirname, '..', 'dist');
  const port = await allocateFreePort();
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json' };
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
  return { url: 'http://127.0.0.1:' + port + '/tests/runtime-host.html', server };
}

const APP_URL = HOST_URL;

// Adversarial input for ^(a+)+$: ~30 a's then a non-matching tail. Would
// backtrack exponentially (far beyond the 1s grep regex timeout); the
// worker is terminated long before it could finish, so CI CPU stays bounded.
const ADVERSARIAL = 'a'.repeat(30) + 'X';
const TIMEOUT_MS = 1000; // keep in sync with GREP_REGEX_TIMEOUT_MS in src/shell.js

const PAGE_HELPERS = `
(() => {
  if (window.__gwE2e) return 'ready';
  const H = window.__host;
  const exec = (cmd, opts) => H.exec(cmd, opts || {});
  window.__gwE2e = {
    beats: null,
    exec,
    // Heartbeat runs on the MAIN thread: if the pattern ever executes there,
    // the interval freezes and count stays 0 while grep runs.
    withHeartbeat: async (promise) => {
      const beats = { count: 0, ms: null };
      window.__gwE2e.beats = beats;
      const hb = setInterval(() => beats.count++, 50);
      const t0 = Date.now();
      try {
        const r = await promise;
        beats.ms = Date.now() - t0;
        return { output: r.output, success: r.success, beats: beats.count, elapsed: beats.ms };
      } finally {
        clearInterval(hb);
      }
    },
    dangerous: () => window.__gwE2e.withHeartbeat(
      exec("grep '^(a+)+$' adversarial.txt")),
    // TEST-ONLY instrumentation through the documented worker seam: wraps
    // the REAL Blob-Worker construction to count create/terminate pairs.
    // M2a: the source comes from the runtime assets (the product page no
    // longer carries a #grep-worker-src element).
    instrument: () => {
      const src = H.workerAssets.grepWorkerSource;
      H.GrepRegexRuntime._workerFactory = () => {
        window.__gwE2e.created++;
        const blob = new Blob([src], { type: 'text/javascript' });
        const url = URL.createObjectURL(blob);
        let w;
        try { w = new Worker(url); } finally { URL.revokeObjectURL(url); }
        const origTerm = w.terminate.bind(w);
        w.terminate = () => {
          if (!w.__terminated) { w.__terminated = true; window.__gwE2e.terminated++; }
          return origTerm();
        };
        return w;
      };
    },
    counts: () => ({ created: window.__gwE2e.created, terminated: window.__gwE2e.terminated }),
    resetCounts: () => { window.__gwE2e.created = 0; window.__gwE2e.terminated = 0; },
    restore: () => { H.GrepRegexRuntime._workerFactory = null; },
    breakWorker: () => { H.GrepRegexRuntime._workerFactory = () => { throw new Error('e2e: workers disabled'); }; },
    created: 0,
    terminated: 0,
  };
  return 'installed';
})()
`;

async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true, timeout: 110000,
  });
  if (result?.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result?.result?.value;
}

async function main() {
  let profileDir;
  let chrome;
  let cdp;
  let distServer = null;
  const closeDistServer = () => new Promise((r) => (distServer ? distServer.close(() => r()) : r()));
  let passed = 0;
  let failed = 0;
  const check = (name, condition, detail) => {
    if (condition) { passed++; console.log('PASS ' + name); }
    else { failed++; console.log('FAIL ' + name + (detail ? ' | ' + detail : '')); }
  };

  try {
    let appUrl = APP_URL;
    if (!appUrl) {
      const served = await serveDist();
      distServer = served.server;
      appUrl = served.url;
    }

    profileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'locus-grep-profile-'));
    chrome = await launchChrome(appUrl, {
      chromePath: process.env.CHROME,
      label: 'grep worker Chrome',
      profileDir,
      extraArgs: ['--window-size=1440,900'],
    });
    await waitForCdp(chrome, { timeoutMs: 15000 });
    const target = await waitForPageTarget(chrome, appUrl, { timeoutMs: 15000 });
    cdp = await connectToTarget(target);
    await waitForRuntimeCondition(cdp,
      '!!(window.__host && window.__host.ready && window.__host.vfs)',
      { process: chrome, phase: 'grep-app-boot', timeoutMs: 15000 });
    // M3a: the runtime host's VFS topology is final as soon as the page is
    // ready (no async durable-home re-mount exists here); the home mount
    // presence is the topology probe.
    await waitForRuntimeCondition(cdp,
      '!!(window.__host.vfs.mounts && window.__host.vfs.mounts.some(m => m.path === \'/home/locus\'))',
      { process: chrome, phase: 'grep-home', timeoutMs: 15000 });
    await evaluate(cdp, PAGE_HELPERS);

    // ---- setup: fixture files through ordinary shell commands ----
    const setup = await evaluate(cdp, `(async () => {
      const e = window.__gwE2e.exec;
      const r1 = await e("echo '${ADVERSARIAL}' > adversarial.txt");
      const r2 = await e("echo 'foo bar' > normal.txt");
      await e("echo baz >> normal.txt");
      const ls = await e('ls');
      return { adv: r1.success, norm: r2.success, ls: ls.output };
    })()`);
    check('G-E1 fixtures written via ordinary shell commands',
      setup.adv && setup.norm && /adversarial\.txt/.test(setup.ls) && /normal\.txt/.test(setup.ls),
      JSON.stringify(setup));

    // ---- CASE D: catastrophic regex — worker isolation, heartbeat, timeout ----
    // Pure production path (no test instrumentation): the real Blob Worker.
    const redos = await evaluate(cdp, `window.__gwE2e.dangerous()`);
    check('G-E2 catastrophic regex reports the bounded timeout failure',
      !redos.success && redos.output === 'grep: regex evaluation timed out (the pattern may cause excessive backtracking; simplify it)',
      JSON.stringify(redos));
    check('G-E2 main-thread heartbeat kept firing while the regex burned',
      redos.beats >= 5, 'beats=' + redos.beats);
    check('G-E2 grep returns bounded after the hard timeout',
      redos.elapsed >= TIMEOUT_MS && redos.elapsed < 3 * TIMEOUT_MS + 2000,
      'elapsed=' + redos.elapsed + 'ms');

    // ---- CASE G: recovery after timeout ----
    const recovery = await evaluate(cdp, `window.__gwE2e.exec('grep foo normal.txt').then(r => ({ output: r.output, success: r.success }))`);
    check('G-E3 ordinary grep succeeds right after a regex timeout',
      recovery.success && recovery.output === 'foo bar', JSON.stringify(recovery));

    // ---- CASE C: invalid regex — bounded failure and recovery ----
    const invalid = await evaluate(cdp, `window.__gwE2e.exec("grep '(' normal.txt").then(r => ({ output: r.output, success: r.success }))`);
    check('G-E4 invalid pattern fails with the bounded message',
      !invalid.success && invalid.output === 'grep: invalid pattern (patterns use JavaScript regex syntax)',
      JSON.stringify(invalid));
    const afterInvalid = await evaluate(cdp, `window.__gwE2e.exec('grep foo normal.txt').then(r => ({ output: r.output, success: r.success }))`);
    check('G-E4 ordinary grep succeeds right after an invalid pattern',
      afterInvalid.success && afterInvalid.output === 'foo bar', JSON.stringify(afterInvalid));

    // ---- instrumented (still REAL workers) lifecycle checks ----
    await evaluate(cdp, `window.__gwE2e.instrument(); 'installed'`);

    // ---- CASE E: cancellation beats the timeout, worker terminated ----
    const cancel = await evaluate(cdp, `(async () => {
      const ac = new AbortController();
      setTimeout(() => ac.abort(), 150);
      return window.__gwE2e.withHeartbeat(
        window.__gwE2e.exec("grep '^(a+)+$' adversarial.txt", { signal: ac.signal }));
    })()`);
    check('G-E5 cancelled catastrophic grep reports bash: cancelled before the timeout',
      !cancel.success && cancel.output === 'bash: cancelled' && cancel.elapsed < TIMEOUT_MS,
      JSON.stringify(cancel));
    check('G-E5 heartbeat kept firing during the cancelled run', cancel.beats >= 1, 'beats=' + cancel.beats);
    const cancelCounts = await evaluate(cdp, `window.__gwE2e.counts()`);
    check('G-E5 cancel creates and terminates exactly one worker',
      cancelCounts.created === 1 && cancelCounts.terminated === 1, JSON.stringify(cancelCounts));

    // ---- timeout under instrumentation: one create/terminate pair ----
    await evaluate(cdp, `window.__gwE2e.resetCounts(); 'reset'`);
    const redos2 = await evaluate(cdp, `window.__gwE2e.dangerous()`);
    const timeoutCounts = await evaluate(cdp, `window.__gwE2e.counts()`);
    check('G-E6 catastrophic grep still times out under instrumentation',
      !redos2.success && /regex evaluation timed out/.test(redos2.output) && redos2.beats >= 5,
      JSON.stringify(redos2));
    check('G-E6 timeout creates and terminates exactly one worker',
      timeoutCounts.created === 1 && timeoutCounts.terminated === 1, JSON.stringify(timeoutCounts));

    // ---- CASE F: worker unavailable — fail closed, NO main-thread fallback ----
    const unavailable = await evaluate(cdp, `(async () => {
      window.__gwE2e.breakWorker();
      const t0 = Date.now();
      try {
        const r = await window.__gwE2e.exec('grep foo normal.txt');
        return { output: r.output, success: r.success, elapsed: Date.now() - t0 };
      } finally { window.__gwE2e.restore(); }
    })()`);
    check('G-E7 worker unavailable fails closed (never a main-thread answer)',
      !unavailable.success && unavailable.output === 'grep: regex worker unavailable' && unavailable.output !== 'foo bar',
      JSON.stringify(unavailable));
    check('G-E7 fail-closed grep returns promptly instead of hanging',
      unavailable.elapsed < 2000, 'elapsed=' + unavailable.elapsed + 'ms');
    await evaluate(cdp, `window.__gwE2e.restore(); 'restored'`);
    await evaluate(cdp, `window.__gwE2e.restore(); 'restored'`);
    const restored = await evaluate(cdp, `window.__gwE2e.exec('grep foo normal.txt').then(r => ({ output: r.output, success: r.success }))`);
    check('G-E7 ordinary grep recovers once workers are available again',
      restored.success && restored.output === 'foo bar', JSON.stringify(restored));

    // ---- ordinary searches keep their semantics in the real browser ----
    const semantics = await evaluate(cdp, `(async () => {
      const e = window.__gwE2e.exec;
      const cnt = await e('grep -c foo normal.txt');
      const num = await e('grep -n foo normal.txt');
      const pipe = await e('echo hello-foo | grep foo');
      return { cnt: { output: cnt.output, success: cnt.success },
               num: { output: num.output, success: num.success },
               pipe: { output: pipe.output, success: pipe.success } };
    })()`);
    check('G-E8 -c exact count in browser', semantics.cnt.success && semantics.cnt.output === '1', JSON.stringify(semantics.cnt));
    check('G-E8 -n line numbers in browser', semantics.num.success && semantics.num.output === '1:foo bar', JSON.stringify(semantics.num));
    check('G-E8 stdin grep through the worker in browser', semantics.pipe.success && semantics.pipe.output === 'hello-foo', JSON.stringify(semantics.pipe));

    check('G-E9 browser reported no unhandled errors', (await evaluate(cdp, '(window.__e2eErrors || []).length')) === 0);

    console.log('---');
    console.log('e2e-grep: ' + passed + ' passed, ' + failed + ' failed');
    process.exitCode = failed ? 1 : 0;
  } catch (error) {
    console.error('GREP E2E FAIL: ' + (error && error.stack || error));
    process.exitCode = 1;
  } finally {
    try { cdp?.close(); } catch (e) {}
    if (chrome) await closeChrome(chrome);
    if (profileDir) { try { await fs.rm(profileDir, { recursive: true, force: true }); } catch (e) {} }
    if (distServer) { try { await closeDistServer(); } catch (e) {} }
  }
}

main().catch((error) => { console.error(error && error.stack || error); process.exitCode = 1; });
