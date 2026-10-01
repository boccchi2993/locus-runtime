// Python BROWSER authority e2e (F04b). Real headless Chrome, real CSP, real
// Blob workers -- proves the F04b architecture before and after the
// production change:
//
//   PHASE A -- boundary model: a strict-CSP creator iframe (hidden srcdoc
//   with <meta http-equiv="Content-Security-Policy">) creates a Blob
//   Worker, and the BROWSER -- not JavaScript monkey-patching -- makes
//   arbitrary network egress impossible from inside that worker:
//
//     default-src 'none';
//     connect-src 'none';
//     script-src 'unsafe-inline' 'unsafe-eval';
//     worker-src blob:;
//     child-src blob:;
//
//   The oracle is the probe servers' REQUEST COUNTERS (two ports/origins),
//   never the Promise rejection text. Local compute must keep working:
//   Function, eval, WebAssembly, Promise, timers and postMessage are all
//   exercised as positive controls. A no-CSP CONTROL worker (identical
//   battery, distinct /control/* probe paths) proves the counters actually
//   observe real requests -- the strict ZEROs cannot pass vacuously.
//
//   PHASE B -- in-memory Pyodide bootstrap: the TRUSTED harness (the page)
//   fetches the FIXED Pyodide asset set, transfers the bytes into a strict
//   CSP worker, and REAL Pyodide 0.26.4 boots ENTIRELY from memory:
//   pyodide.js / pyodide.asm.js are eval'd from text (never importScripts),
//   every fetch (lock file / wasm / stdlib / pandas wheels) is served by a
//   bootstrap-only in-memory resolver that fail-closes on unknown URLs.
//   After bootstrap the resolver is torn down, native fetch is restored --
//   and the escape battery runs against the SAME worker with the REAL
//   interpreter live. Oracle: the asset server saw EXACTLY the harness's
//   fixed bootstrap requests; the worker contributed ZERO, and every
//   post-bootstrap escape (js.fetch, pyfetch, loadPackage, Function import,
//   constructor import, importScripts, timers, nested workers) is blocked
//   by CSP with ZERO requests while pandas/numpy compute still works.
const fs = require('fs/promises');
const http = require('http');
const os = require('os');
const path = require('path');
const {
  allocateFreePort, closeChrome, connectToTarget, launchChrome, waitForCdp,
  waitForPageTarget, waitForRuntimeCondition,
} = require('./helpers/chrome.cjs');

// The strict policy under test. No http/https/blob/data source appears in
// script-src, so no browser loader (script tag, importScripts, dynamic or
// static import) has anything to load from the network; connect-src 'none'
// kills every fetch/XHR/WS/EventSource/sendBeacon; worker-src blob: allows
// ONLY harness-created Blob workers -- and a nested one inherits the same
// restrictive policy (proven below, not assumed).
const STRICT_CSP = "default-src 'none'; connect-src 'none'; "
  + "script-src 'unsafe-inline' 'unsafe-eval'; worker-src blob:; child-src blob:;";

// The FIXED Pyodide 0.26.4 asset set — derived from the runtime's pinned
// PYTHON_BOOTSTRAP_MANIFEST (src/shell.js, F04c single source of truth;
// sizes/hashes verified by scripts/verify-python-bootstrap-manifest.mjs).
// Harness-defined only -- nothing user-controlled ever reaches this list.
// The virtual origin keys the in-memory resolver; `.invalid` is a reserved
// TLD that can never resolve, and the resolver fail-closes on every URL it
// does not hold EXACTLY (no path/query variation).
const { loadPythonManifest } = require('./helpers/python-manifest.cjs');
const { base: PYODIDE_CDN, manifest: PY_MANIFEST, installerSupportFiles: PY_INSTALLER_FILES } = loadPythonManifest();
const VIRTUAL_BASE = 'https://locus-bootstrap.invalid/';
const ASSET_FILES = PY_MANIFEST.map((a) => ({ name: a.name, kind: a.kind, mime: a.mime }));
const ASSET_CACHE_DIR = path.join(__dirname, '..', 'tmp-f04b-probe', 'pyodide');

async function evaluate(cdp, expression, timeoutMs) {
  const result = await cdp.send('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true, timeout: timeoutMs || 120000,
  });
  if (result?.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails).slice(0, 600));
  return result?.result?.value;
}

// ---- Phase A worker battery -------------------------------------------
// `prefix` ('' for the strict worker under test, '/control' for the no-CSP
// control) routes every probe to a disjoint request-counter namespace.
function buildWorkerSrc(portA, portB, prefix) {
  return `
var PROBE_A = 'http://127.0.0.1:${portA}${prefix}';
var PROBE_B = 'http://127.0.0.1:${portB}${prefix}';
var out = [];
function note(tag, verdict, detail) {
  out.push({ tag: tag, verdict: verdict, detail: String(detail == null ? '' : detail).slice(0, 200) });
}
function attempt(tag, fn) {
  return Promise.resolve().then(fn).then(
    function (v) { note(tag, 'ALLOWED', v === undefined ? '' : v); },
    function (e) { note(tag, 'BLOCKED', (e && e.name || 'Error') + ': ' + (e && e.message || e)); });
}
var probes = [
  ['fn-compute', function () { return new Function('return 40 + 2')(); }],
  ['eval-compute', function () { return (0, eval)('6 * 7'); }],
  ['wasm-compile', function () { return WebAssembly.compile(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])).then(function () { return 'module'; }); }],
  ['promise', function () { return Promise.resolve(7); }],
  ['fetch-same-origin', function () { return fetch(PROBE_A + '/probe-hit').then(function (r) { return r.status; }); }],
  ['fetch-cross-origin', function () { return fetch(PROBE_B + '/probe-hit').then(function (r) { return r.status; }); }],
  ['xhr-sync', function () { var x = new XMLHttpRequest(); x.open('GET', PROBE_B + '/probe-hit', false); x.send(); return x.status; }],
  ['xhr-async', function () { return new Promise(function (resolve, reject) {
      var x = new XMLHttpRequest();
      x.open('GET', PROBE_A + '/probe-hit');
      x.onload = function () { resolve(x.status); };
      x.onerror = function () { reject(new Error('XHR network error')); };
      x.send();
    }); }],
  ['websocket', function () { return new Promise(function (resolve, reject) {
      var ws = new WebSocket('ws://127.0.0.1:${portB}${prefix}/probe-hit');
      ws.onopen = function () { ws.close(); resolve('open'); };
      ws.onerror = function () { try { ws.close(); } catch (e) {} reject(new Error('WS error')); };
    }); }],
  ['eventsource', function () { return new Promise(function (resolve, reject) {
      var es = new EventSource(PROBE_A + '/probe-hit');
      es.onopen = function () { es.close(); resolve('open'); };
      es.onerror = function () { es.close(); reject(new Error('ES error')); };
    }); }],
  ['sendbeacon', function () {
      if (typeof navigator === 'undefined' || typeof navigator.sendBeacon !== 'function') return 'absent';
      return navigator.sendBeacon(PROBE_B + '/probe-hit', 'x') ? 'queued' : 'not-queued';
    }],
  ['importscripts', function () { importScripts(PROBE_B + '/probe-script.js'); return 'imported'; }],
  ['import-dynamic', function () { return import(PROBE_A + '/probe-module.js').then(function () { return 'imported'; }); }],
  ['import-dynamic-cross', function () { return import(PROBE_B + '/probe-module.js').then(function () { return 'imported'; }); }],
  ['fn-dynamic-import', function () { return new Function('u', 'return import(u)')(PROBE_B + '/probe-module.js').then(function () { return 'imported'; }); }],
  ['constructor-dynamic-import', function () { return console.log.constructor('u', 'return import(u)')(PROBE_A + '/probe-module.js').then(function () { return 'imported'; }); }],
  ['proto-fetch', function () {
      var lvl = Object.getPrototypeOf(self);
      var native = (lvl && lvl.fetch) || (lvl && Object.getPrototypeOf(lvl) || {}).fetch || self.fetch;
      if (!native) throw new Error('no native fetch found on the chain');
      return Reflect.apply(native, self, [PROBE_B + '/probe-hit']).then(function (r) { return r.status; });
    }],
  ['eval-dynamic-import', function () { return (0, eval)("(import('" + PROBE_B + "/probe-module.js'))").then(function () { return 'imported'; }); }],
  ['timer-string', function () { return new Promise(function (resolve) {
      self.__tsVerdict = 'pending';
      setTimeout("import('" + PROBE_B + "/probe-module.js').then(function(){ self.__tsVerdict = 'timer-import-ALLOWED'; }, function(){ self.__tsVerdict = 'timer-import-blocked'; })", 0);
      setTimeout(function () { resolve(self.__tsVerdict); }, 400);
    }); }],
  // Same-origin on purpose: a cross-origin classic Worker is always blocked
  // by the platform's own same-origin rule, which would prove nothing about
  // CSP. The same-origin form is blocked ONLY by worker-src -- and is also
  // the realistic escape (importing a real URL from the app's own origin).
  ['nested-remote-worker', function () { return new Promise(function (resolve, reject) {
      var w = new Worker(PROBE_A + '/probe-worker.js');
      w.onmessage = function (ev) { resolve(ev.data); };
      w.onerror = function (e) { reject(new Error('remote worker failed: ' + (e && e.message || 'blocked'))); };
      setTimeout(function () { reject(new Error('remote worker no reply')); }, 3000);
    }); }],
  ['nested-blob-worker', function () { return new Promise(function (resolve, reject) {
      var src = "fetch('" + PROBE_B + "/probe-hit').then(function(){ postMessage('nested-fetch-ALLOWED'); }, function(e){ postMessage('nested-fetch-blocked:' + (e && e.message || e)); }); "
        + "import('" + PROBE_A + "/probe-module.js').then(function(){ postMessage('nested-import-ALLOWED'); }, function(e){ postMessage('nested-import-blocked'); }); "
        + "new Function('u','return import(u)')('" + PROBE_B + "/probe-module.js').then(function(){ postMessage('nested-fn-import-ALLOWED'); }, function(e){ postMessage('nested-fn-import-blocked'); });";
      var url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
      var w = new Worker(url);
      var seen = [];
      w.onmessage = function (ev) { seen.push(ev.data); if (seen.length >= 3) resolve(seen.join(' | ')); };
      w.onerror = function () { reject(new Error('nested blob worker error')); };
      setTimeout(function () { reject(new Error('nested blob worker partial: ' + seen.join(' | '))); }, 4000);
    }); }],
];
var results = [];
var chain = Promise.resolve();
for (var i = 0; i < probes.length; i++) {
  (function (pair) {
    chain = chain.then(function () { return attempt(pair[0], pair[1]).then(function () {
      results.push(out[out.length - 1]);
    }, function () {
      results.push(out[out.length - 1]);
    }); });
  })(probes[i]);
}
chain.then(function () {
  setTimeout(function () {
    out.push({ tag: 'timer-fn', verdict: 'ALLOWED', detail: 'fired' });
    postMessage({ type: 'battery', results: out });
  }, 60);
}).catch(function (e) {
  postMessage({ type: 'battery', results: out, fatal: String(e && e.message || e) });
});
`;
}

// ---- Phase B worker: real Pyodide, entirely in-memory ------------------
function buildPyodideWorkerSrc(assetBase, portA, portB) {
  return `
postMessage({ type: 'pyodide-progress', stage: 'worker-evaluated' });
var ASSET_BASE = ${JSON.stringify(assetBase)};
var PROBE_A = 'http://127.0.0.1:${portA}';
var PROBE_B = 'http://127.0.0.1:${portB}';
var VIRTUAL = ${JSON.stringify(VIRTUAL_BASE)};
var nativeFetch = self.fetch;
var assets = null;
var served = [];
var stages = [];

function post(obj) { obj.from = 'pyodide-worker'; postMessage(obj); }

// Bootstrap-only in-memory resolver. It serves EXACTLY the URLs it holds --
// full-string key match, no path normalization, no query tolerance, no
// fallback to the native fetch. An unknown URL rejects: fail closed.
function shimFetch(url) {
  var u = String((url && url.url) || url);
  served.push(u);
  var hit = assets[u];
  if (!hit) return Promise.reject(new TypeError('Locus bootstrap: no in-memory asset for ' + u));
  return Promise.resolve(new Response(hit.text !== undefined ? hit.text : hit.buffer,
    { status: 200, headers: { 'content-type': hit.mime } }));
}

var escapes = [];
function attempt(tag, fn) {
  return Promise.resolve().then(fn).then(
    function (v) { escapes.push({ tag: tag, verdict: 'ALLOWED', detail: String(v == null ? '' : v).slice(0, 160) }); },
    function (e) { escapes.push({ tag: tag, verdict: 'BLOCKED', detail: (e && e.name || 'Error') + ': ' + String(e && e.message || e).slice(0, 140) }); });
}

async function boot(msgAssets) {
  assets = {};
  for (var name in msgAssets) {
    var a = msgAssets[name];
    assets[VIRTUAL + name] = a.text !== undefined ? { text: a.text, mime: a.mime } : { buffer: a.buffer, mime: a.mime };
  }
  var stage = function (s) { stages.push(s); post({ type: 'pyodide-progress', stage: s, served: served }); };
  stage('install-resolver');
  self.fetch = shimFetch;
  // pyodide.js assigns globalThis.loadPyodide itself (strict-mode friendly).
  stage('eval-pyodide.js');
  (0, eval)(assets[VIRTUAL + 'pyodide.js'].text);
  // pyodide.asm.js opens with "use strict", so its var stays inside the
  // eval scope -- export it explicitly. With the factory present,
  // loadPyodide NEVER loads a script itself (no importScripts, no import).
  stage('eval-pyodide.asm.js');
  (0, eval)(assets[VIRTUAL + 'pyodide.asm.js'].text + '\\n;globalThis._createPyodideModule = _createPyodideModule;');
  stage('loadPyodide');
  var py = await loadPyodide({
    indexURL: VIRTUAL,
    lockFileURL: VIRTUAL + 'pyodide-lock.json',
    stdLibURL: VIRTUAL + 'python_stdlib.zip',
  });
  stage('loadPackage:pandas');
  await py.loadPackage(['pandas']);
  stage('booted');
  return py;
}

self.onmessage = async function (ev) {
  var msg = ev.data || {};
  if (msg.type !== 'assets') return;
  var stdoutLines = [];
  try {
    var py = await boot(msg.assets);
    py.setStdout({ batched: function (s) { stdoutLines.push(s); } });
    py.setStderr({ batched: function (s) { stdoutLines.push('ERR ' + s); } });

    // Compute checks on the live interpreter.
    await py.runPythonAsync('print("PYOK", 2 + 2)');
    await py.runPythonAsync('import pandas as pd, numpy as np\\nprint("DF", int(pd.DataFrame({"a": [1, 2, 3]}).a.sum() + np.array([4]).sum()))');
    await py.runPythonAsync('import io, json\\nprint("VFS", len(json.loads(json.dumps({"k": 1}))))');

    // Tear the bootstrap authority down: no in-memory assets, native fetch
    // back in place. From here the browser CSP is the ONLY boundary.
    assets = null;
    self.fetch = nativeFetch;
    stages.push('locked');

    // ---- escape battery with the REAL interpreter live ----
    await attempt('fn-compute-post', function () { return new Function('return 6 * 7')(); });
    await attempt('fetch-asset-server', function () { return fetch(ASSET_BASE + '/pyodide.js').then(function (r) { return r.status; }); });
    await attempt('fetch-probe', function () { return fetch(PROBE_A + '/probe-hit').then(function (r) { return r.status; }); });
    await attempt('fn-dynamic-import-asset', function () { return new Function('u', 'return import(u)')(ASSET_BASE + '/probe-module.js').then(function () { return 'imported'; }); });
    await attempt('constructor-dynamic-import-asset', function () { return console.log.constructor('u', 'return import(u)')(ASSET_BASE + '/probe-module.js').then(function () { return 'imported'; }); });
    await attempt('proto-fetch', function () {
      var lvl = Object.getPrototypeOf(self);
      var native = (lvl && lvl.fetch) || (lvl && Object.getPrototypeOf(lvl) || {}).fetch || self.fetch;
      return Reflect.apply(native, self, [PROBE_B + '/probe-hit']).then(function (r) { return r.status; });
    });
    await attempt('importscripts', function () { importScripts(PROBE_B + '/probe-script.js'); return 'imported'; });
    await attempt('eval-dynamic-import', function () { return (0, eval)("(import('" + PROBE_B + "/probe-module.js'))").then(function () { return 'imported'; }); });
    await attempt('timer-string-import', function () { return new Promise(function (resolve) {
      self.__tsVerdict = 'pending';
      setTimeout("import('" + ASSET_BASE + "/probe-module.js').then(function(){ self.__tsVerdict = 'ALLOWED'; }, function(){ self.__tsVerdict = 'blocked'; })", 0);
      setTimeout(function () { resolve(self.__tsVerdict); }, 400);
    }); });
    await attempt('nested-remote-worker', function () { return new Promise(function (resolve, reject) {
      var w = new Worker(PROBE_A + '/probe-worker.js');
      w.onmessage = function (ev) { resolve(ev.data); };
      w.onerror = function () { reject(new Error('remote worker blocked')); };
      setTimeout(function () { reject(new Error('no reply')); }, 3000);
    }); });
    await attempt('nested-blob-worker-fetch', function () { return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(new Blob(["fetch('" + PROBE_B + "/probe-hit').then(function(){ postMessage('nested-fetch-ALLOWED'); }, function(){ postMessage('nested-fetch-blocked'); });"], { type: 'text/javascript' }));
      var w = new Worker(url);
      w.onmessage = function (ev) { resolve(ev.data); };
      w.onerror = function () { reject(new Error('nested blob worker error')); };
      setTimeout(function () { reject(new Error('no reply')); }, 4000);
    }); });
    // Python-side escapes through the live interpreter.
    await attempt('py-js-fetch', function () {
      return py.runPythonAsync("import js\\ntry:\\n    await js.fetch('" + PROBE_A + "/probe-hit')\\n    print('PYJSFETCH ALLOWED')\\nexcept Exception as ex:\\n    print('PYJSFETCH blocked')");
    });
    await attempt('py-pyfetch', function () {
      return py.runPythonAsync("from pyodide.http import pyfetch\\ntry:\\n    await pyfetch('" + PROBE_B + "/probe-hit')\\n    print('PYFETCH ALLOWED')\\nexcept Exception as ex:\\n    print('PYFETCH blocked')");
    });
    await attempt('py-loadpackage-regex', function () {
      return py.runPythonAsync("import pyodide\\ntry:\\n    await pyodide.loadPackage('regex')\\n    print('LOADPKG ALLOWED')\\nexcept Exception as ex:\\n    print('LOADPKG blocked')");
    });
    await attempt('py-sqlite3', function () {
      return py.runPythonAsync("try:\\n    import sqlite3\\n    print('SQLITE IMPORTED')\\nexcept ModuleNotFoundError:\\n    print('SQLITE ModuleNotFoundError')");
    });
    // Positive: pandas compute STILL works after teardown.
    await attempt('py-pandas-post', function () {
      return py.runPythonAsync("import pandas as pd\\nprint('PANDAS-POST', int(pd.DataFrame({'a': [5, 6]}).a.sum()))");
    });

    post({ type: 'pyodide-done', stages: stages, served: served,
      stdout: stdoutLines.join('\\n'), escapes: escapes });
  } catch (e) {
    post({ type: 'pyodide-done', stages: stages, served: served,
      error: String(e && e.stack || e), stdout: stdoutLines.join('\\n'), escapes: escapes });
  }
};
`;
}

// ---- srcdoc iframe + page builders ------------------------------------
// All generated page/iframe/worker sources are sanitized to printable
// ASCII: the srcdoc pipeline is string-in-string-in-string, and any
// multi-byte character is a decoding accident waiting to happen (measured:
// an em-dash under a GBK default charset ate the following backslash of a
// JSON escape and broke the script). Comments are rewritten, not trusted.
function asciiOnly(s) {
  return String(s).replace(/[^\x20-\x7e\n\t]/g, function (c) {
    return { '\u2014': '--', '\u2192': '->', '\u2018': "'", '\u2019': "'",
      '\u201c': '"', '\u201d': '"', '\u2026': '...' }[c] || '?';
  });
}

function buildIframeDoc(workerSrc, scope, withCsp) {
  const meta = withCsp
    ? '<meta http-equiv="Content-Security-Policy" content="' + STRICT_CSP.replace(/"/g, '&quot;') + '">'
    : '<!-- no CSP: control -->';
  return [
    '<!DOCTYPE html><html><head>', meta, '</head><body><script>',
    '(function () {',
    '  var workerSrc = ' + JSON.stringify(asciiOnly(workerSrc)).replace(/<\//g, '<\\/') + ';',
    '  var url = URL.createObjectURL(new Blob([workerSrc], { type: "text/javascript" }));',
    '  var worker = new Worker(url);',
    '  document.addEventListener("securitypolicyviolation", function (e) {',
    '    parent.postMessage({ type: "violation", scope: ' + JSON.stringify(scope) + ',',
    '      effectiveDirective: e.effectiveDirective, blockedURI: e.blockedURI }, "*");',
    '  });',
    '  worker.onmessage = function (ev) { var d = ev.data; d.scope = ' + JSON.stringify(scope) + '; parent.postMessage(d, "*"); };',
    '  worker.onerror = function (e) { parent.postMessage({ type: "worker-error", scope: ' + JSON.stringify(scope) + ', message: e && e.message }, "*"); };',
    '})();',
    '<\/script></body></html>',
  ].join('\n');
}

// The Phase B iframe relays assets from the page into the worker
// (transferring every ArrayBuffer) and forwards worker messages up.
function buildPyodideIframeDoc(workerSrc) {
  return [
    '<!DOCTYPE html><html><head>',
    '<meta http-equiv="Content-Security-Policy" content="' + STRICT_CSP.replace(/"/g, '&quot;') + '">',
    '</head><body><script>',
    '(function () {',
    '  var workerSrc = ' + JSON.stringify(asciiOnly(workerSrc)).replace(/<\//g, '<\\/') + ';',
    '  var url = URL.createObjectURL(new Blob([workerSrc], { type: "text/javascript" }));',
    '  var worker = new Worker(url);',
    '  worker.onmessage = function (ev) { var d = ev.data;',
    '    if (d && d.type === "pyodide-done") parent.postMessage(d, "*");',
    '    else if (d && d.type === "pyodide-progress") parent.postMessage(d, "*");',
    '  };',
    '  worker.onerror = function (e) { parent.postMessage({ type: "pyodide-done", scope: "pyodide",',
    '    error: "worker error: " + (e && e.message || "unknown") }, "*"); };',
    '  parent.postMessage({ type: "need-assets", scope: "pyodide" }, "*");',
    '  window.addEventListener("message", function (ev) {',
    '    var d = ev.data || {};',
    '    if (d.type === "assets") {',
    '      var transfers = [];',
    '      for (var k in d.assets) if (d.assets[k].buffer) transfers.push(d.assets[k].buffer);',
    '      worker.postMessage(d, transfers);',
    '    }',
    '  });',
    '})();',
    '<\/script></body></html>',
  ].join('\n');
}

function buildPage(portA, portB, assetBase) {
  const strictDoc = buildIframeDoc(buildWorkerSrc(portA, portB, ''), 'strict', true);
  const controlDoc = buildIframeDoc(buildWorkerSrc(portA, portB, '/control'), 'control', false);
  const pyodideDoc = buildPyodideIframeDoc(buildPyodideWorkerSrc(assetBase, portA, portB));
  const embed = (doc) => JSON.stringify(asciiOnly(doc)).replace(/<\//g, '<\\/');
  return '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><script>' +
    'window.__f04b = { strict: null, control: null, pyodide: null, assetsReady: false, assetsError: null, violations: [], errors: [] };' +
    'window.addEventListener("message", function (ev) {' +
    '  var d = ev.data || {};' +
    '  if (d.type === "battery") { if (d.scope === "control") window.__f04b.control = d; else window.__f04b.strict = d; }' +
    '  else if (d.type === "pyodide-done") window.__f04b.pyodide = d;' +
    '  else if (d.type === "pyodide-progress") window.__f04b.progress = d.stage + " | served: " + (d.served || []).join(",");' +
    '  else if (d.type === "need-assets" && !window.__f04b.assetsSent) { window.__f04b.assetsSent = true;' +
    '    var transfers = [];' +
    '    for (var k in window.__f04b.assetMap) if (window.__f04b.assetMap[k].buffer) transfers.push(window.__f04b.assetMap[k].buffer);' +
    '    ev.source.postMessage({ type: "assets", assets: window.__f04b.assetMap }, "*", transfers); }' +
    '  else if (d.type === "violation") window.__f04b.violations.push(d);' +
    '  else if (d.type === "worker-error") window.__f04b.errors.push(d);' +
    '});' +
    'function spawn(doc) { var f = document.createElement("iframe"); f.style.display = "none"; f.srcdoc = doc; document.body.appendChild(f); }' +
    'spawn(' + embed(strictDoc) + ');' +
    'spawn(' + embed(controlDoc) + ');' +
    // TRUSTED HARNESS PHASE: fetch the FIXED asset set, then spawn the
    // strict-CSP Pyodide creator iframe and hand the bytes over.
    '(function prefetch() {' +
    '  var files = ' + JSON.stringify(ASSET_FILES.map((a) => a.name)) + ';' +
    '  var base = ' + JSON.stringify(assetBase + '/') + ';' +
    '  Promise.all(files.map(function (name) {' +
    '    var meta = ' + JSON.stringify(Object.fromEntries(ASSET_FILES.map((a) => [a.name, a]))) + '[name];' +
    '    return fetch(base + name).then(function (r) { if (!r.ok) throw new Error(name + " -> " + r.status);' +
    '      return meta.kind === "text" ? r.text().then(function (t) { return [name, { text: t, mime: meta.mime }]; })' +
    '        : r.arrayBuffer().then(function (b) { return [name, { buffer: b, mime: meta.mime }]; }); });' +
    '  })).then(function (pairs) {' +
    '    var map = {}; pairs.forEach(function (p) { map[p[0]] = p[1]; });' +
    '    window.__f04b.assetMap = map; window.__f04b.assetsReady = true;' +
    '    spawn(' + embed(pyodideDoc) + ');' +
    '  }).catch(function (e) { window.__f04b.assetsError = String(e && e.message || e); });' +
    '})();' +
    '<\/script></body></html>';
}

// ---- asset loader: disk cache or CDN (self-contained suite) ------------
async function loadAsset(name) {
  const cached = path.join(ASSET_CACHE_DIR, name);
  try {
    return await fs.readFile(cached);
  } catch (e) {
    // fall through to CDN
  }
  const res = await fetch(PYODIDE_CDN + name);
  if (!res.ok) throw new Error('asset download failed: ' + name + ' -> ' + res.status);
  const bytes = Buffer.from(await res.arrayBuffer());
  try {
    await fs.mkdir(ASSET_CACHE_DIR, { recursive: true });
    await fs.writeFile(cached, bytes);
  } catch (e) { /* cache is best-effort */ }
  return bytes;
}

async function main() {
  let serverA;
  let serverB;
  let passed = 0;
  let failed = 0;
  const check = (name, condition, detail) => {
    if (condition) { passed++; console.log('PASS ' + name); }
    else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + detail : '')); }
  };

  // ---- probe servers: two origins, EVERY request counted. CONTROL
  // traffic lives under /control/*, strict traffic under /* -- disjoint. ----
  const hits = [];
  const assetCache = new Map(); // name -> Buffer
  let portA;
  let portB;
  const makeServer = (label, withPage) => http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    hits.push({ origin: label, path: u.pathname, t: Date.now() });
    if (withPage && u.pathname === '/f04b-page') {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(buildPage(portA, portB, 'http://127.0.0.1:' + portA + '/assets'));
      return;
    }
    if (u.pathname.startsWith('/assets/')) {
      const name = u.pathname.slice('/assets/'.length);
      if (name !== decodeURIComponent(name)) { res.statusCode = 400; res.end('bad asset name'); return; }
      const entry = ASSET_FILES.find((a) => a.name === name);
      if (!entry) { res.statusCode = 404; res.end('unknown asset'); return; }
      const bytes = assetCache.get(name);
      if (!bytes) { res.statusCode = 503; res.end('asset not preloaded'); return; }
      // CORS-open: the file://-mode harness page (opaque origin) prefetches
      // the fixed asset set from here -- same trust rule as the hosted mode,
      // where the page is same-origin.
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('content-type', entry.mime + '; charset=utf-8');
      res.setHeader('content-length', bytes.length);
      res.end(bytes);
      return;
    }
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (u.pathname.endsWith('probe-script.js') || u.pathname.endsWith('probe-module.js')) {
      res.setHeader('content-type', 'application/javascript');
      res.end('self.__probeLoaded = true;');
      return;
    }
    if (u.pathname.endsWith('probe-worker.js')) {
      res.setHeader('content-type', 'application/javascript');
      res.end("postMessage('remote-worker-alive');");
      return;
    }
    res.setHeader('content-type', 'text/plain');
    res.end('probe-hit');
  });
  portA = await allocateFreePort();
  portB = await allocateFreePort();
  await new Promise((r) => serverA = makeServer('A', true).listen(portA, '127.0.0.1', r));
  await new Promise((r) => serverB = makeServer('B', false).listen(portB, '127.0.0.1', r));
  const controlHits = (suffix) => hits.filter((h) => h.path === '/control' + suffix).length;
  const strictProbeTotal = () => hits.filter((h) => h.path.startsWith('/probe-')).length;
  const assetServerHits = () => hits.filter((h) => h.path.startsWith('/assets/')).length;

  // Runs the full boundary model (Phase A battery + Phase B in-memory
  // Pyodide) against one page URL, prefixing every check with `label`.
  // Both hosting modes -- http://127.0.0.1 and file:// -- must behave
  // identically: the strict-CSP srcdoc iframe, its Blob worker, the CSP
  // inheritance and the in-memory bootstrap are all origin-agnostic
  // mechanics, and this pins that claim instead of assuming it.
  async function runBoundaryPhases(pageUrl, label) {
    let profileDir = null;
    let chrome = null;
    let cdp = null;
    const assetBaseline = assetServerHits();
    try {
      profileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'locus-f04b-profile-'));
      chrome = await launchChrome(pageUrl, {
        chromePath: process.env.CHROME,
        label: 'F04b ' + label + ' Chrome',
        profileDir,
        extraArgs: ['--window-size=1280,800'],
      });
      await waitForCdp(chrome, { timeoutMs: 15000 });
      const target = await waitForPageTarget(chrome, pageUrl, { timeoutMs: 15000 });
      cdp = await connectToTarget(target);

      // ---- PHASE A: the boundary model ----
      await waitForRuntimeCondition(cdp, '!!(window.__f04b && window.__f04b.strict && window.__f04b.control)',
        { process: chrome, phase: 'f04b-' + label + '-batteries', timeoutMs: 30000 });
      await new Promise((r) => setTimeout(r, 1500)); // settle stragglers
      const state = await evaluate(cdp, 'window.__f04b');

      const byTag = (battery, tag) => (battery.results || []).find((r) => r.tag === tag);
      const control = state.control;
      const strict = state.strict;
      check(label + ' A00 both batteries completed without a fatal', !strict.fatal && !control.fatal,
        JSON.stringify({ strictFatal: strict.fatal, controlFatal: control.fatal }));

      // CONTROL: the no-CSP worker really can reach the network -- otherwise
      // every ZERO below would be vacuous.
      check(label + ' CONTROL no-CSP worker fetch reaches the probe server (oracle observability)',
        byTag(control, 'fetch-cross-origin')?.verdict === 'ALLOWED' && controlHits('/probe-hit') >= 1,
        JSON.stringify(byTag(control, 'fetch-cross-origin')) + ' hits=' + controlHits('/probe-hit'));
      check(label + ' CONTROL no-CSP worker dynamic import reaches the probe server',
        byTag(control, 'import-dynamic-cross')?.verdict === 'ALLOWED' && controlHits('/probe-module.js') >= 1,
        JSON.stringify(byTag(control, 'import-dynamic-cross')) + ' hits=' + controlHits('/probe-module.js'));

      // STRICT: local compute keeps working.
      for (const [tag, why] of [
        ['fn-compute', 'new Function must stay usable (Pyodide interop needs dynamic JS compute)'],
        ['eval-compute', 'indirect eval must stay usable'],
        ['wasm-compile', 'WebAssembly.compile must stay usable (Pyodide runtime)'],
        ['promise', 'Promise must stay usable'],
        ['timer-fn', 'function-handler timers must keep firing'],
      ]) {
        const r = byTag(strict, tag);
        check(label + ' STRICT ' + tag + ' ALLOWED -- ' + why, r?.verdict === 'ALLOWED', JSON.stringify(r));
      }

      // STRICT: every network family is browser-blocked.
      for (const tag of [
        'fetch-same-origin', 'fetch-cross-origin', 'xhr-sync', 'xhr-async',
        'websocket', 'eventsource', 'importscripts', 'import-dynamic',
        'import-dynamic-cross', 'fn-dynamic-import', 'constructor-dynamic-import',
        'proto-fetch', 'eval-dynamic-import', 'nested-remote-worker',
      ]) {
        const r = byTag(strict, tag);
        check(label + ' STRICT ' + tag + ' blocked by browser policy', r?.verdict === 'BLOCKED', JSON.stringify(r));
      }
      const sb = byTag(strict, 'sendbeacon');
      check(label + ' STRICT sendbeacon reports blocked/not-queued/absent (oracle decides)',
        !!sb && (sb.verdict === 'BLOCKED' || /not-queued|absent|queued/.test(sb.detail || '')),
        JSON.stringify(sb));
      const ts = byTag(strict, 'timer-string');
      check(label + ' STRICT string-timer dynamic import blocked inside the compiled handler',
        !!ts && /timer-import-blocked/.test(ts.detail || ''), JSON.stringify(ts));
      const nested = byTag(strict, 'nested-blob-worker');
      check(label + ' STRICT nested blob worker created but its fetch/import/fn-import all blocked',
        nested?.verdict === 'ALLOWED' && /nested-fetch-blocked/.test(nested.detail)
          && /nested-import-blocked/.test(nested.detail) && /nested-fn-import-blocked/.test(nested.detail),
        JSON.stringify(nested));

      // THE ORACLE: the strict workers contributed EXACTLY ZERO probe
      // requests (cumulative across every run in this suite).
      check(label + ' ORACLE strict workers performed ZERO probe requests across both origins',
        strictProbeTotal() === 0,
        'total=' + strictProbeTotal() + ' paths=' + JSON.stringify(hits.map((h) => h.origin + h.path)));

      // ---- PHASE B: real Pyodide, entirely in-memory ----
      await waitForRuntimeCondition(cdp,
        '(window.__f04b.assetsError !== null) || (window.__f04b.pyodide !== null)',
        { process: chrome, phase: 'f04b-' + label + '-pyodide', timeoutMs: 300000 });
      if (await evaluate(cdp, 'window.__f04b.assetsError')) {
        check(label + ' B00 harness asset prefetch completed', false,
          String(await evaluate(cdp, 'window.__f04b.assetsError')));
      } else {
        const bootHits = assetServerHits() - assetBaseline;
        check(label + ' B00 harness fetched EXACTLY the fixed asset set (bootstrap requests are harness-owned)',
          bootHits === ASSET_FILES.length,
          'hits=' + bootHits + ' expected=' + ASSET_FILES.length);
        const pb = await evaluate(cdp, 'window.__f04b.pyodide');
        check(label + ' B01 Pyodide booted entirely in-memory (no error)', !pb.error,
          JSON.stringify(String(pb.error || '').slice(0, 400)));
        if (!pb.error) {
          check(label + ' B02 bootstrap stages reached locked', pb.stages[pb.stages.length - 1] === 'locked',
            JSON.stringify(pb.stages));
          // The boot consumes every asset EXCEPT the two page-eval'd JS
          // files and the trusted wheel-installer closure (TPR v1A), which
          // the worker loads only when a plugin payload carries wheels —
          // this suite boots the core runtime with pandas only.
          const expectedServed = new Set(ASSET_FILES
            .filter((a) => a.name !== 'pyodide.js' && a.name !== 'pyodide.asm.js'
              && !PY_INSTALLER_FILES.includes(a.name))
            .map((a) => VIRTUAL_BASE + a.name));
          const servedSet = new Set(pb.served);
          const unexpected = [...servedSet].filter((u) => !expectedServed.has(u));
          const missing = [...expectedServed].filter((u) => !servedSet.has(u));
          check(label + ' B03 resolver served EXACTLY the fixed bootstrap set (no unknown URLs, no query tricks)',
            unexpected.length === 0 && missing.length === 0,
            'unexpected=' + JSON.stringify(unexpected) + ' missing=' + JSON.stringify(missing));
          check(label + ' B04 python compute works (print 2+2)', /PYOK 4/.test(pb.stdout || ''), JSON.stringify((pb.stdout || '').slice(0, 200)));
          check(label + ' B05 pandas + numpy work under the strict policy', /DF 10/.test(pb.stdout || ''), JSON.stringify((pb.stdout || '').slice(0, 300)));
          check(label + ' B06 json/stdlib work', /VFS 1/.test(pb.stdout || ''), JSON.stringify((pb.stdout || '').slice(0, 300)));
          const pbt = (tag) => (pb.escapes || []).find((r) => r.tag === tag);
          check(label + ' B07 Function compute still allowed post-lock', pbt('fn-compute-post')?.verdict === 'ALLOWED',
            JSON.stringify(pbt('fn-compute-post')));
          for (const tag of [
            'fetch-asset-server', 'fetch-probe', 'fn-dynamic-import-asset',
            'constructor-dynamic-import-asset', 'proto-fetch', 'importscripts',
            'eval-dynamic-import', 'nested-remote-worker',
          ]) {
            check(label + ' B08 ' + tag + ' blocked by browser policy with the live interpreter',
              pbt(tag)?.verdict === 'BLOCKED', JSON.stringify(pbt(tag)));
          }
          // The nested blob worker itself is created (worker-src blob:) and
          // reports back; the fetch INSIDE it is what must be blocked.
          check(label + ' B08 nested-blob-worker-fetch blocked inside the nested worker',
            pbt('nested-blob-worker-fetch')?.verdict === 'ALLOWED'
              && /nested-fetch-blocked/.test(pbt('nested-blob-worker-fetch')?.detail || ''),
            JSON.stringify(pbt('nested-blob-worker-fetch')));
          check(label + ' B09 string-timer import blocked post-lock', /blocked/.test(pbt('timer-string-import')?.detail || ''),
            JSON.stringify(pbt('timer-string-import')));
          check(label + ' B10 Python js.fetch blocked with ZERO requests', /PYJSFETCH blocked/.test(pb.stdout || ''),
            JSON.stringify((pb.stdout || '').slice(-400)));
          check(label + ' B11 Python pyfetch blocked with ZERO requests', /PYFETCH blocked/.test(pb.stdout || ''),
            JSON.stringify((pb.stdout || '').slice(-400)));
          check(label + ' B12 pyodide.loadPackage fails closed post-lock (no resolver, CSP blocks the virtual URL)',
            /LOADPKG blocked/.test(pb.stdout || ''), JSON.stringify((pb.stdout || '').slice(-400)));
          check(label + ' B13 sqlite3 import fails honestly (no auto-load, no network)', /SQLITE ModuleNotFoundError/.test(pb.stdout || ''),
            JSON.stringify((pb.stdout || '').slice(-400)));
          check(label + ' B14 pandas compute STILL works after teardown', /PANDAS-POST 11/.test(pb.stdout || ''),
            JSON.stringify((pb.stdout || '').slice(-300)));
          await new Promise((r) => setTimeout(r, 1500)); // settle stragglers
          check(label + ' ORACLE B15 worker contributed ZERO requests to the asset server (bootstrap bytes traveled by postMessage)',
            assetServerHits() - assetBaseline === ASSET_FILES.length, 'delta=' + (assetServerHits() - assetBaseline));
          check(label + ' ORACLE B16 worker contributed ZERO probe requests',
            strictProbeTotal() === 0, 'total=' + strictProbeTotal());
        }
      }
      console.log('# [' + label + '] worker errors: ' + JSON.stringify(state.errors));
    } finally {
      try { cdp && cdp.close(); } catch (e) {}
      if (chrome) await closeChrome(chrome);
      if (profileDir) { try { await fs.rm(profileDir, { recursive: true, force: true }); } catch (e) {} }
    }
  }

  try {
    // Preload the fixed asset set into the asset server (disk cache first).
    console.log('# loading fixed Pyodide asset set (' + ASSET_FILES.length + ' files, disk cache at '
      + ASSET_CACHE_DIR + ' when present, CDN otherwise)');
    for (const a of ASSET_FILES) assetCache.set(a.name, await loadAsset(a.name));

    // ---- HOSTED MODE: page served over http://127.0.0.1 ----
    await runBoundaryPhases('http://127.0.0.1:' + portA + '/f04b-page', 'hosted');

    // ---- FILE:// MODE: the same page from disk, no special Chrome flags --
    // how a user opening dist/index.html by double-click runs Locus. The
    // page's opaque origin must not weaken the boundary: the harness
    // prefetch still works (CORS *), the srcdoc iframe + blob worker +
    // inherited CSP behave identically. ----
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'locus-f04b-filemode-'));
    try {
      const pageFile = path.join(tmpDir, 'f04b-file-page.html');
      await fs.writeFile(pageFile, buildPage(portA, portB, 'http://127.0.0.1:' + portA + '/assets'));
      const fileUrl = require('url').pathToFileURL(pageFile).href;
      await runBoundaryPhases(fileUrl, 'file');
    } finally {
      try { await fs.rm(tmpDir, { recursive: true, force: true }); } catch (e) {}
    }

    console.log('---');
    console.log('e2e-python-browser-authority: ' + passed + ' passed, ' + failed + ' failed');
    process.exitCode = failed ? 1 : 0;
  } catch (error) {
    console.error('F04B BROWSER AUTHORITY E2E FAIL: ' + (error && error.stack || error));
    process.exitCode = 1;
  } finally {
    for (const s of [serverA, serverB]) { if (s) { try { await new Promise((r) => s.close(r)); } catch (e) {} } }
  }
}

if (require.main === module) {
  main().catch((error) => { console.error(error && error.stack || error); process.exitCode = 1; });
}

module.exports = { buildPage, buildWorkerSrc, buildPyodideWorkerSrc, buildIframeDoc, STRICT_CSP, ASSET_FILES };
