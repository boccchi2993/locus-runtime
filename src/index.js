// ============================================================
//  LOCUS RUNTIME — PUBLIC ENTRY
//
//  createRuntime → RuntimeHost → RuntimeSession: the importable
//  boundary this package exposes. Importing this module starts no
//  worker, downloads no Python and touches no DOM.
//
//  M3a (repository extraction): the M2a two-mode assembly (classic
//  __LOCUS_RUNTIME_CORE__ registry delegation vs dynamic-import
//  self-assembly over classic sources) is DELETED. The implementation
//  modules (workspace/vfs/network/shell) are plain ES modules; this
//  entry imports them directly. There is no page-global table, no
//  classic-script load order, and no registry read/write anywhere.
//  Everything a host needs is this import + the worker assets
//  (locus-runtime/worker-assets).
//
//  WHAT A SESSION OWNS: one interpreter instance (createPythonRuntime
//  — all interpreter mutable state stays inside it), the status
//  listener fan-out, the prepare serialization chain, AND the full
//  lifecycle of every accepted public execute — from admission (queued
//  behind an in-flight prepare barrier) to complete settlement,
//  INCLUDING composite shell work (VFS writes, grep, curl,
//  python-inside-shell), which counts exactly once.
//
//  TWO SEPARATE INVALIDATION ALGEBRAS:
//    - the SESSION boundary generation (session.reset/dispose) — a real
//      boundary: invalidates in-flight executes (via a session-owned
//      cancellation plane merged with the caller's signal), refuses every
//      prepare it crossed, and blocks not-yet-started side effects of
//      queued work. Already-dispatched provider operations are awaited
//      and reported honestly — never rolled back, never a fake success.
//    - the INTERPRETER generation (instance reset/dispose) — bumped by
//      legitimate prepare rebuilds (a key change tears down and rebuilds
//      the interpreter) as well as by boundaries. A prepare that waited
//      judges only the SESSION algebra: a concurrent prepare's rebuild is
//      normal serialized work, not an external reset.
// ============================================================

import {
  createPythonRuntime,
  runShellCommand,
  runPythonCode,
  SHELL_COMMANDS,
  shellSystemPromptSection,
  SHELL_PIPE_MAX_BYTES,
  HEAD_TAIL_MAX_OUTPUT_BYTES,
  PYTHON_TIMEOUT_MS,
} from './shell.js';
import { VirtualWorkspace, MemoryWorkspace } from './vfs.js';

// ---------- worker asset validation ----------
function requireWorkerSource(value, name) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('createRuntime: workerAssets.' + name + ' (a non-empty worker source string) is required');
  }
  return value;
}

function cancelled(what) {
  const e = new Error(what + ' cancelled');
  e.name = 'AbortError';
  e.cancelled = true;
  return e;
}

// UTF-8 byte length of an appended result note (io accounting).
let noteEncoder = null;
function utf8Length(s) {
  noteEncoder = noteEncoder || new TextEncoder();
  return noteEncoder.encode(s).length;
}

// The implementation's own bound constants, surfaced through
// capabilities().limits exactly as the M2c declared core table did
// (real constants, never retyped numbers).
const IMPL_LIMITS = Object.freeze({
  shellPipeMaxBytes: SHELL_PIPE_MAX_BYTES,
  headTailMaxOutputBytes: HEAD_TAIL_MAX_OUTPUT_BYTES,
  pythonTimeoutMs: PYTHON_TIMEOUT_MS,
});

// ---------- the entry ----------
// Still async (public API shape unchanged since M2a — callers await it);
// validation is synchronous and the core is a static import graph, so
// no assembly work remains.
export async function createRuntime(opts) {
  const o = opts || {};
  const workerAssets = {
    pyWorkerSource: requireWorkerSource(o.workerAssets && o.workerAssets.pyWorkerSource, 'pyWorkerSource'),
    grepWorkerSource: requireWorkerSource(o.workerAssets && o.workerAssets.grepWorkerSource, 'grepWorkerSource'),
  };
  return createRuntimeHost(workerAssets);
}

// ---------- VFS exports ----------
// The task filesystem constructors. createWorkspace supplies the
// runtime's own shell command surface by default (a host may override
// listCommands); the home skeleton stays the host's explicit choice
// (neutral default when omitted, exactly like the underlying
// VirtualWorkspace). M3a: these are direct imports — usable as soon as
// the module is imported (the old "call createRuntime() first"
// resolution order no longer exists).
export function createWorkspace(opts) {
  const o = opts || {};
  const merged = Object.assign({ listCommands: () => shellCommandNames() }, o);
  return new VirtualWorkspace(merged);
}

export function createMemoryWorkspace(opts) {
  return new MemoryWorkspace(opts);
}

// The runtime's shell command surface (registry data).
export function shellCommandNames() {
  return Object.keys(SHELL_COMMANDS);
}

// ---------- RuntimeHost ----------
function createRuntimeHost(workerAssets) {
  const sessions = new Set();
  let hostDisposed = null;

  const host = {
    contractVersion: 1,

    // Declared, checked capabilities — never version-guessed.
    // `commands` comes from the actual SHELL_COMMANDS registry and
    // `limits` from the implementation's real constants.
    capabilities() {
      return Object.freeze({
        contractVersion: 1,
        executionKinds: Object.freeze(['shell', 'python']),
        bootstrap: Object.freeze({ shaPinned: true }),
        policyMechanisms: Object.freeze(['mutationPolicy', 'authorization']),
        commands: Object.freeze(Object.keys(SHELL_COMMANDS).sort()),
        limits: IMPL_LIMITS,
      });
    },

    createSession() {
      if (hostDisposed) throw new Error(hostDisposed);
      const session = createRuntimeSession(workerAssets, () => sessions.delete(session));
      sessions.add(session);
      return session;
    },

    // Terminal for the whole host: disposes every session (idempotent —
    // a second dispose keeps the first reason; sessions dispose the same
    // way inside).
    dispose(reason) {
      const why = hostDisposed || ('runtime host disposed' + (reason ? ': ' + reason : ''));
      hostDisposed = why;
      for (const s of Array.from(sessions)) s.dispose(why);
      sessions.clear();
    },
  };
  return host;
}

// ---------- RuntimeSession ----------
function createRuntimeSession(workerAssets, onReleased) {
  // The ONE interpreter instance for this session (M1b lifecycle inside).
  const py = createPythonRuntime({ pyWorkerSource: workerAssets.pyWorkerSource });

  // ---- execution tracking (session-owned) ----
  // Every ACCEPTED public execute is tracked here from admission to
  // complete settlement. Composite shell work (VFS writes, grep, network,
  // python-inside-shell) lives INSIDE its one execute entry and is never
  // counted twice. busyExecutions reports this set's size — the session's
  // honest "not yet settled" count.
  const inflight = new Set();

  // ---- session boundary algebra ----
  // Bumped by reset()/dispose() ONLY. The interpreter's own
  // _resetGeneration moves for a second reason (a legitimate prepare
  // rebuild) and is NEVER read as a boundary signal here.
  let boundaryGeneration = 0;
  let boundaryReason = null;
  // Terminal state: set by dispose(); execute/prepare refuse with this
  // reason afterwards.
  let sessionDisposed = null;
  // Per-execute invalidation hooks: a boundary aborts every in-flight
  // execute's merged cancellation plane. Each hook removes itself in its
  // execute's finally — exactly one registration, exactly one release.
  const boundaryListeners = new Set();

  function fireBoundary() {
    for (const fn of Array.from(boundaryListeners)) {
      try { fn(); } catch (e) { /* contained: an observer can never break the boundary */ }
    }
  }

  // ---- status fan-out ----
  // One pump subscription over the instance's event stream for the
  // session's lifetime; session listeners are fanned out from it. The
  // INSTANCE contains observer exceptions per listener already; the
  // session-side fan-out is a plain synchronous loop (the pump callback
  // itself never throws).
  const listeners = new Set();
  let unsubInstance = null;
  function sessionStatus() {
    const snap = py.snapshot();
    snap.busyExecutions = inflight.size;
    return snap;
  }
  function ensurePump() {
    if (unsubInstance) return;
    // Subscribe BEFORE adding the listener so the instance's immediate
    // on-subscribe snapshot finds an empty set; the initial read is then
    // delivered exactly once by onStatus itself.
    unsubInstance = py.onStatus(() => {
      for (const fn of Array.from(listeners)) {
        try { fn(sessionStatus()); } catch (e) { /* contained: observer failure */ }
      }
    });
  }

  // ---- prepare serialization chain ----
  // Concurrent prepares apply in call order: each enqueues one exclusive
  // chain segment. The segment and the CALLER'S ANSWER are two different
  // promises (review round 2): the segment settles only when the previous
  // segment has TRULY settled AND this turn completed (applied, or a
  // refused/skipped exit) — caller cancellation never ends it early. The
  // caller receives a cancellable OBSERVATION of the segment instead:
  // abort answers the caller promptly with AbortError while the segment
  // keeps its queue position, so a later prepare/execute can never jump
  // ahead of an unfinished earlier one.
  let prepareTail = Promise.resolve();
  // The interpreter generation the CHAIN last observed or produced. While
  // a prepare waits, this is the ONLY legitimate way the interpreter
  // generation may move (a chained prepare's own serialized apply). A move
  // to any other value means an out-of-band instance reset and refuses the
  // waiting prepare.
  let chainPyGeneration = py._resetGeneration;

  // Settlement barrier over everything in flight AT CALL TIME (public
  // executes + any instance-level runs from the documented test seam).
  // Call-time, not apply-time: executes admitted later queue behind the
  // chain and must never extend (or deadlock against) an earlier prepare's
  // barrier.
  function sessionSettlementSnapshot() {
    const proms = [];
    for (const e of inflight) if (e.done) proms.push(e.done.then(() => {}, () => {}));
    const pySettle = py._inflightSettlement();
    if (pySettle) proms.push(pySettle);
    return proms.length ? Promise.all(proms) : null;
  }

  const session = {
    // ---- between-task configuration ----
    // Waits for (1) its turn on the serialization chain and (2) every
    // execution in flight AT CALL TIME to settle — no timers, no polling —
    // then re-validates before applying ANYTHING:
    //   disposed (session or instance) → throws the disposal reason;
    //   session boundary during wait   → throws the boundary reason,
    //                                    nothing applied;
    //   out-of-band instance reset     → refuses (never mistaken for a
    //                                    legitimate chained rebuild);
    //   signal aborted                 → the cancellation-shaped refusal
    //                                    (M1b form).
    // Only then the instance's synchronous validate-then-swap prepare
    // runs. A configuration can never land late for a task that died
    // while its prepare was waiting.
    prepare(req) {
      // Immediate refusals — nothing queued yet, nothing to release.
      if (sessionDisposed) return Promise.reject(new Error(sessionDisposed));
      if (py._disposed) return Promise.reject(new Error(py._disposed));
      const signal = req && req.signal;
      if (signal && signal.aborted) return Promise.reject(cancelled('python preparation'));

      const prev = prepareTail;
      const boundaryAtCall = boundaryGeneration;
      // Settlement barrier over everything in flight AT CALL TIME (public
      // executes + any instance-level runs from the documented test seam).
      // Call-time, not apply-time: executes admitted later queue behind
      // the chain and must never extend (or deadlock against) an earlier
      // prepare's barrier.
      const inflightBarrier = sessionSettlementSnapshot();

      // The INTERNAL QUEUE SEGMENT. It waits out prev's TRUE settlement —
      // deliberately no race against the abort here: racing and releasing
      // on cancel would hand this segment's queue position to a later
      // entry while an earlier segment is still unfinished (review round
      // 2, gap F2). The caller is answered early instead (below).
      const internalSegment = (async () => {
        await prev;
        // Our turn. Liveness before anything applies; a cancelled prepare
        // skips its configuration but still ENDS ITS SEGMENT IN ORDER.
        if (sessionDisposed) throw new Error(sessionDisposed);
        if (py._disposed) throw new Error(py._disposed);
        if (boundaryGeneration !== boundaryAtCall) {
          throw new Error('python runtime reset while preparation waited for in-flight executions;'
            + ' configuration not applied (' + (boundaryReason || 'session boundary') + ')');
        }
        if (signal && signal.aborted) throw cancelled('python preparation');
        if (inflightBarrier) await inflightBarrier;
        // Post-barrier validation — the no-late-effect gate. Captured
        // against the SESSION algebra: a concurrent prepare's legitimate
        // interpreter rebuild (already applied ahead of us on the chain)
        // is not an external reset.
        if (sessionDisposed) throw new Error(sessionDisposed);
        if (py._disposed) throw new Error(py._disposed);
        if (boundaryGeneration !== boundaryAtCall) {
          throw new Error('python runtime reset while preparation waited for in-flight executions;'
            + ' configuration not applied (' + (boundaryReason || 'session boundary') + ')');
        }
        if (py._resetGeneration !== chainPyGeneration) {
          throw new Error('python runtime was reset outside the preparation chain while preparation waited;'
            + ' configuration not applied');
        }
        if (signal && signal.aborted) throw cancelled('python preparation');
        // The instance's synchronous validate-then-swap. A failure rejects
        // THIS segment only — the chain barrier below is failure-proofed,
        // so the next entry still runs (a failing prepare never wedges).
        const result = py.prepare(req);
        chainPyGeneration = py._resetGeneration;
        return result;
      })();

      // prepareTail = the segment's SETTLEMENT barrier, with both outcomes
      // handled: a rejected segment must never poison the queue behind it.
      prepareTail = internalSegment.then(() => undefined, () => undefined);

      // The CALLER's answer: a cancellable observation of the segment.
      // abort → prompt AbortError; the segment keeps its queue position
      // and every later entry keeps waiting for it. The abort listener is
      // registered synchronously here and removed when the observation
      // ends (either side); the segment's own rejection is always handled
      // (by this chain AND by prepareTail), so a caller that cancelled
      // early can never produce an unhandled rejection.
      if (!signal) return internalSegment;
      return new Promise((resolve, reject) => {
        const onAbort = () => reject(cancelled('python preparation'));
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
        internalSegment.then(
          (v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
          (e) => { signal.removeEventListener('abort', onAbort); reject(e); },
        );
      });
    },

    // ---- the execution port ----
    // `context` is the task-frozen binding: filesystem (REQUIRED — the
    // caller's task fork), signal, mutationPolicy (host policy; absent
    // = the neutral generic runtime), authorization (the execution
    // authorization port), cwd. The result is the honest tool-shaped
    // report plus a normalized `ok` (compute AND commit success; partial
    // failure is never a success — the underlying report keeps every
    // field).
    //
    // LIFECYCLE: the execute is tracked from admission to complete
    // settlement. Admission = queued behind the prepare barrier in force
    // at call time (a new execute can never penetrate an in-flight
    // prepare). The caller's signal and the session's own invalidation
    // plane are MERGED into one internal controller: a reset/dispose
    // lands at the run's next cancellation checkpoint (between shell
    // steps, before every write, before every commit) WITHOUT depending
    // on the caller ever aborting. Already-dispatched provider operations
    // settle and are reported honestly — a boundary-stopped run is never
    // rewritten as a success. The result then passes the FINAL
    // classification inside this closure: a run whose boundary struck
    // (or whose caller aborted) while its last operation was
    // dispatched-but-unsettled is downgraded to an honest failure with
    // the original report kept and the reason appended.
    async execute(req) {
      if (sessionDisposed) throw new Error(sessionDisposed);
      const kind = req && req.kind;
      if (kind !== 'shell' && kind !== 'python') {
        throw new Error('runtime execute: unsupported kind: ' + String(kind));
      }
      const ctx = (req && req.context) || {};
      const entry = { done: null };
      inflight.add(entry);
      const callerSignal = ctx.signal;
      const merged = new AbortController();
      const onCallerAbort = () => {
        try { merged.abort(callerSignal.reason); } catch (e) { merged.abort(); }
      };
      if (callerSignal) {
        if (callerSignal.aborted) onCallerAbort();
        else callerSignal.addEventListener('abort', onCallerAbort, { once: true });
      }
      const boundaryAtCall = boundaryGeneration;
      // THIS run's first invalidation, captured IN THE CLOSURE at strike
      // time: the session-global boundaryReason may be rewritten by a
      // LATER reset before the result forms, so the report must name the
      // boundary that struck THIS run (review round 2, gap F1).
      let struck = null;
      const onBoundary = () => {
        if (boundaryGeneration !== boundaryAtCall) {
          if (!struck) struck = boundaryReason || 'session boundary';
          merged.abort(new Error(struck));
        }
      };
      boundaryListeners.add(onBoundary);
      // The LAST honest word on the public result (review round 2, gap
      // F1), applied before the result leaves the session — shell and
      // direct python both pass through it.
      //   - A run the BOUNDARY struck is NEVER a clean success, and the
      //     boundary always names itself (the underlying report cannot
      //     know the session reason — not even the instance generation
      //     check covers a caller abort): the original report keeps every
      //     field, the explanation is appended, io.out counts the note.
      //   - A CALLER abort downgrades only a report that never saw it
      //     (the abort landed while the last dispatched operation was
      //     still unsettled, so no cancellation checkpoint ran): that
      //     clean success becomes an honest failure. An ALREADY-FAILED
      //     report ('bash: cancelled' / 'python: execution cancelled')
      //     IS the cancellation report and stays byte-identical.
      // An underlying THROW never reaches this at all (existing
      // propagation, unchanged); real worker/provider errors keep
      // precedence — the note is additive, never a downgrade of detail.
      const classifyResult = (res, isShell) => {
        const underFailed = isShell ? !!res.isError : res.success === false;
        if (!struck && !(merged.signal.aborted && !underFailed)) return res;
        const hit = struck || 'execution cancelled';
        const note = 'runtime: ' + hit + ' — the run was superseded after its last'
          + ' operation was already dispatched; the settled effect is kept'
          + ' (no rollback), so the run is reported as failed';
        const report = isShell
          ? { ok: false, isError: true, output: (res.output ? res.output + '\n' : '') + note }
          : { ok: false, success: false, stderr: (res.stderr ? res.stderr + '\n' : '') + note };
        if (res.io) report.io = { in: res.io.in, out: res.io.out + utf8Length(note) };
        if (struck) report.boundary = struck;
        return Object.assign({}, res, report);
      };
      const prevPrepare = prepareTail;
      const run = (async () => {
        try {
          // ADMISSION: wait out the prepare barrier captured at call time.
          await prevPrepare;
          if (sessionDisposed) throw new Error(sessionDisposed);
          if (boundaryGeneration !== boundaryAtCall) {
            throw cancelled(boundaryReason || 'session boundary');
          }
          if (merged.signal.aborted) throw cancelled('execution');
          const opts = {
            signal: merged.signal,
            mutationPolicy: ctx.mutationPolicy,
            authorization: ctx.authorization,
            // Runtime-internal injections: the session's OWN interpreter and
            // grep worker asset — a request can never execute on a foreign
            // instance or fetch its worker source from anywhere else.
            pythonRuntime: py,
            grepWorkerSource: workerAssets.grepWorkerSource,
            cwd: ctx.cwd,
          };
          if (kind === 'shell') {
            // filesystem OPTIONAL: absent → the shell's own fallback (a fresh
            // internal machine — the accepted asVfs semantics, unchanged).
            const res = await runShellCommand(req.input, ctx.filesystem, opts);
            return classifyResult(Object.assign({ ok: !res.isError }, res), true);
          }
          const res = await runPythonCode(req.input, ctx.filesystem, opts);
          return classifyResult(Object.assign({ ok: !!res.success }, res), false);
        } finally {
          // Exactly one release of every registration and the tracking seat.
          boundaryListeners.delete(onBoundary);
          if (callerSignal) callerSignal.removeEventListener('abort', onCallerAbort);
          inflight.delete(entry);
        }
      })();
      // Assigned synchronously (no await separates it from the inflight
      // add), so a prepare barrier taken at any later moment sees EVERY
      // accepted execute exactly once.
      entry.done = run;
      return run;
    },

    // ---- state reads + status subscription ----
    // Canonical snapshot (interpreter state + the SESSION's busy count);
    // onStatus delivers the CURRENT snapshot synchronously on subscribe
    // (no missed-edge window, no polling), then every change. Observer
    // exceptions are contained per listener; unsubscribe stops everything
    // for that listener.
    status() {
      return sessionStatus();
    },
    onStatus(fn) {
      if (typeof fn !== 'function') return () => {};
      ensurePump();
      listeners.add(fn);
      try { fn(sessionStatus()); } catch (e) { /* contained: initial read */ }
      return () => { listeners.delete(fn); };
    },

    // ---- boundaries ----
    // reset: a session boundary — invalidates every in-flight execute
    // (their merged cancellation plane fires; already-dispatched provider
    // operations still settle and report honestly), refuses every prepare
    // it crossed, and blocks queued-not-started side effects. The
    // interpreter instance reset (M1b semantics, verbatim) runs with it.
    // The session stays usable afterwards.
    reset(reason) {
      boundaryGeneration++;
      boundaryReason = 'runtime session reset' + (reason ? ': ' + reason : '');
      fireBoundary();
      py.reset(reason);
      // The boundary's OWN interpreter reset is chained work, not an
      // out-of-band mutation: sync the chain algebra so a fresh prepare
      // after the boundary applies normally.
      chainPyGeneration = py._resetGeneration;
    },
    // dispose: terminal. Everything reset does, plus permanent refusal of
    // execute/prepare. Idempotent: a second dispose keeps the first
    // reason. busyExecutions drains only as the overtaken executes truly
    // settle.
    dispose(reason) {
      const why = 'runtime session disposed' + (reason ? ': ' + reason : '');
      if (!sessionDisposed) {
        sessionDisposed = why;
        boundaryGeneration++;
        boundaryReason = why;
        fireBoundary();
        py.dispose(why);
        chainPyGeneration = py._resetGeneration;
        if (unsubInstance) { unsubInstance(); unsubInstance = null; }
        listeners.clear();
      }
      if (onReleased) onReleased();
    },

    // ---- capability description ----
    // The command/capability description GENERATED from this runtime's
    // own command registry (the same text `help` renders). A host's
    // agent layer adapts this public method into its description port;
    // no consumer reads shellSystemPromptSection as a global anymore.
    // Returns null when the core does not provide a description (never
    // a fabricated capability).
    describeCommands() {
      return typeof shellSystemPromptSection === 'function' ? shellSystemPromptSection() : null;
    },

    // Runtime-internal accessor for test/e2e seams ONLY (documented
    // users: the host test page, Node suites). Host execution goes
    // through execute/prepare/reset/dispose — never through this.
    pythonRuntime() {
      return py;
    },
  };
  return session;
}
