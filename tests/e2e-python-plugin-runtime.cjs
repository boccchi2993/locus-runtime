// Trusted Plugin Runtime v1A BROWSER e2e. Real headless Chrome, the REAL
// production runtime (the store's canonical instance from src/shell.js
// createPythonRuntime + the REAL py-worker-src
// from index.html), a real strict-CSP creator iframe, a real Pyodide 0.26.4
// boot and the REAL synthetic wheel from the Capability Package fixture --
// against local controllable servers:
//
//   verified wheel bytes (page-built, harness-configured)
//     -> strict-CSP Pyodide worker
//     -> OFFLINE wheel install (micropip + emfs: + deps=False)
//     -> declared import smoke test
//     -> READY
//     -> ordinary user Python: import locus_test_plugin; answer() == 42
//
// The oracle for every network claim is the servers' REQUEST COUNTERS:
//   - the asset server serves EXACTLY the pinned manifest names (harness
//     owned); the worker itself never fetches anything;
//   - a second probe server counts EVERY request -- it must stay at ZERO
//     across boots, resets, crashes and every post-READY escape probe.
//
//  E1  cold boot with a wheel payload: offline install + smoke + READY
//  E2  user Python imports the plugin; answer() == 42; pandas intact;
//      worker-local file compute untouched
//  E3  ORACLE: boot+run fetched exactly the pinned asset set; ZERO other
//      requests anywhere
//  R1  worker crash + asset server DOWN: rebuild reinstalls the plugin
//      from the configured payload (zero network; no plugin URL exists)
//  R2  runtime reset(): fresh worker, same configured payload, answer 42
//  C1  cancellation during the boot: boot aborts, no READY, clean rebuild
//  I2  declared size mismatch (1296 vs 1295) -> configureExtensions throws
//      BEFORE the boot send
//  I3  declared hash wrong -> worker integrity failure, no install, no
//      READY; recovery with the good payload
//  I4  bytes tampered under a correct declared hash -> integrity failure
//  I5  correct hash but not a wheel -> offline install failure, no READY
//  S2  declared import missing -> smoke failure, no READY; S3 recovery
//  L1  LEGACY source-file payload still boots and imports (explicitly
//      NOT Trusted Plugin Runtime artifact delivery)
//  U2  post-READY package authority: micropip remote install / index
//      install / local emfs install and pyodide.loadPackage* are all dead
//      with ZERO requests; F04a user network denial intact
// Run: node tests/e2e-python-plugin-runtime.cjs
const fs = require('fs/promises');
const http = require('http');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const {
  allocateFreePort, closeChrome, connectToTarget, launchChrome, waitForCdp,
  waitForPageTarget, waitForRuntimeCondition,
} = require('./helpers/chrome.cjs');
const { loadPythonManifest } = require('./helpers/python-manifest.cjs');

const { base: PYODIDE_CDN, manifest: PY_MANIFEST } = loadPythonManifest();
const ASSET_CACHE_DIR = path.join(__dirname, '..', 'tmp-f04b-probe', 'pyodide');
const WHEEL_PATH = path.join(__dirname, 'fixtures/capability-package/minimal',
  'plugins/locus-test-plugin/artifacts/locus_test_plugin-1.0.0-py3-none-any.whl');
const WHEEL_FILENAME = 'locus_test_plugin-1.0.0-py3-none-any.whl';

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
  try { return await fs.readFile(cached); } catch (e) { /* fall through to CDN */ }
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
// M3a: src/shell.js is an ES module, so the page loads it as ONE module
// ('/src/shell.js', served by this suite's own server straight from the
// repo's src/ tree). The old classic base trio (extension-composition.js,
// extensions.js) existed only to satisfy shell.js's classic-script global
// references; the ES module imports its own dependencies and owns its own
// RUNTIME_PLUGIN_ID_PATTERN, so the page imports ONLY createPythonRuntime.
// The CDN-redirect fetch patch and the driver are installed INSIDE the
// module; the readiness flags land at the end of it, exactly where the
// suite's polling expects them. The runtime itself is untouched production
// code.
function buildPage(shellModuleUrl, workerSrc, localAssets, wheelB64, wheelSha, wheelSize) {
  return '<!DOCTYPE html><html><head><meta charset="utf-8"><title>TPR v1A</title></head><body>'
    + '<script type="module">'
    + 'import { createPythonRuntime } from ' + JSON.stringify(shellModuleUrl) + ';'
    + 'var __nativeFetch = window.fetch.bind(window);'
    + 'var __cdnPrefix = ' + JSON.stringify(PYODIDE_CDN) + ';'
    + 'var __localAssets = ' + JSON.stringify(localAssets) + ';'
    + 'window.fetch = function (input, init) {'
    + '  var url = typeof input === "string" ? input : (input && input.url) || String(input);'
    + '  if (url.indexOf(__cdnPrefix) === 0) url = __localAssets + url.slice(__cdnPrefix.length);'
    + '  return __nativeFetch(url, init);'
    + '};'
    // M2a: the worker source is a runtime asset handed to the factory —
    // this page carries no #py-worker-src element.
    + 'window.__pyrt = createPythonRuntime({ pyWorkerSource: ' + JSON.stringify(workerSrc) + ' });'
    + 'window.__tpr = { ready: true, configError: null };'
    + 'function wheelBytes(tamper) {'
    + '  var bin = atob(' + JSON.stringify(wheelB64) + ');'
    + '  var bytes = new Uint8Array(bin.length);'
    + '  for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);'
    + '  if (tamper) bytes[7] ^= 0xa5;'
    + '  return bytes;'
    + '}'
    // M3a: the classic inline script made wheelBytes a page global; the
    // I3a probe evaluates it from outside the module, so publish it.
    + 'window.wheelBytes = wheelBytes;'
    + 'window.__tprWheelModule = function (overrides) {'
    + '  var m = { pluginId: "locus-test-plugin", imports: ["locus_test_plugin"], wheels: [{'
    + '    filename: ' + JSON.stringify(WHEEL_FILENAME) + ', format: "python-wheel",'
    + '    size: ' + JSON.stringify(wheelSize) + ', sha256: ' + JSON.stringify(wheelSha) + ','
    + '    bytes: wheelBytes(false) }] };'
    + '  if (overrides) for (var k in overrides) m[k] = overrides[k];'
    + '  return m;'
    + '};'
    + 'window.__tprConfigure = function (key, modules) {'
    + '  try { window.__pyrt.configureExtensions({ key: key, modules: modules }); return { ok: true }; }'
    + '  catch (e) { return { ok: false, error: String(e && e.message || e) }; }'
    + '};'
    + 'window.__tprConfigureGood = function () {'
    + '  return window.__tprConfigure("locus-test-plugin@1.0.0", [window.__tprWheelModule()]);'
    + '};'
    + 'window.__tprRun = function (code, opts) {'
    + '  return window.__pyrt.run(code, null, Object.assign({ cwd: "/tmp" }, opts || {}))'
    + '    .then(function (r) { return { ok: true, result: r }; },'
    + '      function (e) { return { ok: false, error: String(e && e.message || e), code: e && e.code }; });'
    + '};'
    + 'window.__tprAC = null;'
    + 'window.__tprRunAbortable = function (code) {'
    + '  window.__tprAC = new AbortController();'
    + '  return window.__pyrt.run(code, null, { cwd: "/tmp", signal: window.__tprAC.signal })'
    + '    .then(function (r) { return { ok: true, result: r }; },'
    + '      function (e) { return { ok: false, error: String(e && e.message || e), code: e && e.code }; });'
    + '};'
    + 'window.__tprAbort = function () {'
    + '  if (window.__tprAC) window.__tprAC.abort(new Error("python execution cancelled"));'
    + '};'
    + 'window.__tprCrash = function () { window.__pyrt._onWorkerFatal({ message: "simulated crash" }); };'
    + 'window.__tprReset = function () { window.__pyrt.reset(); };'
    + '<\/script>'
    + '</body></html>';
}

async function main() {
  let server;
  let probeServer;
  let passed = 0;
  let failed = 0;
  const check = (name, condition, detail) => {
    if (condition) { passed++; console.log('PASS ' + name); }
    else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + detail : '')); }
  };

  // ---- asset server (fault modes) + probe server (pure counter) ----------
  // mode: 'good' | 'down'
  let mode = 'good';
  let pageHtml = null;
  const assetBytes = new Map();
  const assetHits = [];
  const unauthorizedHits = [];
  const probeHits = [];
  const port = await allocateFreePort();
  const probePort = await allocateFreePort();
  const assetHitCount = () => assetHits.length;
  server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (u.pathname === '/tpr-page') {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(pageHtml);
      return;
    }
    // M3a: the module graph is served straight from the repo's src/ tree --
    // the page imports '/src/shell.js' and its relative imports (./vfs.js,
    // ./network.js, ./lib/utf8.js) resolve against the served /src/ URLs.
    // Served like the old /shell.js route: real page-loaded scripts, NOT
    // oracle-counted requests.
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
      assetHits.push({ name, t: Date.now() });
      const bytes = assetBytes.get(name);
      if (!bytes) { res.statusCode = 404; res.end('unknown asset'); return; }
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('cache-control', 'no-store'); // counters observe every fetch
      const entry = PY_MANIFEST.find((a) => a.name === name);
      if (mode === 'down') { res.statusCode = 503; res.end('asset server down'); return; }
      res.setHeader('content-type', entry.mime);
      res.setHeader('content-length', bytes.length);
      res.end(bytes);
      return;
    }
    // Chrome itself requests /favicon.ico for the page: browser noise, not a
    // runtime request. Serve it empty and keep it OUT of the oracle counts.
    if (u.pathname === '/favicon.ico') {
      res.statusCode = 204;
      res.end();
      return;
    }
    // EVERYTHING else is an unauthorized request by definition.
    unauthorizedHits.push({ path: u.pathname, t: Date.now() });
    res.statusCode = 404;
    res.end('not found');
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  probeServer = http.createServer((req, res) => {
    probeHits.push({ path: req.url, t: Date.now() });
    res.setHeader('content-type', 'text/plain');
    res.end('probe-hit');
  });
  await new Promise((r) => probeServer.listen(probePort, '127.0.0.1', r));
  const ASSETS = 'http://127.0.0.1:' + port + '/assets';
  const SHELL_URL = 'http://127.0.0.1:' + port + '/src/shell.js';

  const wheelBytesBuf = await fs.readFile(WHEEL_PATH);
  const wheelSha = crypto.createHash('sha256').update(wheelBytesBuf).digest('hex');
  const wheelSize = wheelBytesBuf.length;

  let profileDir = null;
  let chrome = null;
  let cdp = null;
  try {
    console.log('# loading pinned asset set (' + PY_MANIFEST.length
      + ' files, disk cache at ' + ASSET_CACHE_DIR + ' when present, CDN otherwise)');
    for (const a of PY_MANIFEST) assetBytes.set(a.name, await loadAsset(a.name));
    // M2a: the worker source comes from the runtime asset module.
    const workerSrc = require('./helpers/runtime.cjs').PY_WORKER_SOURCE;

    pageHtml = buildPage('/src/shell.js', workerSrc, ASSETS + '/',
      wheelBytesBuf.toString('base64'), wheelSha, wheelSize);
    const pageUrl = 'http://127.0.0.1:' + port + '/tpr-page';
    profileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'locus-tpr-profile-'));
    chrome = await launchChrome(pageUrl, {
      chromePath: process.env.CHROME,
      label: 'TPR v1A Chrome',
      profileDir,
      extraArgs: ['--window-size=1280,800'],
    });
    await waitForCdp(chrome, { timeoutMs: 15000 });
    const target = await waitForPageTarget(chrome, pageUrl, { timeoutMs: 15000 });
    cdp = await connectToTarget(target);
    await waitForRuntimeCondition(cdp, '!!(window.__tpr && window.__tpr.ready && window.__pyrt)',
      { process: chrome, phase: 'tpr-app-boot', timeoutMs: 15000 });

    // ---- E-series: cold boot with a wheel payload ----
    mode = 'good';
    const t1 = assetHitCount();
    check('E0 configureExtensions accepts the verified wheel payload',
      (await evaluate(cdp, 'window.__tprConfigureGood()')).ok === true, '');
    check('E0b extensionKey reflects the configured payload',
      (await evaluate(cdp, 'window.__pyrt.extensionKey()')) === 'locus-test-plugin@1.0.0', '');

    const e1 = await evaluate(cdp,
      'window.__tprRun("import locus_test_plugin\\nprint(\'ANSWER\', locus_test_plugin.answer())")', 240000);
    check('E1 cold boot: offline wheel install + smoke import + READY, python works',
      e1.ok && /ANSWER 42/.test(e1.result.stdout || '') && !e1.result.error,
      JSON.stringify(e1).slice(0, 300));
    console.log('# E1 stdout: ' + JSON.stringify((e1.result && e1.result.stdout || '').slice(-120)));

    const e2 = await evaluate(cdp,
      'window.__tprRun("import pandas as pd, json\\nimport locus_test_plugin\\nopen(\'/tmp/tpr-probe.txt\', \'w\').write(\'ok\')\\nprint(\'DF\', int(pd.DataFrame({\'a\': [2, 20]}).a.sum()))\\nprint(\'FILE\', open(\'/tmp/tpr-probe.txt\').read())\\nprint(\'JSON\', json.dumps({\'v\': 42}))")', 120000);
    check('E2 user phase: plugin + pandas + filesystem compute coexist',
      e2.ok && /DF 22/.test(e2.result.stdout || '') && /FILE ok/.test(e2.result.stdout || '')
      && /JSON \{"v": 42\}/.test(e2.result.stdout || ''),
      JSON.stringify(e2).slice(0, 300));

    const e1hits = assetHitCount() - t1;
    const assetNames = assetHits.slice(t1).map((h) => h.name).sort();
    check('E3 ORACLE boot fetched EXACTLY the pinned asset set, one fetch each',
      e1hits === PY_MANIFEST.length
      && JSON.stringify([...new Set(assetNames)]) === JSON.stringify(PY_MANIFEST.map((a) => a.name).sort()),
      'hits=' + e1hits + ' names=' + JSON.stringify(assetNames));
    check('E3b ORACLE ZERO unauthorized requests so far',
      unauthorizedHits.length === 0, JSON.stringify(unauthorizedHits.slice(0, 5)));
    check('E3c ORACLE probe server saw ZERO requests so far',
      probeHits.length === 0, JSON.stringify(probeHits.slice(0, 5)));

    // ---- I-series: integrity adversarial ----
    // I2: 1295 real wheel bytes declared as 1296 -> the trusted Harness
    // metadata/bytes invariant rejects BEFORE any boot send.
    const i2 = await evaluate(cdp,
      '(function () {'
      + '  var bin = atob(' + JSON.stringify(wheelBytesBuf.toString('base64')) + ');'
      + '  var bytes = new Uint8Array(bin.length - 1);'
      + '  for (var i = 0; i < bytes.length; i++) bytes[i] = bin.charCodeAt(i);'
      + '  try { window.__pyrt.configureExtensions({ key: "bad-size", modules: [{'
      + '    pluginId: "locus-test-plugin", imports: ["locus_test_plugin"], wheels: [{'
      + '    filename: ' + JSON.stringify(WHEEL_FILENAME) + ', format: "python-wheel",'
      + '    size: ' + wheelSize + ', sha256: ' + JSON.stringify(wheelSha) + ', bytes: bytes }] }] });'
      + '    return { ok: true };'
      + '  } catch (e) { return { ok: false, error: String(e && e.message || e) }; } })()', 30000);
    check('I2 1295 actual bytes vs 1296 declared -> configureExtensions throws pre-boot',
      i2.ok === false && /bytes\.byteLength 1295 != declared size 1296/.test(i2.error || ''),
      JSON.stringify(i2));
    check('I2b the rejected configuration never replaced the good payload',
      (await evaluate(cdp, 'window.__pyrt.extensionKey()')) === 'locus-test-plugin@1.0.0', '');

    mode = 'down'; // rebuilds below must come from the verified page cache only
    const badSha = 'f'.repeat(64);
    const i3a = await evaluate(cdp,
      'window.__tprConfigure("locus-test-plugin@badhash", [window.__tprWheelModule({ wheels: [{'
      + ' filename: ' + JSON.stringify(WHEEL_FILENAME) + ', format: "python-wheel",'
      + ' size: ' + wheelSize + ', sha256: "' + badSha + '", bytes: wheelBytes(false) }] })])', 30000);
    check('I3a wrong declared hash configures (shape is valid; digest is worker-checked)', i3a.ok === true, JSON.stringify(i3a));
    // The reconfigured payload only reaches a FRESH interpreter: the harness
    // contract is reset() -> rebuild -> install -> READY.
    await evaluate(cdp, 'window.__pyrt.reset(); "reset"', 15000);
    const i3boot = await evaluate(cdp,
      'window.__tprRun("print(\'never\')")', 240000);
    check('I3b declared hash wrong -> worker integrity failure, no install, no READY',
      !i3boot.ok && /artifact sha256 mismatch: plugin locus-test-plugin, artifact /.test(i3boot.error || ''),
      JSON.stringify(i3boot).slice(0, 300));

    await evaluate(cdp,
      'window.__tprConfigure("locus-test-plugin@tampered", [window.__tprWheelModule({ wheels: [{'
      + ' filename: ' + JSON.stringify(WHEEL_FILENAME) + ', format: "python-wheel",'
      + ' size: ' + wheelSize + ', sha256: ' + JSON.stringify(wheelSha) + ', bytes: wheelBytes(true) }] })])', 30000);
    await evaluate(cdp, 'window.__pyrt.reset(); "reset"', 15000);
    const i4boot = await evaluate(cdp, 'window.__tprRun("print(\'never\')")', 240000);
    check('I4 tampered bytes under a correct declared hash -> integrity failure',
      !i4boot.ok && /artifact sha256 mismatch/.test(i4boot.error || ''),
      JSON.stringify(i4boot).slice(0, 300));

    // I5: bytes whose own sha256 IS declared (identity valid) but which are
    // not a wheel: Package Core identity is NOT installability.
    const garbage = crypto.randomBytes(wheelSize);
    const garbageB64 = garbage.toString('base64');
    const garbageSha = crypto.createHash('sha256').update(garbage).digest('hex');
    await evaluate(cdp,
      'window.__garbage = "' + garbageB64 + '"; window.__garbageSha = "' + garbageSha + '"; "set"', 30000);
    const i5cfg = await evaluate(cdp,
      '(function () {'
      + '  var bin = atob(window.__garbage);'
      + '  var bytes = new Uint8Array(bin.length);'
      + '  for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);'
      + '  try { window.__pyrt.configureExtensions({ key: "locus-test-plugin@garbage", modules: [{'
      + '    pluginId: "locus-test-plugin", imports: ["locus_test_plugin"], wheels: [{'
      + '    filename: ' + JSON.stringify(WHEEL_FILENAME) + ', format: "python-wheel",'
      + '    size: bytes.byteLength, sha256: window.__garbageSha, bytes: bytes }] }] });'
      + '    return { ok: true }; } catch (e) { return { ok: false, error: String(e && e.message || e) }; } })()', 30000);
    await evaluate(cdp, 'window.__pyrt.reset(); "reset"', 15000);
    const i5boot = await evaluate(cdp, 'window.__tprRun("print(\'never\')")', 240000);
    check('I5 identity-valid bytes that are NOT a wheel -> offline install failure, no READY',
      i5cfg.ok === true && !i5boot.ok
        && /offline wheel install failed: plugin locus-test-plugin/.test(i5boot.error || '')
        && !/sha256 mismatch/.test(i5boot.error || ''),
      JSON.stringify(i5boot).slice(0, 400));

    // ---- S-series: smoke import adversarial + recovery ----
    const s2cfg = await evaluate(cdp,
      'window.__tprConfigure("locus-test-plugin@badimport", [window.__tprWheelModule({ imports: ["module_that_does_not_exist_7f91"] })])', 30000);
    await evaluate(cdp, 'window.__pyrt.reset(); "reset"', 15000);
    const s2boot = await evaluate(cdp, 'window.__tprRun("print(\'never\')")', 240000);
    check('S2 declared import missing -> smoke failure, no READY (install may have succeeded)',
      s2cfg.ok === true && !s2boot.ok
        && /smoke import failed for module_that_does_not_exist_7f91/.test(s2boot.error || ''),
      JSON.stringify(s2boot).slice(0, 300));

    // ---- recovery with the good payload ----
    const s3cfg = await evaluate(cdp, 'window.__tprConfigureGood()', 30000);
    await evaluate(cdp, 'window.__pyrt.reset(); "reset"', 15000);
    const s3 = await evaluate(cdp,
      'window.__tprRun("import locus_test_plugin\\nprint(\'ANSWER\', locus_test_plugin.answer())")', 240000);
    check('S3 recovery: good payload re-boots after every adversarial failure',
      s3cfg.ok === true && s3.ok && /ANSWER 42/.test(s3.result.stdout || ''),
      JSON.stringify(s3).slice(0, 200));

    // ---- R-series: crash + reset rebuild from the configured payload ----
    const r1AssetsBefore = assetHitCount();
    await evaluate(cdp, 'window.__tprCrash(); "crashed"', 15000);
    const r1 = await evaluate(cdp,
      'window.__tprRun("import locus_test_plugin\\nprint(\'ANSWER\', locus_test_plugin.answer())")', 240000);
    check('R1 crash rebuild (asset server DOWN): wheel reinstalled from the configured payload',
      r1.ok && /ANSWER 42/.test(r1.result.stdout || ''), JSON.stringify(r1).slice(0, 250));
    check('R1b rebuild fetched ZERO assets (page-session verified cache; no plugin URL exists)',
      assetHitCount() - r1AssetsBefore === 0, 'delta=' + (assetHitCount() - r1AssetsBefore));

    await evaluate(cdp, 'window.__tprReset(); "reset"', 15000);
    const r2 = await evaluate(cdp,
      'window.__tprRun("import locus_test_plugin\\nprint(\'ANSWER\', locus_test_plugin.answer())")', 240000);
    check('R2 reset(): fresh worker, same configured payload, ordinary import works',
      r2.ok && /ANSWER 42/.test(r2.result.stdout || ''), JSON.stringify(r2).slice(0, 250));
    check('R2b ORACLE still ZERO unauthorized + ZERO probe requests',
      unauthorizedHits.length === 0 && probeHits.length === 0,
      JSON.stringify({ unauthorized: unauthorizedHits.slice(0, 3), probe: probeHits.slice(0, 3) }));

    // ---- C-series: cancellation during boot ----
    await evaluate(cdp, 'window.__tprCrash(); "crashed"', 15000);
    const c1promise = evaluate(cdp,
      'window.__tprRunAbortable("print(\'never\')")', 240000);
    await new Promise((r) => setTimeout(r, 700)); // mid-boot (pandas still loading)
    await evaluate(cdp, 'window.__tprAbort(); "aborted"', 15000);
    const c1 = await c1promise;
    check('C1 cancellation during the boot: run cancels, worker killed',
      !c1.ok && /cancelled/i.test(c1.error || ''), JSON.stringify(c1).slice(0, 250));
    check('C1b no half-ready worker after the abort',
      ['cold'].includes(await evaluate(cdp, 'window.__pyrt.status')),
      'status=' + JSON.stringify(await evaluate(cdp, 'window.__pyrt.status')));
    const c1b = await evaluate(cdp,
      'window.__tprRun("import locus_test_plugin\\nprint(\'ANSWER\', locus_test_plugin.answer())")', 240000);
    check('C1c clean rebuild after cancellation answers 42 (no late zombie READY)',
      c1b.ok && /ANSWER 42/.test(c1b.result.stdout || ''), JSON.stringify(c1b).slice(0, 250));

    // ---- L-series: LEGACY source path still works ----
    const l1cfg = await evaluate(cdp,
      'window.__tprConfigure("synthetic-python-plugin@1", [{ pluginId: "synthetic-python-plugin",'
      + ' files: { "locus_legacy_probe.py": "def probe():\\n    return 7\\n" }, imports: ["locus_legacy_probe"] }])', 30000);
    await evaluate(cdp, 'window.__pyrt.reset(); "reset"', 15000);
    const l1 = await evaluate(cdp,
      'window.__tprRun("import locus_legacy_probe\\nprint(\'LEGACY\', locus_legacy_probe.probe())")', 240000);
    check('L1 LEGACY source-file payload still boots and imports (not TPR delivery)',
      l1cfg.ok === true && l1.ok && /LEGACY 7/.test(l1.result.stdout || ''),
      JSON.stringify(l1).slice(0, 250));

    // ---- U-series: post-READY package authority ----
    // Re-establish the wheel payload interpreter for the authority probes.
    await evaluate(cdp, 'window.__tprConfigureGood()', 30000);
    await evaluate(cdp, 'window.__pyrt.reset(); "reset"', 15000);
    const u0 = await evaluate(cdp,
      'window.__tprRun("import locus_test_plugin\\nprint(\'ANSWER\', locus_test_plugin.answer())")', 240000);
    check('U0 wheel-payload interpreter live for the authority probes',
      u0.ok && /ANSWER 42/.test(u0.result.stdout || ''), JSON.stringify(u0).slice(0, 200));

    const u1 = await evaluate(cdp, 'window.__tprRun(' + JSON.stringify(
      'import micropip\n'
      + 'try:\n'
      + '    await micropip.install("https://127.0.0.1:' + probePort + '/probe-hit", deps=False)\n'
      + '    print("MICROPIP-REMOTE ALLOWED")\n'
      + 'except Exception as ex:\n'
      + '    print("MICROPIP-REMOTE blocked:", type(ex).__name__)\n'
      + 'try:\n'
      + '    await micropip.install(["regex"])\n'
      + '    print("MICROPIP-INDEX ALLOWED")\n'
      + 'except Exception as ex:\n'
      + '    print("MICROPIP-INDEX blocked:", type(ex).__name__)\n'
      + 'try:\n'
      + '    await micropip.install("emfs:/mnt/workspace/evil.whl", deps=False)\n'
      + '    print("MICROPIP-LOCAL ALLOWED")\n'
      + 'except Exception as ex:\n'
      + '    print("MICROPIP-LOCAL blocked:", type(ex).__name__)\n'
      + 'import pyodide\n'
      + 'try:\n'
      + '    await pyodide.loadPackage("regex")\n'
      + '    print("LOADPKG ALLOWED")\n'
      + 'except Exception as ex:\n'
      + '    print("LOADPKG blocked")\n'
      + 'try:\n'
      + '    await pyodide.loadPackagesFromImports("import regex")\n'
      + '    print("LOADIMPORTS ALLOWED")\n'
      + 'except Exception as ex:\n'
      + '    print("LOADIMPORTS blocked")\n'
      + 'try:\n'
      + '    import js\n'
      + '    await js.fetch("https://127.0.0.1:' + probePort + '/probe-hit")\n'
      + '    print("JSFETCH ALLOWED")\n'
      + 'except Exception as ex:\n'
      + '    print("JSFETCH blocked")\n'
      + 'import locus_test_plugin\n'
      + 'print("ANSWER", locus_test_plugin.answer())\n') + ')', 120000);
    const u1out = (u1.ok && u1.result.stdout || '');
    check('U2 micropip remote URL install dead (zero requests)',
      /MICROPIP-REMOTE blocked/.test(u1out), JSON.stringify(u1out.slice(-600)));
    check('U2b micropip index/repodata install dead post-READY (installer retired)',
      /MICROPIP-INDEX blocked/.test(u1out), JSON.stringify(u1out.slice(-600)));
    check('U2c micropip local emfs install dead post-READY (installer retired)',
      /MICROPIP-LOCAL blocked/.test(u1out), JSON.stringify(u1out.slice(-600)));
    check('U2d pyodide.loadPackage denied post-READY',
      /LOADPKG blocked/.test(u1out), JSON.stringify(u1out.slice(-600)));
    check('U2e pyodide.loadPackagesFromImports denied post-READY',
      /LOADIMPORTS blocked/.test(u1out), JSON.stringify(u1out.slice(-600)));
    check('U2f F04a js.fetch denial intact with a live plugin runtime',
      /JSFETCH blocked/.test(u1out), JSON.stringify(u1out.slice(-600)));
    check('U2g plugin still importable after every authority probe',
      /ANSWER 42/.test(u1out), JSON.stringify(u1out.slice(-200)));
    await new Promise((r) => setTimeout(r, 1500)); // settle stragglers
    check('U2h ORACLE probe server saw ZERO requests across every escape attempt',
      probeHits.length === 0, JSON.stringify(probeHits.slice(0, 5)));
    check('U2i ORACLE ZERO unauthorized requests across the whole session',
      unauthorizedHits.length === 0, JSON.stringify(unauthorizedHits.slice(0, 5)));

    console.log('---');
    console.log('e2e-python-plugin-runtime: ' + passed + ' passed, ' + failed + ' failed');
    process.exitCode = failed ? 1 : 0;
  } catch (error) {
    console.error('TPR PLUGIN RUNTIME E2E FAIL: ' + (error && error.stack || error));
    process.exitCode = 1;
  } finally {
    try { cdp && cdp.close(); } catch (e) {}
    if (chrome) await closeChrome(chrome);
    if (profileDir) { try { await fs.rm(profileDir, { recursive: true, force: true }); } catch (e) {} }
    if (server) { try { await new Promise((r) => server.close(r)); } catch (e) {} }
    if (probeServer) { try { await new Promise((r) => probeServer.close(r)); } catch (e) {} }
  }
}

if (require.main === module) {
  main().catch((error) => { console.error(error && error.stack || error); process.exitCode = 1; });
}
