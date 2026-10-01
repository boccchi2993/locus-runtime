// Python authority browser e2e (F04a + F04b; M3a extraction form). Real
// Chrome, the PACKAGED standalone runtime host (dist/tests/runtime-host.html),
// REAL Pyodide worker behind the strict-CSP creator iframe. Proves the
// worker's authority boundary against a local HTTP probe server whose
// REQUEST COUNTERS are the oracle — error text alone is never accepted as
// proof that no network attempt happened:
//   - basic Python and pandas keep working (compute + VFS preserved),
//   - js.fetch / pyodide.http.pyfetch / sync XHR / WebSocket / EventSource /
//     WebTransport attempts are denied LOCALLY with ZERO requests arriving,
//   - nested Worker and importScripts escapes are denied with ZERO requests,
//   - micropip against a local wheel URL performs ZERO requests,
//   - imports the runtime does not carry fail honestly with ZERO requests,
//   - dynamic-JS escapes (js.eval, pyodide.code.run_js) perform ZERO requests,
//   - the F04a-R1 residual is CLOSED (F04b): the reconstructed-Function
//     dynamic import is blocked by the BROWSER's creator-iframe CSP with
//     EXACTLY ZERO requests — Function compute itself still works,
//   - the PROTOTYPE-CHAIN family from the F04a-A1 audit (getPrototypeOf(self)
//     at every level: fetch via Reflect.apply / descriptor.value.call / bind,
//     importScripts, string-handler timers, a Function-recovered fetch) is
//     denied with ZERO requests — before AND after reset and crash recovery,
//   - real function handlers still reach the native timers at every level,
//   - concurrent runs are serialized (no stdout cross-contamination),
//   - reset and worker-crash recovery re-apply the lockdown,
//   - Python-side pyodide.loadPackage / loadPackagesFromImports are denied.
// M3a: standalone run needs the BUILT runtime host page. When
// E2E_HOST_URL is unset this suite serves dist/ itself on a free port, so
// `npm run build && node tests/e2e-python-authority.cjs` is self-contained;
// `npm run test:e2e` provides one through the shared vite preview.
const fs = require('fs/promises');
const http = require('http');
const os = require('os');
const path = require('path');
const {
  allocateFreePort, closeChrome, connectToTarget, launchChrome, waitForCdp,
  waitForPageTarget, waitForRuntimeCondition,
} = require('./helpers/chrome.cjs');

// M3a: standalone run needs the BUILT runtime host page. When
// E2E_HOST_URL is unset this suite serves dist/ itself on a free port, so
// `npm run build && node tests/e2e-python-authority.cjs` is self-contained;
// `npm run test:e2e` provides one through the shared vite preview.
const HOST_URL = process.env.E2E_HOST_URL || null;

async function serveDist() {
  const distRoot = path.join(__dirname, '..', 'dist');
  const port = await allocateFreePort();
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };
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

const APP_URL = HOST_URL; // resolved in main() (serving dist/ when unset)

async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true, timeout: 240000,
  });
  if (result?.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails).slice(0, 600));
  return result?.result?.value;
}

async function main() {
  let profileDir;
  let chrome;
  let cdp;
  let server;
  let distServer = null;
  const closeDistServer = () => new Promise((r) => (distServer ? distServer.close(() => r()) : r()));
  let passed = 0;
  let failed = 0;
  const check = (name, condition, detail) => {
    if (condition) { passed++; console.log('PASS ' + name); }
    else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + detail : '')); }
  };

  // ---- local probe server: counts EVERY request it receives ----
  const hits = [];
  const probeServer = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    hits.push({ path: u.pathname, t: Date.now() });
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    if (u.pathname === '/probe_wheel_fake-1.0-py3-none-any.whl') {
      res.setHeader('content-type', 'application/zip');
      res.end('not-a-real-wheel');
      return;
    }
    if (u.pathname === '/probe-script.js') {
      res.setHeader('content-type', 'application/javascript');
      res.end('self.__probeScriptLoaded = true;');
      return;
    }
    res.setHeader('content-type', 'text/plain');
    res.end('probe-hit');
  });
  const probePort = await allocateFreePort();
  await new Promise((r) => server = probeServer.listen(probePort, '127.0.0.1', r));
  const PROBE = 'http://127.0.0.1:' + probePort;
  const hitsTo = (pathname, since) => hits.filter((h) => h.path === pathname && h.t >= since).length;
  const probeTotal = () => hits.filter((h) => ['/probe-hit', '/probe-script.js', '/probe_wheel_fake-1.0-py3-none-any.whl'].indexOf(h.path) !== -1).length;

  // Runs Python through the REAL production path (bash tool → the store's
  // → Blob worker). kind='heredoc' wraps multi-line code in the heredoc form.
  const pyCmd = (code) => {
    const body = Array.isArray(code) ? code.join('\n') : code;
    return "python <<'PY'\n" + body + '\nPY';
  };
  const runPy = (code) => evaluate(cdp, `window.__paE2e.exec(${JSON.stringify(pyCmd(code))})`);

  try {
    let appUrl = APP_URL;
    if (!appUrl) {
      const served = await serveDist();
      distServer = served.server;
      appUrl = served.url;
    }
    profileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'locus-pyauth-profile-'));
    chrome = await launchChrome(appUrl, {
      chromePath: process.env.CHROME,
      label: 'python authority Chrome',
      profileDir,
      extraArgs: ['--window-size=1440,900'],
    });
    await waitForCdp(chrome, { timeoutMs: 15000 });
    const target = await waitForPageTarget(chrome, appUrl, { timeoutMs: 15000 });
    cdp = await connectToTarget(target);
    await waitForRuntimeCondition(cdp,
      '!!(window.__host && window.__host.ready && window.__host.vfs)',
      { process: chrome, phase: 'pyauth-app-boot', timeoutMs: 20000 });
    await waitForRuntimeCondition(cdp,
      '!!(window.__host.vfs.mounts && window.__host.vfs.mounts.some(m => m.path === \'/home/locus\'))',
      { process: chrome, phase: 'pyauth-home', timeoutMs: 20000 });
    await evaluate(cdp, `(() => {
      if (window.__paE2e) return 'ready';
      window.__paE2e = {
        exec: (cmd, opts) => window.__host.exec(cmd, opts || {}),
      };
      return 'installed';
    })()`);


    // ---- CDN prewarm (harness-only): since F04c the 30s PYTHON_TIMEOUT_MS
    // budget covers ONLY user execution; the bootstrap has its own
    // independent acquisition/initialization budgets. Prewarming the
    // browser HTTP cache keeps cold boots fast anyway. The URL set derives
    // from the runtime's pinned manifest (single source of truth). ----
    const { base: pyBase, manifest: pyManifest } =
      require('./helpers/python-manifest.cjs').loadPythonManifest();
    const prewarmUrls = pyManifest.map((a) => a.name);
    const prewarmResult = await evaluate(cdp, `(async () => {
      const base = ${JSON.stringify(pyBase)};
      const urls = ${JSON.stringify(prewarmUrls)};
      const deadline = Date.now() + 300000;
      const missing = [];
      for (const f of urls) {
        let ok = false;
        while (!ok && Date.now() < deadline) {
          try {
            const r = await fetch(base + f, { cache: 'default' });
            if (r.ok) { ok = true; break; }
          } catch (e) { /* retry */ }
          await new Promise((r) => setTimeout(r, 2000));
        }
        if (!ok) missing.push(f);
      }
      return { prewarmed: missing.length === 0, missing };
    })()`);
    console.log('# CDN prewarm: ' + JSON.stringify(prewarmResult));
    if (!prewarmResult || prewarmResult.prewarmed !== true) {
      console.log('# WARNING: CDN prewarm incomplete — cold boots may time out');
    }

    // ---- E1 (CASE A): basic Python through a full cold bootstrap ----
    const t1 = Date.now();
    const e1 = await runPy('print(2 + 2)');
    check('E1 basic python works (cold bootstrap incl. declared packages)',
      e1.success && e1.output.trim().endsWith('4'), JSON.stringify(e1).slice(0, 200));
    console.log('# E1 cold boot took ' + Math.round((Date.now() - t1) / 1000) + 's');

    // ---- E2 (CASE B): pandas + numpy preserved ----
    const e2 = await runPy([
      "import pandas as pd",
      "import numpy as np",
      "df = pd.DataFrame({'a': [1, 2, 3]})",
      "print('sum=%d np=%d' % (df['a'].sum(), np.array([1, 2]).sum()))",
    ]);
    check('E2 pandas and numpy keep working after the lockdown',
      e2.success && e2.output.includes('sum=6 np=3'), JSON.stringify(e2).slice(0, 200));

    // ---- E3 (CASE C): js.fetch denied, ZERO requests arrive ----
    // The denial semantic is the policy marker thrown by denyUserNetwork
    // (index.html). The presentation copy after the marker stays pinned
    // verbatim by the worker-source unit suite (python-authority.test.cjs
    // DENY_MESSAGE). Measured flake: under heavy machine load Pyodide's
    // JS->Python exception bridging can fail internally — the traceback then
    // ends at the call site with "SystemError: error return without
    // exception set" instead of the JsException carrying the marker, while
    // the denial itself held (E3b stayed at ZERO requests). That
    // presentation glitch is transient, so an attempt that failed WITHOUT
    // presenting the marker is re-observed exactly once; the denial must be
    // observed on the final attempt or E3 fails. E3b's window below spans
    // every attempt.
    const PYTHON_NETWORK_DENIED = 'Python network access is disabled in Locus';
    const isPythonNetworkDenied = (r) => !!r && r.success === false
      && typeof r.output === 'string' && r.output.includes(PYTHON_NETWORK_DENIED);
    let t = Date.now();
    const e3payload = [
      'import js',
      "js.fetch('" + PROBE + "/probe-hit')",
    ];
    let e3 = await runPy(e3payload);
    if (!isPythonNetworkDenied(e3) && e3.success === false) {
      console.log('# E3 attempt failed without presenting the denial; re-observing once');
      e3 = await runPy(e3payload);
    }
    const e3d = hitsTo('/probe-hit', t);
    check('E3 js.fetch attempt denied at the policy layer',
      isPythonNetworkDenied(e3),
      JSON.stringify(e3).slice(0, 200) + ' …tail: '
        + (e3 && typeof e3.output === 'string' ? e3.output.slice(-120) : ''));
    check('E3b js.fetch produced ZERO requests to the probe server', e3d === 0, 'delta=' + e3d);

    // ---- E4 (CASE D): pyodide.http.pyfetch denied, ZERO requests ----
    t = Date.now();
    const e4 = await runPy([
      'import asyncio, time',
      'from pyodide.http import pyfetch',
      'async def go():',
      "    try:",
      "        r = await pyfetch('" + PROBE + "/probe-hit')",
      "        print('pyfetch ALLOWED', r.status)",
      "    except Exception as ex:",
      "        print('pyfetch denied:', str(ex)[:80])",
      'asyncio.ensure_future(go())',
      'time.sleep(1.5)',
    ]);
    const e4d = hitsTo('/probe-hit', t);
    check('E4 pyodide.http.pyfetch denied with ZERO requests', e4d === 0, 'delta=' + e4d);
    // The E3 predicate is a denial semantic, not any-failure: it rejects a
    // successful run, a SUCCESSFUL run that merely mentions the marker (E4's
    // Python catches the pyfetch denial, so the marker lands in a success),
    // the package-loading denial (a different policy), every
    // infra-replaced output, and empty/non-object shapes.
    check('E3c isPythonNetworkDenied separates the denial from every unrelated result shape',
      isPythonNetworkDenied(e3)
      && !isPythonNetworkDenied(e2)
      && !isPythonNetworkDenied(e4)
      && !isPythonNetworkDenied({ success: false, output: 'Python package loading is controlled by the Locus runtime; declared runtime packages are provided automatically' })
      && !isPythonNetworkDenied({ success: false, output: 'python execution timed out after 30000ms' })
      && !isPythonNetworkDenied({ success: false, output: 'worker error: simulated fatal' })
      && !isPythonNetworkDenied({ success: false, output: 'python runtime reset (session boundary)' })
      && !isPythonNetworkDenied({ success: true, output: PYTHON_NETWORK_DENIED })
      && !isPythonNetworkDenied(null)
      && !isPythonNetworkDenied(undefined)
      && !isPythonNetworkDenied({})
      && !isPythonNetworkDenied({ success: false, output: '' }),
      'predicate verdicts diverged');

    // ---- E5 (CASE E): micropip against a LOCAL wheel URL, ZERO requests ----
    t = Date.now();
    const e5 = await runPy([
      'import micropip',
      "await micropip.install('" + PROBE + "/probe_wheel_fake-1.0-py3-none-any.whl')",
    ]);
    const e5d = hitsTo('/probe_wheel_fake-1.0-py3-none-any.whl', t);
    check('E5 micropip.install denied with ZERO requests to the local wheel',
      !e5.success && e5d === 0, JSON.stringify(e5).slice(0, 200) + ' | delta=' + e5d);

    // ---- E6 (CASE F): importScripts denied, ZERO requests ----
    t = Date.now();
    const e6 = await runPy([
      'import js',
      "js.importScripts('" + PROBE + "/probe-script.js')",
    ]);
    const e6d = hitsTo('/probe-script.js', t);
    check('E6 js.importScripts denied with ZERO requests',
      !e6.success && e6d === 0, JSON.stringify(e6).slice(0, 200) + ' | delta=' + e6d);

    // ---- E7 (CASE F): nested-Worker escape denied, ZERO requests ----
    t = Date.now();
    const e7 = await runPy([
      'import js',
      "blob = js.Blob.new([\"fetch('" + PROBE + "/probe-hit')\"], {'type': 'text/javascript'})",
      'wurl = js.URL.createObjectURL(blob)',
      'w = js.Worker.new(wurl)',
    ]);
    const e7d = hitsTo('/probe-hit', t);
    check('E7 nested Worker construction denied at the policy layer',
      !e7.success && e7.output.includes('Python network access is disabled in Locus'),
      JSON.stringify(e7).slice(0, 240));
    check('E7b nested Worker escape produced ZERO requests', e7d === 0, 'delta=' + e7d);

    // ---- E7c/d: XHR + WebSocket + EventSource + WebTransport ----
    t = Date.now();
    const e7c = await runPy([
      'import js',
      'x = js.XMLHttpRequest.new()',
      "x.open('GET', '" + PROBE + "/probe-hit', False)",
      'x.send()',
    ]);
    const e7cd = hitsTo('/probe-hit', t);
    check('E7c sync XMLHttpRequest denied with ZERO requests',
      !e7c.success && e7cd === 0, JSON.stringify(e7c).slice(0, 200) + ' | delta=' + e7cd);
    t = Date.now();
    const e7d2 = await runPy([
      'import js',
      "ws = js.WebSocket.new('ws://127.0.0.1:" + probePort + "/probe-hit')",
      "print('WS CONSTRUCTED')",
    ]);
    const e7dd = hitsTo('/probe-hit', t);
    check('E7d WebSocket construction denied with ZERO requests',
      !e7d2.success && !e7d2.output.includes('WS CONSTRUCTED') && e7dd === 0,
      JSON.stringify(e7d2).slice(0, 200) + ' | delta=' + e7dd);
    const e7e = await runPy([
      'import js',
      "es = js.EventSource.new('" + PROBE + "/probe-hit')",
      "print('ES CONSTRUCTED')",
    ]);
    check('E7e EventSource denied', !e7e.success && !e7e.output.includes('ES CONSTRUCTED'),
      JSON.stringify(e7e).slice(0, 200));
    const e7f = await runPy([
      'import js',
      "wt = js.WebTransport.new('" + PROBE + "/probe-hit')",
      "print('WT CONSTRUCTED')",
    ]);
    check('E7f WebTransport denied', !e7f.success && !e7f.output.includes('WT CONSTRUCTED'),
      JSON.stringify(e7f).slice(0, 200));

    // ---- E8 (CASE G): imports the runtime does not carry fail honestly ----
    t = Date.now();
    const e8 = await runPy([
      'try:',
      '    import regex',
      "    print('regex IMPORTED')",
      'except ModuleNotFoundError:',
      "    print('regex ModuleNotFoundError')",
    ]);
    const e8d = probeTotal();
    check('E8 lockfile package outside the declared set fails honestly',
      e8.success && e8.output.includes('regex ModuleNotFoundError'), JSON.stringify(e8).slice(0, 240));
    const e8b = await runPy([
      'try:',
      '    import definitely_not_a_real_pkg_xyz',
      "    print('unknown IMPORTED')",
      'except ModuleNotFoundError:',
      "    print('unknown ModuleNotFoundError')",
    ]);
    check('E8b unknown package import fails honestly with ZERO network',
      e8b.success && e8b.output.includes('unknown ModuleNotFoundError') && probeTotal() === e8d,
      JSON.stringify(e8b).slice(0, 240));

    // ---- E9: Python-side loader routes are denied ----
    t = Date.now();
    const e9 = await runPy([
      'import pyodide',
      "pyodide.loadPackage('regex')",
    ]);
    const e9b = await runPy([
      'import pyodide',
      "pyodide.loadPackagesFromImports('import regex')",
    ]);
    // The neutered instance loaders surface either as the harness denial or
    // as an AttributeError on the pyodide module — both are bounded failures
    // with ZERO network.
    check('E9 pyodide.loadPackage denied from Python',
      !e9.success && (e9.output.includes('Python package loading is controlled by the Locus runtime')
        || e9.output.includes("has no attribute 'loadPackage'")),
      JSON.stringify(e9).slice(0, 240));
    check('E9b pyodide.loadPackagesFromImports denied from Python',
      !e9b.success && (e9b.output.includes('Python package loading is controlled by the Locus runtime')
        || e9b.output.includes("has no attribute 'loadPackagesFromImports'")),
      JSON.stringify(e9b).slice(0, 240));

    // ---- E10 (E11 spec): dynamic-JS escapes perform ZERO requests ----
    const t10 = Date.now();
    const e10 = await runPy([
      'import js',
      "js.eval(\"fetch('" + PROBE + "/probe-hit')\")",
    ]);
    const e10b = await runPy([
      'import js',
      "F = js.Function.new(\"return fetch\")",
    ]);
    const e10c = await runPy([
      'from pyodide.code import run_js',
      "run_js(\"fetch('" + PROBE + "/probe-hit')\")",
    ]);
    // THE critical probe: Function reconstructed from a SURVIVING native
    // object — the one path that does not go through any denied global.
    // Construction alone compiles the body but performs NO request (F04a
    // pinned this); the residual was the CALL. Under F04b the worker runs
    // behind the strict-CSP creator iframe, so the browser itself must
    // block the called dynamic import.
    const t10d = Date.now();
    const e10d = await runPy([
      'import js',
      'F = js.console.log.constructor',
      "f = F(\"import('" + PROBE + "/probe-script.js')\")",
      "print('RECONSTRUCTED FUNCTION EXECUTED')",
    ]);
    await new Promise((r) => setTimeout(r, 2500));
    const e10dd = hitsTo('/probe-script.js', t10d);
    check('E10 js.eval denied with ZERO requests',
      !e10.success && hitsTo('/probe-hit', t10) === 0, JSON.stringify(e10).slice(0, 240));
    // js.Function stays native ON PURPOSE: Pyodide's glue needs the global
    // and F04b's boundary is network authority, never compute.
    check('E10b js.Function stays reachable (Pyodide requires the global; compute is not the boundary)',
      e10b.success, JSON.stringify(e10b).slice(0, 200));
    check('E10c pyodide.code.run_js denied with ZERO requests',
      !e10c.success && hitsTo('/probe-hit', t10) === 0, JSON.stringify(e10c).slice(0, 240));
    check('E10d2 constructing (never calling) the reconstructed Function performs ZERO requests',
      e10dd === 0, 'delta=' + e10dd);
    check('E10d local compute via the reconstructed Function still executes',
      e10d.success && e10d.output.includes('RECONSTRUCTED FUNCTION EXECUTED'),
      JSON.stringify(e10d).slice(0, 240));

    // F04a-R1 CLOSED (F04b): the CALLED dynamic import from a reconstructed
    // Function — the exact documented residual — is now blocked by the
    // browser's creator-iframe CSP. The import() promise REJECTS (the
    // payload's error handler turns it into 'ERR: …'), and the probe
    // server sees EXACTLY ZERO requests: the oracle, not the text.
    const e10e = await runPy([
      'import js',
      'F = js.Function.new("u", "return import(u).then(function(){ return \'LOADED\'; }, function(e){ return \'ERR: \' + (e && e.message || String(e)); })")',
      "res = await F('" + PROBE + "/probe-script.js')",
      "print('PROBE-IMPORT:', res)",
    ]);
    await new Promise((r) => setTimeout(r, 1000));
    const e10ed = hitsTo('/probe-script.js', t10d);
    check('E10e F04a-R1 CLOSED: the called dynamic import is browser-blocked (rejection surfaced, module never loaded)',
      e10e.success && /PROBE-IMPORT: ERR/.test(e10e.output) && !/PROBE-IMPORT: LOADED/.test(e10e.output),
      JSON.stringify(e10e).slice(0, 240));
    check('E10e2 the residual performs EXACTLY ZERO requests (was 1 before F04b)',
      e10ed === 0, 'delta=' + e10ed);
    // Same-origin dynamic import: the APP's own static server is not owned
    // by this suite, and a CSP-BLOCKED load still creates a ResourceTiming
    // entry — so entry count cannot distinguish blocked from loaded. The
    // deterministic oracle is the entry's responseStatus + transferSize:
    // blocked => status 0 and ZERO bytes received; a real GET would answer
    // 200 with the bundle's ~130KB.
    let bundlePath = null;
    try {
      // M3a: the packaged page is the runtime host build input; its module
      // bundle lives at /assets/runtimeHost-<hash>.js on the app origin
      // (the page references it as ../assets/… relative to /tests/).
      const idx = await fs.readFile(path.join(__dirname, '..', 'dist', 'tests', 'runtime-host.html'), 'utf8');
      const mb = idx.match(/src="[^"]*?(\/assets\/[^"]+\.js)"/);
      if (mb) bundlePath = mb[1];
    } catch (e) {}
    const e10f = await runPy([
      'import js',
      'origin = js.location.origin',
      'G = js.Function.new("u", "return import(u).catch(function(e){ return null; }).then(function(){ var es = performance.getEntriesByType(\'resource\').filter(function(en){ return en.name === u; }); if (!es.length) return \'none\'; var e0 = es[0]; return (e0.responseStatus || 0) + \'/\' + (e0.transferSize || 0); })")',
      "n = await G(origin + '" + (bundlePath || '/no-bundle-in-dist') + "')",
      "import time",
      'time.sleep(0.3)',
      "print('SAMEORIGIN-BYTES', n)",
    ]);
    check('E10f same-origin dynamic import is blocked with ZERO bytes received (responseStatus 0)',
      bundlePath !== null && e10f.success
        && (/SAMEORIGIN-BYTES none/.test(e10f.output) || /SAMEORIGIN-BYTES 0\/0/.test(e10f.output)),
      JSON.stringify(e10f).slice(0, 260));

    // ---- E10g (F04b): the worker runs behind the strict-CSP creator ----
    const creator = await evaluate(cdp, `(() => {
      const f = document.querySelector('iframe[data-locus-py-creator]');
      if (!f) return { present: false };
      return { present: true, srcdoc: f.srcdoc || '' };
    })()`);
    check('E10g the strict-CSP creator iframe hosts the python worker',
      !!creator && creator.present === true
        && /default-src 'none'/.test(creator.srcdoc)
        && /connect-src 'none'/.test(creator.srcdoc)
        && /worker-src blob:/.test(creator.srcdoc)
        && /script-src 'unsafe-inline' 'unsafe-eval'/.test(creator.srcdoc),
      JSON.stringify(String(creator && creator.srcdoc).slice(0, 160)));

    // ---- E11 (CASE H): reset re-applies the lockdown ----
    await evaluate(cdp, 'window.__host.session.pythonRuntime().reset(); "reset"');
    const e11a = await runPy('print(40 + 2)');
    check('E11 python works again after reset (full re-bootstrap)',
      e11a.success && e11a.output.trim().endsWith('42'), JSON.stringify(e11a).slice(0, 200));
    t = Date.now();
    const e11b = await runPy([
      'import js',
      "js.fetch('" + PROBE + "/probe-hit')",
    ]);
    check('E11b network still denied after reset, ZERO requests',
      !e11b.success && hitsTo('/probe-hit', t) === 0, JSON.stringify(e11b).slice(0, 200));

    // ---- E12 (CASE H): fatal worker recovery re-applies the lockdown ----
    await evaluate(cdp, `(() => {
      var pyrt = window.__host.session.pythonRuntime();
      if (!pyrt.worker) return 'no-worker';
      pyrt.worker.onerror({ message: 'e2e: simulated fatal worker error' });
      return 'crashed';
    })()`);
    check('E12 worker fatal error drops the runtime to cold',
      (await evaluate(cdp, '(function () { var pyrt = window.__host.session.pythonRuntime(); return pyrt.worker === null && pyrt.status === "cold"; })()')) === true);
    const e12a = await runPy('print(4 * 21)');
    check('E12b python recovers after a fatal worker error',
      e12a.success && e12a.output.trim().endsWith('84'), JSON.stringify(e12a).slice(0, 200));
    t = Date.now();
    const e12b = await runPy([
      'import js',
      "js.fetch('" + PROBE + "/probe-hit')",
    ]);
    check('E12c recovered worker still denies network with ZERO requests',
      !e12b.success && hitsTo('/probe-hit', t) === 0, JSON.stringify(e12b).slice(0, 200));
    // The F04a-A1 escape must ALSO stay closed after the rebuild: the fresh
    // worker re-walks the whole prototype chain under the new lockdown.
    t = Date.now();
    const e12d = await runPy([
      'import js',
      "js.Reflect.apply(js.Object.getPrototypeOf(js.Object.getPrototypeOf(js.self)).fetch, js.self, ['" + PROBE + "/probe-hit'])",
    ]);
    check('E12d recovered worker: prototype-level fetch denied with ZERO requests',
      !e12d.success && e12d.output.includes('Python network access is disabled') && hitsTo('/probe-hit', t) === 0,
      JSON.stringify(e12d).slice(0, 220));
    const e12e = await runPy([
      'import js',
      "js.Reflect.apply(js.Object.getPrototypeOf(js.self).importScripts, js.self, ['" + PROBE + "/probe-script.js'])",
    ]);
    check('E12e recovered worker: prototype-level importScripts denied with ZERO requests',
      !e12e.success && hitsTo('/probe-script.js', t) === 0, JSON.stringify(e12e).slice(0, 220));

    // ---- E13: stdlib battery (§52) + sqlite3 C-extension load after lockdown
    const e13 = await runPy([
      'import json, csv, re, math, statistics, pathlib, zipfile, hashlib, datetime',
      "print('stdlib-ok', json.dumps({'a': 1}), hashlib.md5(b'x').hexdigest()[:6], datetime.date(2026, 9, 20).isoformat())",
    ]);
    check('E13 stdlib modules keep working', e13.success && e13.output.includes('stdlib-ok'),
      JSON.stringify(e13).slice(0, 240));
    // sqlite3 is UNVENDORED in the Pyodide distribution: the removed
    // loadPackagesFromImports used to auto-load it from the CDN on import;
    // now it fails honestly (stock Pyodide behavior, zero network). §52
    // requires reporting this, not silently expanding the package set.
    const e13b = await runPy([
      'try:',
      '    import sqlite3',
      "    print('sqlite3 IMPORTED')",
      'except ModuleNotFoundError:',
      "    print('sqlite3 ModuleNotFoundError (unvendored in the Pyodide distribution)')",
    ]);
    check('E13b sqlite3 unvendored stdlib now fails honestly with ZERO network (was auto-loaded before F04a)',
      e13b.success && e13b.output.includes('sqlite3 ModuleNotFoundError (unvendored in the Pyodide distribution)'),
      JSON.stringify(e13b).slice(0, 300));

    // ---- E14: urllib cannot reach the network either (documented behavior)
    t = Date.now();
    const e14 = await runPy([
      'import urllib.request',
      "urllib.request.urlopen('" + PROBE + "/probe-hit', timeout=3)",
    ]);
    check('E14 urllib fails bounded with ZERO requests',
      !e14.success && hitsTo('/probe-hit', t) === 0, JSON.stringify(e14).slice(0, 240));

    // ---- E18 (F04a-A1): the PROTOTYPE-CHAIN family — every form the audit
    // used to recover a native primitive from getPrototypeOf(self) must be
    // the same denial, with ZERO requests arriving. Audited Chrome layout:
    // fetch/importScripts/caches/timers are OWNED by a scope prototype
    // (p2), XHR/WebSocket/Worker by the global instance. ----
    const protoPrologue = [
      'import js',
      'p = js.Object.getPrototypeOf(js.self)',
      'p2 = js.Object.getPrototypeOf(p)',
    ];
    const DENIED = 'Python network access is disabled in Locus; use the shell curl command';
    const e18forms = [
      ['reflect p.fetch', "js.Reflect.apply(p.fetch, js.self, ['" + PROBE + "/probe-hit'])"],
      ['reflect p2.fetch', "js.Reflect.apply(p2.fetch, js.self, ['" + PROBE + "/probe-hit'])"],
      ['descriptor.value.call p2.fetch', "js.Object.getOwnPropertyDescriptor(p2, 'fetch').value.call(js.self, '" + PROBE + "/probe-hit')"],
      ['bound p.fetch', "p.fetch.bind(js.self)('" + PROBE + "/probe-hit')"],
    ];
    for (const [tag, expr] of e18forms) {
      t = Date.now();
      const r = await runPy(protoPrologue.concat([expr]));
      const d = hitsTo('/probe-hit', t);
      check('E18 prototype fetch via ' + tag + ': denied + ZERO requests',
        !r.success && r.output.includes(DENIED) && d === 0, JSON.stringify(r).slice(0, 220) + ' | delta=' + d);
    }
    const e18graph = await runPy(protoPrologue.concat([
      "d = js.Object.getOwnPropertyDescriptor(p, 'fetch')",
      "print('P-DESC', 'absent' if d is None else 'present')",
    ]));
    check('E18b the global owns NO own fetch descriptor (audited object graph intact)',
      e18graph.success && e18graph.output.includes('P-DESC absent'), JSON.stringify(e18graph).slice(0, 200));
    for (const lvl of ['p', 'p2']) {
      t = Date.now();
      const r = await runPy(['import js'].concat(lvl === 'p' ? [
        'L = js.Object.getPrototypeOf(js.self)',
      ] : [
        'p = js.Object.getPrototypeOf(js.self)',
        'L = js.Object.getPrototypeOf(p)',
      ]).concat([
        "L.importScripts('" + PROBE + "/probe-script.js')",
      ]));
      const d = hitsTo('/probe-script.js', t);
      check('E18c prototype importScripts via ' + lvl + ': denied + ZERO requests',
        !r.success && r.output.includes(DENIED) && d === 0, JSON.stringify(r).slice(0, 220) + ' | delta=' + d);
    }
    t = Date.now();
    const e18d = await runPy(protoPrologue.concat([
      "p.setTimeout(\"import('" + PROBE + "/probe-script.js')\", 0)",
      "p2.setTimeout(\"import('" + PROBE + "/probe-script.js')\", 0)",
      "p.setInterval(\"import('" + PROBE + "/probe-script.js')\", 0)",
      "p2.setInterval(\"import('" + PROBE + "/probe-script.js')\", 0)",
      "print('unreachable')",
    ]));
    await new Promise((r) => setTimeout(r, 1200));
    const e18dd = hits.filter((h) => h.path === '/probe-script.js' && h.t >= t).length;
    check('E18d prototype setTimeout/setInterval string handlers denied at every level + ZERO requests',
      !e18d.success && e18d.output.includes(DENIED) && e18dd === 0,
      JSON.stringify(e18d).slice(0, 220) + ' | delta=' + e18dd);
    const e18e = await runPy(protoPrologue.concat([
      'from pyodide.ffi import create_proxy',
      '# create_proxy keeps the callback alive past the run boundary — a',
      '# bare lambda would be destroyed as a borrowed proxy when the timer',
      '# fires after the run finished (and raise an unhandled worker error).',
      'cb = create_proxy(lambda: None)',
      'js.setTimeout(cb, 5)',
      'p.setTimeout(cb, 5)',
      'p2.setTimeout(cb, 5)',
      'import time',
      'time.sleep(0.4)',
      "print('TIMER-FN-OK')",
    ]));
    check('E18e real function handlers still accepted at the own slot and both prototype levels (Pyodide needs them)',
      e18e.success && e18e.output.includes('TIMER-FN-OK'), JSON.stringify(e18e).slice(0, 240));
    t = Date.now();
    const e18f = await runPy([
      'import js',
      'F = js.Function.new("url", "const f = Object.getPrototypeOf(self).fetch; return Reflect.apply(f, self, [url])")',
      "F('" + PROBE + "/probe-hit')",
    ]);
    check('E18f Function-generated code recovering the prototype fetch: denied + ZERO requests (audit payload, now closed)',
      !e18f.success && e18f.output.includes(DENIED) && hitsTo('/probe-hit', t) === 0,
      JSON.stringify(e18f).slice(0, 240));
    for (const [tag, expr] of [
      ['XMLHttpRequest', "js.Reflect.construct(p2.XMLHttpRequest, [])"],
      ['WebSocket', "js.Reflect.construct(p2.WebSocket, ['ws://127.0.0.1:" + probePort + "/probe-hit'])"],
      ['Worker', "js.Reflect.construct(p2.Worker, ['blob:probe'])"],
    ]) {
      t = Date.now();
      const r = await runPy(protoPrologue.concat([expr]));
      const d = hitsTo('/probe-hit', t);
      check('E18g prototype-level ' + tag + ': no native survivor on the chain, denied + ZERO requests',
        !r.success && d === 0, JSON.stringify(r).slice(0, 220) + ' | delta=' + d);
    }

    // ---- E19 (F04a-A2): concurrent runs are serialized — outputs never
    // cross. The audit reproduced stdout cross-contamination twice. ----
    const [e19a, e19b] = await Promise.all([
      runPy("print('A42')"),
      runPy(['import time', 'time.sleep(1.2)', "print('B25')"]),
    ]);
    check('E19 concurrent runs: the short run keeps exactly its own stdout',
      e19a.success && e19a.output.trim().endsWith('A42') && !e19a.output.includes('B25'),
      JSON.stringify(e19a).slice(0, 200));
    check('E19b concurrent runs: the slow run keeps exactly its own stdout',
      e19b.success && e19b.output.trim().endsWith('B25') && !e19b.output.includes('A42'),
      JSON.stringify(e19b).slice(0, 200));

    // ---- E15: VFS write-back sanity under the lockdown (§53) ----
    await evaluate(cdp, `window.__paE2e.exec("echo pyauth-fixture > pyauth-in.txt").then(r => r.success).then(ok => { window.__paE2e.wrote = ok; })`);
    check('E15 fixture written via shell', (await evaluate(cdp, 'window.__paE2e.wrote')) === true);
    const e15 = await runPy([
      "data = open('pyauth-in.txt').read().strip()",
      "open('pyauth-out.txt', 'w').write('processed:' + data)",
      "print('saw:' + data)",
    ]);
    const e15b = await evaluate(cdp, `window.__paE2e.exec('cat pyauth-out.txt').then(r => ({ output: r.output, success: r.success }))`);
    check('E15 python read + write-back roundtrip through the VFS',
      e15.success && e15.output.includes('saw:pyauth-fixture') && e15b.success
      && e15b.output.replace(/\n$/, '') === 'processed:pyauth-fixture',
      JSON.stringify(e15.output) + ' | ' + JSON.stringify(e15b));

    // ---- E16: no HIDDEN attempts — ZERO probe-server traffic in the whole
    // suite. Every denial above, every prototype-chain probe, the closed
    // F04a-R1 dynamic import, both recovery cycles — all contributed ZERO
    // (before F04b the suite carried exactly one documented residual GET). --
    check('E16 probe server received ZERO requests across the entire suite',
      probeTotal() === 0, 'total=' + probeTotal() + ' paths=' + JSON.stringify(hits.map((h) => h.path)));
    check('E17 browser reported no unhandled errors', (await evaluate(cdp, '(window.__e2eErrors || []).length')) === 0,
      JSON.stringify(await evaluate(cdp, '(window.__e2eErrors || []).slice(0, 3)')));

    console.log('---');
    console.log('e2e-python-authority: ' + passed + ' passed, ' + failed + ' failed');
    process.exitCode = failed ? 1 : 0;
  } catch (error) {
    console.error('PYTHON AUTHORITY E2E FAIL: ' + (error && error.stack || error));
    process.exitCode = 1;
  } finally {
    try { cdp && cdp.close(); } catch (e) {}
    if (chrome) await closeChrome(chrome);
    if (profileDir) { try { await fs.rm(profileDir, { recursive: true, force: true }); } catch (e) {} }
    if (server) { try { await new Promise((r) => server.close(r)); } catch (e) {} }
    if (typeof closeDistServer === 'function') { try { await closeDistServer(); } catch (e) {} }
  }
}

main().catch((error) => { console.error(error && error.stack || error); process.exitCode = 1; });
