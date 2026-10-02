// ============================================================
//  BROWSER SHELL COMPATIBILITY LAYER
//  Implements the local `bash` tool: pwd / ls / cat / echo / python.
//  Everything runs against the WorkspaceAdapter and the Pyodide
//  worker — no native shell, no server, no cloud execution.
//
//  M3a (repository extraction): this file is an ES module. The
//  cross-file names it consumed as classic-script globals
//  (utf8ByteLength / VirtualWorkspace / normalizeVfsPath / vfsError /
//  NetworkRuntime / safeNetworkUrlForDisplay) arrive through explicit
//  imports below, and the declared __LOCUS_RUNTIME_CORE__ registry at
//  the end of the classic file is DELETED — the public entry
//  (src/index.js) imports this module directly.
// ============================================================
import { utf8ByteLength } from './lib/utf8.js';
import { normalizeVfsPath, vfsError, VirtualWorkspace } from './vfs.js';
import { NetworkRuntime, safeNetworkUrlForDisplay } from './network.js';

// USER PYTHON EXECUTION timeout ONLY (unchanged semantics): 30s covers the
// worker run itself. Bootstrap phases own separate independent budgets below.
const PYTHON_TIMEOUT_MS = 30000;
// TRUSTED-HARNESS BOOTSTRAP budgets (F04c) - measured cold on the reference
// machine: a full CDN acquisition of the ~51 MB set ran ~55s under network
// contention and ~2s from a warm browser cache; the in-memory Pyodide boot
// incl. pandas ran ~10s. The acquisition bound covers a genuinely slow link
// (~280KB/s floor) - a HUNG bootstrap dies far earlier via the per-asset
// no-progress stall bound. Assets are hash-pinned, so a force-cache hit is
// always safe: wrong cached bytes fail the SHA-256 check and the boot.
const PYTHON_ASSET_TIMEOUT_MS = 180000;    // whole-set download + integrity verification
const PYTHON_ASSET_STALL_MS = 20000;       // one asset: no body progress for this long
const PYTHON_BOOTSTRAP_TIMEOUT_MS = 60000; // creator ready + worker boot + lockdown

function makeCancelledError(what) {
  const e = new Error((what || 'operation') + ' cancelled');
  e.name = 'AbortError';
  e.cancelled = true;
  return e;
}

function isCancelledError(e) {
  return !!e && (e.cancelled || e.name === 'AbortError');
}

// Uniform cancellation gate used by python commits, echo redirects, curl
// downloads and workspace collection: re-checked after every async
// pre-check, before every side effect.
function throwIfCancelled(signal, what) {
  if (signal && signal.aborted) throw makeCancelledError(what || 'operation');
}

// ---------- Python runtime bridge (strict-CSP creator iframe + Pyodide) ----------
// TRUSTED HARNESS PHASE / USER EXECUTION PHASE (F04b): the page fetches the
// FIXED Pyodide asset set from the pinned CDN and delivers the bytes into a
// worker created by a strict-CSP srcdoc iframe. From the moment untrusted
// Python executes, the BROWSER — not JS monkey-patching — makes arbitrary
// network egress impossible: the worker inherits the creator's CSP
// (connect-src 'none', script-src with no loadable origin, worker-src
// blob:), so fetch/XHR/WS/EventSource/importScripts/dynamic import/nested
// remote workers all fail at the platform level with ZERO requests while
// Function/eval/WebAssembly compute keeps working. The F04a JS lockdown
// inside the worker stays as defense-in-depth with clean denial semantics.

// The ONLY Pyodide origin the trusted page ever fetches, plus the SINGLE
// SOURCE OF TRUTH (F04c) for the pinned bootstrap: exact name, kind, mime,
// EXACT byte size and SHA-256 of every asset. The loader derives its URL
// list from THIS manifest alone; only a fully size- and hash-verified set
// is ever delivered to the worker or cached. Sizes/hashes were established
// from the official pyodide-0.26.4 release artifacts and cross-checked
// byte-for-byte against this CDN (scripts/verify-python-bootstrap-manifest.mjs
// re-verifies: jsDelivr bytes, release provenance, lockfile dependency
// closure). A version upgrade means rewriting this one table and passing
// every gate; nothing else in the runtime may add or change a bootstrap URL.
const PYODIDE_BASE = 'https://cdn.jsdelivr.net/pyodide/v0.26.4/full/';
const PYTHON_BOOTSTRAP_MANIFEST = Object.freeze([
  { name: 'pyodide.js', kind: 'text', mime: 'text/javascript', size: 14761, sha256: 'c0069107621d5b942a659e737a12e774cc0451feaa2256f475d72e071d844ec7' },
  { name: 'pyodide.asm.js', kind: 'text', mime: 'text/javascript', size: 1229099, sha256: '919560652ed3dad3707cb3a394785da1e046fb13dc0defa162058ff230cb7eed' },
  { name: 'pyodide.asm.wasm', kind: 'bytes', mime: 'application/wasm', size: 10088051, sha256: 'b7e66a19427a55010ac3367c1b6c64b893f9826f783412945fdf0c3337f3bc94' },
  { name: 'pyodide-lock.json', kind: 'text', mime: 'application/json', size: 106335, sha256: 'cd50b49de944c579045e122fe8628b31f9ce446379f032f36c05e273d38766e0' },
  { name: 'python_stdlib.zip', kind: 'bytes', mime: 'application/zip', size: 2341872, sha256: '72894522b791858b9d613ac786b951d8b5094035dcf376313ea24a466810f336' },
  { name: 'pandas-2.2.0-cp312-cp312-pyodide_2024_0_wasm32.whl', kind: 'bytes', mime: 'application/octet-stream', size: 23759073, sha256: 'ae979af0f0be1e8c482408d838ea1366d187f3f057f47b429910e66dbba60673' },
  { name: 'numpy-1.26.4-cp312-cp312-pyodide_2024_0_wasm32.whl', kind: 'bytes', mime: 'application/octet-stream', size: 11959269, sha256: '4a2f5303a88a0747c5e6c80701e0ff4ff5667e487c0c9f9c73875e4d88f4cf9a' },
  { name: 'python_dateutil-2.9.0.post0-py2.py3-none-any.whl', kind: 'bytes', mime: 'application/octet-stream', size: 444927, sha256: '302d74af893af51ee8b52e2c06a1fc2bc73cfe645eed3f35a17f082cdf101c7d' },
  { name: 'six-1.16.0-py2.py3-none-any.whl', kind: 'bytes', mime: 'application/octet-stream', size: 38737, sha256: 'f359c3850331f250d1a5e394aae58193774c6358676340aba992718589b9dcf1' },
  { name: 'pytz-2024.1-py2.py3-none-any.whl', kind: 'bytes', mime: 'application/octet-stream', size: 1083571, sha256: '561652a008b98ef7b66a6acf816e3f4d1c0e17e8ed9eb8dbb993037413cda597' },
  // Trusted wheel installer support (TPR v1A): the EXACT micropip closure
  // declared by the SAME pinned pyodide-lock.json. Loaded by the worker ONLY
  // when a plugin payload carries wheels, always inside the bootstrap window
  // and always BEFORE the network lockdown. Plugin wheels themselves are
  // payload data (bootstrap MESSAGE), never manifest entries — the manifest
  // stays the Locus runtime trusted base.
  { name: 'micropip-0.6.0-py3-none-any.whl', kind: 'bytes', mime: 'application/octet-stream', size: 125054, sha256: 'd97c0c01748ddbc52a19944c6a6788c6a8969ed13158c06bc63c6eb02779cd98' },
  { name: 'packaging-23.2-py3-none-any.whl', kind: 'bytes', mime: 'application/octet-stream', size: 194236, sha256: '3c30fe6689a35520f2040f4963eae8dbdf6aaa8e326674a13bca3f11514c674a' },
]);
// Core runtime files vs the declared runtime package closure (pandas) vs the
// declared trusted wheel installer closure (micropip). The package half must
// equal EXACTLY the pandas dependency closure and the installer half EXACTLY
// the micropip dependency closure in the pinned pyodide-lock.json - no
// missing dependency, no undeclared extra, no overlap - which
// tests/python-bootstrap-integrity.test.cjs pins against a lockfile snapshot
// and the browser e2e re-verifies against the real (integrity-passed)
// lockfile bytes.
const PYTHON_BOOTSTRAP_CORE_ASSETS = Object.freeze([
  'pyodide.js', 'pyodide.asm.js', 'pyodide.asm.wasm', 'pyodide-lock.json', 'python_stdlib.zip',
]);
const PYTHON_RUNTIME_PACKAGE_FILES = Object.freeze([
  'pandas-2.2.0-cp312-cp312-pyodide_2024_0_wasm32.whl',
  'numpy-1.26.4-cp312-cp312-pyodide_2024_0_wasm32.whl',
  'python_dateutil-2.9.0.post0-py2.py3-none-any.whl',
  'six-1.16.0-py2.py3-none-any.whl',
  'pytz-2024.1-py2.py3-none-any.whl',
]);
const PYTHON_INSTALLER_SUPPORT_FILES = Object.freeze([
  'micropip-0.6.0-py3-none-any.whl',
  'packaging-23.2-py3-none-any.whl',
]);

// The creator iframe's strict policy. No http/https/blob/data source in
// script-src means no browser loader (script tag, importScripts, dynamic or
// static import) has anything to load; connect-src 'none' kills every
// fetch/XHR/WS/EventSource/sendBeacon; worker-src blob: allows only
// harness-created Blob workers (a nested one inherits the same policy).
// unsafe-eval stays because Pyodide's interop needs dynamic JS compute —
// the boundary is network authority, never compute.
const PY_CREATOR_CSP = "default-src 'none'; connect-src 'none'; "
  + "script-src 'unsafe-inline' 'unsafe-eval'; worker-src blob:; child-src blob:;";

// The creator document: meta CSP + a minimal relay that spawns the Blob
// worker and pipes messages both ways. Kept printable-ASCII on purpose —
// srcdoc is string-in-string HTML and any multi-byte character is a
// decoding accident waiting to happen.
const PY_CREATOR_DOC = (function () {
  const relay = [
    '(function () {',
    '  var worker = null;',
    '  window.addEventListener("message", function (ev) {',
    '    if (ev.source !== parent) return;',
    '    var d = ev.data || {};',
    '    if (d.type === "spawn" && !worker) {',
    '      var url = URL.createObjectURL(new Blob([d.workerSrc], { type: "text/javascript" }));',
    '      try {',
    '        worker = new Worker(url);',
    '      } finally {',
    '        URL.revokeObjectURL(url);',
    '      }',
    '      worker.onmessage = function (e2) { parent.postMessage(e2.data, "*"); };',
    '      worker.onerror = function (e3) { parent.postMessage({ type: "worker-fatal",',
    '        message: (e3 && e3.message) || "unknown" }, "*"); };',
    '    } else if (worker && (d.cmd === "bootstrap" || d.cmd === "run")) {',
    '      worker.postMessage(d);',
    '    }',
    '  });',
    '  parent.postMessage({ type: "creator-ready" }, "*");',
    '})();',
  ].join('\n');
  return '<!DOCTYPE html><html><head>'
    + '<meta http-equiv="Content-Security-Policy" content="' + PY_CREATOR_CSP.replace(/"/g, '&quot;') + '">'
    + '</head><body><script>' + relay.replace(/<\//g, '<\\/') + '<\/script></body></html>';
})();

// ---------- F04c: bounded, integrity-verified asset acquisition ----------
// The trusted harness downloads the pinned Pyodide set as RAW ENTITY BYTES
// (never res.text()), bounds every body at the manifest's exact expected
// size, hashes it with the browser's NATIVE WebCrypto and compares against
// PYTHON_BOOTSTRAP_MANIFEST BEFORE any decode, cache write or worker
// delivery. Truncated, oversized, tampered, stalled or cancelled
// acquisitions fail closed: unverified bytes never reach the worker and
// never enter the page-session cache. Text decoding happens only AFTER the
// digest matches. A context without WebCrypto subtle (e.g. a non-secure
// origin) cannot bootstrap at all - integrity is never silently skipped.

function bootstrapAssetError(message, code) {
  const e = new Error(message);
  e.code = code;
  return e;
}
function pythonAssetUnavailable(message) {
  return bootstrapAssetError(message, 'python_bootstrap_unavailable');
}
function pythonAssetIntegrityError(name, category, detail) {
  return bootstrapAssetError(
    'Python runtime asset integrity check failed: ' + name + ' (' + category + (detail ? ': ' + detail : '') + ')',
    'python_bootstrap_integrity');
}
function pythonAssetTimeoutError(message) {
  return bootstrapAssetError(message, 'python_asset_timeout');
}
function pythonInitTimeoutError(ms) {
  return bootstrapAssetError('Python runtime initialization timed out after ' + ms + 'ms', 'python_bootstrap_timeout');
}

// Bootstrap budgets (F04c), independent of the 30s user-execution budget:
// assetMs bounds the WHOLE acquisition (downloads + integrity checks),
// assetStallMs is the per-asset no-progress bound (a hung body fails long
// before the overall deadline), bootstrapMs bounds creator ready + worker
// spawn + in-memory boot + lockdown. The bootstrapBudgets option is a
// TEST-ONLY seam (run() -> _runOnce -> _ensureWorker) for deterministic
// lifecycle tests; production always runs on the pinned constants.
function pythonBootstrapBudgets(budgets) {
  budgets = budgets || {};
  const pos = (v, dflt) => (typeof v === 'number' && v > 0 ? v : dflt);
  return {
    assetMs: pos(budgets.assetMs, PYTHON_ASSET_TIMEOUT_MS),
    assetStallMs: pos(budgets.assetStallMs, PYTHON_ASSET_STALL_MS),
    bootstrapMs: pos(budgets.bootstrapMs, PYTHON_BOOTSTRAP_TIMEOUT_MS),
  };
}

// A budget clock that can PAUSE while another budget owns the wall clock:
// initialization (creator ready + worker boot reply) shares one clock that
// is paused during asset acquisition, so a slow CDN can never eat the boot
// budget (and the boot can never shorten acquisition). Bounded by design.
function makeBudgetClock(ms) {
  let consumed = 0;
  let since = Date.now(); // null while paused
  return {
    remaining() {
      return ms - consumed - (since !== null ? Date.now() - since : 0);
    },
    pause() {
      if (since !== null) { consumed += Date.now() - since; since = null; }
    },
    resume() {
      if (since === null) since = Date.now();
    },
  };
}

// One bootstrap attempt's cancellation plane: aborts the in-flight
// acquisition (fetch + body reader) when the task signal cancels, a
// bootstrap budget expires, the session resets or the worker dies. Hand-
// rolled instead of AbortSignal.any (not universally available). The abort
// REASON is the error the run sees, so a deadline expiry surfaces as its
// own clearly-labelled timeout, never as a generic abort.
function openBootstrapAbort(signal) {
  const ac = new AbortController();
  let listener = null;
  const adopt = (reason) => { try { ac.abort(reason); } catch (e) {} };
  if (signal) {
    if (signal.aborted) adopt(signal.reason || makeCancelledError('python execution'));
    else {
      listener = () => adopt(signal.reason || makeCancelledError('python execution'));
      signal.addEventListener('abort', listener, { once: true });
    }
  }
  return {
    ac,
    fail: adopt,
    aborted() { return ac.signal.aborted; },
    reason() { return ac.signal.reason; },
    dispose() {
      if (listener && signal) signal.removeEventListener('abort', listener);
      listener = null;
    },
  };
}

// The boot is dead: its abort reason is the error to surface (fall back to
// a cancellation for reasons without one).
function throwIfBootAborted(boot) {
  if (boot.ac.signal.aborted) {
    throw (boot.ac.signal.reason || makeCancelledError('python bootstrap'));
  }
}

function raceTimeout(promise, ms, makeError) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(makeError()), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); });
  });
}

// Race one initialization stage against its budget clock; on expiry the
// WHOLE boot fails (any in-flight acquisition aborts with the labelled
// reason) and the labelled timeout error is thrown.
function raceBootStage(promise, boot, clock, makeError) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      const err = makeError();
      boot.fail(err);
      reject(err);
    }, Math.max(clock.remaining(), 0));
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); });
  });
}

function sha256Available() {
  return typeof crypto !== 'undefined' && !!crypto.subtle
    && typeof crypto.subtle.digest === 'function';
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  let hex = '';
  const view = new Uint8Array(digest);
  for (let i = 0; i < view.length; i++) hex += (view[i] < 16 ? '0' : '') + view[i].toString(16);
  return hex;
}

// Read a response body as RAW ENTITY BYTES with an exact bound: streaming
// reads stop (and best-effort cancel the stream) the moment the body
// exceeds the manifest size, so an oversized response can never balloon
// memory; a body that ends short, or even one byte over, fails the
// acquisition. Content-Length is only an early sanity check (compression
// and intermediaries make header semantics unreliable) - the bytes
// actually read are the final judge.
async function readBodyBounded(res, entry, stallMs) {
  const expected = entry.size;
  const lenHeader = res.headers && typeof res.headers.get === 'function'
    ? Number(res.headers.get('content-length')) : NaN;
  if (Number.isFinite(lenHeader) && lenHeader > expected) {
    throw pythonAssetIntegrityError(entry.name, 'oversized body', 'content-length ' + lenHeader + ' > ' + expected);
  }
  if (!(res.body && typeof res.body.getReader === 'function')) {
    const buf = await res.arrayBuffer(); // fallback: exact-size check after completion
    if (buf.byteLength !== expected) {
      throw pythonAssetIntegrityError(entry.name, 'size mismatch', 'expected ' + expected + ' bytes, got ' + buf.byteLength);
    }
    return new Uint8Array(buf);
  }
  const reader = res.body.getReader();
  let received = 0;
  let clean = false;
  const chunks = [];
  try {
    while (true) {
      const chunk = await raceTimeout(reader.read(), stallMs, () =>
        pythonAssetTimeoutError('Python runtime asset acquisition stalled: '
          + entry.name + ' (no body progress for ' + stallMs + 'ms)'));
      if (chunk.done) { clean = true; break; }
      received += chunk.value.byteLength;
      if (received > expected) {
        throw pythonAssetIntegrityError(entry.name, 'oversized body', 'exceeded ' + expected + ' bytes while reading');
      }
      chunks.push(chunk.value);
    }
  } finally {
    if (!clean) { try { reader.cancel(); } catch (e) {} }
  }
  if (received !== expected) {
    throw pythonAssetIntegrityError(entry.name, 'size mismatch', 'expected ' + expected + ' bytes, got ' + received);
  }
  const out = new Uint8Array(expected);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  return out;
}

// ---------- Runtime payload contract data (M2a, repository split) ----------
// The payload-identity rules are the RUNTIME's own declared contract data
// (REPOSITORY-SPLIT-CONTRACTS §3.7): this module validates plugin payloads
// against THESE patterns and imports nothing from extensions.js. The
// Harness keeps its own copy in src/extensions.js; a boundary test pins
// the two sources EQUAL (the declared synchronization mechanism — the
// values are contract, not incidental). Error texts embed the pattern
// source, so byte-stability of the messages is preserved by construction.
const RUNTIME_PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const RUNTIME_PY_MODULE_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;

// ---------- TPR v1A: trusted wheel payload validation (main thread) ----------
// One plugin wheel artifact as configured through configureExtensions. These
// checks are the trusted Harness invariants: shape, bounds and the metadata
// <-> bytes agreement. The WORKER re-verifies byte identity (size + WebCrypto
// SHA-256) before installing — this side only guarantees that what is posted
// is self-consistent, correctly bounded plugin data. Never raw-bytes
// dependent: a validation failure names the plugin and the fault category.
const PYTHON_PLUGIN_WHEEL_MAX_BYTES = 64 * 1024 * 1024; // == Capability Package artifact bound
const PYTHON_PLUGIN_WHEEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.whl$/;

function validateWheelArtifact(pluginId, wheel) {
  const bad = (category) => {
    throw new Error('PythonRuntime.configureExtensions: plugin ' + pluginId
      + ' wheel artifact ' + category);
  };
  if (!wheel || typeof wheel !== 'object') bad('entry is not an object');
  const filename = wheel.filename;
  if (typeof filename !== 'string' || !PYTHON_PLUGIN_WHEEL_NAME.test(filename)
      || filename.indexOf('/') !== -1 || filename.indexOf('\\') !== -1) {
    bad('filename must be a plain .whl basename');
  }
  if (wheel.format !== 'python-wheel') bad('format must be exactly "python-wheel"');
  if (!Number.isInteger(wheel.size) || wheel.size < 0) bad('size must be a finite integer >= 0');
  if (wheel.size > PYTHON_PLUGIN_WHEEL_MAX_BYTES) {
    bad('size ' + wheel.size + ' exceeds the ' + PYTHON_PLUGIN_WHEEL_MAX_BYTES + '-byte artifact bound');
  }
  if (typeof wheel.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(wheel.sha256)) {
    bad('sha256 must be exactly 64 lowercase hex characters');
  }
  const bytes = wheel.bytes;
  const isView = !!bytes && typeof bytes === 'object'
    && typeof bytes.byteLength === 'number'
    && bytes.buffer instanceof ArrayBuffer;
  if (!isView) bad('bytes must be a Uint8Array (or an ArrayBuffer view)');
  if (bytes.byteLength !== wheel.size) {
    bad('bytes.byteLength ' + bytes.byteLength + ' != declared size ' + wheel.size);
  }
  // OWN COPY (CapabilityBundle readBytes rule): the caller mutating its
  // original buffer after configureExtensions must never change what future
  // boots install. Every accepted view is canonicalized in two steps: a
  // Uint8Array view over EXACTLY the declared byte range (byteOffset ..
  // byteOffset + byteLength), then `new Uint8Array(view)` — a fresh,
  // independent element copy. The caller's backing ArrayBuffer is never
  // retained (a bare subarray view would still alias it), so mutating any
  // region of the original buffer afterwards cannot reach the stored
  // payload. The structured clone into the worker leaves this page copy
  // untouched, so every boot (first, reset, crash-rebuild) replays the same
  // canonical bytes.
  const view = bytes instanceof Uint8Array
    ? bytes
    : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const copy = new Uint8Array(view);
  return { filename: filename, format: 'python-wheel', size: wheel.size, sha256: wheel.sha256, bytes: copy };
}

// M1b (repository split): the interpreter is an INSTANCE, not a page-global
// singleton. createPythonRuntime() builds one interpreter with ALL of its
// mutable state owned per instance: the worker facade, boot promise and
// timers, pending-request map, request sequence, execution queue, plugin
// payload set and the disposed flag. Two instances share nothing mutable —
// resetting or disposing one can never touch another (pinned by
// tests/python-lifecycle.test.cjs).
//
// Explicitly shared across instances (all immutable or stateless): the
// frozen PYTHON_BOOTSTRAP_MANIFEST, the budget constants/clocks, the
// py-creator document and every helper in this file. The VERIFIED ASSET
// CACHE (_assets) is intentionally PER INSTANCE: it holds verified bytes
// for this interpreter’s boots only; sharing it across instances would
// re-couple lifecycles that M1b exists to separate.
//
// Lifecycle (contract docs/REPOSITORY-SPLIT-CONTRACTS.md §3.1, M1b form):
//   prepare(req)  — between tasks: compare the wanted plugin payload with
//                    the configured one; validate-then-swap (all-or-nothing,
//                    never boots, never fetches). Returns
//                    { rebuiltInterpreter }.
//   run(code, vfs, opts) — the execution port (serialized queue, mirrors,
//                    commit phases unchanged).
//   reset(reason) — session/rebuild boundary: invalidates the in-flight
//                    boot, pending requests and queued runs SYNCHRONOUSLY.
//                    reset() returns immediately — an abort’s effect on a
//                    caller’s in-flight run() promise lands at that run’s
//                    next await boundary, not inside reset() itself. The
//                    instance stays reusable afterwards.
//   dispose(reason) — terminal: everything reset does, plus permanent
//                    refusal of prepare/run/configureExtensions. Idempotent.
//                    Late worker messages cannot revive the instance (the
//                    creator iframe is gone; the disposed flag blocks new
//                    work).
//   snapshot()    — canonical state read for callers outside the runtime.
//
// The product keeps ONE active instance per page and keeps lazy boot: a
// text-only task constructs the instance object but never creates a
// worker, downloads assets or starts Pyodide.
//
// M2a (repository split): the Pyodide worker source is a RUNTIME asset —
// the instance receives it as `opts.pyWorkerSource` (from the host's
// workerAssets bundle; src/runtime/worker-assets.js is the canonical
// module). There is deliberately NO page-DOM source and NO fallback:
// constructing without a source is an assembly bug and fails here.
function createPythonRuntime(opts) {
  const pyWorkerSource = opts && opts.pyWorkerSource;
  if (typeof pyWorkerSource !== 'string' || !pyWorkerSource.trim()) {
    throw new Error('createPythonRuntime: pyWorkerSource (a non-empty worker source string) is required');
  }
  const rt = {
  // The worker source for EVERY boot of this instance (immutable after
  // construction; hosts pass the same frozen bundle to every session).
  _pyWorkerSource: pyWorkerSource,
  // M3a TEST SEAM (same category as opts.bootstrapBudgets): a package
  // unit suite may supply a synthetic bootstrap manifest (same names,
  // kinds, mimes; synthetic sizes/hashes over tiny bytes) so the full
  // acquisition pipeline runs deterministically offline. Production
  // never sets it — the default is always the frozen
  // PYTHON_BOOTSTRAP_MANIFEST below, and URLs stay manifest-derived.
  _manifestOverride: (function (m) {
    if (m == null) return null;
    if (!Array.isArray(m) || !m.length
      || m.some((e) => !e || typeof e.name !== 'string' || !e.name
        || typeof e.kind !== 'string' || typeof e.mime !== 'string'
        || !Number.isFinite(e.size) || typeof e.sha256 !== 'string')) {
      throw new Error('createPythonRuntime: bootstrapManifest override must be a non-empty manifest-shaped array');
    }
    return m;
  })(opts && opts.bootstrapManifest),
  worker: null, // facade over the creator-relayed worker (null = cold)
  status: 'cold', // cold | loading | ready
  _reqId: 0,
  _pending: new Map(),
  // Trusted-harness bootstrap state: the VERIFIED asset cache (bytes live
  // on the page; every worker boot clones them; written only on a complete
  // integrity-passed set) and the creator iframe. _boot is the in-flight
  // bootstrap's cancellation plane (null when idle).
  _assets: null,
  _boot: null,
  _creator: null,
  _creatorReady: null,
  _windowListener: false,
  // Run serialization (F04a-A2): the worker answers messages one at a time
  // but its onmessage is ASYNC — overlapping run() calls would interleave
  // runPythonAsync/setStdout inside the worker and cross-contaminate stdout
  // (measured: run A's output landed in run B's result). _queue is the
  // tail of the run chain; every run() call appends one exclusive turn.
  _queue: Promise.resolve(),
  // Queued-but-unstarted runs, drainable by reset() (a session boundary
  // must not let a pre-reset run execute on a post-reset worker). A
  // reset/dispose only MARKS these entries killed: each entry stays
  // counted until its run's promise actually settles — a synchronous
  // boundary must never masquerade as the run's settlement.
  _queuedRuns: new Set(),
  // ACTIVE runs: every execution between seat acquisition and final
  // settlement — boot, mirror collection, worker execution AND the whole
  // commit/write-back phase. busyExecutions = queued + active, so the
  // count returns to zero only when runs truly settle. Entries are
  // released exactly once, in the run's own finally — never by
  // reset()/dispose() themselves.
  _activeRuns: new Set(),
  // Capability Composition v1: the python extension payload for the
  // NEXT boot ({ key, modules: [{ pluginId, files, imports }] }),
  // configured by the trusted harness from the frozen TaskEnvironment
  // before a task runs. A changed key means the booted interpreter
  // (if any) holds a different plugin set, so the harness resets it;
  // the next boot installs the new payload before READY. Null = core
  // runtime only. Plugin payloads never touch the bootstrap asset
  // manifest (F04c) — they arrive in the bootstrap MESSAGE, are
  // installed after the declared package set, and fail the boot
  // closed when broken.
  _extensions: null,
  // Terminal state (dispose()): the disposal reason, or null while the
  // instance accepts work. Permanent — there is no un-dispose.
  _disposed: null,
  // Reset generation: bumped by EVERY reset()/dispose(). A queued run
  // captures the generation at call time and re-checks it after the seat
  // is taken and again before the worker post, so a boundary that lands
  // while a run is suspended between seat and post still invalidates it
  // (the drained-set alone cannot see runs that already left the queue).
  _resetGeneration: 0,
  // The reason carried by the latest reset/dispose, used as the
  // invalidation error for runs caught by the generation check.
  _resetReason: null,

  // Everything below runs in the TRUSTED harness phase: creator iframe
  // spawn, verified asset acquisition, bootstrap delivery, lock
  // confirmation - each stage under its OWN budget (F04c): acquisition
  // (download + integrity) <= PYTHON_ASSET_TIMEOUT_MS; initialization
  // (creator ready + worker spawn + in-memory boot + lockdown) <=
  // PYTHON_BOOTSTRAP_TIMEOUT_MS, paused while acquisition runs. Neither
  // shares the 30s user-execution budget, and every stage's error says
  // which phase failed. A failure tears the whole stack down so the next
  // run rebuilds from scratch (verified assets stay cached).
  async _ensureWorker(signal, budgets) {
    if (this._disposed) throw new Error(this._disposed);
    if (this.worker) return;
    throwIfCancelled(signal, 'python execution');
    this._setStatus('loading');
    this._ensureCreator();
    const b = pythonBootstrapBudgets(budgets);
    const boot = openBootstrapAbort(signal);
    this._boot = boot;
    // Initialization budget: creator ready + worker spawn + worker boot
    // reply. PAUSED around acquisition, which owns its own budget.
    const initClock = makeBudgetClock(b.bootstrapMs);
    try {
      await raceBootStage(this._creatorReady, boot, initClock, () => pythonInitTimeoutError(b.bootstrapMs));
      throwIfCancelled(signal, 'python execution');
      throwIfBootAborted(boot);
      if (!this._creator) throw new Error('python creator iframe lost');
      this._creator.contentWindow.postMessage({ type: 'spawn', workerSrc: this._pyWorkerSource }, '*');
      this.worker = {
        postMessage: (msg) => { this._postToWorker(msg); },
        onerror: (e) => this._onWorkerFatal(e),
        terminate: () => { this._destroyCreator(); },
      };
      // TRUSTED HARNESS PHASE: acquire the pinned asset set on its OWN
      // budget - raw-byte bounded reads + SHA-256 verification (F04c) -
      // then hand the VERIFIED bytes to the worker. The bytes travel by
      // postMessage; the worker itself performs zero bootstrap network
      // requests (its CSP forbids them).
      initClock.pause();
      let assets;
      try {
        assets = await this._loadAssets(signal, boot, b);
      } finally {
        initClock.resume();
      }
      throwIfCancelled(signal, 'python execution');
      throwIfBootAborted(boot);
      const id = ++this._reqId;
      const remaining = Math.max(initClock.remaining(), 0);
      const reply = await new Promise((resolve) => {
        const entry = {
          resolve,
          timer: setTimeout(() => {
            this._pending.delete(id);
            resolve({ error: pythonInitTimeoutError(b.bootstrapMs).message });
          }, remaining),
        };
        this._pending.set(id, entry);
        // The boot-reply wait is INSIDE the boot's cancellation plane: a
        // task/session cancellation (or a reset, or a worker-fatal, or the
        // budget deadline) that lands while the worker is still installing
        // must end the boot IMMEDIATELY — never let a cancelled boot turn
        // READY hours later when the worker finally replies 'locked'.
        boot.ac.signal.addEventListener('abort', () => {
          const pendingEntry = this._pending.get(id);
          if (pendingEntry !== entry) return; // real reply already landed
          this._pending.delete(id);
          clearTimeout(entry.timer);
          resolve({ error: boot.ac.signal.reason });
        }, { once: true });
        this._postToWorker({ id: id, cmd: 'bootstrap', assets: assets, extensionModules: this._extensions ? this._extensions.modules : [] });
      });
      if (reply.error) throw (reply.error instanceof Error ? reply.error : new Error(reply.error));
      if (reply.status !== 'locked') throw new Error('python runtime bootstrap did not lock');
    } catch (e) {
      this.worker = null;
      this._destroyCreator();
      this._setStatus('cold');
      throw e;
    } finally {
      boot.dispose();
      if (this._boot === boot) this._boot = null;
    }
  },

  _ensureCreator() {
    if (this._creator) return;
    const iframe = document.createElement('iframe');
    iframe.setAttribute('data-locus-py-creator', '');
    iframe.setAttribute('title', 'python runtime');
    iframe.style.display = 'none';
    iframe.srcdoc = PY_CREATOR_DOC;
    if (!this._windowListener) {
      this._windowListener = true;
      window.addEventListener('message', (ev) => this._onWindowMessage(ev));
    }
    this._creatorReady = new Promise((resolve) => {
      const onReady = (ev) => {
        const d = ev.data || {};
        if (ev.source === iframe.contentWindow && d.type === 'creator-ready') {
          window.removeEventListener('message', onReady);
          resolve();
        }
      };
      window.addEventListener('message', onReady);
    });
    document.body.appendChild(iframe);
    this._creator = iframe;
  },

  _destroyCreator() {
    if (this._creator) {
      try { this._creator.remove(); } catch (e) {}
      this._creator = null;
    }
    this._creatorReady = null;
    this.worker = null;
  },

  _postToWorker(msg) {
    const creator = this._creator;
    const ready = this._creatorReady || Promise.resolve();
    ready.then(() => {
      if (creator && this._creator === creator && creator.contentWindow) {
        creator.contentWindow.postMessage(msg, '*');
      }
    });
  },

  _onWindowMessage(ev) {
    if (!this._creator || ev.source !== this._creator.contentWindow) return;
    const msg = ev.data || {};
    const pending = this._pending.get(msg.id);
    if (msg.type === 'status') {
      this._setStatus(msg.status);
      return;
    }
    if (msg.type === 'boot') {
      if (pending) {
        this._pending.delete(msg.id);
        clearTimeout(pending.timer);
        pending.resolve(msg);
      }
      return;
    }
    if (msg.type === 'worker-fatal') {
      this._onWorkerFatal({ message: msg.message });
      return;
    }
    if (msg.type === 'result' && pending) {
      this._pending.delete(msg.id);
      clearTimeout(pending.timer);
      pending.resolve(msg);
    }
  },

  _onWorkerFatal(e) {
    // A fatal worker error kills the interpreter: fail pending calls AND
    // destroy the creator stack so the next run boots a fresh one.
    // (Ordinary Python exceptions never reach here — they come back as
    // result.error.) An in-flight bootstrap is aborted first, so its
    // acquisition stops and cannot complete into state afterwards.
    const message = 'worker error: ' + (e && e.message ? e.message : 'unknown');
    this._failBoot(bootstrapAssetError(message, 'python_worker_fatal'));
    this._destroyCreator();
    this._failAllPending(message);
    this._setStatus('cold');
  },

  // Fixed-asset acquisition (trusted harness, F04c). Every asset comes
  // from its pinned URL as raw bytes bounded at the manifest's exact size
  // and SHA-256-verified BEFORE text decoding; only the complete verified
  // set is cached or delivered. The overall acquisition deadline aborts
  // the whole boot (fetch + body reads) with a labelled timeout; any other
  // failure fails the boot too, so nothing keeps downloading after a
  // mismatch. The page-session cache survives worker crashes and resets -
  // a verified rebuild never re-downloads (zero network).
  async _loadAssets(signal, boot, budgets) {
    if (this._assets) return this._assets;
    if (!sha256Available()) {
      throw pythonAssetIntegrityError('(context)', 'unavailable',
        'WebCrypto subtle is not available here; refusing to bootstrap unverified assets');
    }
    const deadlineTimer = setTimeout(() => {
      boot.fail(pythonAssetTimeoutError(
        'Python runtime asset acquisition timed out after ' + budgets.assetMs + 'ms'));
    }, Math.max(budgets.assetMs, 0));
    try {
      const out = {};
      // The instance's manifest: the pinned module constant, or the
      // documented TEST-ONLY override passed at construction.
      const manifest = this._manifestOverride || PYTHON_BOOTSTRAP_MANIFEST;
      for (const entry of manifest) {
        throwIfCancelled(signal, 'python execution');
        throwIfBootAborted(boot);
        const bytes = await this._acquireAsset(entry, boot, budgets);
        out[entry.name] = entry.kind === 'text'
          ? { text: new TextDecoder('utf-8').decode(bytes), mime: entry.mime } // decode AFTER integrity passed
          : { buffer: bytes.buffer, mime: entry.mime };
      }
      // Single-threaded: an abort can only land at an await boundary, so a
      // cancelled/timed-out/mismatched acquisition cannot slip past these
      // checks into the cache write. Only a complete verified manifest set
      // gets here.
      throwIfCancelled(signal, 'python execution');
      throwIfBootAborted(boot);
      this._assets = out;
      return out;
    } catch (e) {
      boot.fail(e); // stop every remaining acquisition boundary, best effort
      throw e;
    } finally {
      clearTimeout(deadlineTimer);
    }
  },

  // Acquire ONE manifest asset: fetch from the pinned URL under the boot's
  // abort signal, read exactly manifest-size raw entity bytes, SHA-256
  // verify against the manifest. The URL is manifest-derived only - user
  // input can never vary it (no path/query/fallback).
  async _acquireAsset(entry, boot, budgets) {
    const signal = boot.ac.signal;
    let res;
    try {
      // force-cache: the manifest pins the exact content, so ANY cached copy
      // is acceptable (a wrong one fails the SHA-256 gate downstream). The
      // browser HTTP cache then serves warm boots with zero network even
      // when freshness heuristics would revalidate.
      res = await fetch(PYODIDE_BASE + entry.name, { signal, cache: 'force-cache' });
    } catch (e) {
      if (signal.aborted) throw (signal.reason || e); // deadline/cancel/reset reason is authoritative
      throw pythonAssetUnavailable('Python runtime asset unavailable: ' + entry.name
        + ' (' + (e && e.name ? e.name + ': ' : '') + (e && e.message ? e.message : String(e)) + ')');
    }
    if (!res.ok) {
      throw pythonAssetUnavailable('Python runtime asset unavailable: ' + entry.name + ' (HTTP ' + res.status + ')');
    }
    let bytes;
    try {
      bytes = await readBodyBounded(res, entry, budgets.assetStallMs);
    } catch (e) {
      if (signal.aborted) throw (signal.reason || e);
      throw e;
    }
    const hex = await sha256Hex(bytes);
    if (hex !== entry.sha256) {
      throw pythonAssetIntegrityError(entry.name, 'sha256 mismatch');
    }
    return bytes;
  },

  // Abort any in-flight bootstrap attempt: acquisition fetches and body
  // reads stop at the next boundary, and a late completion can never
  // mutate runtime state or the asset cache afterwards (re-checked at
  // every await). No-op when idle.
  _failBoot(reason) {
    if (this._boot) this._boot.fail(reason || makeCancelledError('python bootstrap'));
  },

  // Terminate the worker stack (timeout, cancellation, fatal error), fail
  // every pending request, and reset so the next call boots a fresh one.
  _killWorker(reason) {
    this._destroyCreator();
    this._failAllPending(reason || ('python execution timed out after ' + PYTHON_TIMEOUT_MS + 'ms'));
    this._setStatus('cold');
  },

  // ---- M1b lifecycle: prepare ----
  // Between-task configuration point. Compares the wanted python plugin
  // payload with the configured one and reconfigures ONLY on a key change.
  // This is pure configuration work: it never creates the creator iframe,
  // never spawns a worker, never downloads an asset — the interpreter
  // stays lazily booted and a text-only task performs zero Python asset
  // acquisition. A no-change prepare (same key) touches nothing: no reset,
  // no reconfiguration, no interpreter churn.
  //
  // All-or-nothing: the new payload is validated (the exact
  // configureExtensions shape gates) BEFORE the old interpreter is torn
  // down, so a validation failure leaves the previously configured payload
  // fully intact — never a half-applied reset with no payload.
  //
  // Synchronous by construction: there is no await between the comparison,
  // validation, teardown and commit, so a stale or cancelled caller can
  // never interleave — a late apply cannot overwrite a newer task’s
  // configuration. An already-aborted req.signal is refused before any
  // state changes. Returns { rebuiltInterpreter: boolean }.
  //
  // Caller contract: prepare runs BETWEEN tasks. A key change tears down
  // the configured interpreter (reset), which would kill an in-flight
  // execution — waiting for in-flight work is the harness task runner’s
  // admission + storage-mutation quiesce gate’s job, not prepare’s.
  prepare(req) {
    if (this._disposed) throw new Error(this._disposed);
    const signal = req && req.signal;
    if (signal && signal.aborted) {
      // Cancellation-shaped (AbortError): the caller's existing
      // cancellation classification must read this refusal as a
      // cancellation, never as an independent prepare error.
      throw makeCancelledError('python preparation');
    }
    const wanted = req && req.python ? req.python.key : null;
    if (this.extensionKey() === wanted) return { rebuiltInterpreter: false };
    // Validate + stage the new payload BEFORE tearing anything down.
    const staged = wanted === null ? null : this.buildExtensions(req.python);
    this.reset('python runtime reset (interpreter rebuilt for a changed plugin set)');
    this._extensions = staged;
    return { rebuiltInterpreter: true };
  },

  // ---- M1b lifecycle: dispose ----
  // Terminal teardown for page teardown / runtime replacement. Everything
  // reset() does (invalidate boot, pending requests, queued runs) plus a
  // permanent refusal of prepare/run/configureExtensions. IDEMPOTENT: a
  // second dispose keeps the FIRST reason and does not throw. Late worker
  // messages cannot revive the instance: the creator iframe is destroyed
  // (so _onWindowMessage drops everything) and the disposed flag blocks
  // new work.
  dispose(reason) {
    const why = this._disposed || ('python runtime disposed' + (reason ? ': ' + reason : ''));
    this._resetReason = why;
    this._resetGeneration++;
    this._failBoot(makeCancelledError(why));
    if (this.worker || this._pending.size) {
      this._killWorker(why);
    }
    // Queued runs are MARKED killed but stay counted until their promises
    // actually settle at their next boundary: a synchronous dispose must
    // not masquerade as those runs' settlement (busyExecutions stays the
    // honest "not yet settled" signal for callers like the storage gate).
    for (const entry of this._queuedRuns) {
      entry.killed = true;
      entry.reason = why;
    }
    this._disposed = why;
  },

  // ---- M1b lifecycle: state reads ----
  // Canonical snapshot for callers outside the runtime (UI status,
  // harness adapters, tests). No internal Maps/Sets are exposed.
  snapshot() {
    return {
      interpreter: this.status,
      busyExecutions: this._queuedRuns.size + this._activeRuns.size,
      extensionKey: this.extensionKey(),
      disposed: this._disposed,
    };
  },

  // Session boundary: drop the entire interpreter (globals, imported
  // modules, /tmp files, pending state). Called on workspace switch and
  // on explicit session reset so no Python state leaks across sessions.
  reset(reason) {
    const why = reason || 'python runtime reset (session boundary)';
    this._resetReason = why;
    this._resetGeneration++;
    // An in-flight bootstrap belongs to the dying session: abort its
    // acquisition (verified assets stay cached - they are stateless bytes).
    this._failBoot(makeCancelledError(why));
    if (this.worker || this._pending.size) {
      this._killWorker(why);
    }
    // Drain queued-but-unstarted runs too: the boundary is the queue's
    // boundary. Timeouts, cancellations and worker crashes kill the worker
    // but deliberately do NOT drain — the next queued run proceeds on a
    // fresh worker (its own timer starts when it gets the seat).
    // The drain MARKS entries killed; each stays counted until its own
    // promise settles (the throw in run()) — reset() never releases a
    // caller's run tracking itself, so busyExecutions cannot claim the
    // run settled before it actually did.
    for (const entry of this._queuedRuns) {
      entry.killed = true;
      entry.reason = why;
    }
  },

  // Current extension key of the configured python runtime (null =
  // core only). The harness compares it with the next task's
  // TaskEnvironment key to decide whether the interpreter must be
  // rebuilt before that task runs.
  extensionKey() {
    return this._extensions ? this._extensions.key : null;
  },

  // Configure the extension payload for FUTURE boots (trusted harness
  // only). Shape-validated and frozen; a booted interpreter is never
  // touched here — swapping the live plugin set is the harness's
  // explicit reset() decision, never a side effect of configuration.
  //
  // Two module payload shapes exist:
  //  - LEGACY SYNTHETIC COMPOSITION PATH: { pluginId, files: {rel: text},
  //    imports } — source text written straight into site-packages by the
  //    worker. Capability Composition's synthetic proof; NOT Trusted
  //    Plugin Runtime artifact delivery (V1B retires/isolates it).
  //  - TRUSTED WHEEL PAYLOAD (TPR v1A): { pluginId, wheels: [{ filename,
  //    format, size, sha256, bytes }], imports } — EXACTLY ONE verified
  //    wheel per module, installed OFFLINE by the worker before READY.
  //    Every invariant a worker cannot be trusted to catch is enforced
  //    HERE: a metadata/bytes disagreement is a trusted-harness bug and
  //    must fail before the boot send, never inside the interpreter.
  buildExtensions(ext) {
    if (ext === null || ext === undefined) return null;
    if (!ext || typeof ext !== 'object' || typeof ext.key !== 'string' || !ext.key
        || !Array.isArray(ext.modules)) {
      throw new Error('PythonRuntime.configureExtensions: invalid extension payload');
    }
    const modules = ext.modules.map((m) => {
      if (!m || typeof m !== 'object' || typeof m.pluginId !== 'string' || !m.pluginId
          || !Array.isArray(m.imports)) {
        throw new Error('PythonRuntime.configureExtensions: invalid extension module entry');
      }
      // CANONICAL PLUGIN IDENTITY: the trusted Harness payload may not invent
      // a weaker id schema — every module id must match the SAME pattern the
      // descriptors are validated against (extensions.js keeps its own copy;
      // equality is pinned by tests/runtime-boundary.test.cjs). Both payload
      // shapes — LEGACY SYNTHETIC COMPOSITION PATH (files) and TRUSTED
      // PLUGIN RUNTIME V1A (wheels) — pass through this gate.
      if (!RUNTIME_PLUGIN_ID_PATTERN.test(m.pluginId)) {
        throw new Error('PythonRuntime.configureExtensions: module pluginId must match '
          + RUNTIME_PLUGIN_ID_PATTERN + ': ' + m.pluginId);
      }
      if (m.imports.some((n) => !RUNTIME_PY_MODULE_PATTERN.test(String(n)))) {
        throw new Error('PythonRuntime.configureExtensions: invalid smoke import name in module ' + m.pluginId);
      }
      const hasFiles = m.files !== undefined;
      const hasWheels = m.wheels !== undefined;
      if (hasFiles && hasWheels) {
        throw new Error('PythonRuntime.configureExtensions: module ' + m.pluginId
          + ' carries both files and wheels payloads');
      }
      if (hasWheels) {
        // EXACTLY-ONE-WHEEL (Package v1 / TPR v1A contract): one python-wheel
        // artifact per plugin — no dependency closure, no multi-wheel format.
        // A wrong shape is a protocol violation and fails here with a
        // controlled validation error, never as an incidental JS TypeError
        // bubbling out of the mapping below.
        if (!Array.isArray(m.wheels) || m.wheels.length !== 1) {
          throw new Error('PythonRuntime.configureExtensions: module ' + m.pluginId
            + ' wheels payload must be an array with exactly one .whl artifact');
        }
        const wheels = m.wheels.map((w) => validateWheelArtifact(m.pluginId, w));
        return Object.freeze({ pluginId: m.pluginId, imports: m.imports.slice(), wheels: Object.freeze(wheels.map(Object.freeze)) });
      }
      if (!hasFiles || typeof m.files !== 'object' || Array.isArray(m.files)) {
        throw new Error('PythonRuntime.configureExtensions: invalid extension module entry');
      }
      const files = {};
      for (const rel of Object.keys(m.files)) {
        if (typeof m.files[rel] !== 'string') {
          throw new Error('PythonRuntime.configureExtensions: module ' + m.pluginId
            + ' payload file ' + rel + ' must be UTF-8 text');
        }
        files[rel] = m.files[rel];
      }
      return Object.freeze({ pluginId: m.pluginId, files: files, imports: m.imports.slice() });
    });
    return Object.freeze({ key: ext.key, modules: Object.freeze(modules) });
  },

  // Configure the extension payload for FUTURE boots (trusted harness
  // only). Thin assign over buildExtensions — kept as the compatibility
  // entry for direct payload setters; the task path uses prepare(), which
  // stages the payload before any teardown. Refuses a disposed instance.
  configureExtensions(ext) {
    if (this._disposed) throw new Error(this._disposed);
    this._extensions = this.buildExtensions(ext);
  },

  _failAllPending(errorMessage) {
    for (const [, p] of this._pending) {
      clearTimeout(p.timer);
      p.resolve({ stdout: '', stderr: '', error: errorMessage, files: [], deleted: [], createdDirs: [], deletedDirs: [] });
    }
    this._pending.clear();
  },

  // M2a (repository split): status changes are EVENTS, never DOM writes.
  // _setStatus updates the instance state and fans out to the listener
  // set (onStatus). Observer exceptions are CONTAINED per listener: a
  // throwing observer can never break the execution, other observers or
  // the cleanup path. Events are instance-scoped — a stale instance's
  // events reach only its own (unsubscribed) listeners.
  _statusListeners: null,

  onStatus(fn) {
    if (typeof fn !== 'function') return () => {};
    if (!this._statusListeners) this._statusListeners = new Set();
    this._statusListeners.add(fn);
    // Immediate snapshot on subscribe: consumers read the current state
    // without a poll and without a missed-edge window.
    try { fn(this.snapshot()); } catch (e) { /* contained: initial read */ }
    return () => { this._statusListeners.delete(fn); };
  },

  _emitStatus() {
    if (!this._statusListeners || !this._statusListeners.size) return;
    const snap = this.snapshot();
    for (const fn of Array.from(this._statusListeners)) {
      try { fn(snap); } catch (e) { /* contained: observer failure */ }
    }
  },

  _setStatus(status) {
    if (this.status === status) { return; }
    this.status = status;
    this._emitStatus();
  },

  // Run Python code with every VFS data mount mirrored in — serialized:
  // concurrent callers queue up and each gets the interpreter exclusively
  // for its whole transaction (mirror-in → worker execution → commit).
  // See _runOnce for the per-run contract. opts.bootstrapBudgets is a
  // TEST-ONLY seam shrinking the bootstrap budgets (never used in prod).
  async run(code, vfs, opts) {
    if (this._disposed) throw new Error(this._disposed);
    const entry = { killed: false, reason: null, done: null };
    this._queuedRuns.add(entry);
    const gen = this._resetGeneration;
    const turn = this._queue.then(async () => {
      // Seat acquired (or the entry was drained while queued — delete is
      // idempotent either way). A killed entry belongs to a superseded
      // generation: the boundary already won and this run must not start.
      // The entry still releases its own tracking HERE — the boundary only
      // marked it; the run settles itself.
      this._queuedRuns.delete(entry);
      if (entry.killed) {
        throw new Error(entry.reason || this._resetReason || 'python runtime reset (session boundary)');
      }
      // The boundary may also land AFTER the seat was taken but before the
      // run posted (this turn was suspended at an await): the generation
      // check invalidates it here, before _runOnce starts.
      if (gen !== this._resetGeneration) {
        throw new Error(this._resetReason || 'python runtime reset (session boundary)');
      }
      // ACTIVE for the run's WHOLE remaining lifetime — boot, collection,
      // worker execution and the commit/write-back phase alike — and
      // released exactly once when the run settles. reset()/dispose() do
      // NOT touch this set: a synchronous boundary invalidates the run
      // but never masquerades as its settlement.
      this._activeRuns.add(entry);
      try {
        return await this._runOnce(code, vfs, opts, gen);
      } finally {
        this._activeRuns.delete(entry);
      }
    });
    // A failed or killed run must not poison the callers queued behind it;
    // the chain always advances, so timeouts/cancellations/releases cannot
    // wedge the queue.
    this._queue = turn.then(() => {}, () => {});
    // M2a: the entry's settlement promise. Assigned synchronously (no await
    // separates it from the queued-set add), so a prepare barrier taken at
    // any later moment sees EVERY in-flight run exactly once.
    entry.done = turn;
    return turn;
  },

  // M2a (repository split): resolves when every execution tracked at call
  // time (queued + active) has SETTLED — the barrier RuntimeSession.prepare
  // waits on before applying a configuration change. Promise.allSettled:
  // a failing run is still a settled run. Null when nothing is in flight
  // (the common between-tasks case — no promise allocated).
  _inflightSettlement() {
    const proms = [];
    for (const e of this._queuedRuns) if (e.done) proms.push(e.done);
    for (const e of this._activeRuns) if (e.done) proms.push(e.done);
    if (!proms.length) return null;
    return Promise.allSettled(proms).then(() => {});
  },

  // Run Python code with every VFS data mount mirrored in.
  // `vfs` is always a VirtualWorkspace (asVfs guarantees it); opts carries
  // { signal, cwd } — cwd is the ABSOLUTE VFS path of the shell invocation
  // and becomes Python's working directory.
  // opts.signal (optional AbortSignal) cancels the run: cancellation is
  // checked before starting, during mount collection, after the worker
  // reply, after EVERY async pre-check and before EVERY commit side effect.
  // A reset()/dispose() boundary is enforced with the same SHAPE (before
  // the worker post, after the reply, and before every mkdir/write/remove/
  // rmdir): once the run's generation is superseded, no further VFS side
  // effect starts. Operations ALREADY handed to the provider (a worker run
  // in flight, a commit call in flight) cannot be rolled back — the run
  // waits for their settlement, reports exactly what committed and what
  // never ran, and never presents a boundary-stopped run as a success.
  // Returns {
  //   stdout, stderr, error,            — compute outcome
  //   written, deleted,                 — ABS paths actually committed (deleted covers files AND directories)
  //   mkdirs,                           — ABS directory paths actually created
  //   conflicts: [{path, reason}],      — commits refused (read-only mount / external change / unsynced path / type change)
  //   writeFailed: [description],       — commits attempted but failed
  //   notPersisted: [paths],            — generated changes never written (cancelled / incomplete changeset)
  //   skipped: [{path, reason}],        — files NOT mirrored into Python (ABS paths)
  //   uncollected: [paths],             — python outputs over the worker caps (changeset incomplete)
  //   stdoutTruncated, stderrTruncated, — output notice flags (NOT commit failures)
  // }
  async _runOnce(code, vfs, opts, expectedGeneration) {
    const signal = opts && opts.signal;
    // The injected mutation policy decides which provider errors are
    // REFUSALS (reported as conflicts — honest changeset accounting)
    // rather than generic write failures. No policy = no refusals.
    const policy = opts && opts.mutationPolicy;
    const isRefusal = (e) => !!(policy && typeof policy.isPolicyRefusal === 'function' && policy.isPolicyRefusal(e));
    // Boundary invalidation for THIS run: a reset()/dispose() that landed
    // at any await since the run started. Checked before the worker post
    // (never reach the next generation's interpreter), again once the
    // worker answers, and before EVERY commit side effect — a run whose
    // generation already ended must not write stale state back.
    const invalidated = () => {
      if (this._disposed) return this._disposed;
      if (expectedGeneration !== undefined && expectedGeneration !== this._resetGeneration) {
        return this._resetReason || 'python runtime reset (session boundary)';
      }
      return null;
    };
    // Commit-phase stop decision: the task signal (cancellation — existing
    // semantics and texts) or a runtime boundary (reason as the text).
    // Returns the notPersisted entry, or null when the commit may proceed.
    let boundaryStop = null; // first boundary reason that stopped a commit
    const runStopped = (label, cancelledAs) => {
      if (signal && signal.aborted) return label + ' (' + cancelledAs + ')';
      const why = invalidated();
      if (why) {
        if (!boundaryStop) boundaryStop = why;
        return label + ' (' + why + ')';
      }
      return null;
    };
    await this._ensureWorker(signal, opts && opts.bootstrapBudgets);
    throwIfCancelled(signal, 'python execution');

    // Mirror every data mount: files are collected from each provider with
    // RELATIVE paths and rebased onto the mount root, so the worker mirror,
    // the snapshot keys and every commit/conflict message all use absolute
    // VFS paths.
    const mounts = [];
    let skipped = [];
    let inputBytes = 0;
    const snapshot = {}; // ABS path → b64 at sync-in time (optimistic concurrency base)
    if (vfs && typeof vfs.dataMounts === 'function') {
      for (const dm of vfs.dataMounts()) {
        const collected = await collectWorkspaceFiles(dm.provider, signal);
        const files = collected.files.map((f) => ({ path: dm.root + '/' + f.path, b64: f.b64 }));
        // Every real VFS directory (empty ones included) is mirrored in, so
        // Python sees the same directory tree the shell does.
        const directories = collected.dirs.map((d) => dm.root + '/' + d);
        skipped = skipped.concat(collected.skipped.map((s) => ({ path: dm.root + '/' + s.path, reason: s.reason })));
        for (const f of files) snapshot[f.path] = f.b64;
        inputBytes += files.reduce((n, f) => n + b64ByteLength(f.b64), 0);
        mounts.push({
          root: dm.root,
          readOnly: dm.authority === 'read-only' || dm.authority === 'system-read-only',
          files: files,
          directories: directories,
        });
      }
    }
    // The shell cwd must exist in the Python mirror — but it is only ever
    // CREATED there when the VFS itself confirms it is a real directory.
    // A bogus cwd must still fail in Python, never be fabricated.
    const cwdAbs = (opts && opts.cwd) || (vfs && typeof vfs.defaultCwd === 'function' ? vfs.defaultCwd() : '/');
    for (const m of mounts) {
      if (cwdAbs === m.root || !cwdAbs.startsWith(m.root + '/')) continue;
      if (m.directories.indexOf(cwdAbs) === -1) {
        let st = null;
        try { st = await vfs.stat(cwdAbs); } catch (e) { st = null; }
        if (st && st.kind === 'directory') m.directories.push(cwdAbs);
      }
      break;
    }
    // The abort may have landed DURING collection (no listener was attached
    // yet) — never start the worker run on a cancelled task.
    throwIfCancelled(signal, 'python execution');

    // Last boundary before the worker post: a reset()/dispose() that
    // landed while this run was suspended in the boot/mirror awaits
    // invalidates it here — it must never reach the (possibly replaced)
    // interpreter of the next generation.
    const prePostInvalid = invalidated();
    if (prePostInvalid) throw new Error(prePostInvalid);
    const id = ++this._reqId;
    const onAbort = () => this._killWorker('python execution cancelled');
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    let result;
    try {
      result = await new Promise((resolve) => {
        const timer = setTimeout(
          () => this._killWorker('python execution timed out after ' + PYTHON_TIMEOUT_MS + 'ms'),
          PYTHON_TIMEOUT_MS);
        this._pending.set(id, { resolve, timer });
        this.worker.postMessage({
          id: id, cmd: 'run', code: code,
          cwd: cwdAbs,
          mounts: mounts,
        });
      });
    } finally {
      if (signal) signal.removeEventListener('abort', onAbort);
    }
    throwIfCancelled(signal, 'python execution');
    // The worker answered, but a boundary may have landed while this run
    // was suspended at the reply await: if the boundary itself did not
    // already fail the reply (_failAllPending puts its reason in
    // result.error), record it so NOTHING from this changeset commits and
    // the final report carries the boundary as its error — a run of a
    // superseded generation is never presented as a clean success.
    const postReplyInvalid = invalidated();
    if (postReplyInvalid && !result.error) boundaryStop = postReplyInvalid;

    const skippedSet = new Set(skipped.map((s) => s.path));
    const uncollected = result.uncollectedFiles || [];
    const createdDirs = result.createdDirs || []; // worker emits parent-first
    const deletedDirs = result.deletedDirs || []; // worker emits child-first
    const written = [];
    const mkdirs = [];
    const conflicts = [];
    const writeFailed = [];
    const notPersisted = [];
    const outFiles = result.files || [];

    for (const p of uncollected) {
      notPersisted.push(p + ' (over python output limit; changeset incomplete)');
    }

    // ---- commit phase 0: created directories (parent before child) ----
    // Directory creations route through the same mount-authority checks as
    // file writes: read-only mounts reject with a conflict, and a path
    // already occupied by a FILE is a loud refusal — file↔directory type
    // changes are never half-applied.
    for (const d of createdDirs) {
      const stopD = runStopped('mkdir ' + d, 'cancelled before commit');
      if (stopD) {
        notPersisted.push(stopD);
        continue;
      }
      const mount = vfs && typeof vfs.resolveMount === 'function' ? vfs.resolveMount(d) : null;
      if (!mount) {
        conflicts.push({ path: d, reason: 'not under any writable mount; mkdir skipped' });
        continue;
      }
      if (mount.authority === 'read-only' || mount.authority === 'system-read-only') {
        conflicts.push({
          path: d,
          reason: 'read-only filesystem: changes under ' + mount.path + ' are never committed',
        });
        continue;
      }
      let st = null;
      try {
        st = await vfs.stat(d);
      } catch (e) {
        if (!e || e.name !== 'NotFoundError') {
          conflicts.push({ path: d, reason: 'could not verify current on-disk state (' + e.message + '); mkdir skipped' });
          continue;
        }
      }
      if (st && st.kind === 'directory') continue; // appeared externally — already satisfied
      if (st) {
        conflicts.push({ path: d, reason: 'a file exists at this path; file→directory type changes are not committed' });
        continue;
      }
      // The stat above awaited: re-check cancellation AND boundary
      // validity BEFORE the side effect.
      const stopD2 = runStopped('mkdir ' + d, 'cancelled before commit');
      if (stopD2) {
        notPersisted.push(stopD2);
        continue;
      }
      try {
        await vfs.mkdir(d);
        mkdirs.push(d);
      } catch (e) {
        // A skill-boundary refusal is a DECISION (harness-owned layout),
        // reported as a refused conflict — never a silent skip.
        if (isRefusal(e)) conflicts.push({ path: d, reason: e.message });
        else writeFailed.push('mkdir ' + d + ': ' + (e && e.message ? e.message : String(e)));
      }
    }

    // ---- commit phase 1: create/modify ----
    // EVERY changed ABS path is routed through the mount table: read-only
    // mounts reject with a conflict (the worker mirror is writable, so
    // authority is enforced HERE, at commit time — the provider bytes are
    // never touched), external mounts keep the optimistic-concurrency
    // check, internal mounts write straight through.
    for (const f of outFiles) {
      const stopF = runStopped(f.path, 'cancelled before write');
      if (stopF) {
        notPersisted.push(stopF);
        continue;
      }
      const mount = vfs && typeof vfs.resolveMount === 'function' ? vfs.resolveMount(f.path) : null;
      if (!mount) {
        conflicts.push({ path: f.path, reason: 'not under any writable mount; refusing to write' });
        continue;
      }
      if (mount.authority === 'read-only' || mount.authority === 'system-read-only') {
        conflicts.push({
          path: f.path,
          reason: 'read-only filesystem: changes under ' + mount.path + ' are never committed',
        });
        continue;
      }
      if (skippedSet.has(f.path)) {
        // The real file exists but was never mirrored in (over the size
        // or count limit). Python saw this path as absent; whatever it
        // created there must NOT clobber the real file.
        conflicts.push({
          path: f.path,
          reason: 'exists in workspace but was not synced into Python (over snapshot limits); refusing to overwrite',
        });
        continue;
      }
      const bytes = b64ToBytes(f.b64);
      if (mount.authority === 'external-read-write') {
        let conflict = null;
        try {
          conflict = await detectExternalChange(vfs, f.path, snapshot, bytes);
        } catch (e) {
          conflict = { path: f.path, reason: 'could not verify current on-disk state (' + e.message + '); refusing to overwrite' };
        }
        if (conflict) {
          conflicts.push(conflict);
          continue;
        }
      }
      // The pre-check awaited: cancellation or a boundary may have landed
      // meanwhile. Re-check BEFORE the side effect, not just at the loop top.
      const stopF2 = runStopped(f.path, 'cancelled before write');
      if (stopF2) {
        notPersisted.push(stopF2);
        continue;
      }
      try {
        await vfs.write(f.path, bytes);
        written.push(f.path);
      } catch (e) {
        // Skill mutations are approval-bound at the task fork's
        // SkillInstanceWorkspace: declined confirmations, TOCTOU
        // conflicts and undeclared paths are honest REFUSALS (changeset
        // reports the skill as not persisted), not generic I/O errors.
        if (isRefusal(e)) conflicts.push({ path: f.path, reason: e.message });
        else writeFailed.push(f.path + ': ' + (e && e.message ? e.message : String(e)));
      }
    }

    // ---- commit phase 2: deletions (rename = delete + create) ----
    // If ANY write failed, was refused, or the worker could not collect the
    // full changeset, the run's new state is incomplete — deleting sources
    // could destroy the only good copy (e.g. a rename whose target never
    // landed). Stop the delete phase.
    const deleted = [];
    const deletesBlocked = writeFailed.length > 0 || conflicts.length > 0 || uncollected.length > 0;
    if (result.deleted && result.deleted.length && !deletesBlocked) {
      for (const p of result.deleted) {
        const stopDel = runStopped('delete ' + p, 'cancelled before commit');
        if (stopDel) {
          notPersisted.push(stopDel);
          continue;
        }
        const mount = vfs && typeof vfs.resolveMount === 'function' ? vfs.resolveMount(p) : null;
        if (!mount) {
          conflicts.push({ path: p, reason: 'not under any writable mount; deletion skipped' });
          continue;
        }
        if (mount.authority === 'read-only' || mount.authority === 'system-read-only') {
          conflicts.push({
            path: p,
            reason: 'read-only filesystem: changes under ' + mount.path + ' are never committed',
          });
          continue;
        }
        if (mount.authority === 'external-read-write' && snapshot[p] !== undefined) {
          // Only delete the exact content we mirrored: re-read and compare
          // against the snapshot so an externally modified/replaced file is
          // never removed from under the user.
          let currentB64 = null;
          try {
            currentB64 = bytesToB64(await vfs.readBytes(p));
          } catch (e) {
            if (e && e.name === 'NotFoundError') continue; // already gone externally
            conflicts.push({ path: p, reason: 'could not verify current on-disk state (' + e.message + '); deletion skipped' });
            continue;
          }
          if (currentB64 !== snapshot[p]) {
            conflicts.push({ path: p, reason: 'modified externally during the run; deletion skipped' });
            continue;
          }
        }
        // Verification awaited: re-check cancellation AND boundary
        // validity BEFORE removing.
        const stopDel2 = runStopped('delete ' + p, 'cancelled before commit');
        if (stopDel2) {
          notPersisted.push(stopDel2);
          continue;
        }
        try {
          await vfs.remove(p);
          deleted.push(p);
        } catch (e) {
          if (e && e.name === 'NotFoundError') continue; // already gone
          if (isRefusal(e)) conflicts.push({ path: p, reason: e.message });
          else writeFailed.push('delete ' + p + ': ' + (e && e.message ? e.message : String(e)));
        }
      }
    } else if (result.deleted && result.deleted.length && deletesBlocked) {
      const why = uncollected.length > 0
        ? 'output changeset incomplete (' + uncollected.length + ' file(s) not collected), sources preserved'
        : 'earlier commits failed, sources preserved';
      notPersisted.push('deletions skipped (' + result.deleted.join(', ') + '): ' + why);
    }

    // ---- commit phase 3: deleted directories (child before parent) ----
    // Same honesty rule as file deletions, re-evaluated AFTER phase 2: any
    // failed/refused/incomplete commit so far means the run's new state is
    // incomplete — removing directories could destroy data, so stop.
    const dirDeletesBlocked = deletesBlocked || writeFailed.length > 0 || conflicts.length > 0;
    if (deletedDirs.length && !dirDeletesBlocked) {
      for (const p of deletedDirs) {
        const stopRd = runStopped('rmdir ' + p, 'cancelled before commit');
        if (stopRd) {
          notPersisted.push(stopRd);
          continue;
        }
        if (vfs && typeof vfs.isProtectedRoot === 'function' && vfs.isProtectedRoot(p)) {
          conflicts.push({ path: p, reason: 'protected path; refusing to remove directory' });
          continue;
        }
        const mount = vfs && typeof vfs.resolveMount === 'function' ? vfs.resolveMount(p) : null;
        if (!mount) {
          conflicts.push({ path: p, reason: 'not under any writable mount; rmdir skipped' });
          continue;
        }
        if (mount.authority === 'read-only' || mount.authority === 'system-read-only') {
          conflicts.push({
            path: p,
            reason: 'read-only filesystem: changes under ' + mount.path + ' are never committed',
          });
          continue;
        }
        // A directory that still holds unsynced files is not empty — the
        // provider refuses the removal and the failure is reported below.
        // No async pre-check precedes this side effect on internal mounts,
        // so this validity check IS the boundary gate: a run of a
        // superseded generation must never remove directories.
        const stopRd2 = runStopped('rmdir ' + p, 'cancelled before commit');
        if (stopRd2) {
          notPersisted.push(stopRd2);
          continue;
        }
        try {
          await vfs.remove(p);
          deleted.push(p);
        } catch (e) {
          if (e && e.name === 'NotFoundError') continue; // already gone
          if (isRefusal(e)) conflicts.push({ path: p, reason: e.message });
          else writeFailed.push('rmdir ' + p + ': ' + (e && e.message ? e.message : String(e)));
        }
      }
    } else if (deletedDirs.length && dirDeletesBlocked) {
      const why = uncollected.length > 0
        ? 'output changeset incomplete (' + uncollected.length + ' file(s) not collected), sources preserved'
        : 'earlier commits failed, sources preserved';
      notPersisted.push('directory deletions skipped (' + deletedDirs.join(', ') + '): ' + why);
    }

    // A boundary may land while the FINAL provider side effect is in flight
    // (dispatched, not yet settled): settlement of that call is not
    // validation, and with no later commit iteration there is no further
    // pre-effect check to catch it — the report below would read error:null
    // and present a boundary-stopped run as a success. Re-validate the
    // generation HERE, at result formation. What already committed stays
    // reported in written/mkdirs/deleted (no rollback, no fabricated
    // notPersisted), and a real worker error keeps its precedence.
    const finalInvalid = invalidated();
    if (finalInvalid && !result.error && !boundaryStop) boundaryStop = finalInvalid;

    return {
      stdout: result.stdout || '',
      stderr: result.stderr || '',
      // A boundary that stopped the commits is the run's honest error even
      // when the compute itself succeeded — never a clean success report.
      error: result.error || boundaryStop || null,
      written,
      mkdirs,
      deleted,
      conflicts,
      writeFailed,
      notPersisted,
      skipped,
      uncollected,
      stdoutTruncated: !!result.stdoutTruncated,
      stderrTruncated: !!result.stderrTruncated,
      inputBytes: inputBytes,
      outputBytes: outFiles.reduce((n, f) => n + b64ByteLength(f.b64), 0),
    };
  },
  };
  return rt;
}

// Optimistic concurrency check before committing a create/modify.
// Returns null when the write is safe, or {path, reason} when the real
// file diverged from what Python saw (external edit/create/delete during
// the run). The user's newer on-disk content always wins.
async function detectExternalChange(workspace, path, snapshot, newBytes) {
  if (snapshot[path] !== undefined) {
    // File existed at sync-in: it must still exist with identical content.
    let current;
    try {
      current = await workspace.readBytes(path);
    } catch (e) {
      if (e && e.name === 'NotFoundError') {
        return { path, reason: 'deleted externally during the run; refusing to recreate' };
      }
      throw e;
    }
    if (bytesToB64(current) !== snapshot[path]) {
      return { path, reason: 'modified externally during the run; on-disk version kept' };
    }
    return null;
  }
  // New file from Python's point of view: safe unless someone else created
  // a different file at this path meanwhile.
  let exists = false;
  try {
    exists = await workspace.exists(path);
  } catch (e) {
    throw e;
  }
  if (!exists) return null;
  const current = await workspace.readBytes(path);
  if (current.byteLength !== newBytes.byteLength || bytesToB64(current) !== bytesToB64(newBytes)) {
    return { path, reason: 'created externally during the run; on-disk version kept' };
  }
  return null; // identical content — writing is a no-op
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function bytesToB64(bytes) {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

// Real byte count of a base64 payload, excluding padding (length*0.75
// would count a 1-byte payload as 3 bytes).
function b64ByteLength(b64) {
  const len = String(b64 || '').length;
  if (!len) return 0;
  let pad = 0;
  if (b64[len - 1] === '=') pad++;
  if (b64[len - 2] === '=') pad++;
  return Math.floor(len / 4) * 3 - pad;
}

// Snapshot workspace files for the Python mirror. Caps keep V0 sane.
// IMPORTANT: a capped snapshot is not the workspace. Every skipped path
// is recorded explicitly so (a) the model is told exactly what Python
// cannot see and (b) the write-back phase can refuse to overwrite those
// paths with files Python created in their absence.
const SYNC_MAX_FILES = 200;
const SYNC_MAX_FILE_BYTES = 5 * 1024 * 1024;
const SYNC_MAX_TOTAL_BYTES = 25 * 1024 * 1024;

async function collectWorkspaceFiles(workspace, signal) {
  const files = [];
  const dirs = []; // RELATIVE paths of every directory (empty ones included)
  const skipped = [];
  let total = 0;

  async function walk(rel) {
    throwIfCancelled(signal, 'workspace collection');
    const entries = await workspace.list(rel);
    throwIfCancelled(signal, 'workspace collection');
    for (const e of entries) {
      const childRel = rel ? rel + '/' + e.name : e.name;
      if (e.kind === 'directory') {
        // Directories are real filesystem state: an empty dir must exist in
        // the Python mirror (the shell cwd may point at it) and must survive
        // a round trip. Content caps below apply to files only.
        dirs.push(childRel);
        await walk(childRel);
        continue;
      }
      if (files.length >= SYNC_MAX_FILES) {
        skipped.push({ path: childRel, reason: 'over ' + SYNC_MAX_FILES + '-file snapshot limit' });
        continue;
      }
      const st = await workspace.stat(childRel);
      if (st.size > SYNC_MAX_FILE_BYTES) {
        skipped.push({ path: childRel, reason: st.size + ' bytes, over per-file limit of ' + SYNC_MAX_FILE_BYTES });
        continue;
      }
      if (total + st.size > SYNC_MAX_TOTAL_BYTES) {
        skipped.push({ path: childRel, reason: 'over total snapshot limit of ' + SYNC_MAX_TOTAL_BYTES + ' bytes' });
        continue;
      }
      const bytes = await workspace.readBytes(childRel);
      throwIfCancelled(signal, 'workspace collection');
      total += bytes.byteLength;
      files.push({ path: childRel, b64: bytesToB64(bytes) });
    }
  }

  await walk('');
  return { files, skipped, dirs };
}

// ---------- shell ----------
// Unix-like COMPATIBILITY shell — NOT full POSIX bash. Structure:
//   input → tokenizer → small parser (command list / pipelines) → executor
// No eval, no system shell: every simple command lands in an explicit,
// controlled handler from SHELL_COMMANDS. Quoted text is always DATA,
// never syntax: `echo "a;b"` prints text, it is never split.

// Bounds for command composition and recursive traversal.
const SHELL_PIPE_MAX_BYTES = 1024 * 1024; // intermediate stdout between pipeline stages
const CAT_MAX_FILE_BYTES = 512 * 1024;
// Append (`>>` / `2>>`) holds old+new bytes in memory, so the EXISTING
// content is bounded (16 MiB, matching the memory-provider per-file cap).
// A bigger target fails loudly — never a silent truncate, partial write
// or OOM.
const APPEND_MAX_EXISTING_BYTES = 16 * 1024 * 1024;
const FIND_MAX_VISITED = 5000;            // entries visited per find run
const FIND_MAX_RESULTS = 1000;            // paths emitted per find run
const GREP_MAX_FILES = 500;               // files searched per recursive grep
const GREP_MAX_FILE_BYTES = 2 * 1024 * 1024;
const GREP_MAX_MATCHES = 500;
// head/tail: INPUT size and TERMINAL OUTPUT size are different bounds. A
// `head -n 3` over a 2.5 MiB log only needs to read it — the answer is tiny.
// The read is capped at 16 MiB (matching the per-file provider cap); the
// output stays bounded by CAT_MAX_FILE_BYTES regardless.
const HEAD_TAIL_MAX_INPUT_BYTES = 16 * 1024 * 1024;
const HEAD_TAIL_MAX_OUTPUT_BYTES = CAT_MAX_FILE_BYTES;
// sort holds every input line in memory at once, so its total input is
// bounded separately (all operands + stdin combined).
const SORT_MAX_INPUT_BYTES = 8 * 1024 * 1024;

// Tokenize one command line, keeping quote/operator information.
// Returns [{text, quoted, op, pos}] — quoted text is DATA, never syntax, so
// `echo ">" victim.txt` prints text instead of redirecting into a file.
// `pos` is the start offset in the line (used to detect glued `2>` redirects).
// Throws on unclosed quotes.
function shellTokenize(line) {
  const tokens = [];
  let cur = '';
  let quoted = false;
  let has = false;
  let start = 0;
  const push = () => {
    if (has) tokens.push({ text: cur, quoted: quoted, op: false, pos: start });
    cur = '';
    quoted = false;
    has = false;
  };
  let i = 0;
  const s = String(line || '');
  while (i < s.length) {
    const c = s[i];
    if (c === '"' || c === "'") {
      if (!has) start = i;
      const close = s.indexOf(c, i + 1);
      if (close === -1) throw new Error('unclosed quote in command line');
      cur += s.slice(i + 1, close);
      quoted = true;
      has = true;
      i = close + 1;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
      push();
      i++;
      continue;
    }
    if (c === '>' && has && !quoted && cur === '2') {
      // Glued stderr redirects: 2> / 2>> / 2>&1 are single operators.
      cur = '';
      has = false;
      if (s[i + 1] === '&' && s[i + 2] === '1') {
        tokens.push({ text: '2>&1', quoted: false, op: true, pos: i - 1 });
        i += 3;
      } else if (s[i + 1] === '>') {
        tokens.push({ text: '2>>', quoted: false, op: true, pos: i - 1 });
        i += 2;
      } else {
        tokens.push({ text: '2>', quoted: false, op: true, pos: i - 1 });
        i += 1;
      }
      continue;
    }
    if (c === '>' || c === '<' || c === '|' || c === ';' || c === '&') {
      push();
      let op = c;
      if (s[i + 1] === c) { op = c + c; i++; }
      tokens.push({ text: op, quoted: false, op: true, pos: i - (op.length - 1) });
      i++;
      continue;
    }
    if (!has) start = i;
    cur += c;
    has = true;
    i++;
  }
  push();
  return tokens;
}

// Recognize the model-friendly heredoc form and extract the code verbatim:
//   python <<'PY'
//   <arbitrary multi-line code, any quotes>
//   PY
// Returns { code } or null. This is NOT a POSIX parser — just this one form.
function extractPythonHeredoc(line) {
  const m = String(line || '').match(/^python3?\s+<<\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?[ \t]*\r?\n([\s\S]*)$/);
  if (!m) return null;
  const marker = m[1];
  const bodyLines = m[2].split(/\r?\n/);
  if (!bodyLines.length || bodyLines[bodyLines.length - 1].trim() !== marker) return null;
  bodyLines.pop();
  return { code: bodyLines.join('\n') };
}

function shellError(cmd) {
  return 'bash: ' + cmd + ': command not available in local browser runtime'
    + ' (run `help` for the supported command list)';
}

// ---------- capability registry (single source of truth) ----------
// The runtime dispatch, the `help` command and the system prompt all read
// from SHELL_COMMANDS / SHELL_OPERATORS so the advertised contract can never
// silently drift from what actually executes. `stdin` marks commands that
// may consume pipeline input; piping into a command with stdin:false fails
// loudly instead of silently dropping data.
const SHELL_COMMANDS = {
  pwd: {
    usage: 'pwd',
    summary: 'print the current virtual working directory',
    stdin: false, run: shPwd,
  },
  cd: {
    usage: 'cd <path>',
    summary: 'change the cwd for THIS invocation only (bare cd → the default cwd)',
    stdin: false, run: shCd,
  },
  ls: {
    usage: 'ls [-a] [-l] [-h] [path...]',
    summary: 'list directory entries (-a show dotfiles, -l long format, -h human-readable sizes)',
    stdin: false, run: shLs,
  },
  cat: {
    usage: 'cat [file...]',
    summary: 'print file contents; with no file, reads pipeline stdin',
    stdin: true, run: shCat,
  },
  echo: {
    usage: 'echo <text>',
    summary: 'print text (combine with > / >> to write files)',
    stdin: false, run: shEcho,
  },
  find: {
    usage: 'find [path...] [-name glob] [-type f|d] [-maxdepth N]',
    summary: 'bounded recursive listing (glob supports * and ? only)',
    stdin: false, run: shFind,
  },
  grep: {
    usage: 'grep [-c] [-n] [-i] [-r|-R] [-E] <pattern> [path...]',
    summary: 'print lines matching a JavaScript regex, or count matching lines with -c; reads stdin when no path is given',
    stdin: true, run: shGrep,
  },
  head: {
    usage: 'head [-n N|-c N|-N] [file]',
    summary: 'first N lines (default 10) or first N bytes (-c); reads stdin when no file is given',
    stdin: true, run: shHead,
  },
  tail: {
    usage: 'tail [-n N|-n +N|-c N|-N] [file]',
    summary: 'last N lines (default 10), -n +N starts at line N, -c N for bytes; reads stdin when no file is given',
    stdin: true, run: shTail,
  },
  wc: {
    usage: 'wc [-l] [-w] [-c] [file...]',
    summary: 'count lines / words / UTF-8 bytes; reads stdin when no file is given',
    stdin: true, run: shWc,
  },
  sort: {
    usage: 'sort [-n] [-r] [-u] [file...]',
    summary: 'sort lines (-n numeric-first, -r reverse, -u unique); reads stdin when no file is given',
    stdin: true, run: shSort,
  },
  mv: {
    usage: 'mv <src>... <dest>',
    summary: 'move/rename files or directories; fails if the destination exists (no -f)',
    stdin: false, run: shMv,
  },
  rm: {
    usage: 'rm [-f] [-r|-R] <path>...',
    summary: 'remove files; -r for recursive directory removal, -f to ignore missing paths',
    stdin: false, run: shRm,
  },
  python: {
    usage: 'python -c "<code>" | python <script.py> | python <<\'PY\' ... PY',
    summary: 'run Python (Pyodide); script paths resolve against the shell cwd and Python runs in that same directory',
    stdin: false, run: shPython,
  },
  curl: {
    usage: 'curl <url> | curl -o <file> <url> | curl -I <url> | curl -X <method> [-H "Name: value"] [-d <data>] <url>',
    summary: 'HTTP/HTTPS requests — GET/HEAD are anonymous reads; POST/PUT/PATCH/DELETE ask for user approval',
    stdin: false, run: shCurl,
  },
  which: {
    usage: 'which <command>...',
    summary: 'print the /usr/bin path of supported commands (registry lookup only — no external PATH)',
    stdin: false, run: shWhich,
  },
  help: {
    usage: 'help',
    summary: 'show this shell contract',
    stdin: false, run: shHelp,
  },
};

// Command-name aliases resolved by the executor and by `which`. Not a
// second registry — every target must exist in SHELL_COMMANDS.
const SHELL_ALIASES = {
  python3: 'python',
};

const SHELL_OPERATORS = [
  { op: ';', summary: 'sequence — run the next command regardless of the previous result' },
  { op: '&&', summary: 'run the next command only if the previous one succeeded' },
  { op: '||', summary: 'run the next command only if the previous one failed' },
  { op: '|', summary: 'pipeline — stdout (only) of the left command becomes stdin of the right one' },
];

const SHELL_REDIRECTS = [
  { op: '> file', summary: 'write stdout to file (truncate/create)' },
  { op: '>> file', summary: 'append stdout to file' },
  { op: '2> file', summary: 'write stderr to file (truncate/create)' },
  { op: '2>> file', summary: 'append stderr to file' },
  { op: '2>&1', summary: 'send stderr to wherever stdout currently goes (order matters: > all.txt 2>&1 merges both into the file)' },
  { op: '> /dev/null', summary: 'discard output — /dev/null is only a redirection sink, not a file (cat /dev/null fails)' },
];

const SHELL_UNSUPPORTED_NOTE =
  'Not supported: control structures (for / while / if / case / shell functions — use Python for complex logic), '
  + '&, $(...), backticks, subshells, variables/export, '
  + 'glob expansion (* stays literal — use find -name instead), input redirect (<), '
  + 'heredocs other than python (a python heredoc must be a standalone bash invocation; '
  + 'run later commands in a separate bash call), file descriptors other than 2>&1 (no 1>&2 / 3> / &>). '
  + '/dev/null works only as a redirect target, never as a readable file. '
  + 'rm -rf / (and every protected mount root: /usr /home /home/locus /mnt /mnt/workspace '
  + '/mnt/upload /mnt/download /mnt/plugins) is always refused.';

function shellHelpText() {
  return [
    'Locus shell — a Unix-like compatibility shell, NOT full POSIX bash, on a small Linux-like browser machine.',
    'Every bash invocation starts at the default cwd: /mnt/workspace when a workspace folder is mounted, otherwise /home/locus (HOME).',
    '`cd` changes the working directory only within the current invocation; the next bash call starts at the default cwd again.',
    'Filesystem layout: /mnt/workspace (mounted working folder), /mnt/upload (read-only inputs),',
    '/mnt/download (downloadable artifacts), /tmp (scratch), /home/locus (home), /usr/bin + /bin (commands).',
    'Paths containing spaces must be quoted ("my file.txt").',
    '',
    'Commands:',
  ]
    .concat(Object.keys(SHELL_COMMANDS).map((n) => '  ' + SHELL_COMMANDS[n].usage))
    .concat([
      '',
      'Operators:',
    ])
    .concat(SHELL_OPERATORS.map((o) => '  ' + o.op + '  ' + o.summary))
    .concat([
      '',
      'Redirects:',
    ])
    .concat(SHELL_REDIRECTS.map((r) => '  ' + r.op + '  ' + r.summary))
    .concat(['', SHELL_UNSUPPORTED_NOTE])
    .join('\n');
}

// The bash section of the agent system prompt, generated from the same
// registry as the runtime and `help`.
function shellSystemPromptSection() {
  // Derived, never hand-maintained: the pipeline line lists exactly the
  // commands that declare stdin:true, so adding a command updates the prompt.
  const stdinConsumers = Object.keys(SHELL_COMMANDS)
    .filter((n) => SHELL_COMMANDS[n].stdin)
    .join(' ');
  const head = [
    '  This is a Unix-like compatibility shell, NOT full POSIX bash, on a small Linux-like browser machine.',
    '  HOME=/home/locus. Every bash invocation starts at the default cwd: /mnt/workspace when a workspace',
    '  folder is mounted, otherwise /home/locus. `cd` affects only the current invocation.',
    '  Filesystem layout:',
    '    /mnt/workspace  user-authorized working folder (only present when mounted)',
    '    /mnt/upload     user-uploaded input files, READ-ONLY',
    '    /mnt/download   writable; files here are offered to the user as downloadable artifacts',
    '    /tmp            writable scratch space',
    '    /home/locus     your writable home',
    '    /usr/bin, /bin  available commands (virtual userland view)',
    '  Paths containing spaces must be quoted ("my file.txt"). Unquoted paths must not contain spaces.',
    '  Supported commands:',
  ];
  const cmds = Object.keys(SHELL_COMMANDS).map((n) => '    ' + SHELL_COMMANDS[n].usage);
  const tail = [
    '  Supported operators:',
    '    cmd1 ; cmd2     run commands in sequence',
    '    cmd1 && cmd2    run cmd2 only if cmd1 succeeded',
    '    cmd1 || cmd2    run cmd2 only if cmd1 failed',
    '    cmd1 | cmd2     pipe stdout of cmd1 into stdin of cmd2 (stdin consumers: ' + stdinConsumers + ');',
    '                    stderr is NOT piped unless merged with 2>&1',
    '  Supported redirects (applied left to right; order matters for 2>&1):',
    '    cmd > file      write stdout to file (truncate/create)',
    '    cmd >> file     append stdout to file',
    '    cmd 2> file     write stderr to file (truncate/create)',
    '    cmd 2>> file    append stderr to file',
    '    cmd 2>&1        merge stderr into stdout\'s current destination',
    '    cmd > /dev/null discard output (also 2> / 2>>); /dev/null is a redirection sink only —',
    '                    it is not a file: cat /dev/null and ls /dev fail',
    '  Redirection never turns a failed command into a successful one.',
    '  rm -rf / (and every protected mount root) is always refused. Shell glob expansion is not supported:',
    '  * in command arguments stays literal — use find -name "*.tmp" to locate files.',
    '  ' + SHELL_UNSUPPORTED_NOTE,
    '  Run `help` at runtime to see this contract again.',
    '  curl usage (this environment has ordinary HTTP/HTTPS internet access; use curl for network requests):',
    '    curl <url>                  fetches a URL (GET); text/JSON/XML responses are printed directly.',
    '    curl -o <file> <url>        downloads binary-safe into a writable file (use this for images, PDFs,',
    '                              archives, or any data you want to keep or process, e.g. under /mnt/download).',
    '    curl -I <url>               HEAD request — response headers only.',
    '    curl -X <method> <url>      sends an explicit method (POST/PUT/PATCH/DELETE); combine with request',
    '    curl -H "Name: value"       headers (-H, repeatable) and/or a request body: -d <data> implies POST,',
    '    curl -d <data>              --data-binary @file sends a file\'s bytes as the body. Side-effecting',
    '                              requests may require the user\'s approval before anything is sent; if the',
    '                              user denies one, that request was not made — continue another way.',
    '  Requests are anonymous by construction: browser cookies are never attached, and Cookie / Sec-* /',
    '  hop-by-hop headers are not sent. Arbitrary TCP/UDP, raw sockets and non-HTTP protocols are unavailable.',
    '  If curl fails, report the error; do NOT switch to cloud_bash for network access.',
    '  python usage: for short one-liners use python -c "<code>"; for anything multi-line or containing mixed quotes,',
    '  prefer the heredoc form — the code between the markers is passed to Python verbatim:',
    '    python <<\'PY\'',
    '    import pandas as pd',
    '    print(pd.DataFrame({"a": [1]}).to_json())',
    '    PY',
    '  python has the standard library and pandas available. Python sees the SAME filesystem as the shell',
    '  (/mnt/workspace, /mnt/upload, /mnt/download, /tmp, /home/locus) and runs with the shell cwd as its',
    '  working directory. /mnt/upload is read-only, also from Python. python and curl do not read pipeline stdin.',
    '  Python has no network access and cannot fetch URLs or install packages; Python is for local',
    '  computation and files. Anything networked goes through curl.',
    '  The python heredoc must be a STANDALONE bash invocation — nothing may follow the closing marker;',
    '  run subsequent commands in a separate bash call.',
  ];
  return head.concat(cmds, tail).join('\n');
}

// ---------- parser ----------
// Grammar:
//   command_list := pipeline ((';' | '&&' | '||') pipeline)*   (left-associative)
//   pipeline     := simple_command ('|' simple_command)*
// Redirect tokens (> >> 2> 2>> 2>&1) stay inside a simple command and are
// applied by the executor, left to right. Everything else that looks like
// shell syntax fails loudly with the supported alternative.
function parseShellLine(tokens) {
  const steps = [];
  let connector = null;
  let pipeline = [];
  let current = [];
  let pendingPipe = false;
  const fail = (m) => { throw new Error(m); };
  const flushPipeline = (allowEmpty) => {
    if (current.length) { pipeline.push({ argv: current }); current = []; }
    if (!pipeline.length) {
      if (!allowEmpty) fail("syntax error: empty command near '" + connector + "'");
      return;
    }
    steps.push({ connector: connector, pipeline: pipeline });
    pipeline = [];
  };
  for (const t of tokens) {
    if (!t.op) { current.push(t); pendingPipe = false; continue; }
    switch (t.text) {
      case '|':
        if (!current.length) fail("syntax error: empty command near '|'");
        pipeline.push({ argv: current });
        current = [];
        pendingPipe = true;
        break;
      case ';':
      case '&&':
      case '||':
        flushPipeline(t.text === ';'); // bare ';' tolerates empty neighbours
        connector = t.text;
        pendingPipe = false;
        break;
      case '&':
        fail("unsupported operator: '&' (supported operators: ; && || |)");
        break;
      case '<':
      case '<<':
        fail("unsupported operator: '<' (input redirection is not supported; pass the file as an argument instead)");
        break;
      case '>':
      case '>>':
      case '2>':
      case '2>>':
      case '2>&1':
        // A redirect with no command in front of it is a syntax error, not
        // an empty-command trick (`> file` alone is not supported).
        if (!current.length) fail("syntax error: redirect '" + t.text + "' without a command");
        // Other file descriptors (1>, 3>, ...) are out of scope: a digit word
        // glued to the operator must not silently become an argument.
        if (t.text === '>' || t.text === '>>') {
          const prev = current[current.length - 1];
          if (prev && !prev.op && !prev.quoted && /^[0-9]+$/.test(prev.text)
            && prev.pos + prev.text.length === t.pos) {
            fail("unsupported redirect: '" + prev.text + t.text + "' (supported redirects: > >> 2> 2>> 2>&1)");
          }
        }
        current.push(t);
        pendingPipe = false;
        break;
      default:
        fail("unsupported operator: '" + t.text + "' (supported operators: ; && || |; supported redirects: > >> 2> 2>> 2>&1)");
    }
  }
  if (pendingPipe) fail("syntax error: empty command after '|'");
  if (current.length) pipeline.push({ argv: current });
  if (pipeline.length) steps.push({ connector: connector, pipeline: pipeline });
  else if (connector === '&&' || connector === '||') fail("syntax error: empty command after '" + connector + "'");
  return steps;
}

// ---------- VFS bridge ----------
// The shell ALWAYS runs against a VirtualWorkspace: a real VFS is used
// as-is, a legacy WorkspaceAdapter is mounted at /mnt/workspace
// (external-read-write), and a missing argument yields a fresh internal
// machine (test isolation). The filesystem therefore always exists — there
// is no "no workspace selected" state anywhere in the shell.
function asVfs(x) {
  if (x && x.isLocusVFS) return x;
  const vfs = new VirtualWorkspace({ listCommands: () => Object.keys(SHELL_COMMANDS) });
  if (x) vfs.mount('/mnt/workspace', x, 'external-read-write');
  return vfs;
}

// Resolve a (possibly relative) shell path against the invocation-local
// cwd to an ABSOLUTE VFS path. `..` above the filesystem root is rejected
// by normalizeVfsPath.
function resolveShellPath(ctx, p) {
  return normalizeVfsPath(String(p || ''), ctx.cwd);
}

// Join a child name onto an absolute directory path.
function joinAbs(abs, name) {
  return abs === '/' ? '/' + name : abs + '/' + name;
}

// Stat for the filesystem, and report a uniform "no such file or
// directory" for plain missing entries; NotMountedError passes its clear
// message through unchanged.
async function statShellPath(ctx, display, abs) {
  try {
    return await ctx.vfs.stat(abs);
  } catch (e) {
    if (e && e.name === 'NotFoundError') throw new Error(display + ': no such file or directory');
    if (e && e.name === 'NotMountedError') throw new Error(e.message);
    throw e;
  }
}

// Compact writability-failure wording shared by mv/curl/redirects.
function writableErrMsg(e) {
  if (e && e.name === 'NotMountedError') return 'not mounted';
  if (e && e.name === 'ReadOnlyError') return 'read-only filesystem';
  return e && e.message ? e.message : String(e);
}

// ---------- mutation policy (M1b, repository split) ----------
// Product/Harness filesystem-mutation rules (the Locus skill-identity
// protection among them) live OUTSIDE the generic runtime: the shell
// consumes the operation-aware MutationPolicy port from
// opts.mutationPolicy (contract docs/REPOSITORY-SPLIT-CONTRACTS.md 3.7 —
// checkMove / checkRemove / isPolicyRefusal). The policy is injected per
// execution by the product wiring; the GENERIC runtime ships none and is
// deliberately neutral (plain mv/rm wherever the VFS allows). Refusals
// compose as `<command>: <policy reason>` — the reason text is the
// policy's, byte-stable, and this layer adds only the command prefix.
// The VFS's own read-only / protected-root / path-safety enforcement and
// the task fork's SkillInstanceWorkspace per-file approval guard are
// RUNTIME concerns and stay in force regardless of the policy.
function policyRefusal(verdict) {
  return (verdict && verdict.reason) || 'refused by the mutation policy';
}

// The parent of an absolute target must be an existing directory. Mount
// roots and structural directories always exist; only real intermediate
// directories are statted (legacy providers may not answer stat('') for
// their own root).
async function checkParentDir(vfs, abs) {
  const i = abs.lastIndexOf('/');
  const parent = i <= 0 ? '/' : abs.slice(0, i);
  const m = vfs.resolveMount(parent);
  if (m && m.rel === '') return null; // the parent IS a mount root
  let pst;
  try {
    pst = await vfs.stat(parent);
  } catch (e) {
    if (e && e.name === 'NotFoundError') return 'no such directory';
    return writableErrMsg(e);
  }
  if (pst.kind !== 'directory') return 'parent is not a directory';
  return null;
}

function splitLines(text) {
  const lines = String(text).split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop(); // trailing newline is a terminator, not an empty line
  return lines;
}

function humanBytes(n) {
  if (n < 1024) return n + ' B';
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let v = n;
  let u = -1;
  do { v /= 1024; u++; } while (v >= 1024 && u < units.length - 1);
  return (v < 10 ? v.toFixed(1) : String(Math.round(v))) + ' ' + units[u];
}

// Simple glob matching for find -name: * and ? only, everything else literal.
function globMatch(pattern, name) {
  const re = new RegExp('^' + String(pattern).split('').map((c) => {
    if (c === '*') return '.*';
    if (c === '?') return '.';
    return c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }).join('') + '$');
  return re.test(name);
}

function joinDisplay(base, name) {
  return base === '.' ? './' + name : base.replace(/\/+$/, '') + '/' + name;
}

// Internal per-command result: stdout and stderr stay SEPARATED inside the
// executor (pipelines forward stdout only; 2> / 2>&1 routing depends on the
// split). They are merged only at the outermost boundary for presentation.
function shOk(stdout) { return { success: true, stdout: stdout, stderr: '' }; }
function shErr(stderr) { return { success: false, stdout: '', stderr: stderr }; }
function shErrAt(stderr, stdout) { return { success: false, stdout: stdout || '', stderr: stderr }; }

// ---------- command handlers ----------

// Byte-preserving append primitive shared by `>>` and `2>>`. The existing
// target is read as RAW BYTES — never decoded to text (a lossy UTF-8
// decode would silently replace non-UTF-8 bytes with U+FFFD and corrupt
// binary files on rewrite). Order: read/preflight → assemble the complete
// target bytes → re-check cancellation → ONE write, so a read, quota or
// cancellation failure leaves the original file untouched.
async function appendFileBytes(vfs, path, payload, signal, what) {
  let old = null;
  try {
    old = await vfs.readBytes(path);
  } catch (e) {
    if (!e || e.name !== 'NotFoundError') throw e; // missing target → plain create
  }
  let bytes = payload;
  if (old) {
    if (old.byteLength > APPEND_MAX_EXISTING_BYTES) {
      throw vfsError('QuotaExceededError', 'append target is ' + old.byteLength
        + ' bytes, over the ' + APPEND_MAX_EXISTING_BYTES + '-byte append limit: ' + path);
    }
    bytes = new Uint8Array(old.byteLength + payload.byteLength);
    bytes.set(old, 0);
    bytes.set(payload, old.byteLength);
  }
  throwIfCancelled(signal, what);
  await vfs.write(path, bytes);
}

async function shPwd(ctx) {
  return shOk(ctx.cwd);
}

async function shCd(ctx, args) {
  if (args.length > 1) return shErr('cd: too many arguments');
  const target = args.length ? args[0].text : '';
  if (!target) { ctx.cwd = ctx.vfs.defaultCwd(); return shOk(''); }
  let abs;
  try {
    abs = resolveShellPath(ctx, target);
  } catch (e) {
    return shErr('cd: ' + target + ': ' + e.message);
  }
  let st;
  try {
    st = await ctx.vfs.stat(abs);
  } catch (e) {
    return shErr('cd: ' + target + ': ' + (e && e.name === 'NotFoundError' ? 'no such directory' : writableErrMsg(e)));
  }
  if (st.kind !== 'directory') return shErr('cd: ' + target + ': not a directory');
  ctx.cwd = abs;
  return shOk('');
}

async function shLs(ctx, args) {
  let flagA = false, flagL = false, flagH = false;
  const paths = [];
  for (const t of args) {
    if (!t.quoted && t.text.length > 1 && t.text.charAt(0) === '-') {
      for (const ch of t.text.slice(1)) {
        if (ch === 'a') flagA = true;
        else if (ch === 'l') flagL = true;
        else if (ch === 'h') flagH = true;
        else return shErr('ls: unsupported option: -' + ch + ' (supported options: -a -l -h)');
      }
    } else {
      paths.push(t.text);
    }
  }
  if (!paths.length) paths.push('.');
  const showHeader = paths.length > 1;
  const sections = [];
  for (const p of paths) {
    let abs;
    try {
      abs = resolveShellPath(ctx, p);
    } catch (e) {
      return shErr('ls: ' + e.message);
    }
    const st = await statShellPath(ctx, p, abs);
    throwIfCancelled(ctx.opts && ctx.opts.signal, 'ls');
    if (st.kind !== 'directory') {
      sections.push(lsFormatEntry(p, st, flagL, flagH));
      continue;
    }
    const entries = await ctx.vfs.list(abs);
    throwIfCancelled(ctx.opts && ctx.opts.signal, 'ls');
    const lines = [];
    for (const e of entries) {
      if (!flagA && e.name.charAt(0) === '.') continue;
      let est = null;
      if (flagL) est = await ctx.vfs.stat(joinAbs(abs, e.name));
      lines.push(lsFormatEntry(e.name, est || { kind: e.kind, size: 0, modified: null }, flagL, flagH));
    }
    sections.push((showHeader ? p + ':\n' : '') + lines.join('\n'));
  }
  return shOk(sections.join('\n\n'));
}

function lsFormatEntry(name, st, flagL, flagH) {
  const isDir = st.kind === 'directory';
  if (!flagL) return isDir ? name + '/' : name;
  const parts = [isDir ? 'd' : '-', flagH ? humanBytes(st.size) : String(st.size)];
  if (st.modified) parts.push(new Date(st.modified).toISOString().slice(0, 16).replace('T', ' '));
  parts.push(isDir ? name + '/' : name);
  return parts.join(' ');
}

async function shCat(ctx, args, stdin) {
  if (!args.length) {
    if (stdin !== null && stdin !== undefined) return shOk(stdin);
    return shErr('cat: missing file operand (or pipe input into cat)');
  }
  const chunks = [];
  for (const a of args) {
    const abs = resolveShellPath(ctx, a.text);
    const st = await statShellPath(ctx, a.text, abs);
    if (st.kind !== 'file') return shErr('cat: ' + a.text + ': is a directory');
    if (st.size > CAT_MAX_FILE_BYTES) return shErr('cat: ' + a.text + ': file too large for terminal output (use python)');
    chunks.push(await ctx.vfs.read(abs));
  }
  return shOk(chunks.join('\n'));
}

async function shEcho(ctx, args) {
  // Redirection is generic (executor-level) — echo only prints its arguments.
  return shOk(args.map((t) => t.text).join(' '));
}

async function shFind(ctx, args) {
  const paths = [];
  let name = null, type = null, maxdepth = null;
  for (let i = 0; i < args.length; i++) {
    const t = args[i];
    if (!t.quoted && t.text.charAt(0) === '-' && t.text.length > 1) {
      if (t.text === '-name') {
        const v = args[++i];
        if (!v) return shErr('find: -name requires a pattern');
        name = v.text;
      } else if (t.text === '-type') {
        const v = args[++i];
        if (!v || (v.text !== 'f' && v.text !== 'd')) return shErr('find: -type must be f or d');
        type = v.text;
      } else if (t.text === '-maxdepth') {
        const v = args[++i];
        const n = v && /^[0-9]+$/.test(v.text) ? parseInt(v.text, 10) : NaN;
        if (!isFinite(n)) return shErr('find: -maxdepth requires a non-negative integer');
        maxdepth = n;
      } else {
        return shErr('find: unsupported predicate: ' + t.text + ' (supported: -name -type -maxdepth)');
      }
    } else {
      paths.push(t.text);
    }
  }
  if (!paths.length) paths.push('.');

  const signal = ctx.opts && ctx.opts.signal;
  const results = [];
  const state = { visited: 0, truncated: false };

  async function walk(abs, disp, depth, kind) {
    if (state.truncated) return;
    throwIfCancelled(signal, 'find');
    if (state.visited >= FIND_MAX_VISITED || results.length >= FIND_MAX_RESULTS) {
      state.truncated = true;
      return;
    }
    state.visited++;
    const base = disp === '.' ? '.' : disp.slice(disp.lastIndexOf('/') + 1);
    const typeOk = !type || (type === 'f' ? kind === 'file' : kind === 'directory');
    if (typeOk && (!name || globMatch(name, base))) results.push(disp);
    if (kind !== 'directory') return;
    if (maxdepth !== null && depth >= maxdepth) return;
    const entries = await ctx.vfs.list(abs);
    for (const e of entries) {
      await walk(joinAbs(abs, e.name), joinDisplay(disp, e.name), depth + 1, e.kind);
      if (state.truncated) return;
    }
  }

  for (const p of paths) {
    let abs;
    try {
      abs = resolveShellPath(ctx, p);
    } catch (e) {
      return shErr('find: ' + e.message);
    }
    const st = await statShellPath(ctx, p, abs);
    await walk(abs, p.replace(/\/+$/, '') || '.', 0, st.kind);
  }

  let output = results.join('\n');
  if (state.truncated) {
    output += (output ? '\n' : '') + '[find: result truncated at traversal limits; narrow the path or predicates]';
  }
  return shOk(output);
}

// ---------- grep regex worker isolation ----------
// The grep pattern is MODEL-CONTROLLED: its RegExp is compiled and every
// match is executed ONLY inside a dedicated Web Worker (source injected as
// `workerSource` — the runtime-owned GREP_WORKER_SOURCE asset; see
// src/runtime/worker-assets.js). A catastrophic-backtracking pattern can
// therefore never hold the UI event loop — the session TERMINATES the
// worker at the hard timeout, on cancellation, on worker death and at the
// command boundary. There is deliberately NO main-thread fallback: when a
// worker cannot be created or dies mid-command, grep fails closed with a
// bounded error.
const GREP_REGEX_TIMEOUT_MS = 1000;

const GrepRegexRuntime = {
  // TEST-ONLY seam: Node unit tests inject a deterministic fake worker.
  // Production never sets this and always constructs a real Blob Worker
  // from the injected source.
  _workerFactory: null,

  // Throws when the environment cannot provide a Worker or the caller
  // passed no source; the caller must fail the grep command — never fall
  // back to main-thread regex.
  createWorker(workerSource) {
    if (this._workerFactory) return this._workerFactory();
    if (typeof workerSource !== 'string' || !workerSource.trim()) {
      throw new Error('grep worker source not provided');
    }
    const blob = new Blob([workerSource], { type: 'text/javascript' });
    // Same construction pattern as the Python runtime: the Blob URL exists
    // only to construct the Worker and is revoked immediately.
    const url = URL.createObjectURL(blob);
    try {
      return new Worker(url);
    } finally {
      URL.revokeObjectURL(url);
    }
  },
};

function grepRegexError(message, kind) {
  const e = new Error(message);
  e.grepFailure = kind;
  return e;
}

// One session per grep command: the pattern is compiled once in the worker
// and reused for every searched source (stdin, file operands, recursive
// walk). Timeout, cancellation, worker death and command completion all
// TERMINATE the worker, so no regex state or stale reply survives the
// command. Every request settles exactly once; the first of
// { reply, timeout, abort, worker death } wins and the losers clean up.
// `workerSource` is the runtime-owned grep worker asset (injected through
// the shell opts by the host/session — never read from a page DOM).
function createGrepRegexSession(pattern, flags, workerSource) {
  let worker = null;
  try {
    worker = GrepRegexRuntime.createWorker(workerSource);
  } catch (e) {
    throw grepRegexError('grep: regex worker unavailable', 'worker_unavailable');
  }

  let reqSeq = 0;
  let pending = null; // the single in-flight request: { id, cmd, signal, onAbort, timer, settle, active }

  const workerFailedError = () => grepRegexError('grep: regex worker failed', 'worker_failed');

  function terminate() {
    if (!worker) return;
    const w = worker;
    worker = null;
    try { w.terminate(); } catch (e) {}
    w.onmessage = null;
    w.onerror = null;
    w.onmessageerror = null;
  }

  function failPending(err) {
    const p = pending;
    if (!p) return;
    pending = null;
    p.settle(err);
  }

  worker.onmessage = (ev) => {
    const msg = (ev && ev.data) || {};
    const p = pending;
    // Correlate by request id: a reply for an already-settled request
    // (timed out / cancelled / terminated) is stale and ignored.
    if (!p || msg.id !== p.id) return;
    if (msg.type === 'result' || (p.cmd === 'init' && msg.type === 'ready')) {
      p.settle(null, msg);
    } else {
      // invalid_pattern and internal_error arrive as bounded verdicts —
      // the raw pattern and any engine detail never leave the worker.
      p.settle(msg.type === 'invalid_pattern'
        ? grepRegexError('grep: invalid pattern (patterns use JavaScript regex syntax)', 'invalid_pattern')
        : workerFailedError());
    }
  };
  worker.onerror = () => { terminate(); failPending(workerFailedError()); };
  worker.onmessageerror = () => { terminate(); failPending(workerFailedError()); };

  function request(cmd, body, signal) {
    throwIfCancelled(signal, 'grep');
    if (!worker) return Promise.reject(workerFailedError());
    return new Promise((resolve, reject) => {
      const p = { id: ++reqSeq, cmd: cmd, signal: signal || null, onAbort: null, timer: null, settle: null, active: true };
      p.settle = (err, val) => {
        if (!p.active) return; // settle exactly once
        p.active = false;
        if (pending === p) pending = null;
        clearTimeout(p.timer);
        if (p.onAbort && p.signal) p.signal.removeEventListener('abort', p.onAbort);
        if (err) reject(err); else resolve(val);
      };
      p.timer = setTimeout(() => {
        // A timeout TERMINATES the worker instead of merely stop waiting:
        // the pattern has proven unfit to keep running for this command.
        terminate();
        p.settle(grepRegexError(
          'grep: regex evaluation timed out (the pattern may cause excessive backtracking; simplify it)',
          'timeout'));
      }, GREP_REGEX_TIMEOUT_MS);
      p.onAbort = () => {
        terminate();
        p.settle(makeCancelledError('grep'));
      };
      if (p.signal) p.signal.addEventListener('abort', p.onAbort, { once: true });
      pending = p;
      worker.postMessage(Object.assign({ id: p.id, cmd: cmd }, body));
    });
  }

  return {
    // Compile (validate) the pattern inside the worker. Resolves with the
    // 'ready' verdict; rejects with a bounded grepFailure-tagged error.
    init(signal) {
      return request('init', { pattern: pattern, flags: flags }, signal);
    },
    // Scan ONE already-decoded text source in the worker.
    // opts.countOnly — count every matching line (never capped);
    // opts.maxMatches — cap the returned matches (presentation budget).
    scan(text, opts, signal) {
      return request('scan', {
        text: text,
        countOnly: !!(opts && opts.countOnly),
        maxMatches: opts && typeof opts.maxMatches === 'number' ? opts.maxMatches : null,
      }, signal);
    },
    // Command boundary: kill the worker and drop all session state.
    destroy() {
      terminate();
      failPending(workerFailedError());
    },
  };
}

async function shGrep(ctx, args, stdin) {
  let flagN = false, flagI = false, flagR = false, flagC = false;
  let pattern = null;
  const paths = [];
  for (const t of args) {
    if (pattern === null && !t.quoted && t.text.charAt(0) === '-' && t.text.length > 1) {
      for (const ch of t.text.slice(1)) {
        if (ch === 'n') flagN = true;
        else if (ch === 'i') flagI = true;
        else if (ch === 'r' || ch === 'R') flagR = true;
        else if (ch === 'c') flagC = true;
        else if (ch === 'E') { /* alias for the regex semantics already in use */ }
        else return shErr('grep: unsupported option: -' + ch + ' (supported options: -c -n -i -r -R -E)');
      }
    } else if (pattern === null) {
      pattern = t.text;
    } else {
      paths.push(t.text);
    }
  }
  if (pattern === null) return shErr('usage: grep [-c] [-n] [-i] [-r|-R] [-E] <pattern> [path...]');
  // The pattern is model-controlled: it is compiled and matched ONLY inside
  // the grep worker session, never on this thread. The session terminates
  // the worker at the hard timeout, on cancellation, on worker death and at
  // this command's boundary; a worker that cannot be created fails the
  // command — there is no main-thread fallback.
  const signal = ctx.opts && ctx.opts.signal;
  let session = null;
  try {
    session = createGrepRegexSession(pattern, flagI ? 'i' : '', ctx.opts && ctx.opts.grepWorkerSource);
    await session.init(signal);
    if (!paths.length && (stdin === null || stdin === undefined)) {
      return shErr('grep: missing file operand (or pipe input into grep)');
    }
    const matches = [];
    // -c counts MATCHING LINES per searched source. Counting is decoupled from
    // the output-line cap: a file with 1000 matches answers 1000, never the
    // GREP_MAX_MATCHES presentation bound.
    const counts = [];
    let countedFromDir = false;
    const skipped = [];
    const state = { truncated: false, filesSeen: 0 };
    const showPathDefault = paths.length > 1;

    async function grepText(text, disp, showPath) {
      const remaining = GREP_MAX_MATCHES - matches.length;
      if (!flagC && remaining <= 0) { state.truncated = true; return; }
      const r = await session.scan(text, { countOnly: flagC, maxMatches: remaining }, signal);
      if (flagC) {
        counts.push({ disp: disp, count: r.count, showPath: showPath });
        return;
      }
      // The worker stops at the remaining match budget and reports whether
      // it hit the cap — matching here would reintroduce the main-thread
      // regex execution F03 removes.
      if (r.hitMatchLimit) state.truncated = true;
      for (const m of r.matches) {
        matches.push((showPath ? disp + ':' : '') + (flagN ? m.lineNumber + ':' : '') + m.line);
      }
    }

    async function grepFile(abs, disp, showPath) {
      const st = await ctx.vfs.stat(abs);
      if (st.size > GREP_MAX_FILE_BYTES) {
        skipped.push(disp + ' (over ' + GREP_MAX_FILE_BYTES + '-byte grep limit)');
        return;
      }
      let text;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(await ctx.vfs.readBytes(abs));
      } catch (e) {
        skipped.push(disp + ' (not UTF-8 text)');
        return;
      }
      await grepText(text, disp, showPath);
    }

    async function grepDir(abs, disp) {
      if (state.truncated) return;
      throwIfCancelled(signal, 'grep');
      countedFromDir = true;
      const entries = await ctx.vfs.list(abs);
      for (const e of entries) {
        if (state.truncated) return;
        throwIfCancelled(signal, 'grep');
        const childAbs = joinAbs(abs, e.name);
        const childDisp = joinDisplay(disp, e.name);
        if (e.kind === 'directory') {
          await grepDir(childAbs, childDisp);
        } else {
          state.filesSeen++;
          if (state.filesSeen > GREP_MAX_FILES) { state.truncated = true; return; }
          await grepFile(childAbs, childDisp, true);
        }
      }
    }

    if (!paths.length) {
      await grepText(stdin, '', false);
    } else {
      for (const p of paths) {
        if (state.truncated) break;
        let abs;
        try {
          abs = resolveShellPath(ctx, p);
        } catch (e) {
          return shErr('grep: ' + e.message);
        }
        const st = await statShellPath(ctx, p, abs);
        if (st.kind === 'directory') {
          if (!flagR) return shErr('grep: ' + p + ': is a directory (use -r to search recursively)');
          await grepDir(abs, p.replace(/\/+$/, '') || '.');
        } else {
          await grepFile(abs, p, showPathDefault);
        }
      }
    }

    let output;
    if (flagC) {
      // Count mode: `<number>` for stdin, `<number>` for a single file operand,
      // `path:count` for multiple operands or a recursive directory search
      // (matching GNU presentation). Zero matches are a successful answer.
      const showPath = paths.length > 1 || countedFromDir
        || counts.some((c) => c.showPath);
      output = counts.map((c) => (showPath ? c.disp + ':' : '') + c.count).join('\n');
    } else {
      output = matches.join('\n');
    }
    if (skipped.length) {
      output += (output ? '\n' : '') + '[grep: skipped ' + skipped.length + ' file(s): '
        + skipped.slice(0, 5).join('; ') + (skipped.length > 5 ? '; …' : '') + ']';
    }
    if (state.truncated) {
      output += (output ? '\n' : '') + '[grep: results truncated at traversal limits; narrow the pattern or path]';
    }
    // A search with zero matches is a successful empty answer (diverges from
    // the GNU exit code) so pipelines like `grep x | wc -l` keep working.
    return shOk(output);
  } catch (e) {
    if (isCancelledError(e)) throw e;
    // Bounded worker verdicts (invalid pattern / regex timeout / worker
    // failure / worker unavailable) are ordinary grep failures.
    if (e && e.grepFailure) return shErr(e.message);
    throw e;
  } finally {
    if (session) session.destroy();
  }
}

async function shHead(ctx, args, stdin) {
  const parsed = parseCountArgs('head', args);
  if (parsed.error) return shErr(parsed.error);
  const input = await readHeadTailInput(ctx, 'head', parsed.paths, stdin);
  if (input === null) return shErr('head: missing file operand (or pipe input into head)');
  if (input.error) return shErr(input.error);
  if (parsed.mode === 'bytes') {
    return headTailResult('head', input.bytes.slice(0, parsed.count), null);
  }
  const text = splitLines(new TextDecoder('utf-8').decode(input.bytes))
    .slice(0, parsed.count).join('\n');
  return headTailResult('head', null, text);
}

async function shTail(ctx, args, stdin) {
  const parsed = parseCountArgs('tail', args);
  if (parsed.error) return shErr(parsed.error);
  const input = await readHeadTailInput(ctx, 'tail', parsed.paths, stdin);
  if (input === null) return shErr('tail: missing file operand (or pipe input into tail)');
  if (input.error) return shErr(input.error);
  if (parsed.mode === 'bytes') {
    const b = input.bytes;
    return headTailResult('tail', b.slice(Math.max(0, b.byteLength - parsed.count)), null);
  }
  const lines = splitLines(new TextDecoder('utf-8').decode(input.bytes));
  const out = parsed.fromLine !== null
    ? lines.slice(parsed.fromLine - 1)
    : lines.slice(Math.max(0, lines.length - parsed.count));
  return headTailResult('tail', null, out.join('\n'));
}

// Final head/tail answer: byte-mode output is measured in real UTF-8 bytes
// (matching `wc -c`), line-mode output in the encoded text. Either way the
// terminal cap applies to the RESULT — never silently truncated.
function headTailResult(cmd, outBytes, outText) {
  const over = outBytes
    ? outBytes.byteLength > HEAD_TAIL_MAX_OUTPUT_BYTES
    : utf8ByteLength(outText) > HEAD_TAIL_MAX_OUTPUT_BYTES;
  if (over) {
    return shErr(cmd + ': output exceeds the ' + HEAD_TAIL_MAX_OUTPUT_BYTES
      + '-byte terminal limit; use a smaller -n/-c or python');
  }
  return shOk(outBytes ? new TextDecoder('utf-8').decode(outBytes) : outText);
}

// Parse head/tail arguments into one explicit shape:
//   { mode: 'lines'|'bytes', count, fromLine, paths }   — or { error }
// `-n`/`-nN` (and tail's `-n +N`/`-n+N`) select lines, `-c`/`-cN` select
// bytes, a bare unquoted `-N` is the classic shorthand for `-n N`. `-n` and
// `-c` together are a loud error — never last-option-wins. Quoted "-5" stays
// a file operand.
function parseCountArgs(cmd, args) {
  let mode = 'lines';
  let count = 10;
  let fromLine = null;
  let lineCountGiven = false; // explicit -n / -nN / -N / -n +N seen (conflict guard for -c)
  const paths = [];
  const fail = (m) => ({ error: cmd + ': ' + m });
  const wantCount = (text, what) => {
    if (!/^[0-9]+$/.test(text)) return fail('invalid ' + what + ': ' + text);
    if (text.length > 15 || !Number.isSafeInteger(Number(text))) {
      return fail(what + ' too large: ' + text);
    }
    return { value: parseInt(text, 10) };
  };
  for (let i = 0; i < args.length; i++) {
    const t = args[i];
    if (!t.quoted && t.text === '-n') {
      if (mode === 'bytes') return fail('cannot combine line and byte count modes');
      const v = args[++i];
      if (!v) return fail('-n requires a line count');
      if (/^\+[0-9]+$/.test(v.text)) {
        if (cmd !== 'tail') return fail('-n +N is only supported by tail');
        const n = wantCount(v.text.slice(1), 'line count');
        if (n.error) return n;
        fromLine = n.value;
      } else {
        const n = wantCount(v.text, 'line count');
        if (n.error) return n;
        count = n.value;
      }
      lineCountGiven = true;
    } else if (!t.quoted && /^-n[0-9]+$/.test(t.text)) {
      if (mode === 'bytes') return fail('cannot combine line and byte count modes');
      const n = wantCount(t.text.slice(2), 'line count');
      if (n.error) return n;
      count = n.value;
      lineCountGiven = true;
    } else if (!t.quoted && cmd === 'tail' && /^-n\+[0-9]+$/.test(t.text)) {
      const n = wantCount(t.text.slice(3), 'line count');
      if (n.error) return n;
      fromLine = n.value;
      lineCountGiven = true;
    } else if (!t.quoted && t.text === '-c') {
      if (lineCountGiven) return fail('cannot combine line and byte count modes');
      const v = args[++i];
      if (!v) return fail('-c requires a byte count');
      const n = wantCount(v.text, 'byte count');
      if (n.error) return n;
      count = n.value;
      mode = 'bytes';
    } else if (!t.quoted && /^-c[0-9]+$/.test(t.text)) {
      if (lineCountGiven) return fail('cannot combine line and byte count modes');
      const n = wantCount(t.text.slice(2), 'byte count');
      if (n.error) return n;
      count = n.value;
      mode = 'bytes';
    } else if (!t.quoted && /^-[0-9]+$/.test(t.text)) {
      if (mode === 'bytes') return fail('cannot combine line and byte count modes');
      const n = wantCount(t.text.slice(1), 'line count');
      if (n.error) return n;
      count = n.value;
      lineCountGiven = true;
    } else if (!t.quoted && t.text.charAt(0) === '-' && t.text.length > 1) {
      return fail('unsupported option: ' + t.text + ' (supported: -n N'
        + (cmd === 'tail' ? ', -n +N' : '') + ', -c N, -N)');
    } else {
      paths.push(t.text);
    }
  }
  return { mode: mode, count: count, fromLine: fromLine, paths: paths };
}

// head/tail read exactly one file or stdin (multiple files are rejected
// instead of inventing header semantics). The INPUT cap is the generous
// head/tail read bound — only the FINAL OUTPUT is held to the terminal cap.
async function readHeadTailInput(ctx, cmd, paths, stdin) {
  if (!paths.length) {
    if (stdin !== null && stdin !== undefined) {
      return { bytes: new TextEncoder().encode(stdin) };
    }
    return null;
  }
  if (paths.length > 1) return { error: cmd + ': exactly one file operand is supported' };
  const abs = resolveShellPath(ctx, paths[0]);
  const st = await statShellPath(ctx, paths[0], abs);
  if (st.kind !== 'file') return { error: cmd + ': ' + paths[0] + ': is a directory' };
  if (st.size > HEAD_TAIL_MAX_INPUT_BYTES) {
    return { error: cmd + ': ' + paths[0] + ': input exceeds the ' + HEAD_TAIL_MAX_INPUT_BYTES
      + '-byte head/tail input limit (' + st.size + ' bytes); use python' };
  }
  return { bytes: await ctx.vfs.readBytes(abs) };
}

async function shWc(ctx, args, stdin) {
  let flagL = false, flagW = false, flagC = false;
  const paths = [];
  for (const t of args) {
    if (!t.quoted && t.text.charAt(0) === '-' && t.text.length > 1) {
      for (const ch of t.text.slice(1)) {
        if (ch === 'l') flagL = true;
        else if (ch === 'w') flagW = true;
        else if (ch === 'c') flagC = true;
        else return shErr('wc: unsupported option: -' + ch + ' (supported options: -l -w -c)');
      }
    } else {
      paths.push(t.text);
    }
  }
  if (!flagL && !flagW && !flagC) { flagL = flagW = flagC = true; }
  if (!paths.length && (stdin === null || stdin === undefined)) {
    return shErr('wc: missing file operand (or pipe input into wc)');
  }


  // -l counts LINES (newline-terminated or not): our pipeline producers emit
  // unterminated final lines, and `grep x f | wc -l` must answer the number
  // of matched lines, not the number of \n bytes. For files ending in a
  // newline this is identical to GNU wc.
  const counts = (text, bytes) => ({
    l: text === '' ? 0 : (text.match(/\n/g) || []).length + (text.endsWith('\n') ? 0 : 1),
    w: text.split(/\s+/).filter(Boolean).length,
    c: bytes,
  });
  const format = (c, label) => {
    const nums = [];
    if (flagL) nums.push(c.l);
    if (flagW) nums.push(c.w);
    if (flagC) nums.push(c.c);
    return nums.join(' ') + (label ? ' ' + label : '');
  };

  if (!paths.length) return shOk(format(counts(stdin, utf8ByteLength(stdin)), null));

  const lines = [];
  const total = { l: 0, w: 0, c: 0 };
  for (const p of paths) {
    const abs = resolveShellPath(ctx, p);
    const st = await statShellPath(ctx, p, abs);
    if (st.kind !== 'file') return shErr('wc: ' + p + ': is a directory');
    const bytes = await ctx.vfs.readBytes(abs); // -c is real UTF-8 bytes, not JS string length
    const c = counts(new TextDecoder('utf-8').decode(bytes), bytes.byteLength);
    total.l += c.l; total.w += c.w; total.c += c.c;
    lines.push(format(c, p));
  }
  if (paths.length > 1) lines.push(format(total, 'total'));
  return shOk(lines.join('\n'));
}

// ---------- sort ----------
// Deterministic line sort over bounded input (all operands + stdin combined).
// Lexical comparison is plain `<`/`>` on code units — never localeCompare —
// so results cannot drift with browser locale.

// Leading numeric value for -n: optional sign, decimals and exponent.
// Non-numeric lines have no numeric key (null), which the comparator orders
// deterministically (numeric lines first, then lexical among themselves).
function sortLeadingNumber(line) {
  const m = String(line).match(/^[ \t]*[-+]?[0-9]*\.?[0-9]+(?:[eE][-+]?[0-9]+)?/);
  if (!m) return null;
  const v = Number(m[0]);
  return Number.isFinite(v) ? v : null;
}

function compareLexical(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareNumericLines(a, b) {
  const na = sortLeadingNumber(a);
  const nb = sortLeadingNumber(b);
  if (na !== null && nb !== null) {
    if (na < nb) return -1;
    if (na > nb) return 1;
    return compareLexical(a, b); // equal keys: stable, deterministic tie-break
  }
  if (na !== null) return -1;
  if (nb !== null) return 1;
  return compareLexical(a, b);
}

async function shSort(ctx, args, stdin) {
  let flagN = false, flagR = false, flagU = false;
  const paths = [];
  for (const t of args) {
    if (!t.quoted && t.text.charAt(0) === '-' && t.text.length > 1) {
      for (const ch of t.text.slice(1)) {
        if (ch === 'n') flagN = true;
        else if (ch === 'r') flagR = true;
        else if (ch === 'u') flagU = true;
        else return shErr('sort: unsupported option: -' + ch + ' (supported options: -n -r -u)');
      }
    } else {
      paths.push(t.text);
    }
  }
  const signal = ctx.opts && ctx.opts.signal;
  const texts = [];
  let totalBytes = 0;
  if (!paths.length) {
    if (stdin === null || stdin === undefined) {
      return shErr('sort: missing file operand (or pipe input into sort)');
    }
    totalBytes = utf8ByteLength(stdin);
    if (totalBytes > SORT_MAX_INPUT_BYTES) {
      return shErr('sort: input exceeds the ' + SORT_MAX_INPUT_BYTES + '-byte sort limit ('
        + totalBytes + ' bytes); use python');
    }
    texts.push(stdin);
  } else {
    for (const p of paths) {
      throwIfCancelled(signal, 'sort');
      let abs;
      try {
        abs = resolveShellPath(ctx, p);
      } catch (e) {
        return shErr('sort: ' + e.message);
      }
      const st = await statShellPath(ctx, p, abs);
      if (st.kind !== 'file') return shErr('sort: ' + p + ': is a directory');
      totalBytes += st.size;
      if (totalBytes > SORT_MAX_INPUT_BYTES) {
        return shErr('sort: input exceeds the ' + SORT_MAX_INPUT_BYTES + '-byte sort limit ('
          + totalBytes + ' bytes); use python');
      }
      let text;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(await ctx.vfs.readBytes(abs));
      } catch (e) {
        return shErr('sort: ' + p + ': input is not UTF-8 text');
      }
      texts.push(text);
    }
  }
  // All input is in memory; a cancel between reading and sorting still lands.
  throwIfCancelled(signal, 'sort');
  let lines = [];
  for (const t of texts) lines = lines.concat(splitLines(t));
  const cmp = flagN ? compareNumericLines : compareLexical;
  lines.sort((a, b) => (flagR ? -cmp(a, b) : cmp(a, b)));
  if (flagU) {
    const unique = [];
    for (const l of lines) {
      if (!unique.length || unique[unique.length - 1] !== l) unique.push(l);
    }
    lines = unique;
  }
  return shOk(lines.join('\n'));
}

// ---------- which ----------
// Pure registry lookup: resolves through SHELL_COMMANDS + SHELL_ALIASES only.
// It never executes the command, never touches the network and never inspects
// a host PATH. Paths are reported as /usr/bin/<name> because /usr/bin is the
// capability view of exactly this registry.
async function shWhich(ctx, args) {
  if (!args.length) return shErr('usage: which <command>...');
  const found = [];
  const errors = [];
  for (const t of args) {
    const name = SHELL_ALIASES[t.text] || t.text;
    if (Object.prototype.hasOwnProperty.call(SHELL_COMMANDS, name)) {
      found.push('/usr/bin/' + name);
    } else {
      errors.push('which: ' + t.text + ': command not found');
    }
  }
  if (errors.length) return shErrAt(errors.join('\n'), found.join('\n'));
  return shOk(found.join('\n'));
}

// ---------- mv / rm ----------
// Bounded, workspace-confined file mutations implemented on WorkspaceAdapter
// primitives only. A move NEVER deletes its source before the destination
// write has landed and been verified; a recursive delete reports exactly
// what committed when cancelled (a cancel is not a rollback).

// Bounds for recursive directory moves/copies.
const MV_MAX_ENTRIES = 1000;
const MV_MAX_TOTAL_BYTES = 25 * 1024 * 1024;

function baseName(rel) {
  return rel.slice(rel.lastIndexOf('/') + 1);
}

// Cancellation inside a mutating traversal: the thrown error carries exactly
// what already committed so the outer report never pretends a rollback.
function throwMutationCancelled(signal, what, done) {
  if (signal && signal.aborted) {
    const e = makeCancelledError(what);
    e.detail = what + ': cancelled after committing ' + done.length + ' entrie(s): '
      + done.slice(0, 10).join(', ') + (done.length > 10 ? ', …' : '') + ' (not rolled back)';
    throw e;
  }
}

async function shMv(ctx, args) {
  const signal = ctx.opts && ctx.opts.signal;
  const policy = ctx.opts && ctx.opts.mutationPolicy;
  const operands = [];
  for (const t of args) {
    if (!t.quoted && t.text.charAt(0) === '-' && t.text.length > 1) {
      if (t.text === '-f') return shErr('mv: -f is not supported (an existing destination is never overwritten)');
      return shErr('mv: unsupported option: ' + t.text + ' (no options are supported)');
    }
    operands.push(t.text);
  }
  if (operands.length < 2) return shErr('usage: mv <src>... <dest>');

  const destDisplay = operands[operands.length - 1];
  let destAbs;
  try {
    destAbs = resolveShellPath(ctx, destDisplay);
  } catch (e) {
    return shErr('mv: ' + destDisplay + ': ' + e.message);
  }
  const sources = operands.slice(0, -1);
  let destStat = null;
  try {
    destStat = await ctx.vfs.stat(destAbs);
  } catch (e) {
    if (!e || e.name !== 'NotFoundError') return shErr('mv: ' + destDisplay + ': ' + writableErrMsg(e));
  }
  if (sources.length > 1 && (!destStat || destStat.kind !== 'directory')) {
    return shErr('mv: target ' + destDisplay + ': not a directory (required with multiple sources)');
  }

  // ---- preflight: validate EVERY source and BOTH mount authorities before
  // ANY mutation — a cross-mount move must never create a partial
  // destination only to discover the source is read-only afterwards. ----
  const plan = [];
  for (const srcDisplay of sources) {
    throwIfCancelled(signal, 'mv');
    let srcAbs;
    try {
      srcAbs = resolveShellPath(ctx, srcDisplay);
    } catch (e) {
      return shErr('mv: ' + srcDisplay + ': ' + e.message);
    }
    if (ctx.vfs.isProtectedRoot(srcAbs)) {
      return shErr('mv: ' + srcDisplay + ': refusing to move protected path: ' + srcAbs);
    }
    // The FINAL destination (mv-into-directory appends the basename) —
    // computed here so the injected policy judges the real target.
    let finalAbs = destAbs;
    if (destStat && destStat.kind === 'directory') {
      finalAbs = joinAbs(destAbs, baseName(srcAbs));
    }
    // Product/Harness mutation rules ride the injected policy (M1b): any
    // move touching a protected tree (source OR final destination) is
    // refused by IT, with its byte-stable reason — never split into an
    // approved write plus an approved delete. No policy injected = the
    // generic runtime's neutral behavior.
    if (policy) {
      const verdict = policy.checkMove({
        source: srcAbs,
        destination: finalAbs,
        destinationKind: destStat ? destStat.kind : null,
        recursive: true,
      });
      if (!verdict || verdict.allowed !== true) {
        return shErr('mv: ' + srcDisplay + ': ' + policyRefusal(verdict));
      }
    }
    let srcStat;
    try {
      srcStat = await ctx.vfs.stat(srcAbs);
    } catch (e) {
      return shErr('mv: ' + srcDisplay + ': ' + (e && e.name === 'NotFoundError' ? 'no such file or directory' : writableErrMsg(e)));
    }
    const srcMount = ctx.vfs.resolveMount(srcAbs);
    if (!srcMount || srcMount.authority === 'read-only' || srcMount.authority === 'system-read-only') {
      return shErr('mv: ' + srcDisplay + ': source is on a read-only filesystem; move cannot remove source');
    }

    // finalAbs was computed above (before the policy check); the rules
    // below are unchanged.
    if (finalAbs === srcAbs) return shErr('mv: ' + srcDisplay + ' and ' + destDisplay + ' are the same file');
    if (destStat && destStat.kind !== 'directory') {
      return shErr('mv: ' + destDisplay + ': destination exists');
    }
    if (srcStat.kind === 'directory' && finalAbs.startsWith(srcAbs + '/')) {
      return shErr('mv: cannot move a directory into itself: ' + srcDisplay);
    }
    if (await ctx.vfs.exists(finalAbs)) {
      return shErr('mv: destination exists: ' + (destStat && destStat.kind !== 'directory' ? finalAbs : destDisplay));
    }
    // The destination parent must be an existing directory.
    const parentErr = await checkParentDir(ctx.vfs, finalAbs);
    if (parentErr) return shErr('mv: ' + destDisplay + ': ' + parentErr);
    // The destination mount must be writable BEFORE anything is created.
    try {
      ctx.vfs.assertWritable(finalAbs);
    } catch (e) {
      return shErr('mv: ' + destDisplay + ': ' + writableErrMsg(e));
    }
    plan.push({ srcAbs: srcAbs, srcStat: srcStat, finalAbs: finalAbs });
  }

  const moved = [];
  for (const step of plan) {
    throwIfCancelled(signal, 'mv');
    const err = step.srcStat.kind === 'directory'
      ? await mvDirectory(ctx, step.srcAbs, step.finalAbs, signal)
      : await mvFile(ctx, step.srcAbs, step.finalAbs, signal);
    if (err) return shErr(err);
    moved.push(step.srcAbs + ' -> ' + step.finalAbs);
  }
  const r = shOk('');
  r.fs = true;
  return r;
}

// file → new path: copy, VERIFY the destination landed, only then remove
// the source. A failed/short destination write leaves the source untouched.
async function mvFile(ctx, srcAbs, finalAbs, signal) {
  throwIfCancelled(signal, 'mv');
  const bytes = await ctx.vfs.readBytes(srcAbs);
  throwIfCancelled(signal, 'mv');
  await ctx.vfs.write(finalAbs, bytes);
  throwIfCancelled(signal, 'mv');
  const check = await ctx.vfs.readBytes(finalAbs);
  if (check.byteLength !== bytes.byteLength || bytesToB64(check) !== bytesToB64(bytes)) {
    return 'mv: write verification failed for ' + finalAbs + '; source preserved';
  }
  throwIfCancelled(signal, 'mv');
  await ctx.vfs.remove(srcAbs);
  return null;
}

// directory → new path: bounded pre-scan, EXPLICIT destination tree
// creation (the tree itself is part of the data — empty directories must
// survive a move), per-file copy with read-back verification, and ONLY THEN
// a separate recursive delete of the source. Any failure or cancellation in
// the creation/copy/verify phase leaves the source tree fully intact; the
// partial destination is reported, never silently cleaned up.
async function mvDirectory(ctx, srcAbs, finalAbs, signal) {
  // ---- pre-scan: complete tree description; every bound is enforced BEFORE
  // the destination starts to exist ----
  const files = [];
  const dirs = []; // pre-order: parents always precede their children
  let totalBytes = 0;
  async function scan(abs) {
    throwIfCancelled(signal, 'mv');
    const entries = await ctx.vfs.list(abs);
    for (const e of entries) {
      // The entry bound is enforced per entry — a single flat directory can
      // exceed it without any nested scan() call ever re-checking.
      if (files.length + dirs.length >= MV_MAX_ENTRIES) {
        throw new Error('mv: directory exceeds the ' + MV_MAX_ENTRIES + '-entry move limit');
      }
      const child = joinAbs(abs, e.name);
      if (e.kind === 'directory') {
        dirs.push(child);
        await scan(child);
      } else {
        const st = await ctx.vfs.stat(child);
        totalBytes += st.size;
        if (totalBytes > MV_MAX_TOTAL_BYTES) {
          throw new Error('mv: directory exceeds the ' + MV_MAX_TOTAL_BYTES + '-byte move limit');
        }
        files.push(child);
      }
    }
  }
  try {
    await scan(srcAbs);
  } catch (e) {
    if (isCancelledError(e)) throw e;
    return e.message;
  }

  // ---- destination tree creation + copy + verify ----
  const createdDirs = [];
  const copiedFiles = [];
  const throwCopyCancelled = () => {
    if (signal && signal.aborted) {
      const e = makeCancelledError('mv');
      e.detail = 'mv: cancelled during copy; source preserved; partial destination may exist'
        + ' (created ' + createdDirs.length + ' director(y/ies), copied '
        + copiedFiles.length + '/' + files.length + ' file(s))';
      throw e;
    }
  };
  try {
    // The destination root itself is created explicitly — even a completely
    // empty source directory must materialize as an empty destination.
    throwCopyCancelled();
    await ctx.vfs.mkdir(finalAbs);
    createdDirs.push(finalAbs);
    // Child directories shallow-to-deep (pre-order scan already guarantees
    // parents first; mkdir itself is recursive as a second safety net).
    for (const d of dirs) {
      throwCopyCancelled();
      const target = finalAbs + '/' + d.slice(srcAbs.length + 1);
      await ctx.vfs.mkdir(target);
      createdDirs.push(target);
    }
    // Copy every file and verify the copy byte-for-byte before it counts.
    for (const f of files) {
      throwCopyCancelled();
      const bytes = await ctx.vfs.readBytes(f);
      throwCopyCancelled();
      const destPath = finalAbs + '/' + f.slice(srcAbs.length + 1);
      await ctx.vfs.write(destPath, bytes);
      throwCopyCancelled();
      const check = await ctx.vfs.readBytes(destPath);
      if (check.byteLength !== bytes.byteLength || bytesToB64(check) !== bytesToB64(bytes)) {
        return 'mv: write verification failed for ' + destPath
          + '; source preserved (partial destination may exist)';
      }
      copiedFiles.push(f);
    }
  } catch (e) {
    if (isCancelledError(e)) throw e;
    return 'mv: destination creation/copy failed (' + (e && e.message ? e.message : String(e))
      + '); source preserved, partial destination may exist';
  }

  // ---- delete phase — deepest first so directories are empty when removed.
  // Only starts after the entire destination tree exists and every copied
  // file verified. A cancel here is a partial commit: reported, not rolled
  // back. ----
  const deleted = [];
  const all = files.concat(dirs.slice().reverse());
  try {
    for (const p of all) {
      throwMutationCancelled(signal, 'mv', deleted.map((d) => 'delete ' + d));
      await ctx.vfs.remove(p);
      deleted.push(p);
    }
    throwMutationCancelled(signal, 'mv', deleted.map((d) => 'delete ' + d));
    await ctx.vfs.remove(srcAbs);
    deleted.push(srcAbs);
  } catch (e) {
    if (isCancelledError(e)) throw e;
    return 'mv: delete failed at ' + (deleted.length ? 'entry after ' + deleted[deleted.length - 1] : srcAbs)
      + ' (' + (e && e.message ? e.message : String(e)) + '); destination is complete, source may be partially removed';
  }
  return null;
}

async function shRm(ctx, args) {
  const signal = ctx.opts && ctx.opts.signal;
  const policy = ctx.opts && ctx.opts.mutationPolicy;
  let force = false, recursive = false;
  const operands = [];
  for (const t of args) {
    if (!t.quoted && t.text.charAt(0) === '-' && t.text.length > 1) {
      for (const ch of t.text.slice(1)) {
        if (ch === 'f') force = true;
        else if (ch === 'r' || ch === 'R') recursive = true;
        else return shErr('rm: unsupported option: -' + ch + ' (supported options: -f -r -R)');
      }
    } else {
      operands.push(t.text);
    }
  }
  if (!operands.length) return force ? shOk('') : shErr('usage: rm [-f] [-r|-R] <path>...');

  const errors = [];
  const deleted = [];
  for (const op of operands) {
    throwMutationCancelled(signal, 'rm', deleted);
    let abs;
    try {
      abs = resolveShellPath(ctx, op);
    } catch (e) {
      errors.push('rm: ' + op + ': ' + e.message);
      continue;
    }
    // Hard stop: nothing may recursively remove a protected structural or
    // mount root, however spelled (/, /., /mnt/workspace, /x/.., ...).
    // This is disaster prevention, not a permission system.
    if (ctx.vfs.isProtectedRoot(abs)) {
      errors.push(recursive
        ? 'rm: refusing to recursively remove protected path: ' + abs
        : 'rm: ' + op + ': is a directory');
      continue;
    }
    let st;
    try {
      st = await ctx.vfs.stat(abs);
    } catch (e) {
      if (e && e.name === 'NotFoundError') {
        if (!force) errors.push('rm: ' + op + ': no such file or directory');
        continue;
      }
      errors.push('rm: ' + op + ': ' + writableErrMsg(e));
      continue;
    }
    // Product/Harness mutation rules ride the injected policy (M1b), for
    // files and directories alike: the Locus policy refuses directory
    // removal under the skills root (capability-wide deletion is
    // exclusively the user's Remove action in Settings) and leaves single
    // declared skill FILES on their per-file approval path. The VFS's
    // protected-root refusal above stays a RUNTIME check.
    if (policy) {
      const verdict = policy.checkRemove({ target: abs, kind: st.kind, recursive: recursive });
      if (!verdict || verdict.allowed !== true) {
        errors.push('rm: ' + policyRefusal(verdict));
        continue;
      }
    }
    if (st.kind === 'directory') {
      if (!recursive) {
        errors.push('rm: ' + op + ': is a directory');
        continue;
      }
      try {
        await rmRecursive(ctx, abs, signal, deleted);
      } catch (e) {
        if (isCancelledError(e)) throw e;
        // A mid-recursion failure (e.g. a read-only mount) is reported
        // per operand; already-committed deletions stay in `deleted`.
        errors.push('rm: ' + op + ': ' + writableErrMsg(e));
      }
    } else {
      throwMutationCancelled(signal, 'rm', deleted);
      try {
        await ctx.vfs.remove(abs);
        deleted.push(abs);
      } catch (e) {
        errors.push('rm: ' + op + ': ' + writableErrMsg(e));
      }
    }
  }
  if (errors.length) {
    const r = shErr(errors.join('\n'));
    if (deleted.length) r.fs = true;
    return r;
  }
  const r = shOk('');
  if (deleted.length) r.fs = true;
  return r;
}

// Depth-first recursive delete: children (deepest first) before the
// directory itself, with a cancellation check before EVERY removal. Already
// committed deletions are reported on the cancellation error, never hidden.
async function rmRecursive(ctx, abs, signal, deleted) {
  throwMutationCancelled(signal, 'rm', deleted);
  const entries = await ctx.vfs.list(abs);
  for (const e of entries) {
    const child = joinAbs(abs, e.name);
    if (e.kind === 'directory') {
      await rmRecursive(ctx, child, signal, deleted);
    } else {
      throwMutationCancelled(signal, 'rm', deleted);
      await ctx.vfs.remove(child);
      deleted.push(child);
    }
  }
  throwMutationCancelled(signal, 'rm', deleted);
  await ctx.vfs.remove(abs);
  deleted.push(abs);
}

async function shPython(ctx, args) {
  return await runPython(args.map((t) => t.text), ctx, ctx.opts);
}

async function shCurl(ctx, args) {
  return await runCurl(args.map((t) => t.text), ctx, ctx.opts);
}

async function shHelp() {
  return shOk(shellHelpText());
}

// ---------- executor ----------

// Execute one shell command line against the workspace.
// Returns { output: string, isError: boolean, io: {in, out} } for the tool
// layer — stdout/stderr are separated INSIDE the executor and merged only
// here, for presentation. io in UTF-8 bytes.
// The cwd starts at the VFS default on EVERY invocation and never persists
// across tool calls.
async function runShellCommand(input, workspace, opts) {
  const line = String(input || '').trim();
  const ioOf = (output) => ({ in: utf8ByteLength(line), out: utf8ByteLength(output) });
  if (!line) return { output: '', isError: false, io: { in: 0, out: 0 } };

  // The shell always has a filesystem: real VFS as-is, legacy adapter
  // mounted at /mnt/workspace, missing argument → fresh internal machine.
  const vfs = asVfs(workspace);
  // The cwd is VFS-ABSOLUTE and starts at the VFS default on EVERY
  // invocation: /mnt/workspace when mounted, otherwise /home/locus.
  // `cd` never leaks across bash calls.
  const ctx = { vfs: vfs, opts: opts, cwd: vfs.defaultCwd() };

  // Heredoc python is recognized before generic tokenizing.
  const heredoc = extractPythonHeredoc(line);
  if (heredoc) {
    const r = await runPythonCode(heredoc.code, ctx.vfs, pythonOpts(ctx));
    const output = [r.stdout, r.stderr].filter(Boolean).join('\n');
    return { output: output, isError: !r.success, io: r.io };
  }

  let steps;
  try {
    steps = parseShellLine(shellTokenize(line));
  } catch (e) {
    return { output: 'bash: ' + e.message, isError: true, io: ioOf('bash: ' + e.message) };
  }
  if (!steps.length) return { output: '', isError: false, io: ioOf('') };

  const outParts = [];
  const networkOps = [];
  let fsOps = 0;
  let prevSuccess = true;
  let lastRes = null;

  try {
    for (const step of steps) {
      // Cancellation is re-checked between commands: a task cancelled after
      // `echo A > a.txt` must never run the next command's side effects.
      throwIfCancelled(opts && opts.signal, 'bash');
      // and_or_list is left-associative: && skips on failure, || on success.
      if (step.connector === '&&' && !prevSuccess) continue;
      if (step.connector === '||' && prevSuccess) continue;
      const res = await runPipeline(step.pipeline, ctx);
      prevSuccess = res.success;
      if (res.stdout) outParts.push(res.stdout);
      if (res.stderr) outParts.push(res.stderr);
      if (res.network) networkOps.push(res.network);
      if (res.fs) fsOps++;
      lastRes = res;
    }
  } catch (e) {
    if (isCancelledError(e)) {
      // Mutating commands (rm/mv) attach exactly what already committed —
      // a cancel is never a rollback and the report must say so.
      if (e.detail) outParts.push(e.detail);
      outParts.push('bash: cancelled');
    } else {
      outParts.push('bash: ' + (e && e.message ? e.message : String(e)));
    }
    const output = outParts.join('\n');
    return { output: output, isError: true, io: ioOf(output) };
  }

  const output = outParts.join('\n');
  const result = { output: output, isError: lastRes ? !lastRes.success : false, io: ioOf(output) };
  // Operation metadata: a single network command keeps its real backend; a
  // compound command mixing several operations reports honestly instead of
  // attributing one backend to all of them.
  if (networkOps.length === 1 && !fsOps) {
    result.backend = networkOps[0].backend;
    result.operation = 'network';
  } else if (networkOps.length > 1 || (networkOps.length && fsOps)) {
    result.backend = 'browser';
    result.operation = 'compound';
  } else if (fsOps) {
    result.backend = 'browser';
    result.operation = 'filesystem';
  }
  return result;
}

async function runPipeline(pipeline, ctx) {
  let stdin = null;
  let network = null;
  let fs = false;
  const stderrParts = [];
  let res = { success: true, stdout: '', stderr: '' };
  for (let i = 0; i < pipeline.length; i++) {
    throwIfCancelled(ctx.opts && ctx.opts.signal, 'bash');
    res = await runSimpleCommand(pipeline[i], ctx, stdin);
    if (res.network) network = res.network;
    if (res.fs) fs = true;
    if (res.stderr) stderrParts.push(res.stderr);
    if (i < pipeline.length - 1) {
      // A pipeline forwards STDOUT ONLY — stderr is never fed downstream
      // (that is exactly what an explicit `2>&1` is for). Like a real shell,
      // a failed left stage does not stop the right stages from running.
      if (utf8ByteLength(res.stdout) > SHELL_PIPE_MAX_BYTES) {
        // Fail loudly: downstream stages must never receive silently
        // truncated input and mistake it for a complete answer.
        const err = shErr('bash: pipeline stage output exceeds the ' + SHELL_PIPE_MAX_BYTES
          + '-byte limit; refusing to forward truncated data (narrow the command, e.g. with head -n)');
        err.network = network;
        err.fs = fs;
        return err;
      }
      stdin = res.stdout;
    }
  }
  // Pipeline status is the LAST stage's status (shell semantics); stderr is
  // the concatenation of every stage's diagnostics.
  return {
    success: res.success,
    stdout: res.stdout,
    stderr: stderrParts.join('\n'),
    network: network,
    fs: fs,
  };
}

// Execute one simple command: resolve the handler, extract redirections
// (applied LEFT TO RIGHT — `> all.txt 2>&1` and `2>&1 > out.txt` differ),
// run the command, then deliver its stdout/stderr through the routing state.
async function runSimpleCommand(cmd, ctx, stdin) {
  const argv = cmd.argv;
  const rawName = argv[0].text;
  const name = SHELL_ALIASES[rawName] || rawName;
  const spec = SHELL_COMMANDS[name];

  // ---- redirection routing state ----
  // stdout: {kind:'capture'} | {kind:'file', path, append} | {kind:'null'}
  // stderr: same, plus {kind:'merge-stdout'} (2>&1 while stdout was captured)
  const args = [];
  const route = { stdout: { kind: 'capture' }, stderr: { kind: 'capture' } };
  for (let i = 1; i < argv.length; i++) {
    const t = argv[i];
    if (!t.op) { args.push(t); continue; }
    if (t.text === '2>&1') {
      // stderr inherits stdout's CURRENT destination — a snapshot, so a later
      // `> file` does not retroactively move stderr. All three destination
      // kinds (capture / file / null) snapshot correctly: with stdout already
      // discarded, stderr is discarded too.
      route.stderr = route.stdout.kind === 'file'
        ? { kind: 'file', path: route.stdout.path, append: route.stdout.append }
        : route.stdout.kind === 'null'
          ? { kind: 'null' }
          : { kind: 'merge-stdout' };
      continue;
    }
    const target = argv[++i];
    if (!target || target.op) return shErr('bash: missing redirect target after "' + t.text + '"');
    let abs;
    try {
      abs = resolveShellPath(ctx, target.text);
    } catch (e) {
      return shErr('bash: ' + e.message);
    }
    // /dev/null is a redirection SINK, not a filesystem node: output routed
    // here is discarded without touching the VFS (there is deliberately no
    // /dev — `cat /dev/null` still fails like any missing file).
    if (abs === '/dev/null') {
      const dest = { kind: 'null' };
      if (t.text.charAt(0) === '2') route.stderr = dest;
      else route.stdout = dest;
      continue;
    }
    if (abs === '/') return shErr('bash: redirect target must be a file path, not the filesystem root');
    // Unwritable targets (read-only mounts, structural paths, unmounted
    // folders) are rejected BEFORE the command runs — before ANY side
    // effect, not just before the write itself.
    try {
      ctx.vfs.assertWritable(abs);
    } catch (e) {
      return shErr('bash: ' + name + ': cannot write ' + abs + ': ' + writableErrMsg(e));
    }
    const dest = { kind: 'file', path: abs, append: t.text === '>>' || t.text === '2>>' };
    if (t.text.charAt(0) === '2') route.stderr = dest;
    else route.stdout = dest;
  }

  let res;
  if (!spec) {
    // Even an unknown command's error is stderr and routes like stderr.
    res = shErr(shellError(name));
  } else if (stdin !== null && stdin !== undefined && !spec.stdin) {
    res = shErr('bash: ' + name + ': does not read stdin (pipeline input has nowhere to go)');
  } else {
    try {
      res = await spec.run(ctx, args, stdin);
    } catch (e) {
      if (isCancelledError(e)) throw e;
      // Handler failures are the command's stderr — redirection applies to
      // them exactly like to normally-produced stderr.
      res = shErr('bash: ' + name + ': ' + (e && e.message ? e.message : String(e)));
    }
  }

  // ---- deliver streams through the routing state ----
  // Redirection changes WHERE output goes, never the command's success.
  // A 'null' destination discards its stream silently (and is not a
  // filesystem write); 'merge-stdout' folds stderr into the PRESENT stdout.
  const out = {
    success: res.success,
    stdout: '',
    stderr: '',
    network: res.network || null,
    fs: !!res.fs,
  };
  const writes = [];
  if (route.stdout.kind === 'capture') out.stdout = res.stdout || '';
  else if (route.stdout.kind === 'file') writes.push({ dest: route.stdout, text: res.stdout || '' });
  if (route.stderr.kind === 'capture') out.stderr = res.stderr || '';
  else if (route.stderr.kind === 'file') writes.push({ dest: route.stderr, text: res.stderr || '' });
  else if (route.stderr.kind === 'merge-stdout') {
    out.stdout = [out.stdout, res.stderr].filter(Boolean).join('\n');
  }

  const signal = ctx.opts && ctx.opts.signal;
  const writtenPaths = new Set();
  for (const w of writes) {
    let text = w.text;
    // Captured streams carry no trailing newline; a redirected stream
    // terminates like a real one would (echo hi > f → "hi\n").
    if (text && !text.endsWith('\n')) text += '\n';
    // A second stream aimed at the same file in the same command appends to
    // what the first write just landed (stdout first, then stderr).
    const append = w.dest.append || writtenPaths.has(w.dest.path);
    try {
      if (append) {
        // `>>`/`2>>` are byte-preserving: the old content is read as raw
        // bytes and concatenated with the UTF-8 payload — binary targets
        // survive an append untouched.
        await appendFileBytes(ctx.vfs, w.dest.path, new TextEncoder().encode(text), signal, name);
      } else {
        // `>`/`2>` truncate + write (text payload, UTF-8).
        throwIfCancelled(signal, name);
        await ctx.vfs.write(w.dest.path, text);
      }
      writtenPaths.add(w.dest.path);
    } catch (e) {
      if (isCancelledError(e)) throw e;
      out.success = false;
      out.stderr = [out.stderr, 'bash: ' + name + ': cannot write ' + w.dest.path + ': '
        + (e && e.message ? e.message : String(e))].filter(Boolean).join('\n');
      return out;
    }
  }
  if (writes.length) out.fs = true;
  return out;
}

async function runPython(args, ctx, opts) {
  let code = null;

  if (!args.length) {
    return shErr('usage: python -c "<code>" | python <script.py> | python <<\'PY\' ... PY');
  }
  if (args[0] === '--version' || args[0] === '-V') {
    return shOk('Python (browser runtime)');
  }
  if (args[0] === '-c') {
    code = args.slice(1).join(' ');
  } else {
    const script = args[0];
    let abs;
    try {
      abs = resolveShellPath(ctx, script);
    } catch (e) {
      return shErr('python: ' + e.message);
    }
    try {
      code = await ctx.vfs.read(abs);
    } catch (e) {
      return shErr('python: can\'t open file \'' + script + '\': ' + writableErrMsg(e));
    }
  }

  return await runPythonCode(code, ctx.vfs, pythonOpts(ctx));
}

// Options handed to the injected python runtime instance: the caller’s opts plus the ABSOLUTE VFS
// cwd of this invocation (Python's os.chdir target).
function pythonOpts(ctx) {
  return Object.assign({}, ctx.opts, { cwd: ctx.cwd });
}

async function runPythonCode(code, vfs, opts) {
  if (!code || !code.trim()) {
    return { success: false, stdout: '', stderr: 'python: empty code', io: { in: 0, out: 0 } };
  }
  // M1b lifecycle: the interpreter instance arrives INJECTED in opts
  // (Product wiring). There is deliberately no global fallback — a python
  // execution without an injected instance is an assembly bug and fails
  // as an honest tool failure instead of silently resurrecting a
  // page-global runtime.
  const rt = opts && opts.pythonRuntime;
  if (!rt) {
    return { success: false, stdout: '', stderr: 'python: no runtime instance injected', io: { in: utf8ByteLength(code), out: 0 } };
  }

  let res;
  try {
    res = await rt.run(code, vfs, opts);
  } catch (e) {
    if (isCancelledError(e)) {
      return { success: false, stdout: '', stderr: 'python: execution cancelled', cancelled: true, io: { in: utf8ByteLength(code), out: 0 } };
    }
    throw e;
  }

  // stdout carries normal output + commit reports; stderr carries Python's
  // own stderr, execution errors and every commit-failure note.
  const outParts = [];
  const errParts = [];
  if (res.stdout) outParts.push(res.stdout.replace(/\n$/, ''));
  if (res.stderr) errParts.push(res.stderr.replace(/\n$/, ''));
  if (res.error) errParts.push(res.error);
  if (res.stdoutTruncated) {
    outParts.push('[python output limit: stdout truncated]');
  }
  if (res.stderrTruncated) {
    errParts.push('[python output limit: stderr truncated]');
  }
  if (res.skipped && res.skipped.length) {
    const shown = res.skipped.slice(0, 10).map((s) => s.path + ' (' + s.reason + ')');
    outParts.push('[workspace sync: ' + res.skipped.length + ' file(s) NOT visible to Python: ' + shown.join('; ')
      + (res.skipped.length > shown.length ? '; …' : '') + ']');
  }
  if (res.written && res.written.length) {
    outParts.push('[written: ' + res.written.join(', ') + ']');
  }
  if (res.mkdirs && res.mkdirs.length) {
    outParts.push('[mkdir: ' + res.mkdirs.join(', ') + ']');
  }
  if (res.deleted && res.deleted.length) {
    outParts.push('[deleted: ' + res.deleted.join(', ') + ']');
  }
  for (const c of res.conflicts || []) {
    errParts.push('[conflict: ' + c.path + ': ' + c.reason + ']');
  }
  for (const f of res.writeFailed || []) {
    errParts.push('[write-back failed: ' + f + ']');
  }
  for (const p of res.notPersisted || []) {
    errParts.push('[not persisted: ' + p + ']');
  }

  const stdout = outParts.join('\n');
  const stderr = errParts.join('\n');

  // Compute success and commit success are reported separately: a run that
  // computed fine but could not fully persist is a FAILURE state (partial
  // commit), never a silent success. Multi-file commits are staged, NOT
  // atomic — partial results are always spelled out above.
  const commitFailed = (res.writeFailed && res.writeFailed.length > 0)
    || (res.conflicts && res.conflicts.length > 0)
    || (res.notPersisted && res.notPersisted.length > 0);

  return {
    success: !res.error && !commitFailed,
    stdout,
    stderr,
    io: {
      in: utf8ByteLength(code) + res.inputBytes,
      out: utf8ByteLength(stdout) + utf8ByteLength(stderr) + res.outputBytes,
    },
  };
}

// ---------- curl (NetworkRuntime) ----------
// Deliberately NOT full curl. The shell layer is CLI-only: argument
// parsing, stdout/stderr formatting, -o file output, exit semantics.
// ALL network execution — transport, routing, approval, bounds — lives
// in NetworkRuntime.request(); the shell never fetches, never sees
// backends and never reasons about CORS.
//
// Supported forms:
//   curl <url>                      → GET; text printed, binary hint
//   curl -o <file> <url>            → binary-safe download (-o/--output)
//   curl -I <url>                   → HEAD (-I/--head)
//   curl -X <method> <url>          → explicit method (-X/--request)
//   curl -H "Name: value" <url>     → request header (-H/--header, repeatable)
//   curl -d <data> <url>            → request body (-d/--data/--data-binary
//                                     imply POST; --data-raw never reads
//                                     files; @file reads VFS bytes)
// Everything else (-u, cookies, -L, -G, …) fails with a clear message.

const TEXT_LIKE_MIMES = new Set([
  'application/json',
  'application/xml',
  'application/javascript',
  'application/x-javascript',
  'application/x-yaml',
  'application/yaml',
  'application/x-www-form-urlencoded',
  'image/svg+xml',
]);

function isTextLikeMime(contentType) {
  const mime = String(contentType || '').split(';')[0].trim().toLowerCase();
  if (!mime || mime === 'text/plain') return true; // unknown → assume text
  return mime.startsWith('text/') || TEXT_LIKE_MIMES.has(mime)
    || mime.endsWith('+json') || mime.endsWith('+xml');
}

async function runCurl(args, ctx, opts) {
  const vfs = ctx.vfs;
  const netResult = (text, success, net) => ({
    success,
    stdout: success ? text : '',
    stderr: success ? '' : text,
    // network metadata flows up to telemetry via the compound executor
    network: net ? { backend: net.backend } : null,
  });

  // Parse: exactly one URL positional; value-taking options below.
  let outFile = null;
  let url = null;
  let methodArg = null;
  let head = false;
  const headerArgs = [];
  const dataArgs = []; // { raw: string, allowFile: boolean }
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-o' || a === '--output') {
      outFile = args[++i];
      if (!outFile) return netResult('curl: -o requires a file path', false);
    } else if (a === '-X' || a === '--request') {
      methodArg = args[++i];
      if (!methodArg) return netResult('curl: -X requires a method', false);
    } else if (a === '-I' || a === '--head') {
      head = true;
    } else if (a === '-H' || a === '--header') {
      const h = args[++i];
      if (h == null) return netResult('curl: -H requires a header ("Name: value")', false);
      headerArgs.push(h);
    } else if (a === '-d' || a === '--data' || a === '--data-binary') {
      const d = args[++i];
      if (d == null) return netResult('curl: ' + a + ' requires data', false);
      dataArgs.push({ raw: d, allowFile: true });
    } else if (a === '--data-raw') {
      const d = args[++i];
      if (d == null) return netResult('curl: --data-raw requires data', false);
      dataArgs.push({ raw: d, allowFile: false });
    } else if (a.startsWith('-')) {
      return netResult('curl: option not supported in local browser runtime: ' + a, false);
    } else if (url) {
      return netResult('curl: only one URL is supported', false);
    } else {
      url = a;
    }
  }
  if (!url) {
    return netResult('usage: curl <url> | curl -o <file> <url> | curl -I <url> | curl -X <method> [-H <header>] [-d <data>] <url>', false);
  }

  // Method: explicit -X wins; -I means HEAD; -d implies POST (curl
  // semantics); otherwise GET.
  let method = 'GET';
  if (methodArg) method = methodArg;
  else if (head) method = 'HEAD';
  else if (dataArgs.length) method = 'POST';

  // A GET/HEAD request with a body is an unsupported combination, not a
  // silent data loss: `-X GET -d` / `-I -d` fails locally BEFORE any
  // network attempt (curl's real behavior of discarding the body is
  // deliberately NOT imitated).
  if (dataArgs.length && (method === 'GET' || method === 'HEAD')) {
    return netResult('curl: unsupported request combination: '
      + method + ' cannot carry a request body (-d/--data with -X GET or -I)', false);
  }

  // Headers: "Name: value" (first colon splits); invalid names fail
  // before anything else happens.
  const headers = {};
  for (const h of headerArgs) {
    const idx = h.indexOf(':');
    if (idx <= 0) return netResult('curl: invalid header (expected "Name: value"): ' + h, false);
    const name = h.slice(0, idx).trim();
    const value = h.slice(idx + 1).trim();
    if (!name || /\s/.test(name)) {
      return netResult('curl: invalid header name: ' + name, false);
    }
    headers[name] = value;
  }

  // A download with an unwritable target must fail BEFORE any network
  // request: resolve the absolute path, enforce mount authority, check the
  // parent directory and reject an existing DIRECTORY target — nothing here
  // may hit the network first.
  if (outFile) {
    const display = outFile;
    try {
      outFile = resolveShellPath(ctx, outFile);
    } catch (e) {
      return netResult('curl: ' + e.message, false);
    }
    try {
      vfs.assertWritable(outFile);
    } catch (e) {
      return netResult('curl: cannot write ' + display + ': ' + writableErrMsg(e), false);
    }
    const parentErr = await checkParentDir(vfs, outFile);
    if (parentErr) return netResult('curl: cannot write ' + display + ': ' + parentErr, false);
    let targetStat = null;
    try {
      targetStat = await vfs.stat(outFile);
    } catch (e) {
      if (!e || e.name !== 'NotFoundError') {
        return netResult('curl: cannot write ' + display + ': ' + writableErrMsg(e), false);
      }
    }
    if (targetStat && targetStat.kind === 'directory') {
      return netResult('curl: cannot write ' + display + ': is a directory', false);
    }
  }

  // Materialize the request body from the local VFS (local-only, no side
  // effect): @file parts read bytes, inline parts are UTF-8 encoded;
  // parts are joined with '&' (curl semantics). NetworkRuntime enforces
  // the request-byte cap BEFORE approval, but a huge @file is bounded
  // here too so it is never materialized just to be refused.
  let body = null;
  if (dataArgs.length && method !== 'GET' && method !== 'HEAD') {
    const parts = [];
    for (const d of dataArgs) {
      if (d.raw.startsWith('@') && d.allowFile) {
        const display = d.raw;
        let abs;
        try {
          abs = resolveShellPath(ctx, d.raw.slice(1));
        } catch (e) {
          return netResult('curl: ' + e.message, false);
        }
        try {
          const st = await vfs.stat(abs);
          if (st && Number.isFinite(st.size) && st.size > NetworkRuntime.maxRequestBytes) {
            return netResult('curl: request body too large (limit '
              + NetworkRuntime.maxRequestBytes + ' bytes): ' + display, false);
          }
        } catch (e) {
          if (!e || e.name !== 'NotFoundError') {
            return netResult('curl: cannot read ' + display + ': ' + (e && e.message ? e.message : String(e)), false);
          }
        }
        try {
          parts.push(await vfs.readBytes(abs));
        } catch (e) {
          return netResult('curl: cannot read ' + display + ': ' + (e && e.message ? e.message : String(e)), false);
        }
      } else if (d.raw.startsWith('@')) {
        return netResult('curl: --data-raw does not support @file (use --data-binary)', false);
      } else {
        parts.push(new TextEncoder().encode(d.raw));
      }
    }
    const total = parts.reduce((n, p) => n + p.byteLength, 0) + (parts.length - 1);
    body = new Uint8Array(total);
    let off = 0;
    parts.forEach((p, i) => {
      if (i) body[off++] = 0x26; // '&'
      body.set(p, off);
      off += p.byteLength;
    });
  }

  let res;
  try {
    res = await NetworkRuntime.request({
      method: method,
      url: url,
      headers: headers,
      body: body,
      signal: opts && opts.signal,
      // Execution authorization port (contract §3.5): the injected
      // consumer decides; the shell neither constructs approvals nor
      // carries any chat identity.
      authorization: opts && opts.authorization,
    });
  } catch (e) {
    if (isCancelledError(e)) return netResult('curl: cancelled', false);
    // A denial is a deterministic, ordinary result (docs/NETWORK-RUNTIME.md):
    // the request was NOT made; the model may continue another way.
    if (e && e.networkCode === 'network_denied') {
      return netResult('curl: network request denied by user', false);
    }
    return netResult('curl: ' + (e && e.message ? e.message : String(e)), false);
  }

  // HEAD (-I): show the response headers — never a body (a non-conforming
  // server that sends one on HEAD must not surface through the shell).
  // Real HTTP statuses (including 404) are reported through their headers
  // with the usual success/failure flag. x-locus-* wire markers are relay
  // plumbing, not upstream information.
  if (method === 'HEAD') {
    const lines = ['HTTP ' + res.status + (res.statusText ? ' ' + res.statusText : '')];
    for (const pair of (res.headerList || [])) {
      if (String(pair[0]).startsWith('x-locus-')) continue;
      lines.push(pair[0] + ': ' + pair[1]);
    }
    return netResult(lines.join('\n'), res.status < 400, res);
  }

  // An HTTP error status is an authoritative response, not a transport
  // failure — report the status (with a text body preview when sensible).
  // The URL is rendered through the safe display form (origin + path):
  // query strings can carry secrets and are never shown, and the wire
  // request itself is untouched.
  if (res.status >= 400) {
    let output = 'curl: HTTP ' + res.status + ' from ' + safeNetworkUrlForDisplay(res.finalUrl);
    if (isTextLikeMime(res.headers['content-type']) && res.bytes.byteLength) {
      const preview = new TextDecoder().decode(res.bytes.slice(0, 500)).replace(/\n$/, '');
      if (preview.trim()) output += '\n' + preview;
    }
    return netResult(output, false, res);
  }

  if (outFile) {
    // The fetch awaited: re-check cancellation before writing the file.
    throwIfCancelled(opts && opts.signal, 'curl');
    // Binary-safe: raw bytes go straight into the VFS, no decoding.
    await vfs.write(outFile, res.bytes);
    // Telemetry stays `network`: the download IS the network operation.
    return netResult('[written to ' + outFile + ', ' + res.bytes.byteLength + ' bytes]', true, res);
  }

  if (isTextLikeMime(res.headers['content-type'])) {
    return netResult(new TextDecoder('utf-8').decode(res.bytes).replace(/\n$/, ''), true, res);
  }

  const mime = String(res.headers['content-type'] || 'application/octet-stream').split(';')[0].trim();
  return netResult(
    'curl: binary response (' + mime + ', ' + res.bytes.byteLength + ' bytes); use curl -o <file> <url>',
    true, res);
}

// ============================================================
//  M3a (repository extraction): ES module exports.
//
//  The declared __LOCUS_RUNTIME_CORE__ registry is DELETED: the public
//  entry (src/index.js) imports this module directly, so there is no
//  page-global table, no classic-script load order, and no registry
//  delegation anymore. Exports split two ways:
//    - the surface the public entry and hosts consume
//      (interpreter/execution factories, command registry +
//      descriptions, contract data + real limit constants);
//    - internal seams the package's own unit suites drive (bootstrap
//      manifest + budget helpers, wheel validation, tokenizer/parser
//      internals, workspace collection). This file is NOT in the
//      package "exports" map — it stays package-internal.
// ============================================================
export {
  // interpreter + execution
  createPythonRuntime,
  runShellCommand,
  runPythonCode,
  // shell surface (registry + descriptions + grep)
  SHELL_COMMANDS,
  SHELL_ALIASES,
  shellHelpText,
  shellSystemPromptSection,
  GrepRegexRuntime,
  createGrepRegexSession,
  GREP_REGEX_TIMEOUT_MS,
  // contract data: payload identity + real bound constants
  RUNTIME_PLUGIN_ID_PATTERN,
  RUNTIME_PY_MODULE_PATTERN,
  SHELL_PIPE_MAX_BYTES,
  HEAD_TAIL_MAX_OUTPUT_BYTES,
  // python bootstrap contract (single source of truth, F04c)
  PYODIDE_BASE,
  PYTHON_BOOTSTRAP_MANIFEST,
  PYTHON_BOOTSTRAP_CORE_ASSETS,
  PYTHON_RUNTIME_PACKAGE_FILES,
  PYTHON_INSTALLER_SUPPORT_FILES,
  PYTHON_TIMEOUT_MS,
  PYTHON_ASSET_TIMEOUT_MS,
  PYTHON_ASSET_STALL_MS,
  PYTHON_BOOTSTRAP_TIMEOUT_MS,
  PYTHON_PLUGIN_WHEEL_MAX_BYTES,
  validateWheelArtifact,
  // internal seams (package tests only)
  pythonBootstrapBudgets,
  makeBudgetClock,
  readBodyBounded,
  shellTokenize,
  parseShellLine,
  runPipeline,
  collectWorkspaceFiles,
};
