// Python bootstrap integrity + lifecycle tests (F04c). Like the authority
// suites, these drive the REAL shell.js module — the shipped artifact, not
// a mock. Two variants of the module are loaded:
//
//   REAL  — the untouched source: manifest structure, URL derivation,
//           budget constants, and the pandas dependency closure against
//           the pinned pyodide-lock.json snapshot (tests/fixtures/).
//   TEST  — the same module with ONLY the manifest's size/sha256 values
//           rewritten to match tiny synthetic bytes (via the documented
//           TEST-ONLY bootstrapManifest construction seam), so the full
//           acquisition pipeline (bounded raw reads, digest, cache,
//           aborts, deadlines) runs deterministically offline at byte
//           level. Names, order, kinds and mimes stay identical to the
//           real manifest.
//
//  M0    manifest structure: 10 pinned entries, exact names, hashes, sizes
//  M1    core set + package-wheel set partition the manifest exactly
//  M2    budgets: PYTHON_TIMEOUT_MS = 30000 stays USER EXECUTION ONLY;
//        acquisition/initialization constants exist and are independent
//  M3    pandas dependency closure == declared package set (lockfile snapshot)
//  I1    good set: 12/12 verified -> loader resolves, cache written,
//        every fetch URL is exactly PYODIDE_BASE + manifest name
//  I2    one byte modified -> sha256 mismatch, fail closed, worker never
//        receives bootstrap, retry from scratch works
//  I3    truncated body -> exact-size failure
//  I4    oversized body -> bounded reader stops early and cancels
//  I5    wrong asset under the correct filename -> hash mismatch
//  I6    HTTP failure -> asset-unavailable category
//  I7    stalled body -> stall timeout, a LATE fetch completion cannot
//        mutate the cache or runtime state
//  I8    cancel during acquisition -> cancelled, no cache, clean retry
//  I9    partial 9/10 success + one failure -> NO partial cache
//  I10   user input cannot vary bootstrap URLs (manifest-derived only)
//  T2    asset stall beyond deadline -> ACQUISITION timeout wording,
//        never "python execution timed out"
//  T3    worker boot stall -> INITIALIZATION timeout wording; verified
//        assets are retained and the rebuild never re-downloads
//  T5    budgets independent: a slow acquisition does not eat the
//        initialization budget (init clock pauses)
//  T6    queued concurrent runs boot once; a post-crash rebuild reuses
//        the verified cache (zero network)
// Run: node tests/python-bootstrap-integrity.test.cjs

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + detail : '')); }
}

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'shell.js'), 'utf8');

// ---------- module loading ------------------------------------------------

// M3a: the REAL module is the shipped ES module itself (it exports every
// name the old eval'd REAL carried); the suite keeps reading the source
// text only for the SRC text assertions below.
const REAL = require('../src/shell.js');

// ---------- TEST manifest: synthetic bytes under real names ----------------

const cryptoNode = require('crypto');
globalThis.crypto = cryptoNode.webcrypto; // the loader's sha256Available() gate

const syntheticBytes = {};
for (const entry of REAL.PYTHON_BOOTSTRAP_MANIFEST) {
  syntheticBytes[entry.name] = new TextEncoder().encode('synthetic:' + entry.name + ':'
    + 'x'.repeat(entry.size % 97));
}
const syntheticMeta = {};
for (const [name, bytes] of Object.entries(syntheticBytes)) {
  syntheticMeta[name] = {
    size: bytes.length,
    sha256: cryptoNode.createHash('sha256').update(bytes).digest('hex'),
  };
}
// The synthetic manifest: built from the REAL manifest exactly as the old
// source-rewrite built it — SAME name/kind/mime, ONLY size/sha256 replaced
// with the synthetic byte identity.
const SYNTHETIC_MANIFEST = Object.freeze(REAL.PYTHON_BOOTSTRAP_MANIFEST.map((entry) => ({
  name: entry.name,
  kind: entry.kind,
  mime: entry.mime,
  size: syntheticMeta[entry.name].size,
  sha256: syntheticMeta[entry.name].sha256,
})));
// M3a: the TEST variant goes through the documented TEST-ONLY
// `bootstrapManifest` construction seam — a per-instance manifest override
// (URLs still derive from PYODIDE_BASE + entry.name) — instead of a
// rewritten second copy of the module source.
const TEST = {
  PYODIDE_BASE: REAL.PYODIDE_BASE,
  PYTHON_BOOTSTRAP_MANIFEST: SYNTHETIC_MANIFEST,
  pythonBootstrapBudgets: REAL.pythonBootstrapBudgets,
  makeBudgetClock: REAL.makeBudgetClock,
  readBodyBounded: REAL.readBodyBounded,
  createPythonRuntime: (opts) => REAL.createPythonRuntime(Object.assign({ bootstrapManifest: SYNTHETIC_MANIFEST }, opts)),
};

// ---------- fake fetch plumbing ---------------------------------------------

// Serves TEST-manifest-correct bytes for every pinned name by default;
// overrides[name] (fn -> Response | promise thereof) replaces one asset.
// A fetch whose override never resolves stays pending until the boot's
// abort signal rejects it — and a LATE override resolution is dropped,
// exactly like a real late CDN response after an abort.
function installFakeFetch(overrides, log) {
  return function fetch(url, opts) {
    const entry = { url: String(url), aborted: false, settleLate: null };
    log.push('fetch:' + url);
    return new Promise((resolve, reject) => {
      let settled = false;
      const signal = opts && opts.signal;
      const onAbort = () => {
        if (settled) return;
        settled = true;
        entry.aborted = true;
        reject(signal && signal.reason ? signal.reason : Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
      };
      if (signal) {
        if (signal.aborted) return onAbort();
        signal.addEventListener('abort', onAbort, { once: true });
      }
      const name = String(url).slice(TEST.PYODIDE_BASE.length);
      const override = overrides && overrides[name];
      const produce = override
        ? Promise.resolve().then(() => override())
        : Promise.resolve(new Response(syntheticBytes[name]));
      produce.then(
        (res) => { if (!settled) { settled = true; if (signal) signal.removeEventListener('abort', onAbort); resolve(res); } },
        (e) => { if (!settled) { settled = true; if (signal) signal.removeEventListener('abort', onAbort); reject(e); } });
      entry.settleLate = (res) => { if (!settled) { settled = true; if (signal) signal.removeEventListener('abort', onAbort); resolve(res); } };
    });
  };
}

// M1b: instances come from the factory — every mutable field
// (assets/boot/creator/pending/queue/extensions/disposed) is initialized
// per instance, so no manual state reset is needed (or possible to get
// wrong: two freshRuntime() calls can never share Maps/Sets/queues).
function freshRuntime(mod) {
  const { freshRuntime } = require('./helpers/runtime.cjs');
  return freshRuntime(mod);
}

const errText = (e) => String(e && e.message ? e.message : e);
const idleBoot = () => ({ ac: new AbortController(), fail: () => {}, reason: () => null });

// Installs the fake fetch + minimal DOM stubs, runs body, restores.
function withBrowserStubs(body) {
  global.window = { location: { protocol: 'https:' }, addEventListener: () => {} };
  global.document = { getElementById: () => null };
  return Promise.resolve()
    .then(body)
    .finally(() => { delete global.window; delete global.document; });
}

async function expectReject(name, promise, predicate, detail) {
  try {
    await promise;
    check(name, false, 'resolved but should have rejected' + (detail ? ' | ' + detail : ''));
  } catch (e) {
    check(name, predicate(e), errText(e));
  }
}

// A ReadableStream that emits fixed-size chunks forever, counting pulls and
// cancellations (used by I4).
function endlessChunkStream(chunkSize) {
  const state = { pulls: 0, cancels: 0 };
  const stream = new ReadableStream({
    pull(controller) {
      state.pulls++;
      controller.enqueue(new Uint8Array(chunkSize).fill(65));
      if (state.pulls > 5000) controller.close(); // safety net only
    },
    cancel() { state.cancels++; },
  });
  return { stream, state };
}

async function run() {
  // ================= M0: manifest structure (REAL source) =================
  const man = REAL.PYTHON_BOOTSTRAP_MANIFEST;
  const names = man.map((a) => a.name);
  check('M0 manifest holds exactly the pinned 12 assets',
    man.length === 12
    && JSON.stringify(names) === JSON.stringify([
      'pyodide.js', 'pyodide.asm.js', 'pyodide.asm.wasm', 'pyodide-lock.json', 'python_stdlib.zip',
      'pandas-2.2.0-cp312-cp312-pyodide_2024_0_wasm32.whl',
      'numpy-1.26.4-cp312-cp312-pyodide_2024_0_wasm32.whl',
      'python_dateutil-2.9.0.post0-py2.py3-none-any.whl',
      'six-1.16.0-py2.py3-none-any.whl',
      'pytz-2024.1-py2.py3-none-any.whl',
      'micropip-0.6.0-py3-none-any.whl',
      'packaging-23.2-py3-none-any.whl',
    ]), JSON.stringify(names));
  check('M0 manifest is frozen (no runtime mutation)', Object.isFrozen(man), '');
  check('M0 every entry: kind, mime, exact size, lowercase sha256, unique',
    man.every((a) => (a.kind === 'text' || a.kind === 'bytes')
      && typeof a.mime === 'string' && a.mime.length > 0
      && Number.isInteger(a.size) && a.size > 0
      && /^[0-9a-f]{64}$/.test(a.sha256))
    && new Set(names).size === 12, JSON.stringify(man.map((a) => [a.name, a.kind, a.size])));
  check('M0 pinned CDN base is the exact jsDelivr v0.26.4 full/ URL',
    REAL.PYODIDE_BASE === 'https://cdn.jsdelivr.net/pyodide/v0.26.4/full/', REAL.PYODIDE_BASE);

  // ================= M1: core + package + installer partition ==============
  const coreNames = REAL.PYTHON_BOOTSTRAP_CORE_ASSETS;
  const pkgNames = REAL.PYTHON_RUNTIME_PACKAGE_FILES;
  const installerNames = REAL.PYTHON_INSTALLER_SUPPORT_FILES;
  check('M1 core (5) + runtime packages (5) + installer support (2) partition the manifest exactly',
    coreNames.length === 5 && pkgNames.length === 5 && installerNames.length === 2
    && new Set([...coreNames, ...pkgNames, ...installerNames]).size === 12
    && names.every((n) => coreNames.includes(n) || pkgNames.includes(n) || installerNames.includes(n))
    && Object.isFrozen(installerNames),
    JSON.stringify([coreNames, pkgNames, installerNames]));
  check('M1b installer support wheels are NOT the pandas closure and NOT plugin payload',
    installerNames.every((n) => !pkgNames.includes(n))
    && !names.some((n) => n.startsWith('locus_test_plugin')),
    JSON.stringify(installerNames));

  // ================= M2: budgets ===========================================
  check('M2 PYTHON_TIMEOUT_MS stays 30000 (USER EXECUTION ONLY)',
    REAL.PYTHON_TIMEOUT_MS === 30000 && SRC.includes('const PYTHON_TIMEOUT_MS = 30000;'),
    String(REAL.PYTHON_TIMEOUT_MS));
  check('M2 bootstrap budgets are separate bounded constants',
    REAL.PYTHON_ASSET_TIMEOUT_MS > 0 && REAL.PYTHON_ASSET_TIMEOUT_MS !== 30000
    && REAL.PYTHON_ASSET_STALL_MS > 0 && REAL.PYTHON_ASSET_STALL_MS <= REAL.PYTHON_ASSET_TIMEOUT_MS
    && REAL.PYTHON_BOOTSTRAP_TIMEOUT_MS > 0 && REAL.PYTHON_BOOTSTRAP_TIMEOUT_MS !== 30000,
    JSON.stringify([REAL.PYTHON_ASSET_TIMEOUT_MS, REAL.PYTHON_ASSET_STALL_MS, REAL.PYTHON_BOOTSTRAP_TIMEOUT_MS]));
  const b = REAL.pythonBootstrapBudgets({ assetMs: 5, assetStallMs: 4, bootstrapMs: 6 });
  const bDflt = REAL.pythonBootstrapBudgets(null);
  check('M2 budget helper: test overrides honored, production defaults pinned',
    b.assetMs === 5 && b.assetStallMs === 4 && b.bootstrapMs === 6
    && bDflt.assetMs === REAL.PYTHON_ASSET_TIMEOUT_MS
    && bDflt.bootstrapMs === REAL.PYTHON_BOOTSTRAP_TIMEOUT_MS,
    JSON.stringify([b.assetMs, bDflt.assetMs, bDflt.bootstrapMs]));
  check('M2 budget clock pauses and resumes (the independence primitive)', (() => {
    const c = REAL.makeBudgetClock(100000);
    const busy = Date.now();
    while (Date.now() - busy < 60) {} // burn ~60ms of counted budget
    const before = c.remaining();
    c.pause();
    const pausedRemaining = c.remaining();
    const busy2 = Date.now();
    while (Date.now() - busy2 < 60) {} // paused wall time must NOT count
    const afterPause = c.remaining();
    c.resume();
    const busy3 = Date.now();
    while (Date.now() - busy3 < 30) {} // resumed wall time counts again
    const afterResume = c.remaining();
    return Math.abs(before - pausedRemaining) < 5
      && Math.abs(afterPause - pausedRemaining) < 5
      && afterResume < pausedRemaining - 20;
  })(), '');

  // ================= M3: dependency closures (offline snapshot) ============
  const snap = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'pyodide-lock-snapshot.json'), 'utf8'));
  check('M3 snapshot is of the SAME lockfile the manifest pins',
    snap.lockfile.sha256 === man.find((a) => a.name === 'pyodide-lock.json').sha256,
    JSON.stringify([snap.lockfile.sha256, man.find((a) => a.name === 'pyodide-lock.json').sha256]));
  check('M3 snapshot provenance: pyodide v0.26.4, abi 2024_0, wasm32/emscripten',
    snap.lockfile.version === '0.26.4' && snap.lockfile.abi === '2024_0'
    && snap.lockfile.arch === 'wasm32' && snap.lockfile.platform === 'emscripten_3_1_58',
    JSON.stringify(snap.lockfile));
  const closureFiles = Object.values(snap.closure).map((p) => p.file_name).sort();
  check('M3 pandas dependency closure == declared runtime package wheel set EXACTLY',
    JSON.stringify(closureFiles) === JSON.stringify([...pkgNames].sort()),
    JSON.stringify(closureFiles));
  let closureHashesOk = true;
  for (const [, p] of Object.entries(snap.closure)) {
    const entry = man.find((a) => a.name === p.file_name);
    if (!entry || entry.sha256 !== p.sha256) closureHashesOk = false;
  }
  check('M3 every closure wheel hash matches the manifest pin', closureHashesOk,
    JSON.stringify(Object.entries(snap.closure).map(([k, v]) => [k, v.version, v.sha256.slice(0, 12)])));
  const lockPackages = Object.keys(snap.closure);
  check('M3 closure walks pandas -> numpy/dateutil/pytz -> six with no extras',
    lockPackages.length === 5 && lockPackages.includes('pandas') && lockPackages.includes('numpy')
    && lockPackages.includes('python-dateutil') && lockPackages.includes('six') && lockPackages.includes('pytz')
    && JSON.stringify(snap.closure.pandas.depends.sort()) === JSON.stringify(['numpy', 'python-dateutil', 'pytz'])
    && JSON.stringify(snap.closure['python-dateutil'].depends) === JSON.stringify(['six'])
    && snap.closure.numpy.depends.length === 0 && snap.closure.six.depends.length === 0
    && snap.closure.pytz.depends.length === 0,
    JSON.stringify(lockPackages));
  // TPR v1A: the trusted wheel installer closure (micropip) is pinned with
  // the same rigor, from the SAME lockfile bytes.
  const installerPackages = Object.keys(snap.installerClosure || {});
  check('M3b installer closure walks micropip -> packaging with no extras',
    installerPackages.length === 2 && installerPackages.includes('micropip') && installerPackages.includes('packaging')
    && JSON.stringify(snap.installerClosure.micropip.depends) === JSON.stringify(['packaging'])
    && snap.installerClosure.packaging.depends.length === 0,
    JSON.stringify(snap.installerClosure));
  const installerFiles = Object.values(snap.installerClosure || {}).map((p) => p.file_name).sort();
  check('M3b installer closure == declared installer support wheel set EXACTLY',
    JSON.stringify(installerFiles) === JSON.stringify([...installerNames].sort()),
    JSON.stringify([installerFiles, [...installerNames].sort()]));
  let installerHashesOk = true;
  for (const [, p] of Object.entries(snap.installerClosure || {})) {
    const entry = man.find((a) => a.name === p.file_name);
    if (!entry || entry.sha256 !== p.sha256) installerHashesOk = false;
  }
  check('M3b every installer closure wheel hash matches the manifest pin', installerHashesOk,
    JSON.stringify(Object.entries(snap.installerClosure || {}).map(([k, v]) => [k, v.version, v.sha256.slice(0, 12)])));

  // ================= I1: good set ==========================================
  {
    const rt = freshRuntime(TEST);
    const log = [];
    await withBrowserStubs(async () => {
      global.fetch = installFakeFetch(null, log);
      const assets = await rt._loadAssets(null, idleBoot(), TEST.pythonBootstrapBudgets(null));
      const got = Object.keys(assets);
      check('I1 good set resolves 12/12', got.length === 12 && got.every((n) => names.includes(n)),
        JSON.stringify(got));
      check('I1 cache written only after full verification', rt._assets === assets && Object.keys(rt._assets).length === 12, '');
      check('I1 text assets decoded (only after integrity PASS), bytes as ArrayBuffer',
        typeof assets['pyodide.js'].text === 'string'
        && assets['pyodide.js'].text === new TextDecoder().decode(syntheticBytes['pyodide.js'])
        && assets['pyodide.asm.wasm'].buffer instanceof ArrayBuffer
        && Buffer.from(assets['pyodide.asm.wasm'].buffer).equals(syntheticBytes['pyodide.asm.wasm']),
        JSON.stringify(Object.entries(assets).map(([k, v]) => [k, typeof v.text === 'string' ? 'text' : 'bytes'])));
      check('I1 asset cache reused on the next call with ZERO fetches',
        log.length === 12
        && (await rt._loadAssets(null, idleBoot(), TEST.pythonBootstrapBudgets(null))) === assets
        && log.length === 12, 'fetches=' + log.length);
    });
  }

  // ---------- shared failure-mode runner ------------------------------------
  function makeRig(overrides) {
    const rt = freshRuntime(TEST);
    const log = [];
    const postLog = [];
    rt._postToWorker = (msg) => postLog.push(msg);
    return { rt, postLog, start: () => { global.fetch = installFakeFetch(overrides, log); return rt; }, log };
  }

  // ================= I2: one byte modified =================================
  await withBrowserStubs(async () => {
    const rig = makeRig({
      'pyodide.asm.wasm': () => {
        const bytes = syntheticBytes['pyodide.asm.wasm'].slice();
        bytes[3] ^= 0xff;
        return new Response(bytes);
      },
    });
    rig.start();
    let err = null;
    try { await rig.rt._loadAssets(null, idleBoot(), TEST.pythonBootstrapBudgets(null)); } catch (e) { err = e; }
    check('I2 one modified byte -> integrity failure, fail closed',
      !!err && /integrity check failed: pyodide\.asm\.wasm \(sha256 mismatch\)/.test(errText(err))
      && err.code === 'python_bootstrap_integrity', errText(err));
    check('I2 mismatched bytes never cached', rig.rt._assets === null, '');
    check('I2 worker never receives bootstrap after a mismatch',
      rig.postLog.every((m) => m.cmd !== 'bootstrap'), JSON.stringify(rig.postLog.map((m) => m.cmd)));
    // A clean retry from scratch must work (no poisoned state).
    global.fetch = installFakeFetch(null, []);
    let retryErr = null;
    let retry = null;
    try { retry = await rig.rt._loadAssets(null, idleBoot(), TEST.pythonBootstrapBudgets(null)); } catch (e) { retryErr = e; }
    check('I2 clean retry after mismatch succeeds from scratch',
      !retryErr && !!retry && rig.rt._assets === retry, errText(retryErr));
  });

  // ================= I3: truncated body ====================================
  await withBrowserStubs(async () => {
    const rig = makeRig({
      'python_stdlib.zip': () => new Response(syntheticBytes['python_stdlib.zip'].slice(0, -4)),
    });
    rig.start();
    await expectReject('I3 truncated body -> exact-size integrity failure',
      rig.rt._loadAssets(null, idleBoot(), TEST.pythonBootstrapBudgets(null)),
      (e) => /integrity check failed: python_stdlib\.zip \(size mismatch: expected \d+ bytes, got \d+\)/.test(errText(e))
        && e.code === 'python_bootstrap_integrity' && rig.rt._assets === null);
  });

  // ================= I4: oversized body ====================================
  await withBrowserStubs(async () => {
    const { stream, state } = endlessChunkStream(64);
    const rig = makeRig({
      'six-1.16.0-py2.py3-none-any.whl': () => new Response(stream),
    });
    rig.start();
    await expectReject('I4 oversized body -> bounded reader fails closed',
      rig.rt._loadAssets(null, idleBoot(), TEST.pythonBootstrapBudgets(null)),
      (e) => /integrity check failed: six-1\.16\.0-py2\.py3-none-any\.whl \(oversized body/.test(errText(e))
        && rig.rt._assets === null);
    check('I4 bounded reader stopped EARLY (tiny expected size vs endless stream)',
      state.pulls <= 6, 'pulls=' + state.pulls);
    check('I4 underlying stream cancelled once the bound is exceeded', state.cancels === 1,
      'cancels=' + state.cancels);
    await new Promise((r) => setTimeout(r, 10));
    check('I4 no late cache mutation after the oversize failure', rig.rt._assets === null, '');
  });

  // ================= I5: wrong asset under the correct name ================
  await withBrowserStubs(async () => {
    const rig = makeRig({
      // Same SIZE as pinned, different bytes: must fail the HASH, not the size.
      'pyodide-lock.json': () => new Response(new Uint8Array(syntheticBytes['pyodide-lock.json'].length).fill(66)),
    });
    rig.start();
    await expectReject('I5 wrong bytes under the pinned filename -> hash mismatch',
      rig.rt._loadAssets(null, idleBoot(), TEST.pythonBootstrapBudgets(null)),
      (e) => /integrity check failed: pyodide-lock\.json \(sha256 mismatch\)/.test(errText(e))
        && rig.rt._assets === null);
  });

  // ================= I6: HTTP + network failures ===========================
  await withBrowserStubs(async () => {
    const rig = makeRig({
      'pyodide.js': () => new Response('nope', { status: 503 }),
    });
    rig.start();
    await expectReject('I6 HTTP failure -> asset-unavailable category',
      rig.rt._loadAssets(null, idleBoot(), TEST.pythonBootstrapBudgets(null)),
      (e) => /Python runtime asset unavailable: pyodide\.js \(HTTP 503\)/.test(errText(e))
        && e.code === 'python_bootstrap_unavailable' && rig.rt._assets === null);
  });
  await withBrowserStubs(async () => {
    const rig = makeRig({
      'pyodide.asm.js': () => Promise.reject(new TypeError('Failed to fetch')),
    });
    rig.start();
    await expectReject('I6b network failure -> asset-unavailable category',
      rig.rt._loadAssets(null, idleBoot(), TEST.pythonBootstrapBudgets(null)),
      (e) => /Python runtime asset unavailable: pyodide\.asm\.js/.test(errText(e))
        && e.code === 'python_bootstrap_unavailable' && rig.rt._assets === null);
  });

  // ================= I7: stalled body + late completion race ================
  await withBrowserStubs(async () => {
    const rt = freshRuntime(TEST);
    const postLog = [];
    rt._postToWorker = (msg) => postLog.push(msg);
    const log = [];
    let stallController = null;
    const goodBytes = syntheticBytes['numpy-1.26.4-cp312-cp312-pyodide_2024_0_wasm32.whl'];
    global.fetch = installFakeFetch({
      // The RESPONSE arrives but its body never yields: a hung CDN stream.
      'numpy-1.26.4-cp312-cp312-pyodide_2024_0_wasm32.whl': () => new Response(new ReadableStream({
        start(c) { stallController = c; },
      })),
    }, log);
    let err = null;
    try {
      await rt._loadAssets(null, idleBoot(), TEST.pythonBootstrapBudgets({ assetStallMs: 60 }));
    } catch (e) { err = e; }
    check('I7 stalled body -> acquisition stall failure',
      !!err && /Python runtime asset acquisition stalled: numpy[^(]*\(no body progress for 60ms\)/.test(errText(err))
      && err.code === 'python_asset_timeout', errText(err));
    check('I7 stalled acquisition never caches', rt._assets === null, '');
    check('I7 worker never receives bootstrap after the stall',
      postLog.every((m) => m.cmd !== 'bootstrap'), JSON.stringify(postLog.map((m) => m.cmd)));
    // Late completion race: the stalled body delivers GOOD bytes LATE (after
    // the failure). The abandoned loader must ignore them; state stays cold;
    // no cache write. (The read was cancelled; nobody observes the data.)
    if (stallController) {
      try { stallController.enqueue(goodBytes); stallController.close(); } catch (e) { /* cancelled: fine */ }
    }
    await new Promise((r) => setTimeout(r, 20));
    check('I7 late body completion cannot mutate the cache or state',
      rt._assets === null && rt.status === 'cold', '');
  });

  // ================= I8: cancel during acquisition ==========================
  await withBrowserStubs(async () => {
    const rt = freshRuntime(TEST);
    const task = new AbortController();
    const log = [];
    global.fetch = installFakeFetch({
      'pyodide.asm.js': () => {
        task.abort(new Error('python execution cancelled'));
        return new Response(syntheticBytes['pyodide.asm.js']);
      },
    }, log);
    let err = null;
    try {
      await rt._loadAssets(task.signal, idleBoot(), TEST.pythonBootstrapBudgets(null));
    } catch (e) { err = e; }
    check('I8 cancel during acquisition -> cancelled, fail closed',
      !!err && errText(err) === 'python execution cancelled', errText(err));
    check('I8 cancelled acquisition never caches', rt._assets === null, '');
    // Clean run afterwards works.
    global.fetch = installFakeFetch(null, []);
    let clean = null;
    let cleanErr = null;
    try { clean = await rt._loadAssets(null, idleBoot(), TEST.pythonBootstrapBudgets(null)); } catch (e) { cleanErr = e; }
    check('I8 later clean run works after a cancelled acquisition',
      !cleanErr && !!clean && rt._assets === clean, errText(cleanErr));
  });

  // ================= I9: partial success must not cache =====================
  await withBrowserStubs(async () => {
    const rig = makeRig({
      'pytz-2024.1-py2.py3-none-any.whl': () => new Response('x', { status: 404 }),
    });
    rig.start();
    await expectReject('I9 9/10 good + 1 failure -> rejected',
      rig.rt._loadAssets(null, idleBoot(), TEST.pythonBootstrapBudgets(null)),
      (e) => /unavailable: pytz-2024\.1/.test(errText(e)));
    check('I9 NO partial cache after 9/10 success', rig.rt._assets === null, '');
    check('I9 worker never receives a partial set',
      rig.postLog.every((m) => m.cmd !== 'bootstrap'), JSON.stringify(rig.postLog.map((m) => m.cmd)));
  });

  // ================= I10: URL derivation is manifest-only ===================
  await withBrowserStubs(async () => {
    const rt = freshRuntime(TEST);
    const log = [];
    global.fetch = installFakeFetch(null, log);
    await rt._loadAssets(null, idleBoot(), TEST.pythonBootstrapBudgets(null));
    const expected = TEST.PYTHON_BOOTSTRAP_MANIFEST.map((a) => 'fetch:' + TEST.PYODIDE_BASE + a.name).sort();
    check('I10 every fetched URL is EXACTLY PYODIDE_BASE + manifest name (no path/query variation)',
      JSON.stringify([...log].sort()) === JSON.stringify(expected), JSON.stringify(log));
    check('I10 loader derives URLs from the manifest alone (no second asset list in source)',
      !/PYTHON_BOOTSTRAP_ASSETS\b/.test(SRC)
      && /fetch\(PYODIDE_BASE \+ entry\.name/.test(SRC), '');
  });

  // ================= T2: acquisition deadline wording ========================
  await withBrowserStubs(async () => {
    const rt = freshRuntime(TEST);
    const log = [];
    global.fetch = installFakeFetch({
      'pyodide.asm.wasm': () => new Promise(() => {}), // dead fetch, no abort cooperation needed
    }, log);
    const bootAc = new AbortController();
    let err = null;
    try {
      await rt._loadAssets(null,
        { ac: bootAc, fail: (r) => bootAc.abort(r), reason: () => bootAc.signal.reason },
        TEST.pythonBootstrapBudgets({ assetMs: 80, assetStallMs: 1000 }));
    } catch (e) { err = e; }
    check('T2 asset acquisition beyond deadline -> ACQUISITION timeout wording',
      !!err && /Python runtime asset acquisition timed out after 80ms/.test(errText(err))
      && !/python execution timed out/.test(errText(err)) && err.code === 'python_asset_timeout',
      errText(err));
    check('T2 acquisition timeout never caches', rt._assets === null, '');
  });

  // ================= T3: worker boot stall -> INIT timeout, assets kept =====
  await withBrowserStubs(async () => {
    const rt = freshRuntime(TEST);
    const log = [];
    global.fetch = installFakeFetch(null, log); // all good
    const postedToWorker = [];
    // Fake creator stack: _ensureCreator no-ops because _creator is set;
    // creator-ready resolves instantly; the fake worker NEVER replies.
    rt._creator = {
      contentWindow: { postMessage: (m) => postedToWorker.push(m) },
      remove: () => {}, setAttribute: () => {}, style: {},
    };
    rt._creatorReady = Promise.resolve();
    global.document = { getElementById: () => ({ textContent: 'fake-worker-src' }) };
    let bootErr = null;
    try {
      await rt._ensureWorker(null, { assetMs: 5000, assetStallMs: 1000, bootstrapMs: 120 });
    } catch (e) { bootErr = e; }
    check('T3 stalled worker boot -> INITIALIZATION timeout wording',
      !!bootErr && /Python runtime initialization timed out after 120ms/.test(errText(bootErr))
      && !/python execution timed out/.test(errText(bootErr)), errText(bootErr));
    check('T3 verified assets RETAINED after the init timeout',
      rt._assets !== null && Object.keys(rt._assets).length === 12, '');
    check('T3 worker received spawn + verified bootstrap exactly once before the timeout',
      JSON.stringify(postedToWorker.map((m) => m.type || m.cmd)) === JSON.stringify(['spawn', 'bootstrap'])
      && postedToWorker[1].assets && Object.keys(postedToWorker[1].assets).length === 12,
      JSON.stringify(postedToWorker.map((m) => m.type || m.cmd)));
    check('T3 stack torn down after the init timeout (next run rebuilds)',
      rt.worker === null && rt._creator === null && rt.status === 'cold', '');
    // Recovery: a fresh worker that DOES reply locks from the VERIFIED CACHE
    // with zero network.
    const fetchCountBefore = log.length;
    rt._creator = {
      contentWindow: { postMessage: (m) => {
        postedToWorker.push(m);
        if (m.cmd === 'bootstrap') {
          setTimeout(() => {
            rt._onWindowMessage({ source: rt._creator.contentWindow, data: { id: m.id, type: 'boot', status: 'locked' } });
          }, 10);
        }
      } },
      remove: () => {}, setAttribute: () => {}, style: {},
    };
    rt._creatorReady = Promise.resolve();
    let bootErr2 = null;
    try { await rt._ensureWorker(null, { assetMs: 5000, assetStallMs: 1000, bootstrapMs: 1000 }); } catch (e) { bootErr2 = e; }
    check('T3 rebuild after init timeout locks from the verified cache',
      !bootErr2 && rt.worker !== null, errText(bootErr2));
    check('T3 rebuild performed ZERO asset fetches (network delta = 0)',
      log.length === fetchCountBefore, 'delta=' + (log.length - fetchCountBefore));
  });

  // ================= T5: budgets are independent =============================
  await withBrowserStubs(async () => {
    const rt = freshRuntime(TEST);
    let firstAssetDelayElapsed = false;
    const log = [];
    global.fetch = installFakeFetch({
      // The first asset crawls; at 25ms per asset the whole-manifest
      // acquisition stays well inside its 10s budget. The init budget is
      // only 150ms BUT it is
      // paused during acquisition, so the 100ms boot reply afterwards must
      // still fit — the two budgets cannot eat each other.
      'pyodide.js': () => new Promise((resolve) => setTimeout(() => {
        firstAssetDelayElapsed = true;
        resolve(new Response(syntheticBytes['pyodide.js']));
      }, 25)),
    }, log);
    rt._creator = {
      contentWindow: { postMessage: (m) => {
        if (m.cmd === 'bootstrap') {
          setTimeout(() => {
            rt._onWindowMessage({ source: rt._creator.contentWindow, data: { id: m.id, type: 'boot', status: 'locked' } });
          }, 100);
        }
      } },
      remove: () => {}, setAttribute: () => {}, style: {},
    };
    rt._creatorReady = Promise.resolve();
    global.document = { getElementById: () => ({ textContent: 'fake-worker-src' }) };
    let err = null;
    const t0 = Date.now();
    try {
      await rt._ensureWorker(null, { assetMs: 10000, assetStallMs: 5000, bootstrapMs: 150 });
    } catch (e) { err = e; }
    check('T5 slow acquisition does not consume the paused init budget',
      !err && rt.worker !== null && firstAssetDelayElapsed, errText(err) + ' elapsed=' + (Date.now() - t0));
  });

  // ================= T6: queued concurrent runs ==============================
  await withBrowserStubs(async () => {
    const rt = freshRuntime(TEST);
    const log = [];
    global.fetch = installFakeFetch(null, log);
    const postedToWorker = [];
    let bootReplyDelay = 40;
    rt._creator = {
      contentWindow: { postMessage: (m) => {
        postedToWorker.push(m);
        if (m.cmd === 'bootstrap') {
          const d = bootReplyDelay;
          setTimeout(() => {
            rt._onWindowMessage({ source: rt._creator.contentWindow, data: { id: m.id, type: 'boot', status: 'locked' } });
          }, d);
        }
        if (m.cmd === 'run') {
          setTimeout(() => {
            rt._onWindowMessage({ source: rt._creator.contentWindow, data: {
              id: m.id, type: 'result', stdout: 'ok:' + m.code, stderr: '', error: null,
              files: [], deleted: [], createdDirs: [], deletedDirs: [], uncollectedFiles: [],
            } });
          }, 10);
        }
      } },
      remove: () => {}, setAttribute: () => {}, style: {},
    };
    rt._creatorReady = Promise.resolve();
    global.document = { getElementById: () => ({ textContent: 'fake-worker-src' }) };
    const p1 = rt.run('A', null, { cwd: '/tmp', bootstrapBudgets: { assetMs: 5000, bootstrapMs: 5000 } });
    const p2 = rt.run('B', null, { cwd: '/tmp', bootstrapBudgets: { assetMs: 5000, bootstrapMs: 5000 } });
    const [r1, r2] = await Promise.all([p1, p2]);
    check('T6 both queued runs complete in order', r1.stdout === 'ok:A' && r2.stdout === 'ok:B',
      JSON.stringify([r1.stdout, r2.stdout, r1.error, r2.error]));
    check('T6 exactly ONE bootstrap happened for both runs',
      postedToWorker.filter((m) => m.cmd === 'bootstrap').length === 1,
      JSON.stringify(postedToWorker.map((m) => m.cmd)));
    const fetchCount = log.length;
    // A third run after a worker crash rebuilds from the verified cache
    // (fresh fake creator stack — the crash destroyed the old one).
    rt._onWorkerFatal({ message: 'simulated crash' });
    bootReplyDelay = 5;
    rt._creator = {
      contentWindow: { postMessage: (m) => {
        postedToWorker.push(m);
        if (m.cmd === 'bootstrap') {
          setTimeout(() => {
            rt._onWindowMessage({ source: rt._creator.contentWindow, data: { id: m.id, type: 'boot', status: 'locked' } });
          }, bootReplyDelay);
        }
        if (m.cmd === 'run') {
          setTimeout(() => {
            rt._onWindowMessage({ source: rt._creator.contentWindow, data: {
              id: m.id, type: 'result', stdout: 'ok:' + m.code, stderr: '', error: null,
              files: [], deleted: [], createdDirs: [], deletedDirs: [], uncollectedFiles: [],
            } });
          }, 10);
        }
      } },
      remove: () => {}, setAttribute: () => {}, style: {},
    };
    rt._creatorReady = Promise.resolve();
    let r3 = null;
    let r3Err = null;
    try { r3 = await rt.run('C', null, { cwd: '/tmp' }); } catch (e) { r3Err = e; }
    check('T6 post-crash run rebuilds and completes', !!r3 && r3.stdout === 'ok:C', errText(r3Err));
    check('T6 post-crash rebuild fetched ZERO new assets (verified cache reused)',
      log.length === fetchCount, 'delta=' + (log.length - fetchCount));
  });

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.error('TEST RUNNER FAIL', e && e.stack || e); process.exit(1); });
