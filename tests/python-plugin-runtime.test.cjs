// Trusted Plugin Runtime v1A unit tests. Two layers, both driving the REAL
// shipped sources (not mocks of the logic under test):
//
//   MAIN THREAD (src/shell.js, as the real ES module namespace) —
//   configureExtensions wheel-payload validation: the trusted Harness
//   invariants (schema, bounds, metadata<->bytes agreement, own-copy
//   isolation, key semantics). A metadata/bytes disagreement must fail
//   BEFORE the boot send, never inside the interpreter.
//
//   WORKER (the real py-worker-src extracted from index.html, in a vm
//   sandbox with a recording fake Pyodide) — the wheel install lifecycle:
//   bootstrap order, worker-side integrity re-verification (size +
//   WebCrypto SHA-256), harness-derived scratch path, offline micropip
//   install with deps=False, scratch cleanup, smoke imports, installer
//   retirement, and fail-closed behavior for every tampered shape.
//
//  V1  valid wheel payload accepted, frozen, normalized to an owned copy
//  V2  payload/key shape rejections (null reset keeps working)
//  V3  module entry rejections (pluginId, imports)
//  V4  files payload rejected (alone or beside wheels); neither payload
//      rejected
//  V5  filename must be a plain .whl basename (no slash/backslash/traversal)
//  V6  format is exactly "python-wheel"
//  V7  size bounds: integer >= 0, <= package artifact bound
//  V8  sha256 must be 64 lowercase hex
//  V9  bytes must be an ArrayBuffer view with byteLength == declared size
//  V10 own-copy isolation: caller mutation never changes future boots
//  V11 DataView (non-Uint8Array view) accepted and normalized
//  V12 files-only source-text payload is now rejected (wheel-only per D10)
//  V13 canonical plugin identity: pluginId must match EXTENSION_ID_PATTERN
//      (the gate precedes the payload-shape checks); valid canonical id accepted
//  V14 wheels non-array rejected with a controlled validation error
//  V15 zero wheels rejected
//  V16 multiple wheels rejected (exactly-one-wheel contract)
//  V17 DataView over a padded backing buffer: own exact-range copy
//      (byteOffset + byteLength respected, caller mutation inert)
//  W1  wheel install lifecycle order (pandas -> micropip -> verify -> write
//      -> emfs install deps=False -> unlink/rmdir -> smoke -> neuter)
//  W1g parent scratch dir attempted after the sha dir (no
//      /tmp/locus-plugin-artifacts residue -> no phantom [mkdir: ...] report)
//  W2  tampered bytes (same size, wrong digest) -> sha256 mismatch, no
//      write, no install, no smoke, no READY
//  W3  metadata size != received bytes -> size mismatch, fail closed
//  W4  declared smoke import missing -> boot fails closed AFTER cleanup
//  W4c parent scratch dir also cleaned when the smoke import fails
//  W4d two-wheel boot: per-wheel parent cleanup attempts, both sha dirs
//      removed, swallowed parent-rmdir failures never break the boot
//  W5  installer retired after install (micropip.install is the denial)
//  W6  files payload at the worker fails the boot closed (wheel-only per
//      D10; no site-packages write, no READY)
//  W7  no WebCrypto subtle -> integrity unavailable, fail closed
//  W8  no wheel payload -> micropip never loads (core boot unchanged)
//  W9  install command is exactly emfs: + deps=False (offline contract)
//  WR1 files-only configure AFTER a good wheel payload is refused and
//      leaves the configured payload untouched (wheel-only migration gate)
// Run: node tests/python-plugin-runtime.test.cjs

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + detail : '')); }
}
const errText = (e) => String(e && e.message ? e.message : e);

// ---------- the real fixture wheel identity ----------
const WHEEL_PATH = path.join(__dirname, 'fixtures/capability-package/minimal',
  'plugins/locus-test-plugin/artifacts/locus_test_plugin-1.0.0-py3-none-any.whl');
const WHEEL_BYTES = new Uint8Array(fs.readFileSync(WHEEL_PATH));
const WHEEL_FILENAME = 'locus_test_plugin-1.0.0-py3-none-any.whl';
const WHEEL_SHA256 = require('crypto').createHash('sha256').update(WHEEL_BYTES).digest('hex');

// ---------- MAIN THREAD: real shell.js ----------
const cryptoNode = require('crypto');
globalThis.crypto = cryptoNode.webcrypto;

// M3a: shell.js is a real ES module. The classic base trio
// (workspace/vfs/extension-composition/extensions) existed only to satisfy
// classic global references — the WorkspaceAdapter class bases and the
// shared EXTENSION_ID_PATTERN / EXTENSION_PY_MODULE_PATTERN bindings —
// which the module no longer has: it imports what it needs and owns its own
// RUNTIME_PLUGIN_ID_PATTERN / RUNTIME_PY_MODULE_PATTERN, so the whole
// evalShell/BASE_SRC preamble collapses to a namespace require.
const SHELL = require('../src/shell.js');
// Kept ONLY for the S4 source-text scan of the shipped module source.
const SHELL_SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'shell.js'), 'utf8');

// M1b: instances come from the factory — every mutable field is
// initialized per instance (no Object.create over a shared singleton).
function freshRuntime() {
  const { freshRuntime } = require('./helpers/runtime.cjs');
  return freshRuntime(SHELL);
}

function wheelModule(overrides) {
  return Object.assign({
    pluginId: 'locus-test-plugin',
    imports: ['locus_test_plugin'],
    wheels: [{
      filename: WHEEL_FILENAME,
      format: 'python-wheel',
      size: WHEEL_BYTES.byteLength,
      sha256: WHEEL_SHA256,
      bytes: WHEEL_BYTES.slice(),
    }],
  }, overrides || {});
}

function expectConfigureThrow(name, payload, pattern) {
  const rt = freshRuntime();
  let err = null;
  try { rt.configureExtensions(payload); } catch (e) { err = e; }
  check(name, !!err && pattern.test(errText(err)) && rt._extensions === null, errText(err));
}

// ---------------- V-series: main-thread validation ----------------
{
  const rt = freshRuntime();
  rt.configureExtensions({ key: 'locus-test-plugin@1.0.0', modules: [wheelModule()] });
  const ext = rt._extensions;
  check('V1 valid wheel payload accepted',
    !!ext && ext.key === 'locus-test-plugin@1.0.0' && ext.modules.length === 1
    && ext.modules[0].pluginId === 'locus-test-plugin'
    && ext.modules[0].wheels.length === 1
    && ext.modules[0].wheels[0].bytes instanceof Uint8Array
    && ext.modules[0].wheels[0].bytes.byteLength === WHEEL_BYTES.byteLength,
    JSON.stringify(ext && ext.modules));
  check('V1b payload frozen at every level',
    Object.isFrozen(ext) && Object.isFrozen(ext.modules) && Object.isFrozen(ext.modules[0])
    && Object.isFrozen(ext.modules[0].wheels) && Object.isFrozen(ext.modules[0].wheels[0]), '');
  check('V1c extensionKey reflects the configured key; null config resets',
    rt.extensionKey() === 'locus-test-plugin@1.0.0'
    && (rt.configureExtensions(null), rt.extensionKey() === null && rt._extensions === null), '');
}
expectConfigureThrow('V2a non-object payload rejected', 42, /invalid extension payload/);
expectConfigureThrow('V2b missing key rejected', { modules: [] }, /invalid extension payload/);
expectConfigureThrow('V2c modules not an array rejected', { key: 'k', modules: {} }, /invalid extension payload/);
expectConfigureThrow('V2d empty key rejected', { key: '', modules: [] }, /invalid extension payload/);
expectConfigureThrow('V3a module without pluginId rejected', { key: 'k', modules: [{ imports: [] }] }, /invalid extension module entry/);
expectConfigureThrow('V3b module with empty pluginId rejected', { key: 'k', modules: [wheelModule({ pluginId: '' })] }, /invalid extension module entry/);
expectConfigureThrow('V3c module with non-array imports rejected', { key: 'k', modules: [wheelModule({ imports: 'x' })] }, /invalid extension module entry/);
expectConfigureThrow('V3d module with an invalid import name rejected',
  { key: 'k', modules: [wheelModule({ imports: ['bad name!'] })] }, /invalid smoke import name/);
expectConfigureThrow('V4a files and wheels together rejected',
  { key: 'k', modules: [wheelModule({ files: { 'x.py': 'x' } })] }, /source-text payloads are no longer supported/);
expectConfigureThrow('V4b neither files nor wheels rejected',
  { key: 'k', modules: [{ pluginId: 'p', imports: [] }] }, /exactly one \.whl artifact/);
for (const bad of ['../evil.whl', 'a/b.whl', 'a\\b.whl', 'no-extension', '.hidden.whl', 'locus_test_plugin-1.0.0-py3-none-any.WHL']) {
  expectConfigureThrow('V5 filename "' + bad + '" rejected',
    { key: 'k', modules: [wheelModule({ wheels: [Object.assign({}, wheelModule().wheels[0], { filename: bad })] })] },
    /wheel artifact filename/);
}
expectConfigureThrow('V6 wrong format rejected',
  { key: 'k', modules: [wheelModule({ wheels: [Object.assign({}, wheelModule().wheels[0], { format: 'wheel' })] })] },
  /format must be exactly/);
{
  const w0 = wheelModule().wheels[0];
  expectConfigureThrow('V7a float size rejected',
    { key: 'k', modules: [wheelModule({ wheels: [Object.assign({}, w0, { size: 1.5 })] })] }, /size must be/);
  expectConfigureThrow('V7b negative size rejected',
    { key: 'k', modules: [wheelModule({ wheels: [Object.assign({}, w0, { size: -1 })] })] }, /size must be/);
  expectConfigureThrow('V7c oversized declared size rejected (package artifact bound)',
    { key: 'k', modules: [wheelModule({ wheels: [Object.assign({}, w0, { size: 64 * 1024 * 1024 + 1 })] })] },
    /exceeds the 67108864-byte artifact bound/);
  expectConfigureThrow('V8a uppercase sha256 rejected',
    { key: 'k', modules: [wheelModule({ wheels: [Object.assign({}, w0, { sha256: w0.sha256.toUpperCase() })] })] },
    /sha256 must be exactly 64 lowercase hex/);
  expectConfigureThrow('V8b short sha256 rejected',
    { key: 'k', modules: [wheelModule({ wheels: [Object.assign({}, w0, { sha256: 'abc' })] })] },
    /sha256 must be exactly 64 lowercase hex/);
  expectConfigureThrow('V9a non-view bytes rejected',
    { key: 'k', modules: [wheelModule({ wheels: [Object.assign({}, w0, { bytes: { byteLength: w0.size } })] })] },
    /bytes must be a Uint8Array/);
  expectConfigureThrow('V9b byteLength != declared size rejected (1296 vs 1295)',
    { key: 'k', modules: [wheelModule({ wheels: [Object.assign({}, w0, { bytes: w0.bytes.slice(0, w0.size - 1) })] })] },
    /bytes\.byteLength 1295 != declared size 1296/);
  expectConfigureThrow('V9c SharedArrayBuffer-backed view rejected',
    { key: 'k', modules: [wheelModule({ wheels: [Object.assign({}, w0, { bytes: new Uint8Array(new SharedArrayBuffer(w0.size)) })] })] },
    /bytes must be a Uint8Array/);
}
{
  // V10: the canonical-copy rule (CapabilityBundle readBytes semantics).
  const original = WHEEL_BYTES.slice();
  const rt = freshRuntime();
  rt.configureExtensions({ key: 'k', modules: [wheelModule({ wheels: [{
    filename: WHEEL_FILENAME, format: 'python-wheel', size: original.byteLength,
    sha256: WHEEL_SHA256, bytes: original,
  }] })] });
  original[0] ^= 0xff;
  const stored = rt._extensions.modules[0].wheels[0].bytes;
  const storedSha = cryptoNode.createHash('sha256').update(stored).digest('hex');
  check('V10 caller mutation after configure never changes future boots',
    storedSha === WHEEL_SHA256 && stored[0] === WHEEL_BYTES[0]
      && rt.extensionKey() === 'k', storedSha);
  check('V10b stored payload is a COPY, not the caller array', stored !== original, '');
}
{
  const rt = freshRuntime();
  const view = new DataView(WHEEL_BYTES.slice().buffer);
  rt.configureExtensions({ key: 'k', modules: [wheelModule({ wheels: [{
    filename: WHEEL_FILENAME, format: 'python-wheel', size: WHEEL_BYTES.byteLength,
    sha256: WHEEL_SHA256, bytes: view,
  }] })] });
  const stored = rt._extensions.modules[0].wheels[0].bytes;
  check('V11 DataView (ArrayBufferView) accepted and normalized to Uint8Array',
    stored instanceof Uint8Array && stored.byteLength === WHEEL_BYTES.byteLength
    && cryptoNode.createHash('sha256').update(stored).digest('hex') === WHEEL_SHA256, '');
}
{
  // Wheel-only per D10 §6: the files-only source-text payload is refused
  // outright — the LEGACY SYNTHETIC COMPOSITION PATH is gone.
  expectConfigureThrow('V12 files-only source-text payload is now rejected (wheel-only per D10)',
    { key: 'synthetic@1', modules: [{ pluginId: 'synthetic-python-plugin', files: { 'm.py': 'x' }, imports: ['m'] }] },
    /source-text payloads are no longer supported/);
}
{
  // WR1: the wheel-only migration gate — a files-only payload arriving
  // AFTER a good wheel configuration is refused AND leaves the previously
  // configured payload untouched (configure stays all-or-nothing).
  const rt = freshRuntime();
  rt.configureExtensions({ key: 'good@1', modules: [wheelModule()] });
  let err = null;
  try { rt.configureExtensions({ key: 'synthetic@1', modules: [{ pluginId: 'synthetic-python-plugin', files: { 'm.py': 'x' }, imports: ['m'] }] }); } catch (e) { err = e; }
  check('WR1 files-only payload rejected; the previously configured wheel payload is untouched',
    !!err && /source-text payloads are no longer supported/.test(errText(err))
      && rt.extensionKey() === 'good@1'
      && rt._extensions.modules.length === 1
      && rt._extensions.modules[0].wheels.length === 1
      && rt._extensions.modules[0].files === undefined,
    errText(err));
}

// ------ V13-V17: contract cleanup (canonical id, one-wheel, exact-range own copy) ------
expectConfigureThrow('V13a pluginId "../evil" rejected (canonical identity)',
  { key: 'k', modules: [wheelModule({ pluginId: '../evil' })] }, /pluginId must match/);
expectConfigureThrow('V13b pluginId "Bad ID" rejected (canonical identity)',
  { key: 'k', modules: [wheelModule({ pluginId: 'Bad ID' })] }, /pluginId must match/);
expectConfigureThrow('V13c pluginId "Locus-Test-Plugin" (uppercase) rejected',
  { key: 'k', modules: [wheelModule({ pluginId: 'Locus-Test-Plugin' })] }, /pluginId must match/);
{
  // The canonical plugin identity gate runs BEFORE the wheel-only payload
  // shape check, so a source-text payload with a non-canonical id still
  // fails with the identity error, not the wheel-only error.
  const rt = freshRuntime();
  let err = null;
  try { rt.configureExtensions({ key: 'k', modules: [{ pluginId: '../evil', files: { 'm.py': 'x' }, imports: ['m'] }] }); } catch (e) { err = e; }
  check('V13d files payload with a non-canonical pluginId fails the identity gate first',
    !!err && /pluginId must match/.test(errText(err)) && rt._extensions === null, errText(err));
}
{
  const rt = freshRuntime();
  rt.configureExtensions({ key: 'k', modules: [wheelModule()] });
  check('V13e valid canonical pluginId accepted', rt._extensions.modules[0].pluginId === 'locus-test-plugin', '');
}
{
  // V14: a non-array wheels payload is a protocol violation and must fail
  // with the controlled validation error, never an incidental TypeError
  // bubbling out of .map.
  const rt = freshRuntime();
  let err = null;
  try { rt.configureExtensions({ key: 'k', modules: [wheelModule({ wheels: {} })] }); } catch (e) { err = e; }
  check('V14 wheels non-array rejected with a controlled validation error',
    !!err && /exactly one \.whl artifact/.test(errText(err))
      && !/\.map is not a function/i.test(errText(err)) && rt._extensions === null, errText(err));
}
expectConfigureThrow('V15 zero wheels rejected',
  { key: 'k', modules: [wheelModule({ wheels: [] })] }, /exactly one \.whl artifact/);
{
  const w0 = wheelModule().wheels[0];
  const second = Object.assign({}, w0, { filename: 'locus_test_plugin-2.0.0-py3-none-any.whl' });
  expectConfigureThrow('V16 two wheels rejected (exactly-one contract)',
    { key: 'k', modules: [wheelModule({ wheels: [w0, second] })] }, /exactly one \.whl artifact/);
}
{
  // V17: a non-Uint8Array view (DataView) over a LARGER backing buffer must
  // be canonicalized to an own copy of EXACTLY the declared byte range —
  // byteOffset and byteLength respected, the surrounding padding never
  // retained, and later caller mutation of the whole buffer inert.
  const prefix = 7; // deliberately misaligned wheel start inside the buffer
  const suffix = 13;
  const backing = new ArrayBuffer(prefix + WHEEL_BYTES.byteLength + suffix);
  const raw = new Uint8Array(backing);
  raw.set(WHEEL_BYTES, prefix);
  const view = new DataView(backing, prefix, WHEEL_BYTES.byteLength);
  const rt = freshRuntime();
  rt.configureExtensions({ key: 'k', modules: [wheelModule({ wheels: [{
    filename: WHEEL_FILENAME, format: 'python-wheel', size: WHEEL_BYTES.byteLength,
    sha256: WHEEL_SHA256, bytes: view,
  }] })] });
  for (let i = 0; i < raw.length; i++) raw[i] = 0x5a; // caller mutates EVERYTHING afterwards
  const stored = rt._extensions.modules[0].wheels[0].bytes;
  const storedSha = cryptoNode.createHash('sha256').update(stored).digest('hex');
  check('V17 DataView over padded backing buffer: stored payload is an own exact-range copy',
    storedSha === WHEEL_SHA256 && stored.byteLength === WHEEL_BYTES.byteLength
      && stored.every((b, i) => b === WHEEL_BYTES[i]), storedSha);
}

// ---------- WORKER: real py worker source (runtime asset) in a recording sandbox ----------
// M2a: the worker source is a runtime asset module (never index.html).
const { PY_WORKER_SOURCE: workerSrc } = require('./helpers/runtime.cjs');

const SITE_DIR = '/lib/python3.12/site-packages';
const LOADER_MESSAGE = 'Python package installation is controlled by the Locus runtime';

// A recording fake Pyodide: FS in memory, every call logged. runPythonAsync
// understands exactly the two shapes the worker drives during a wheel
// install: the micropip install line and the installer-retirement script.
function makeFakePy(calls, opts) {
  opts = opts || {};
  const files = new Map([['/', 'DIR'], ['/tmp', 'DIR'], [SITE_DIR, 'DIR']]);
  const micropip = { install: () => { throw new Error('PRISTINE micropip.install must never run'); } };
  const py = {
    _files: files,
    _micropip: micropip,
    async loadPackage(pkgs) { calls.push('loadPackage:' + String(pkgs)); },
    runPython(code) {
      calls.push('runPython:' + String(code).slice(0, 40));
      if (code.indexOf('sysconfig') !== -1) return SITE_DIR;
      const m = code.match(/^import ([A-Za-z_][A-Za-z0-9_]*)$/);
      if (m) {
        if ((opts.importable || []).includes(m[1])) return undefined;
        throw new Error(`ModuleNotFoundError: No module named '${m[1]}'`);
      }
      return undefined;
    },
    async runPythonAsync(code) {
      calls.push('runPythonAsync:' + String(code).slice(0, 60));
      if (code.indexOf('await micropip.install("emfs:') !== -1) {
        const m = code.match(/await micropip\.install\("([^"]+)"(?:, deps=(\w+))?\)/);
        if (!m) throw new Error('unparseable install command: ' + code);
        micropip.lastInstall = { path: m[1], deps: m[2] === undefined ? null : m[2] !== 'False' };
        micropip.installed = micropip.installed || [];
        micropip.installed.push(m[1]);
        return undefined;
      }
      if (code.indexOf('_locus_install_denied') !== -1) {
        micropip.install = function () { throw new Error(LOADER_MESSAGE); };
        micropip.add_mock_package = micropip.install;
        micropip.remove_mock_package = micropip.install;
        return undefined;
      }
      if (code.indexOf('os.chdir') !== -1) return undefined;
      throw new Error('unexpected runPythonAsync: ' + String(code).slice(0, 60));
    },
    FS: {
      mkdirTree(dir) { calls.push('mkdirTree:' + dir); files.set(dir, 'DIR'); },
      writeFile(full, bytes) {
        calls.push('writeFile:' + full + ':' + (bytes && bytes.byteLength));
        files.set(full, bytes instanceof Uint8Array ? bytes.slice() : bytes);
      },
      readFile(full) { const v = files.get(full); if (v === undefined) throw new Error('ENOENT ' + full); return v; },
      stat(full) {
        const v = files.get(full);
        if (v === undefined) throw new Error('ENOENT ' + full);
        return { mode: v === 'DIR' ? 16384 : 32768, size: v === 'DIR' ? 0 : v.byteLength };
      },
      unlink(full) { calls.push('unlink:' + full); if (!files.delete(full)) throw new Error('ENOENT ' + full); },
      rmdir(dir) {
        calls.push('rmdir:' + dir);
        if (files.get(dir) !== 'DIR') throw new Error('ENOTDIR ' + dir);
        for (const k of files.keys()) {
          if (k !== dir && k.startsWith(dir + '/')) throw new Error('ENOTEMPTY ' + dir);
        }
        files.delete(dir);
      },
      chmod() {}, readdir() { return []; }, isDir() { return false; },
    },
    setStdout() {}, setStderr() {},
  };
  return py;
}

// One worker context with the worker-global primitives the lockdown needs
// (same shape philosophy as tests/python-authority.test.cjs).
function makeWorkerContext(loadPyodideImpl, posted, calls, opts) {
  opts = opts || {};
  const sandbox = {
    self: { postMessage(msg) { if (msg.type === 'result' || msg.type === 'boot') posted.push(msg); } },
    importScripts() { calls.push('importScripts'); },
    loadPyodide: loadPyodideImpl,
    atob, btoa, TextEncoder, TextDecoder,
    fetch: function () { calls.push('fetch:RAN'); },
    XMLHttpRequest: function () { calls.push('xhr:RAN'); },
    WebSocket: function () { calls.push('ws:RAN'); },
    Worker: function () { calls.push('worker:RAN'); },
    setTimeout: (fn) => { try { fn(); } catch (e) { calls.push('selfdestruct:' + (e && e.message || e)); } },
    clearTimeout: () => {},
  };
  if (!opts.withCrypto) delete sandbox.crypto;
  else sandbox.crypto = { subtle: cryptoNode.webcrypto.subtle };
  const c = vm.createContext(sandbox);
  vm.runInContext(workerSrc, c);
  return c;
}

const BOOT_ASSETS = {
  'pyodide.js': { text: '/* unit stub: loadPyodide comes from the sandbox */' },
  'pyodide.asm.js': { text: 'var _createPyodideModule = function () {};' },
};
// The bootstrap message crosses into the worker context the way the real
// harness delivers it: as a STRUCTURED CLONE. The vm bridge cannot clone
// host Uint8Arrays as same-realm instances, so wheel bytes travel as base64
// here and are re-materialized INSIDE the context — the worker then sees a
// genuine same-realm Uint8Array, exactly like postMessage delivers.
async function postBootstrap(c, extensionModules) {
  const plain = JSON.stringify({ id: 1, cmd: 'bootstrap', assets: BOOT_ASSETS });
  const mods = JSON.stringify((extensionModules || []).map((m) => Object.assign({}, m, {
    wheels: m.wheels ? m.wheels.map((w) => Object.assign({}, w, {
      bytes: null, __b64: Buffer.from(w.bytes).toString('base64'),
    })) : undefined,
  })));
  await vm.runInContext(`(async function () {
    const msg = ${plain};
    const mods = ${mods};
    msg.extensionModules = mods.map(function (m) {
      if (!m.wheels) return m;
      return Object.assign({}, m, { wheels: m.wheels.map(function (w) {
        const bin = atob(w.__b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return { filename: w.filename, format: w.format, size: w.size, sha256: w.sha256, bytes: bytes };
      }) });
    });
    await self.onmessage({ data: msg });
  })()`, c);
}
async function waitForBoot(posted) {
  for (let i = 0; i < 400; i++) {
    const r = posted.find((m) => m.type === 'boot');
    if (r) return r;
    await new Promise((r2) => setTimeout(r2, 5));
  }
  throw new Error('worker posted no boot reply');
}

const goodWheels = () => [{
  filename: WHEEL_FILENAME, format: 'python-wheel', size: WHEEL_BYTES.byteLength,
  sha256: WHEEL_SHA256, bytes: WHEEL_BYTES.slice(),
}];

async function run() {
  // ---------------- W1/W5/W9: the happy lifecycle ----------------
  {
    const calls = [];
    const posted = [];
    let pyRef = null;
    const c = makeWorkerContext(async () => { pyRef = makeFakePy(calls, { importable: ['locus_test_plugin'] }); return pyRef; }, posted, calls, { withCrypto: true });
    await postBootstrap(c, [{ pluginId: 'locus-test-plugin', wheels: goodWheels(), imports: ['locus_test_plugin'] }]);
    const boot = await waitForBoot(posted);
    check('W1 wheel payload boot locks', !boot.error && boot.status === 'locked', boot.error);
    const order = calls.join(' | ');
    check('W1b bootstrap order: pandas closure, then micropip installer closure, pre-lockdown',
      order.indexOf('loadPackage:pandas') !== -1
      && order.indexOf('loadPackage:micropip') !== -1
      && order.indexOf('loadPackage:micropip') > order.indexOf('loadPackage:pandas'),
      order.slice(0, 400));
    const scratch = '/tmp/locus-plugin-artifacts/' + WHEEL_SHA256 + '/' + WHEEL_FILENAME;
    check('W1c verified wheel written to the harness-derived scratch path',
      calls.some((s) => s === 'mkdirTree:/tmp/locus-plugin-artifacts/' + WHEEL_SHA256)
      && calls.some((s) => s === 'writeFile:' + scratch + ':' + WHEEL_BYTES.byteLength),
      order.slice(0, 500));
    check('W1d offline install ran with deps=False (Package v1: no closure, no index)',
      !!pyRef && !!pyRef._micropip.lastInstall
      && pyRef._micropip.lastInstall.path === 'emfs:' + scratch
      && pyRef._micropip.lastInstall.deps === false,
      JSON.stringify(pyRef && pyRef._micropip.lastInstall));
    check('W1e scratch wheel removed after install (empty dir too)',
      calls.some((s) => s === 'unlink:' + scratch)
      && calls.some((s) => s === 'rmdir:/tmp/locus-plugin-artifacts/' + WHEEL_SHA256), '');
    // mkdirTree creates the parent scratch dir too (/tmp/locus-plugin-artifacts);
    // leaving it behind made the FIRST python run report it as a phantom
    // created dir ("[mkdir: /tmp/locus-plugin-artifacts]"). The cleanup must
    // attempt the parent as well, after its child. The fake FS never
    // materializes the parent entry, so this rmdir throws (swallowed) — which
    // also proves a failing parent rmdir cannot break the boot.
    const shaRmdirAt = calls.indexOf('rmdir:/tmp/locus-plugin-artifacts/' + WHEEL_SHA256);
    const parentRmdirAt = calls.indexOf('rmdir:/tmp/locus-plugin-artifacts');
    check('W1g parent scratch dir removed after the sha dir (no residue, no [mkdir: ...] phantom)',
      shaRmdirAt !== -1 && parentRmdirAt > shaRmdirAt
      && !pyRef._files.has('/tmp/locus-plugin-artifacts/' + WHEEL_SHA256),
      JSON.stringify(calls.filter((s) => s.startsWith('rmdir'))));
    check('W1f smoke import ran for the declared import',
      calls.some((s) => s === 'runPython:import locus_test_plugin'), order.slice(-300));
    check('W5 installer retired before READY (micropip.install is the denial)',
      typeof pyRef._micropip.install === 'function'
      && (() => { try { pyRef._micropip.install('emfs:/x.whl'); return false; } catch (e) { return e.message === LOADER_MESSAGE; } })(), '');
    check('W9 worker performed ZERO real fetch attempts during install',
      !calls.some((s) => s === 'fetch:RAN'), JSON.stringify(calls.filter((s) => s.startsWith('fetch'))));
  }

  // ---------------- W2: tampered bytes ----------------
  {
    const calls = [];
    const posted = [];
    const tampered = WHEEL_BYTES.slice();
    tampered[10] ^= 0x5a; // same size, different bytes
    const c = makeWorkerContext(async () => makeFakePy(calls, {}), posted, calls, { withCrypto: true });
    await postBootstrap(c, [{ pluginId: 'locus-test-plugin', wheels: [{
      filename: WHEEL_FILENAME, format: 'python-wheel', size: WHEEL_BYTES.byteLength,
      sha256: WHEEL_SHA256, bytes: tampered,
    }], imports: ['locus_test_plugin'] }]);
    const boot = await waitForBoot(posted);
    check('W2 tampered bytes -> artifact sha256 mismatch, boot fails closed',
      !!boot.error && /artifact sha256 mismatch: plugin locus-test-plugin, artifact /.test(boot.error),
      boot.error);
    check('W2b no scratch write, no install, no smoke after the mismatch',
      !calls.some((s) => s.startsWith('writeFile:'))
      && !calls.some((s) => s.startsWith('runPythonAsync:import micropip'))
      && !calls.some((s) => s === 'runPython:import locus_test_plugin'),
      JSON.stringify(calls.slice(0, 12)));
  }

  // ---------------- W3: metadata size mismatch ----------------
  {
    const calls = [];
    const posted = [];
    const c = makeWorkerContext(async () => makeFakePy(calls, {}), posted, calls, { withCrypto: true });
    await postBootstrap(c, [{ pluginId: 'locus-test-plugin', wheels: [{
      filename: WHEEL_FILENAME, format: 'python-wheel', size: WHEEL_BYTES.byteLength - 1,
      sha256: WHEEL_SHA256, bytes: WHEEL_BYTES.slice(),
    }], imports: ['locus_test_plugin'] }]);
    const boot = await waitForBoot(posted);
    check('W3 metadata size != received bytes -> size mismatch, fail closed',
      !!boot.error && /artifact size mismatch: plugin locus-test-plugin, artifact .* \(declared 1295 bytes, received 1296\)/.test(boot.error),
      boot.error);
  }

  // ---------------- W4: declared import missing ----------------
  {
    const calls = [];
    const posted = [];
    const scratch = '/tmp/locus-plugin-artifacts/' + WHEEL_SHA256 + '/' + WHEEL_FILENAME;
    const c = makeWorkerContext(async () => makeFakePy(calls, { importable: [] }), posted, calls, { withCrypto: true });
    await postBootstrap(c, [{ pluginId: 'locus-test-plugin', wheels: goodWheels(), imports: ['module_that_does_not_exist_7f91'] }]);
    const boot = await waitForBoot(posted);
    check('W4 declared smoke import missing -> boot fails closed with the import name',
      !!boot.error && /smoke import failed for module_that_does_not_exist_7f91/.test(boot.error), boot.error);
    check('W4b scratch cleaned up even when the smoke import fails',
      calls.some((s) => s === 'unlink:' + scratch), JSON.stringify(calls.slice(-6)));
    const shaRmdirAt4 = calls.indexOf('rmdir:/tmp/locus-plugin-artifacts/' + WHEEL_SHA256);
    const parentRmdirAt4 = calls.indexOf('rmdir:/tmp/locus-plugin-artifacts');
    check('W4c parent scratch dir also removed when the smoke import fails',
      shaRmdirAt4 !== -1 && parentRmdirAt4 > shaRmdirAt4,
      JSON.stringify(calls.filter((s) => s.startsWith('rmdir'))));
  }

  // ---------------- W4d: two wheels, per-wheel parent cleanup ----------------
  // Two modules (the real harness shape for multi-wheel sets: exactly one
  // wheel each). Each wheel's cleanup must attempt the parent scratch dir on
  // its own — for the second wheel the parent was recreated by its mkdirTree,
  // so a single shared cleanup would miss it. The fake FS never materializes
  // the parent entry, so every parent rmdir throws and must be swallowed:
  // the boot still locks and both sha dirs are gone afterwards. (A parent
  // rmdir failing with ENOTEMPTY — a non-empty parent — is not reachable in
  // the sequential install flow: every wheel unlinks its own file and rmdirs
  // its own sha dir before the next wheel runs, so the parent is always empty
  // at that point with the fix in place.)
  {
    const calls = [];
    const posted = [];
    let pyRef = null;
    const secondBytes = WHEEL_BYTES.slice();
    secondBytes[3] ^= 0x5a;
    const secondSha = cryptoNode.createHash('sha256').update(secondBytes).digest('hex');
    const wheelTwo = [{
      filename: 'locus_test_plugin-1.0.1-py3-none-any.whl', format: 'python-wheel',
      size: secondBytes.byteLength, sha256: secondSha, bytes: secondBytes,
    }];
    const c = makeWorkerContext(async () => { pyRef = makeFakePy(calls, { importable: ['locus_test_plugin'] }); return pyRef; }, posted, calls, { withCrypto: true });
    await postBootstrap(c, [
      { pluginId: 'locus-test-plugin', wheels: goodWheels(), imports: ['locus_test_plugin'] },
      { pluginId: 'locus-test-plugin-two', wheels: wheelTwo, imports: ['locus_test_plugin'] },
    ]);
    const boot = await waitForBoot(posted);
    check('W4d two-wheel boot locks with per-wheel parent scratch cleanup',
      !boot.error && boot.status === 'locked'
      && calls.some((s) => s === 'rmdir:/tmp/locus-plugin-artifacts/' + WHEEL_SHA256)
      && calls.some((s) => s === 'rmdir:/tmp/locus-plugin-artifacts/' + secondSha)
      && calls.filter((s) => s === 'rmdir:/tmp/locus-plugin-artifacts').length === 2
      && calls.indexOf('rmdir:/tmp/locus-plugin-artifacts') > calls.indexOf('rmdir:/tmp/locus-plugin-artifacts/' + WHEEL_SHA256)
      && calls.lastIndexOf('rmdir:/tmp/locus-plugin-artifacts') > calls.indexOf('rmdir:/tmp/locus-plugin-artifacts/' + secondSha)
      && !pyRef._files.has('/tmp/locus-plugin-artifacts/' + WHEEL_SHA256)
      && !pyRef._files.has('/tmp/locus-plugin-artifacts/' + secondSha),
      JSON.stringify({ bootError: boot.error, rmdirs: calls.filter((s) => s.startsWith('rmdir')) }));
  }

  // ---------------- W6: files payload at the worker fails the boot closed ----------------
  {
    const calls = [];
    const posted = [];
    const c = makeWorkerContext(async () => makeFakePy(calls, { importable: ['synthetic_module'] }), posted, calls, { withCrypto: true });
    await postBootstrap(c, [{ pluginId: 'synthetic-python-plugin', files: { 'synthetic_module.py': 'def answer():\n    return 42\n' }, imports: ['synthetic_module'] }]);
    const boot = await waitForBoot(posted);
    check('W6 files payload at the worker fails the boot closed (wheel-only, no READY)',
      !!boot.error && /source-text payloads are no longer supported/.test(boot.error)
        && boot.status !== 'locked',
      boot.error);
    check('W6b nothing was written into site-packages after the refusal',
      !calls.some((s) => s.startsWith('writeFile:')),
      JSON.stringify(calls.filter((s) => s.startsWith('writeFile'))));
  }

  // ---------------- W7: no WebCrypto subtle ----------------
  {
    const calls = [];
    const posted = [];
    const c = makeWorkerContext(async () => makeFakePy(calls, {}), posted, calls, { withCrypto: false });
    await postBootstrap(c, [{ pluginId: 'locus-test-plugin', wheels: goodWheels(), imports: ['locus_test_plugin'] }]);
    const boot = await waitForBoot(posted);
    check('W7 missing WebCrypto subtle -> integrity unavailable, fail closed',
      !!boot.error && /artifact integrity unavailable \(WebCrypto subtle missing\)/.test(boot.error), boot.error);
  }

  // ---------------- W8: core boot never loads the installer ----------------
  {
    const calls = [];
    const posted = [];
    const c = makeWorkerContext(async () => makeFakePy(calls, { importable: [] }), posted, calls, { withCrypto: true });
    await postBootstrap(c, []);
    const boot = await waitForBoot(posted);
    check('W8 core boot (no extensions) never loads micropip',
      !boot.error && boot.status === 'locked'
      && !calls.some((s) => s.indexOf('loadPackage:micropip') !== -1),
      boot.error + ' | ' + calls.filter((s) => s.startsWith('loadPackage')).join(','));
  }
  {
    const calls = [];
    const posted = [];
    const c = makeWorkerContext(async () => makeFakePy(calls, { importable: [] }), posted, calls, { withCrypto: true });
    await postBootstrap(c); // legacy bootstrap message without extensionModules at all
    const boot = await waitForBoot(posted);
    check('W8b bootstrap message without extensionModules boots core-only',
      !boot.error && boot.status === 'locked', boot.error);
  }

  // ---------------- mixed message with a source-text module ----------------
  {
    const calls = [];
    const posted = [];
    const c = makeWorkerContext(async () => makeFakePy(calls, { importable: ['locus_test_plugin', 'synthetic_module'] }), posted, calls, { withCrypto: true });
    await postBootstrap(c, [
      { pluginId: 'synthetic-python-plugin', files: { 'synthetic_module.py': 'x = 1\n' }, imports: ['synthetic_module'] },
      { pluginId: 'locus-test-plugin', wheels: goodWheels(), imports: ['locus_test_plugin'] },
    ]);
    const boot = await waitForBoot(posted);
    check('W8c mixed message with a source-text module fails the boot closed',
      !!boot.error && /source-text payloads are no longer supported/.test(boot.error)
        && boot.status !== 'locked'
        && !calls.some((s) => s.startsWith('writeFile:')),
      boot.error);
  }

  // ---------------- source-contract pins ----------------
  check('S1 micropip install command pins deps=False in the worker source',
    workerSrc.includes('deps=False') && workerSrc.includes('micropip.install("emfs:'), '');
  check('S2 worker source documents the wheel-only protocol (LEGACY path gone)',
    !workerSrc.includes('LEGACY SYNTHETIC COMPOSITION PATH')
      && workerSrc.includes('source-text payloads are no longer supported'), '');
  check('S3 plugin wheel scratch root is /tmp only, never a VFS managed root',
    workerSrc.includes("'/tmp/locus-plugin-artifacts/'")
      && !/MANAGED_ROOTS.*locus-plugin-artifacts|locus-plugin-artifacts.*MANAGED_ROOTS/.test(workerSrc), '');
  check('S4 shell manifest never carries a plugin wheel (payload travels by message)',
    !/locus_test_plugin-\d/.test(SHELL_SRC), '');
  check('S5 package artifact bound matches Capability Package Core (64 MiB)',
    SHELL.PYTHON_PLUGIN_WHEEL_MAX_BYTES === 64 * 1024 * 1024, String(SHELL.PYTHON_PLUGIN_WHEEL_MAX_BYTES));

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.error('TEST RUNNER FAIL', e && e.stack || e); process.exit(1); });
