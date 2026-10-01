// Pyodide worker init recovery test (F14): a failed first load must NOT be
// cached forever — the next run retries. Drives the REAL worker source
// (the runtime asset module) with a stubbed loadPyodide.
// Run: node tests/worker-init.test.cjs

const vm = require('vm');

// M2a: the worker source is a runtime asset module (never index.html).
const { PY_WORKER_SOURCE: workerSrc } = require('./helpers/runtime.cjs');

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + detail : '')); }
}

async function run() {
  let attempts = 0;
  const c = vm.createContext({
    self: { postMessage() {} }, // boot replies (protocol v3) are ignored here
    // Worker-global primitives the F04a lockdown expects to find and deny.
    fetch: function () {},
    XMLHttpRequest: function () {},
    WebSocket: function () {},
    importScripts() {},
    loadPyodide: async () => {
      attempts++;
      if (attempts === 1) throw new Error('temporary CDN failure');
      // Full FS call surface used by syncIn/diffOut (protocol v2), so the
      // mock matches the worker's real needs even though init only loads.
      return {
        FS: {
          mkdirTree() {}, writeFile() {}, readFile() { return new Uint8Array(); },
          readdir() { return []; }, stat() { return { mode: 0, size: 0 }; },
          unlink() {}, chmod() {}, isDir() { return false; },
        },
        runPython() {}, // subtree-delete shim (shutil.rmtree of managed roots)
        setStdout() {}, setStderr() {},
        loadPackage: async () => {},
      };
    },
  });
  vm.runInContext(workerSrc, c);

  // Protocol v3: the boot parks on the in-memory assets waiter — start the
  // first attempt, THEN deliver the bootstrap assets (unit stubs — the
  // sandbox provides loadPyodide) and let that attempt settle.
  const first = vm.runInContext('ensureLockedPyodide()', c);
  await vm.runInContext(`self.onmessage({ data: ${JSON.stringify({
    id: 1, cmd: 'bootstrap',
    assets: {
      'pyodide.js': { text: '/* unit stub: loadPyodide comes from the sandbox */' },
      'pyodide.asm.js': { text: 'var _createPyodideModule = function () {};' },
    },
  })} })`, c);

  // first attempt fails
  let e1 = null;
  try { await first; } catch (e) { e1 = e; }
  check('W-I1 first load fails', e1 && e1.message === 'temporary CDN failure', e1 && e1.message);

  // second attempt must RETRY (not reuse the rejected promise)
  let py = null, e2 = null;
  try { py = await vm.runInContext('ensureLockedPyodide()', c); } catch (e) { e2 = e; }
  check('W-I2 second attempt retries and succeeds', !e2 && !!py, e2 && e2.message);
  check('W-I3 loadPyodide actually attempted twice', attempts === 2, 'attempts=' + attempts);
  check('W-I4 lockdown applied after successful bootstrap', (() => {
    const r = vm.runInContext("(function () { try { fetch('http://127.0.0.1:9/probe'); return 'allowed'; } catch (e) { return 'denied: ' + e.message; } })()", c);
    return r.startsWith('denied: Python network access is disabled');
  })(), 'fetch probe result');
  check('W-I5 runtime package load happened before lockdown (state locked)',
    vm.runInContext('bootPhase', c) === 'locked', vm.runInContext('typeof bootPhase', c));

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.error('TEST RUNNER FAIL', e); process.exit(1); });
