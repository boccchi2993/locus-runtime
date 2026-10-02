// Python bootstrap integrity + lifecycle BROWSER e2e (F04c). Real headless
// Chrome, the REAL production runtime (the store's canonical instance from
// src/shell.js createPythonRuntime + the REAL
// py-worker-src from index.html), a real strict-CSP creator iframe and a
// real Pyodide 0.26.4 boot -- against a LOCAL controllable asset server:
//
//   - crypto.subtle REALLY verifies every asset on hosted AND file:// pages
//     (a clean boot is itself the proof: every byte is hashed against the
//     pinned manifest before the worker may receive it);
//   - a corrupted byte on the wire fails the boot CLOSED with the integrity
//     error, the worker never receives bootstrap bytes, and a clean retry
//     succeeds from scratch;
//   - a stalled body fails with the ACQUISITION-stall error (bounded reader);
//   - a silent worker fails with the INITIALIZATION timeout -- verified
//     assets are RETAINED, and the next boot reuses them with ZERO network;
//   - a worker crash + disabled asset server still boots from the verified
//     page-session cache (asset request delta = 0);
//   - every asset request the harness ever makes is exactly
//     PYODIDE_BASE + manifest name (no path/query variation);
//   - the lockfile in the LIVE verified cache yields a pandas dependency
//     closure equal to the manifest's package wheel set;
//   - user execution keeps its untouched 30s budget (while True: pass).
//
// Self-contained: own asset server + Chrome, no app build needed.
// Run: node tests/e2e-python-bootstrap.cjs
const fs = require('fs/promises');
const http = require('http');
const os = require('os');
const path = require('path');
const {
  allocateFreePort, closeChrome, connectToTarget, launchChrome, waitForCdp,
  waitForPageTarget, waitForRuntimeCondition,
} = require('./helpers/chrome.cjs');
const { loadPythonManifest } = require('./helpers/python-manifest.cjs');

const { base: PYODIDE_CDN, manifest: PY_MANIFEST, runtimePackageFiles: PY_RUNTIME_PACKAGE_FILES } = loadPythonManifest();
const ASSET_CACHE_DIR = path.join(__dirname, '..', 'tmp-f04b-probe', 'pyodide');

async function evaluate(cdp, expression, timeoutMs) {
  const result = await cdp.send('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true, timeout: timeoutMs || 120000,
  });
  if (result?.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails).slice(0, 600));
  return result?.result?.value;
}

// ---- asset loader: disk cache or CDN (self-contained) --------------------
async function loadAsset(name) {
  const cached = path.join(ASSET_CACHE_DIR, name);
  try {
    return await fs.readFile(cached);
  } catch (e) { /* fall through to CDN */ }
  const res = await fetch(PYODIDE_CDN + name);
  if (!res.ok) throw new Error('asset download failed: ' + name + ' -> ' + res.status);
  const bytes = Buffer.from(await res.arrayBuffer());
  try {
    await fs.mkdir(ASSET_CACHE_DIR, { recursive: true });
    await fs.writeFile(cached, bytes);
  } catch (e) { /* cache is best-effort */ }
  return bytes;
}

// ---- page builder ----------------------------------------------------------
// M3a: src/shell.js is an ES module, so the page loads it as ONE module --
// hosted: same-origin '/src/shell.js' (served by this suite's own server
// straight from the repo's src/ tree); file://: the absolute server URL
// (a cross-origin module import -- the /src/ route grants CORS). The
// CDN-redirect fetch patch and the driver are installed INSIDE the module,
// before createPythonRuntime runs; the readiness flags land at the end of
// the module, exactly where the suite's polling expects them. The runtime
// itself is untouched production code.
function buildPage(shellModuleUrl, workerSrc, localAssets) {
  return '<!DOCTYPE html><html><head><meta charset="utf-8"><title>F04c</title></head><body>'
    + '<script type="module">'
    + 'import { createPythonRuntime } from ' + JSON.stringify(shellModuleUrl) + ';'
    // Test-page seam (same technique as tests/e2e-network.cjs): rewrite the
    // runtime's PINNED CDN fetches onto the local controllable asset server.
    // Production code is untouched; the pinned URL list is still the only
    // thing the runtime ever asks for -- we just answer it locally so
    // corrupt/stall/down faults are deterministic. The worker's own fetches
    // stay CSP-blocked; only the page ever fetches assets here.
    + 'var __nativeFetch = window.fetch.bind(window);'
    + 'var __cdnPrefix = ' + JSON.stringify(PYODIDE_CDN) + ';'
    + 'var __localAssets = ' + JSON.stringify(localAssets) + ';'
    + 'window.fetch = function (input, init) {'
    + '  var url = typeof input === "string" ? input : (input && input.url) || String(input);'
    + '  if (url.indexOf(__cdnPrefix) === 0) url = __localAssets + url.slice(__cdnPrefix.length);'
    + '  return __nativeFetch(url, init);'
    + '};'
    + 'var __el = document.createElement("script");'
    // M2a: the worker source is a runtime asset handed to the factory —
    // this page carries no #py-worker-src element. SetWorkerSource swaps
    // the source by REBUILDING the instance, carrying the verified asset
    // cache over (content-hash-pinned Pyodide bytes are stateless and
    // independent of the worker build — the same retention the old
    // same-instance swap exercised). __f04cWorkerSrc stays the GOOD
    // source forever: the OLD DOM-based driver mutated only the tag and
    // E7b restored via this variable, so it must never be overwritten.
    + 'window.__f04cWorkerSrc = ' + JSON.stringify(workerSrc) + ';'
    + 'window.__f04c = { ready: true };'
    + 'window.__pyrt = createPythonRuntime({ pyWorkerSource: window.__f04cWorkerSrc });'
    + 'window.__f04cSetWorkerSource = function (t) {'
    + '  var previous = window.__pyrt;'
    + '  window.__pyrt = createPythonRuntime({ pyWorkerSource: t });'
    + '  if (previous && previous._assets) window.__pyrt._assets = previous._assets;'
    + '};'
    + 'window.__f04cRun = function (code, opts) {'
    + '  return window.__pyrt.run(code, null, Object.assign({ cwd: "/tmp" }, opts || {}))'
    + '    .then(function (r) { return { ok: true, result: r }; },'
    + '      function (e) { return { ok: false, error: String(e && e.message || e), code: e && e.code }; });'
    + '};'
    + 'window.__f04cCrash = function () { window.__pyrt._onWorkerFatal({ message: "simulated crash" }); };'
    + 'window.__f04cLockfileText = function () {'
    + '  return window.__pyrt._assets && window.__pyrt._assets["pyodide-lock.json"]'
    + '    ? window.__pyrt._assets["pyodide-lock.json"].text : null;'
    + '};'
    + '<\/script>'
    + '</body></html>';
}

async function main() {
  let server;
  let passed = 0;
  let failed = 0;
  const check = (name, condition, detail) => {
    if (condition) { passed++; console.log('PASS ' + name); }
    else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + detail : '')); }
  };

  // ---- asset server with switchable fault modes --------------------------
  // mode: 'good' | 'down' | 'corrupt:<name>' | 'stall:<name>'
  let mode = 'good';
  let pageHtml = null; // set before hosted mode starts
  const assetBytes = new Map();
  const hits = [];
  const assetHitCount = () => hits.reduce((n, h) => n + (h.kind === 'asset' ? 1 : 0), 0);
  const port = await allocateFreePort();
  server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    const t = Date.now();
    if (u.pathname === '/f04c-page') {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(pageHtml);
      return;
    }
    // M3a: the module graph is served straight from the repo's src/ tree --
    // the page imports '/src/shell.js' and its relative imports (./vfs.js,
    // ./network.js, ./lib/utf8.js) resolve against the served /src/ URLs.
    // CORS-open: the file://-mode harness page (opaque origin) imports the
    // module cross-origin -- same trust rule as the asset route below.
    if (u.pathname.startsWith('/src/')) {
      const root = path.join(__dirname, '..', 'src');
      const file = path.normalize(path.join(root, u.pathname.slice('/src/'.length)));
      if (file !== root && !file.startsWith(root + path.sep)) { res.statusCode = 403; res.end('forbidden'); return; }
      let bytes;
      try { bytes = await fs.readFile(file); } catch (e) { res.statusCode = 404; res.end('not found'); return; }
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('content-type', 'text/javascript; charset=utf-8');
      res.end(bytes);
      return;
    }
    if (u.pathname.startsWith('/assets/')) {
      const name = u.pathname.slice('/assets/'.length);
      hits.push({ kind: 'asset', name, t });
      const bytes = assetBytes.get(name);
      if (!bytes) { res.statusCode = 404; res.end('unknown asset'); return; }
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('cache-control', 'no-store'); // counters must observe every fetch
      const entry = PY_MANIFEST.find((a) => a.name === name);
      if (mode === 'down') {
        res.statusCode = 503;
        res.end('asset server down');
        return;
      }
      if (mode === 'corrupt:' + name) {
        const bad = Buffer.from(bytes);
        bad[Math.floor(bad.length / 2)] ^= 0xff; // one flipped byte, exact size kept
        res.setHeader('content-type', entry.mime);
        res.setHeader('content-length', bad.length);
        res.end(bad);
        return;
      }
      if (mode === 'stall:' + name) {
        res.on('error', () => { /* reader cancelled the socket: expected */ });
        res.setHeader('content-type', entry.mime);
        res.setHeader('content-length', bytes.length);
        res.write(bytes.subarray(0, 1024)); // first KB, then never end: a hung body
        return;
      }
      res.setHeader('content-type', entry.mime);
      res.setHeader('content-length', bytes.length);
      res.end(bytes);
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const ASSETS = 'http://127.0.0.1:' + port + '/assets';
  const SHELL_URL = 'http://127.0.0.1:' + port + '/src/shell.js';

  // One boot + run sequence against a fresh page; returns driver result.
  async function bootAndRun(cdp, label, code, budgets) {
    const t0 = Date.now();
    const r = await evaluate(cdp,
      'window.__f04cRun(' + JSON.stringify(code) + ', ' + JSON.stringify(budgets || null) + ')',
      240000);
    return { r, ms: Date.now() - t0, label };
  }

  async function reloadPage(cdp) {
    await evaluate(cdp, 'location.reload(); "reloading"'); // resolve BEFORE the context dies
    await waitForRuntimeCondition(cdp, '!!(window.__f04c && window.__f04c.ready && window.__pyrt)',
      { process: null, phase: 'f04c-reload', timeoutMs: 15000 });
  }

  try {
    console.log('# loading pinned asset set (' + PY_MANIFEST.length
      + ' files, disk cache at ' + ASSET_CACHE_DIR + ' when present, CDN otherwise)');
    for (const a of PY_MANIFEST) assetBytes.set(a.name, await loadAsset(a.name));
    // M2a: the worker source comes from the runtime asset module.
    const workerSrc = require('./helpers/runtime.cjs').PY_WORKER_SOURCE;

    // ===================== HOSTED MODE ==================================
    {
      const pageUrl = 'http://127.0.0.1:' + port + '/f04c-page';
      pageHtml = buildPage('/src/shell.js', workerSrc, ASSETS + '/');
      let profileDir = null;
      let chrome = null;
      let cdp = null;
      try {
        profileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'locus-f04c-profile-'));
        chrome = await launchChrome(pageUrl, {
          chromePath: process.env.CHROME,
          label: 'F04c hosted Chrome',
          profileDir,
          extraArgs: ['--window-size=1280,800'],
        });
        await waitForCdp(chrome, { timeoutMs: 15000 });
        const target = await waitForPageTarget(chrome, pageUrl, { timeoutMs: 15000 });
        cdp = await connectToTarget(target);
        await waitForRuntimeCondition(cdp, '!!(window.__f04c && window.__f04c.ready && window.__pyrt)',
          { process: chrome, phase: 'f04c-app-boot', timeoutMs: 15000 });

        // E0: WebCrypto subtle really works here (integrity is verifiable).
        const subtleOk = await evaluate(cdp,
          '(async () => { await crypto.subtle.digest("SHA-256", new Uint8Array([1,2,3])); return true; })()');
        check('hosted E0 crypto.subtle available (integrity verification possible)', subtleOk === true, String(subtleOk));

        // E1: cold boot through the REAL pipeline: bounded raw reads +
        // SHA-256 on every asset, exact URL set, then a real Pyodide boot.
        mode = 'good';
        const t1 = assetHitCount();
        const e1 = await bootAndRun(cdp, 'E1', 'print(2 + 2)');
        check('hosted E1 cold boot: real verified acquisition + real Pyodide, python works',
          e1.r.ok && e1.r.result.stdout.trim().endsWith('4') && !e1.r.result.error,
          JSON.stringify(e1.r).slice(0, 300));
        console.log('# hosted E1 cold boot took ' + Math.round(e1.ms / 100) / 10 + 's');
        const e1hits = assetHitCount() - t1;
        const expectedUrls = PY_MANIFEST.map((a) => a.name).sort();
        check('hosted E1 acquisition fetched EXACTLY the pinned URL set, one fetch each (no path/query variation)',
          e1hits === PY_MANIFEST.length, 'delta=' + e1hits + ' expected=' + PY_MANIFEST.length);

        // E2: pandas compute proves the bytes are genuinely intact.
        const e2 = await bootAndRun(cdp, 'E2',
          "import pandas as pd, numpy as np\nprint('DF', int(pd.DataFrame({'a': [1, 2, 3]}).a.sum() + np.array([4]).sum()))");
        check('hosted E2 pandas + numpy compute on verified bytes',
          e2.r.ok && /DF 10/.test(e2.r.result.stdout || ''), JSON.stringify(e2.r).slice(0, 300));

        // E3: the LIVE verified lockfile yields the exact pandas closure.
        const lockText = await evaluate(cdp, 'window.__f04cLockfileText()');
        check('hosted E3 lockfile present in the verified page cache', typeof lockText === 'string' && lockText.length > 100, '');
        if (typeof lockText === 'string') {
          const lock = JSON.parse(lockText);
          const closure = new Set();
          const walk = (n) => {
            if (closure.has(n)) return;
            const p = lock.packages[n];
            if (!p) throw new Error('missing ' + n);
            closure.add(n);
            for (const d of p.depends || []) walk(d);
          };
          walk('pandas');
          const lockFiles = [...closure].map((n) => lock.packages[n].file_name).sort();
          // The manifest's RUNTIME package wheels (the trusted wheel
          // installer closure is a separate partition, loaded only for
          // wheel payloads — not part of the pandas closure).
          const wheelFiles = PY_RUNTIME_PACKAGE_FILES.slice().sort();
          check('hosted E3 live lockfile pandas closure == declared runtime package wheel set EXACTLY',
            JSON.stringify(lockFiles) === JSON.stringify(wheelFiles),
            JSON.stringify([lockFiles, wheelFiles]));
        }

        // E4: crash + asset server DOWN -> rebuild from the verified cache,
        // ZERO network (page-session cache semantics).
        const t4 = assetHitCount();
        await evaluate(cdp, 'window.__f04cCrash()');
        mode = 'down';
        const e4 = await bootAndRun(cdp, 'E4', 'print(3 + 3)');
        check('hosted E4 crash rebuild with asset server DOWN succeeds from the verified cache',
          e4.r.ok && e4.r.result.stdout.trim().endsWith('6'), JSON.stringify(e4.r).slice(0, 300));
        check('hosted E4 rebuild fetched ZERO assets (delta = 0)',
          assetHitCount() - t4 === 0, 'delta=' + (assetHitCount() - t4));

        // E5: corrupted byte on the wire -> fail closed, worker never gets
        // the set, then a clean retry from scratch succeeds.
        await reloadPage(cdp);
        mode = 'corrupt:pyodide.asm.wasm';
        const t5 = assetHitCount();
        const e5 = await bootAndRun(cdp, 'E5', 'print("never")');
        check('hosted E5 corrupted asset -> integrity failure, fail closed',
          !e5.r.ok && /Python runtime asset integrity check failed: pyodide\.asm\.wasm \(sha256 mismatch\)/.test(e5.r.error || '')
          && e5.r.code === 'python_bootstrap_integrity',
          JSON.stringify(e5.r).slice(0, 300));
        check('hosted E5 acquisition stopped at the corrupt asset (sequential, no extra fetches)',
          assetHitCount() - t5 === 3, 'delta=' + (assetHitCount() - t5));
        mode = 'good';
        const e5b = await bootAndRun(cdp, 'E5b', 'print(7 * 6)');
        check('hosted E5b clean retry after corruption succeeds from scratch',
          e5b.r.ok && e5b.r.result.stdout.trim().endsWith('42'), JSON.stringify(e5b.r).slice(0, 200));

        // E6: stalled body -> bounded reader -> ACQUISITION stall error
        // (never an execution timeout), well inside the budget.
        await reloadPage(cdp);
        mode = 'stall:pyodide.asm.wasm';
        const e6 = await bootAndRun(cdp, 'E6', 'print("never")',
          { bootstrapBudgets: { assetMs: 30000, assetStallMs: 1500, bootstrapMs: 30000 } });
        check('hosted E6 stalled body -> ACQUISITION stall error (bounded reader)',
          !e6.r.ok && /Python runtime asset acquisition stalled: pyodide\.asm\.wasm \(no body progress for 1500ms\)/.test(e6.r.error || '')
          && e6.r.code === 'python_asset_timeout'
          && !/python execution timed out/.test(e6.r.error || ''),
          JSON.stringify(e6.r).slice(0, 300));
        check('hosted E6 stall failed promptly (per-asset stall budget, not the overall deadline)',
          e6.ms < 15000, 'elapsed=' + e6.ms + 'ms');
        mode = 'good';
        const e6b = await bootAndRun(cdp, 'E6b', 'print(40 + 2)');
        check('hosted E6b clean boot after a stalled acquisition',
          e6b.r.ok && e6b.r.result.stdout.trim().endsWith('42'), JSON.stringify(e6b.r).slice(0, 200));

        // E7: silent worker -> INITIALIZATION timeout; verified assets are
        // retained; the next (real) worker boots from cache with ZERO fetch,
        // even with the asset server DOWN.
        await evaluate(cdp, 'window.__f04cCrash()');
        await evaluate(cdp, 'window.__f04cSetWorkerSource("/* stalled worker: never replies */")');
        mode = 'down';
        const t7 = hits.length;
        const e7 = await bootAndRun(cdp, 'E7', 'print("never")',
          { bootstrapBudgets: { assetMs: 30000, assetStallMs: 5000, bootstrapMs: 1500 } });
        check('hosted E7 silent worker -> INITIALIZATION timeout wording',
          !e7.r.ok && /Python runtime initialization timed out after 1500ms/.test(e7.r.error || '')
          && !/python execution timed out/.test(e7.r.error || ''),
          JSON.stringify(e7.r).slice(0, 300));
        check('hosted E7 verified assets RETAINED after the init timeout',
          await evaluate(cdp, '!!window.__pyrt._assets && Object.keys(window.__pyrt._assets).length === ' + PY_MANIFEST.length) === true, '');
        check('hosted E7 init timeout fetched ZERO assets (served from the verified cache)',
          assetHitCount() - t7 === 0, 'delta=' + (assetHitCount() - t7));
        await evaluate(cdp, 'window.__f04cSetWorkerSource(window.__f04cWorkerSrc)');
        const t7b = assetHitCount();
        const e7b = await bootAndRun(cdp, 'E7b', 'print(21 * 2)');
        check('hosted E7b real worker boots from the retained cache (server still down)',
          e7b.r.ok && e7b.r.result.stdout.trim().endsWith('42'), JSON.stringify(e7b.r).slice(0, 200));
        check('hosted E7b zero asset requests during the recovery',
          assetHitCount() - t7b === 0, 'delta=' + (assetHitCount() - t7b));

        // E8: user execution keeps the untouched 30s budget.
        mode = 'good';
        const t8 = Date.now();
        const e8 = await bootAndRun(cdp, 'E8', 'while True: pass');
        // The execution timeout arrives as a RESOLVED result carrying the
        // error field (the kill path fails pending calls), not a rejection.
        const e8err = e8.r.ok ? (e8.r.result && e8.r.result.error) : e8.r.error;
        check('hosted E8 infinite loop -> EXACTLY the 30s user execution timeout',
          /python execution timed out after 30000ms/.test(e8err || '')
          && !/bootstrap|acquisition|initialization/.test(e8err || ''),
          JSON.stringify(e8.r).slice(0, 200));
        check('hosted E8 the execution budget ran in full (independent of bootstrap time)',
          Date.now() - t8 >= 29500, 'elapsed=' + (Date.now() - t8) + 'ms');
      } finally {
        try { cdp && cdp.close(); } catch (e) {}
        if (chrome) await closeChrome(chrome);
        if (profileDir) { try { await fs.rm(profileDir, { recursive: true, force: true }); } catch (e) {} }
      }
    }

    // ===================== FILE:// MODE =================================
    // A double-clicked dist/index.html is an opaque origin: WebCrypto subtle
    // must STILL be real there (no silent integrity skip) and the verified
    // acquisition + cache rebuild must behave identically.
    {
      let profileDir = null;
      let chrome = null;
      let cdp = null;
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'locus-f04c-filemode-'));
      try {
        const pageFile = path.join(tmpDir, 'f04c-file-page.html');
        await fs.writeFile(pageFile, buildPage(SHELL_URL, workerSrc, ASSETS + '/'));
        const fileUrl = require('url').pathToFileURL(pageFile).href;
        profileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'locus-f04c-fileprofile-'));
        chrome = await launchChrome(fileUrl, {
          chromePath: process.env.CHROME,
          label: 'F04c file Chrome',
          profileDir,
          extraArgs: ['--window-size=1280,800'],
        });
        await waitForCdp(chrome, { timeoutMs: 15000 });
        const target = await waitForPageTarget(chrome, fileUrl, { timeoutMs: 15000 });
        cdp = await connectToTarget(target);
        await waitForRuntimeCondition(cdp, '!!(window.__f04c && window.__f04c.ready && window.__pyrt)',
          { process: chrome, phase: 'f04c-file-boot', timeoutMs: 15000 });

        const subtleOk = await evaluate(cdp, '!!(window.crypto && crypto.subtle && typeof crypto.subtle.digest === "function")');
        check('file E0 crypto.subtle available on an opaque file:// origin', subtleOk === true, String(subtleOk));

        mode = 'good';
        const ft1 = assetHitCount();
        const e1 = await bootAndRun(cdp, 'file-E1', 'print(2 + 2)');
        check('file E1 cold boot from file://: verified acquisition + real Pyodide',
          e1.r.ok && e1.r.result.stdout.trim().endsWith('4'), JSON.stringify(e1.r).slice(0, 300));
        check('file E1 acquisition fetched exactly the pinned URLs',
          assetHitCount() - ft1 === PY_MANIFEST.length, 'delta=' + (assetHitCount() - ft1));

        const e2 = await bootAndRun(cdp, 'file-E2',
          "import pandas as pd\nprint('DF', int(pd.DataFrame({'a': [5, 6]}).a.sum()))");
        check('file E2 pandas compute on verified bytes from file://',
          e2.r.ok && /DF 11/.test(e2.r.result.stdout || ''), JSON.stringify(e2.r).slice(0, 300));

        const ft4 = assetHitCount();
        await evaluate(cdp, 'window.__f04cCrash()');
        mode = 'down';
        const e4 = await bootAndRun(cdp, 'file-E4', 'print(3 + 3)');
        check('file E4 crash rebuild with the server down succeeds (verified cache)',
          e4.r.ok && e4.r.result.stdout.trim().endsWith('6'), JSON.stringify(e4.r).slice(0, 300));
        check('file E4 rebuild fetched ZERO assets', assetHitCount() - ft4 === 0,
          'delta=' + (assetHitCount() - ft4));
      } finally {
        try { cdp && cdp.close(); } catch (e) {}
        if (chrome) await closeChrome(chrome);
        if (profileDir) { try { await fs.rm(profileDir, { recursive: true, force: true }); } catch (e) {} }
        try { await fs.rm(tmpDir, { recursive: true, force: true }); } catch (e) {}
      }
    }

    console.log('---');
    console.log('e2e-python-bootstrap: ' + passed + ' passed, ' + failed + ' failed');
    process.exitCode = failed ? 1 : 0;
  } catch (error) {
    console.error('F04C BOOTSTRAP E2E FAIL: ' + (error && error.stack || error));
    process.exitCode = 1;
  } finally {
    if (server) { try { await new Promise((r) => server.close(r)); } catch (e) {} }
  }
}

if (require.main === module) {
  main().catch((error) => { console.error(error && error.stack || error); process.exitCode = 1; });
}
