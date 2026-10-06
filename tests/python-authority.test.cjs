// Python authority tests (F04a): the model-generated code inside the Pyodide
// worker must have NO unmediated network path and NO user-driven package
// downloads. Like the grep-worker suite, these tests drive the REAL worker
// source extracted from index.html — the shipped artifact, not a mock.
//
//  PA1  the production path never calls loadPackagesFromImports(user code)
//  PA2  the declared runtime package policy exists (harness-owned list)
//  PA3  lockdown is applied BEFORE any user code executes
//  PA4  fetch denied to user code
//  PA5  XMLHttpRequest denied
//  PA6  WebSocket denied
//  PA7  Worker (nested-worker escape) denied
//  PA8  importScripts denied
//  PA9  eval/Function/loadPyodide denials (dynamic-JS escape closed)
//  PA10 py.loadPackage / loadPackagesFromImports neutered after bootstrap
//  PA11 a fresh worker (reset/recovery path) reapplies the lockdown
//  PA12 a retried bootstrap (fatal worker recovery path) reapplies the lockdown
//  PA13 a worker whose required primitives cannot lock fails CLOSED
//  PB   the same boundary under a REAL worker object graph, where the
//       primitives are owned by the scope PROTOTYPES, not by the global
//       (the structural blind spot that hid F04a-A1 — every owning level
//       must be locked, unlockable levels fail closed, sendBeacon present
//       on the navigator chain is locked too)
//  plus: compute keeps working after the lockdown; prompt/docs contract.
// Run: node tests/python-authority.test.cjs

const fs = require('fs');
const vm = require('vm');
const path = require('path');

// M2a: the worker source is a runtime asset module (never index.html).
const { PY_WORKER_SOURCE: workerSrc } = require('./helpers/runtime.cjs');

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + detail : '')); }
}

const DENY_MESSAGE = 'Python network access is disabled in Locus; use the shell curl command for HTTP/HTTPS';
const LOADER_MESSAGE = 'Python package loading is controlled by the Locus runtime';

// Fake Pyodide instance: enough FS surface for the protocol, plus a
// self-checking runPythonAsync that refuses to run user code unless the
// network lockdown is already in place (PA3).
function makeFakePy(calls, ctx) {
  const files = new Map([['/', 'DIR'], ['/tmp', 'DIR']]);
  return {
    _files: files,
    async loadPackage(pkgs) { calls.push('loadPackage:' + String(pkgs)); },
    async runPythonAsync(code) {
      const g = vm.runInContext('globalThis', ctx);
      const denied = !!g.fetch && g.fetch.__locusNetworkDenied === true;
      calls.push('py:' + String(code).slice(0, 24));
      if (String(code).indexOf('os.chdir') === -1 && !denied) {
        throw new Error('USER CODE RAN BEFORE LOCKDOWN');
      }
    },
    runPython() {},
    FS: {
      mkdirTree() {}, writeFile() {}, readFile() { return new Uint8Array(); },
      readdir() { return []; }, stat() { return { mode: 0, size: 0 }; },
      unlink() {}, chmod() {}, isDir() { return false; },
    },
    setStdout() {}, setStderr() {},
  };
}

// One worker context with the worker-global primitives a real Chrome
// DedicatedWorkerGlobalScope exposes (the lockdown must find and deny them).
// `omit` drops named primitives — used to prove the lockdown fails closed
// when a REQUIRED primitive cannot be locked.
function makeWorkerContext(loadPyodideImpl, posted, calls, omit) {
  omit = omit || [];
  const sandbox = {
    self: { postMessage(msg) { if (msg.type === 'result' || msg.type === 'boot') posted.push(msg); } },
    importScripts() { calls.push('importScripts'); },
    loadPyodide: loadPyodideImpl,
    atob, btoa, TextEncoder, TextDecoder,
  };
  if (omit.indexOf('fetch') === -1) sandbox.fetch = function () { calls.push('fetch:RAN'); };
  if (omit.indexOf('XMLHttpRequest') === -1) sandbox.XMLHttpRequest = function () { calls.push('xhr:RAN'); };
  if (omit.indexOf('WebSocket') === -1) sandbox.WebSocket = function () { calls.push('ws:RAN'); };
  if (omit.indexOf('Worker') === -1) sandbox.Worker = function () { calls.push('worker:RAN'); };
  // The worker schedules an uncaught self-destruct throw on lockdown
  // failure (real Chrome: worker.onerror rebuilds the worker). Capture it.
  sandbox.setTimeout = (fn) => { try { fn(); } catch (e) { calls.push('selfdestruct:' + (e && e.message || e)); } };
  sandbox.clearTimeout = () => {};
  const c = vm.createContext(sandbox);
  vm.runInContext(workerSrc, c);
  return c;
}

async function postRun(c, code, cwd) {
  const msg = { id: 7, cmd: 'run', code: code || 'x', cwd: cwd || '/tmp', mounts: [] };
  await vm.runInContext(`self.onmessage({ data: ${JSON.stringify(msg)} })`, c);
}

// Protocol v3 (F04b): the worker boots ENTIRELY from the in-memory asset
// set delivered by the trusted harness. Unit stubs: the sandbox provides
// loadPyodide; the asm stub defines the factory whose presence makes the
// real loader skip its own (network) script loading.
const BOOT_ASSETS = {
  'pyodide.js': { text: '/* unit stub: loadPyodide comes from the sandbox */' },
  'pyodide.asm.js': { text: 'var _createPyodideModule = function () {};' },
};
async function postBootstrap(c, assets) {
  const msg = { id: 1, cmd: 'bootstrap', assets: assets || BOOT_ASSETS };
  await vm.runInContext(`self.onmessage({ data: ${JSON.stringify(msg)} })`, c);
}

async function waitForResult(posted) {
  for (let i = 0; i < 400; i++) {
    const r = posted.find((m) => m.type === 'result');
    if (r) return r;
    await new Promise((r2) => setTimeout(r2, 5));
  }
  throw new Error('worker posted no result');
}

// Guest-side probe: what does a use of the primitive do now?
function guestTry(c, expr) {
  return vm.runInContext(`(function () {
    try { ${expr}; return 'ALLOWED'; }
    catch (e) { return 'DENIED: ' + (e && e.message || e); }
  })()`, c);
}

async function run() {
  // ---------- PA1: no user-driven package auto-loading ----------
  check('PA1 no loadPackagesFromImports call on user code',
    !/loadPackagesFromImports\s*\(/.test(workerSrc)
    && workerSrc.indexOf('await py.loadPackagesFromImports') === -1,
    'production source must never scan user imports for package downloads');
  check('PA1b loadPackagesFromImports exists only as a DENIED loader name',
    workerSrc.indexOf("'loadPackagesFromImports']") !== -1
    && workerSrc.indexOf('loadPackagesFromImports(') === -1, '');

  // ---------- PA2: declared runtime package policy ----------
  const pol = workerSrc.match(/const PYTHON_RUNTIME_PACKAGES = \[([^\]]*)\]/);
  check('PA2 fixed package policy exists as an auditable literal',
    !!pol && pol[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).join(',') === 'pandas',
    pol && pol[1]);

  // ---------- PA3-PA8 + denials: one boot, then the locked surface ----------
  const calls = [];
  const posted = [];
  const c = makeWorkerContext(async () => makeFakePy(calls, c), posted, calls);
  await postBootstrap(c);
  await postRun(c, "print('hi')");
  const r = await waitForResult(posted);
  check('PA3 boot succeeds and runs user code', !r.error, r.error);

  const order = calls.join(' | ');
  check('PA3b declared packages loaded at bootstrap, before user code',
    order.indexOf('loadPackage:pandas') !== -1
    && order.indexOf('loadPackage:pandas') < order.indexOf('py:print'), order);
  check('PA3c lockdown applied before user code (fake py self-check passed)',
    order.indexOf('USER CODE RAN BEFORE LOCKDOWN') === -1, order);

  // ---------- PA4-PA8: the denied network primitives ----------
  check('PA4 fetch denied', guestTry(c, "fetch('http://127.0.0.1:9/probe')")
    === 'DENIED: ' + DENY_MESSAGE, guestTry(c, "fetch('http://127.0.0.1:9/probe')"));
  check('PA5 XMLHttpRequest denied', guestTry(c, 'new XMLHttpRequest()')
    === 'DENIED: ' + DENY_MESSAGE, guestTry(c, 'new XMLHttpRequest()'));
  check('PA6 WebSocket denied', guestTry(c, "new WebSocket('ws://127.0.0.1:9/probe')")
    === 'DENIED: ' + DENY_MESSAGE, guestTry(c, "new WebSocket('ws://127.0.0.1:9/probe')"));
  check('PA7 nested Worker denied', guestTry(c, "new Worker('blob:probe')")
    === 'DENIED: ' + DENY_MESSAGE, guestTry(c, "new Worker('blob:probe')"));
  check('PA8 importScripts denied', guestTry(c, "importScripts('http://127.0.0.1:9/probe.js')")
    === 'DENIED: ' + DENY_MESSAGE, guestTry(c, "importScripts('http://127.0.0.1:9/probe.js')"));
  check('PA8b absent primitives are skipped, not fabricated',
    guestTry(c, 'typeof SharedWorker') === 'ALLOWED', guestTry(c, 'typeof SharedWorker'));

  // ---------- PA9: dynamic-JS escape denials ----------
  check('PA9 eval denied (dynamic-JS escape closed)', guestTry(c, "eval('1+1')")
    === 'DENIED: ' + DENY_MESSAGE, guestTry(c, "eval('1+1')"));
  check('PA9b Function stays native (Pyodide glue needs the global; see F04a-R1)',
    guestTry(c, "Function('return 1')()") === 'ALLOWED', guestTry(c, "Function('return 1')()"));
  check('PA9c loadPyodide denied (bootstrap not re-enterable)', guestTry(c, 'loadPyodide({})')
    === 'DENIED: ' + DENY_MESSAGE, guestTry(c, 'loadPyodide({})'));
  check('PA9d a property read of a denied primitive denies too',
    guestTry(c, "fetch('http://127.0.0.1:9/probe').call")
    === 'DENIED: ' + DENY_MESSAGE, guestTry(c, "fetch('http://127.0.0.1:9/probe').call"));

  // ---------- PA10: the neutered package loaders (JS instance level; the
  // Python-side pyodide.loadPackage route is proven in the browser e2e) ----
  check('PA10 py.loadPackage denied after bootstrap',
    guestTry(c, "py.loadPackage('regex')").startsWith('DENIED: ' + LOADER_MESSAGE),
    guestTry(c, "py.loadPackage('regex')"));
  check('PA10b py.loadPackagesFromImports denied after bootstrap',
    guestTry(c, "py.loadPackagesFromImports('import regex')").startsWith('DENIED: ' + LOADER_MESSAGE),
    guestTry(c, "py.loadPackagesFromImports('import regex')"));
  posted.length = 0;
  await postRun(c, "print('still-alive')");
  res = await waitForResult(posted);
  check('PA10c compute keeps working after the lockdown',
    !res.error, res.error);

  // ---------- PA11: fresh worker (reset/recovery) reapplies the lockdown ----
  const calls2 = [];
  const posted2 = [];
  const c2 = makeWorkerContext(async () => makeFakePy(calls2, c2), posted2, calls2);
  await postBootstrap(c2);
  await postRun(c2, 'x');
  await waitForResult(posted2);
  check('PA11 a fresh worker applies the same lockdown',
    guestTry(c2, "fetch('http://127.0.0.1:9/probe')") === 'DENIED: ' + DENY_MESSAGE
    && guestTry(c2, "importScripts('http://127.0.0.1:9/probe.js')").startsWith('DENIED:'), '');

  // ---------- PA12: retried bootstrap (fatal recovery) reapplies lockdown ---
  const calls3 = [];
  const posted3 = [];
  let attempts = 0;
  const c3 = makeWorkerContext(async () => {
    attempts++;
    if (attempts === 1) throw new Error('temporary CDN failure');
    return makeFakePy(calls3, c3);
  }, posted3, calls3);
  await postBootstrap(c3);
  await postRun(c3, 'x');
  const boot3 = posted3.find((m) => m.type === 'boot');
  const r3a = posted3.find((m) => m.type === 'result');
  check('PA12 failed bootstrap reports honestly at the boot boundary and is not cached',
    !!boot3 && !!boot3.error && boot3.error.includes('temporary CDN failure'), boot3 && boot3.error);
  check('PA12a the next run retries the bootstrap instead of reusing the failure',
    !!r3a && !r3a.error, r3a && r3a.error);
  posted3.length = 0;
  await postRun(c3, 'x');
  await waitForResult(posted3);
  check('PA12b retried bootstrap reapplies the lockdown',
    attempts === 2 && guestTry(c3, "fetch('http://127.0.0.1:9/probe')") === 'DENIED: ' + DENY_MESSAGE, '');

  // ---------- PA13: lockdown failure is fail-closed, never half-locked ------
  const calls4 = [];
  const posted4 = [];
  const c4 = makeWorkerContext(async () => makeFakePy(calls4, c4), posted4, calls4, ['fetch']);
  await postBootstrap(c4);
  await postRun(c4, 'x');
  const r4 = await waitForResult(posted4);
  check('PA13 a worker whose required primitives cannot lock fails closed',
    !!r4.error && r4.error.includes('Python worker failed to apply the network lockdown'), r4.error);
  check('PA13b a lockdown-failed worker schedules self-destruct (shell rebuilds)',
    calls4.some((c) => String(c).indexOf('selfdestruct:Python worker failed to apply the network lockdown') === 0),
    JSON.stringify(calls4));

  // ---------- PB: prototype-chain layout (the F04a-A1 blind spot) ----------
  // The flat sandbox above owns every primitive as an own property of the
  // global. A REAL Chrome dedicated worker does NOT: in the audited object
  // graph (F04a-A1) fetch/importScripts/caches/timers live on the scope
  // PROTOTYPES — which is exactly why the original lockdown's prototype
  // layer was dead code and Object.getPrototypeOf(self).fetch handed back a
  // working native fetch. This context reproduces that shape on the
  // context's REAL prototype chain (vm exposes globalThis → p → p2):
  // the global owns only instance-family primitives (Worker — as audited),
  // p owns XHR/WebSocket/caches, p2 owns fetch/importScripts/caches/timers,
  // and an onmessage WebIDL accessor (get/set) lives on p. `caches` is
  // owned at BOTH prototype levels to pin the one-denied-instance-per-name
  // rule across levels.
  function makeProtoWorkerContext(loadPyodideImpl, posted, calls, opts) {
    opts = opts || {};
    const sandbox = {
      self: null,
      __calls: calls,
      loadPyodide: loadPyodideImpl,
      atob: atob, btoa: btoa,
      TextEncoder: TextEncoder, TextDecoder: TextDecoder,
      Worker: function () { calls.push('worker:RAN'); }, // instance-own family (audited Chrome)
      postMessage: function (msg) { if (msg.type === 'result' || msg.type === 'boot') posted.push(msg); },
      navigator: Object.create({ sendBeacon() { calls.push('beacon:RAN'); } }),
    };
    const c = vm.createContext(sandbox);
    vm.runInContext('(function () {\n' +
      '  globalThis.self = globalThis;\n' +
      '  const p = Object.getPrototypeOf(globalThis);\n' +
      '  const p2 = Object.getPrototypeOf(p);\n' +
      '  p.XMLHttpRequest = function () { __calls.push("xhr:RAN"); };\n' +
      '  p.WebSocket = function () { __calls.push("ws:RAN"); };\n' +
      '  p.caches = function () { __calls.push("caches:RAN"); };\n' +
      '  p2.fetch = function () { __calls.push("fetch:RAN"); };\n' +
      '  p2.importScripts = function () { __calls.push("importScripts:RAN"); };\n' +
      '  p2.caches = function () { __calls.push("caches:RAN"); };\n' +
      '  p2.setTimeout = function (fn) {\n' +
      '    __calls.push("timer:RAN");\n' +
      '    if (typeof fn === "function") { try { fn(); } catch (e) { __calls.push("selfdestruct:" + (e && e.message || e)); } }\n' +
      '  };\n' +
      '  p2.setInterval = function () { __calls.push("itimer:RAN"); };\n' +
      '  p2.clearTimeout = function () {};\n' +
      (opts.freezeFetch
        ? '  Object.defineProperty(p2, "fetch", { value: p2.fetch, writable: false, configurable: false });\n'
        : '') +
      (opts.freezeOnmessageOwn
        ? '  // PB17 fixture: an OWN non-configurable event-handler slot on the\n' +
          '  // global itself. An ACCESSOR shape is required — a non-configurable\n' +
          '  // WRITABLE data slot can still be locked (narrowing writable is the\n' +
          '  // one redefinition ES allows on non-configurable properties), and a\n' +
          '  // frozen data slot locks as a same-value redefinition. Only the\n' +
          '  // data-over-accessor kind change is undefinable, so only it makes\n' +
          '  // the lockdown\'s own defineProperty throw. The setter keeps\n' +
          '  // registering the worker\'s own handler so nothing ELSE is broken.\n' +
          '  const storedOwn = { current: null };\n' +
          '  Object.defineProperty(globalThis, "onmessage", { get() { return storedOwn.current; }, set(v) { storedOwn.current = v; }, configurable: false });\n'
        : '') +
      '  const stored = { current: null };\n' +
      '  Object.defineProperty(p, "onmessage", { get() { return stored.current; }, set(v) { stored.current = v; }, configurable: true });\n' +
      '})()', c);
    vm.runInContext(workerSrc, c);
    return c;
  }

  // For every prototype-chain level of the guest global that OWNS `name`,
  // does its own descriptor value carry `mark`? (Structural counterpart of
  // the worker's fail-closed self-check.)
  function levelMarks(c, name, mark) {
    return vm.runInContext('(function () {\n' +
      '  const marks = [];\n' +
      '  let cur = globalThis;\n' +
      '  while (cur) {\n' +
      '    if (Object.prototype.hasOwnProperty.call(cur, ' + JSON.stringify(name) + ')) {\n' +
      '      const d = Object.getOwnPropertyDescriptor(cur, ' + JSON.stringify(name) + ');\n' +
      '      marks.push(!!(d && d.value && d.value.' + mark + ' === true));\n' +
      '    }\n' +
      '    cur = Object.getPrototypeOf(cur);\n' +
      '  }\n' +
      '  return marks;\n' +
      '})()', c);
  }

  const callsP = [];
  const postedP = [];
  const cp = makeProtoWorkerContext(async () => makeFakePy(callsP, cp), postedP, callsP);
  await postBootstrap(cp);
  await postRun(cp, "print('proto')");
  const rp = await waitForResult(postedP);
  check('PB1 boot succeeds on the prototype-chain layout (audited Chrome worker shape)', !rp.error, rp.error);

  const escP = (expr) => guestTry(cp, expr);
  const DENY = 'DENIED: ' + DENY_MESSAGE;
  const p2fetch = escP("fetch('http://127.0.0.1:9/probe')");
  check('PB2 chain-resolved fetch is the denial', p2fetch === DENY, p2fetch);
  const p1fetch = escP("Object.getPrototypeOf(self).fetch('http://127.0.0.1:9/probe')");
  check('PB3 prototype-level fetch is denied (the F04a-A1 escape, one hop)', p1fetch === DENY, p1fetch);
  const p2hop = escP("Object.getPrototypeOf(Object.getPrototypeOf(self)).fetch('http://127.0.0.1:9/probe')");
  check('PB4 prototype-level fetch two hops up is denied', p2hop === DENY, p2hop);
  const refl = escP("Reflect.apply(Object.getPrototypeOf(self).fetch, self, ['http://127.0.0.1:9/probe'])");
  check('PB5 Reflect.apply on the prototype fetch is denied', refl === DENY, refl);
  const dvcall = escP("Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Object.getPrototypeOf(self)), 'fetch').value.call(self, 'http://127.0.0.1:9/probe')");
  check('PB6 descriptor.value.call on the prototype fetch is denied', dvcall === DENY, dvcall);
  const bound = escP("Object.getPrototypeOf(self).fetch.bind(self)('http://127.0.0.1:9/probe')");
  check('PB7 a bound prototype fetch is denied', bound === DENY, bound);
  const is1 = escP("Object.getPrototypeOf(self).importScripts('http://127.0.0.1:9/probe.js')");
  const is2 = escP("Object.getPrototypeOf(Object.getPrototypeOf(self)).importScripts('http://127.0.0.1:9/probe.js')");
  check('PB8 prototype importScripts denied at every owning level', is1 === DENY && is2 === DENY,
    JSON.stringify([is1, is2]));
  const xhrP = escP("new (Object.getPrototypeOf(self).XMLHttpRequest)()");
  const wsP = escP("new (Object.getPrototypeOf(self).WebSocket)('ws://127.0.0.1:9/')");
  const wkP = escP("new Worker('blob:probe')");
  check('PB9 prototype XHR/WebSocket and instance-own Worker all denied (no native survivor on the chain)',
    xhrP === DENY && wsP === DENY && wkP === DENY, JSON.stringify([xhrP, wsP, wkP]));
  const t1 = escP("Object.getPrototypeOf(self).setTimeout(\"import('http://127.0.0.1:9/probe.js')\", 0)");
  const t2 = escP("Object.getPrototypeOf(Object.getPrototypeOf(self)).setInterval(\"import('http://127.0.0.1:9/probe.js')\", 0)");
  const t3 = escP("setTimeout(function () {}, 0)");
  check('PB10 prototype timer string handlers denied; real function handler still reaches the native timer',
    t1 === DENY && t2 === DENY && t3 === 'ALLOWED' && callsP.indexOf('timer:RAN') !== -1,
    JSON.stringify([t1, t2, t3, callsP.slice(-3)]));
  const fetchMarks = levelMarks(cp, 'fetch', '__locusNetworkDenied');
  const xhrMarks = levelMarks(cp, 'XMLHttpRequest', '__locusNetworkDenied');
  const workerMarks = levelMarks(cp, 'Worker', '__locusNetworkDenied');
  check('PB11 every owning level carries the denial mark (fetch on p2, XHR on p, Worker own)',
    fetchMarks.length >= 1 && fetchMarks.every(Boolean)
    && xhrMarks.length >= 1 && xhrMarks.every(Boolean)
    && workerMarks.length >= 1 && workerMarks.every(Boolean),
    JSON.stringify([fetchMarks, xhrMarks, workerMarks]));
  const cacheMarks = levelMarks(cp, 'caches', '__locusNetworkDenied');
  const sameInstance = vm.runInContext(
    'Object.getOwnPropertyDescriptor(Object.getPrototypeOf(globalThis), "caches").value === ' +
    'Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Object.getPrototypeOf(globalThis)), "caches").value', cp);
  check('PB11b a name owned at TWO prototype levels is locked at both with the SAME denied instance',
    cacheMarks.length === 2 && cacheMarks.every(Boolean) && sameInstance === true,
    JSON.stringify([cacheMarks, sameInstance]));
  const timerMarksP = levelMarks(cp, 'setTimeout', '__locusTimerSafe');
  const timerMarksI = levelMarks(cp, 'setInterval', '__locusTimerSafe');
  check('PB12 every owning timer level carries the safe-wrapper mark',
    timerMarksP.length >= 1 && timerMarksP.every(Boolean)
    && timerMarksI.length >= 1 && timerMarksI.every(Boolean)
    && levelMarks(c, 'setTimeout', '__locusTimerSafe').every(Boolean),
    JSON.stringify([timerMarksP, timerMarksI]));
  const beacon = escP("navigator.sendBeacon('http://127.0.0.1:9/probe', 'x')");
  check('PB13 navigator.sendBeacon locked when the navigator chain exposes it (F04a-A5 forward defense)',
    beacon === DENY, beacon);
  const setter = escP("Object.getOwnPropertyDescriptor(Object.getPrototypeOf(self), 'onmessage').set.call(self, 'import(1)')");
  check('PB14 a prototype-level onmessage WebIDL setter is replaced by a set-throws denial',
    setter === DENY, setter);
  postedP.length = 0;
  await postRun(cp, "print('still-alive')");
  const rp2 = await waitForResult(postedP);
  check('PB15 compute keeps working after the prototype-chain lockdown', !rp2.error, rp2.error);

  // PB16: an UNLOCKABLE prototype level (non-configurable own slot) must
  // fail the whole bootstrap closed — never a half-locked worker.
  const callsR = [];
  const postedR = [];
  const cr = makeProtoWorkerContext(async () => makeFakePy(callsR, cr), postedR, callsR, { freezeFetch: true });
  await postBootstrap(cr);
  await postRun(cr, 'x');
  const rr = await waitForResult(postedR);
  const bootR = postedR.find((m) => m.type === 'boot');
  check('PB16 an unlockable prototype level fails the bootstrap closed (boot reply keeps the raw detail)',
    !!bootR && !!bootR.error && /fetch/.test(bootR.error)
      && !!rr.error && rr.error.includes('Python worker failed to apply the network lockdown'),
    JSON.stringify([bootR && bootR.error, rr.error]).slice(0, 240));
  check('PB16b the failed bootstrap schedules self-destruct (shell rebuild path)',
    callsR.some((s) => String(s).indexOf('selfdestruct:') === 0), JSON.stringify(callsR.slice(-3)));
  postedR.length = 0;
  await postRun(cr, 'x');
  const rr2 = await waitForResult(postedR);
  check('PB16c the failed-locked worker stays failed (no half-locked retry)',
    !!rr2.error && rr2.error.includes('Python worker failed to apply the network lockdown'), rr2.error);

  // PB17: an UNLOCKABLE event-handler OWN slot (non-configurable own
  // onmessage) must fail the whole bootstrap closed — never a silent
  // swallow-and-continue into a half-locked worker. Every OTHER lockdown
  // target stays normally lockable, so the bootstrap fails BECAUSE of the
  // event-handler own slot, not because some primitive tripped first.
  const callsE = [];
  const postedE = [];
  const ce = makeProtoWorkerContext(async () => makeFakePy(callsE, ce), postedE, callsE, { freezeOnmessageOwn: true });
  await postBootstrap(ce);
  await postRun(ce, 'x');
  const rrE = await waitForResult(postedE);
  const bootE = postedE.find((m) => m.type === 'boot');
  check('PB17 a non-configurable own event-handler slot fails the bootstrap closed (boot reply keeps the raw detail)',
    !!bootE && !!bootE.error && /onmessage/.test(bootE.error)
      && !!rrE.error && rrE.error.includes('Python worker failed to apply the network lockdown'),
    JSON.stringify([bootE && bootE.error, rrE.error]).slice(0, 240));
  check('PB17b no user Python ran in the failed worker (bootstrap traffic only)',
    callsE.every((s) => String(s).indexOf('py:') !== 0), JSON.stringify(callsE));
  check('PB17c the failed bootstrap schedules self-destruct (shell rebuild path)',
    callsE.some((s) => String(s).indexOf('selfdestruct:Python worker failed to apply the network lockdown') === 0),
    JSON.stringify(callsE.slice(-3)));
  // Causality proof: every lockdown stage that runs BEFORE the event-handler
  // own-slot sweep must have completed on the failed context — the required
  // primitives at every owning level, the timers, the beacon. If any of
  // these were unlocked, the test would be failing for the wrong reason.
  const eMarks = {};
  let earlierStagesAllLocked = true;
  for (const n of ['fetch', 'XMLHttpRequest', 'WebSocket', 'Worker', 'importScripts', 'caches', 'eval', 'loadPyodide']) {
    const mk = levelMarks(ce, n, '__locusNetworkDenied');
    eMarks[n] = mk;
    if (!(mk.length >= 1 && mk.every(Boolean))) earlierStagesAllLocked = false;
  }
  for (const n of ['setTimeout', 'setInterval']) {
    const mk = levelMarks(ce, n, '__locusTimerSafe');
    eMarks[n] = mk;
    if (!(mk.length >= 1 && mk.every(Boolean))) earlierStagesAllLocked = false;
  }
  check('PB17d every earlier lockdown stage completed (failure is exactly the event-handler own slot)',
    earlierStagesAllLocked, JSON.stringify(eMarks));
  postedE.length = 0;
  await postRun(ce, 'x');
  const rrE2 = await waitForResult(postedE);
  check('PB17e the failed worker stays failed (no half-locked retry)',
    !!rrE2.error && rrE2.error.includes('Python worker failed to apply the network lockdown'), rrE2.error);

  // ---------- prompt/docs contract (model-facing authority wording) ---------
  const shellSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'shell.js'), 'utf8');
  // M3a: this package ships no agent module (three-repository split — the
  // agent stays in the product repository). The negative wording scan
  // applies to its text whenever the module is present here; an absent
  // module loads as empty text and the assertion holds on it.
  const agentPath = path.join(__dirname, '..', 'src', 'agent.js');
  // M3a: agent.js is Harness code and does not ship with the Runtime
  // package — PA14b holds vacuously here (nothing to scan). The binding
  // wording check remains the source repository's python-authority suite.
  const agentSrc = fs.existsSync(agentPath) ? fs.readFileSync(agentPath, 'utf8') : '';
  check('PA14 system prompt tells the model Python has no network path (use curl)',
    shellSrc.includes('Python has no network access') && shellSrc.includes('use curl for network'),
    'shell prompt must document the boundary');
  check('PA14b the old "Python can fetch" policy wording is gone',
    !agentSrc.includes('including Python code calling fetch directly'),
    'agent.js trust-boundary text must match the technical boundary');
  check('PA15 PYTHON_TIMEOUT_MS unchanged by F04a',
    shellSrc.includes('const PYTHON_TIMEOUT_MS = 30000;'), 'cancellation semantics out of scope');

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.error('TEST RUNNER FAIL', e && e.stack || e); process.exit(1); });
