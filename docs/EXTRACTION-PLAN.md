# Extraction plan — Runtime repository (M3a)

Status: M3a deliverable. Source baseline: `boccchi2993/Locus-browser-agent-runtime`
@ `2aec76e78431382873be1db8a6db6310cc89c782` (branch `refactor/repository-split-m2c`,
head of OPEN PR #7, base `refactor/repository-split-m2b`). This repository is
the **extraction candidate**; the product repository remains authoritative
until M3c switches its imports. Provenance and licensing:
[PROVENANCE.md](PROVENANCE.md). Gate evidence: [M3A-VERIFICATION.md](M3A-VERIFICATION.md).

## 1. What this repository is

A standalone ES-module package (`locus-runtime`) that installs, builds, tests
and runs with ZERO Harness/Product source. Public contract (unchanged from
the M2a/M2b/M2c landed entry): `createRuntime → RuntimeHost → RuntimeSession`
with `capabilities()`, `prepare`/`execute`/`status()`/`onStatus()`,
`describeCommands()`, `reset`/`dispose`, host `dispose()`, and the host-facing
VFS exports `createWorkspace`/`createMemoryWorkspace`/`shellCommandNames`.

Package exports (deliberately minimal — only interfaces with consumers):

| Export | Module | Content |
|---|---|---|
| `.` | `src/index.js` | the public API above |
| `./worker-assets` | `src/worker-assets.js` | `PY_WORKER_SOURCE`, `GREP_WORKER_SOURCE` (version-controlled worker assets) |

Everything else (`src/workspace.js`, `src/vfs.js`, `src/network.js`,
`src/shell.js`, `src/lib/utf8.js`) is package-internal. The npm `files` field
ships `src/`, LICENSE, README; the package is marked `private` and is NOT
published to any registry.

## 2. Source → target file map

| Source path @ 2aec76e | Target path | Processing |
|---|---|---|
| `src/runtime/index.js` | `src/index.js` | Rewritten assembly: the two-mode core resolution (registry delegation / dynamic-import self-assembly) DELETED; implementation modules imported directly. Session semantics byte-equivalent (tracked in §4). |
| `src/runtime/worker-assets.js` | `src/worker-assets.js` | Verbatim (already ESM). |
| `src/runtime/core.js` | — | DELETED (existed only to import classic sources as ES modules). |
| `src/telemetry.js` | `src/lib/utf8.js` | SPLIT: only `utf8ByteLength` (the one function the Runtime consumes) moved. The `Telemetry` singleton, record store, `window.__telemetry` accessor and the `renderDebugPanel` history are PRODUCT observability — not extracted. |
| `src/workspace.js` | `src/workspace.js` | ESM conversion: `export { … }` block added, `globalThis` publishes removed. `ConversationHistoryWorkspace` had already moved to Product (M2a). |
| `src/vfs.js` | `src/vfs.js` | ESM conversion: `import { WorkspaceAdapter, normalizeWorkspacePath } from './workspace.js'`; exports added; publishes removed. |
| `src/network.js` | `src/network.js` | ESM conversion: exports added (`NetworkRuntime`, `safeNetworkUrlForDisplay`, `isPrivateHostname`, bound constants); publishes removed. |
| `src/shell.js` | `src/shell.js` | ESM conversion: three imports (utf8/vfs/network) replace classic globals; the declared `__LOCUS_RUNTIME_CORE__` registry block DELETED and replaced by the module export block. ONE additive test seam (§5). |
| `functions/fetch.js` | `tests/fixtures/relay/fetch.js` | Copied as a TEST-ONLY fixture: the reference `/fetch` relay the network browser gate drives. Not part of the package; removal note in §6. |
| `tests/fixtures/pyodide-lock-snapshot.json` | same path | Verbatim (test fixture; Pyodide-derived data, see PROVENANCE). |
| `tests/fixtures/capability-package/…whl` | same path | Verbatim (synthetic wheel fixture for the plugin suites). |
| `LICENSE` | `LICENSE` | Verbatim (Apache-2.0 as found, template placeholder preserved). |

Import-time purity (a hard requirement, gated by
`tests/runtime-import-purity.test.mjs`): importing the package starts no
worker, downloads no Python, queries no DOM, opens no storage, and defines
no `globalThis` symbol. `shell.js`'s remaining `document`/`window` uses are
the existing Python creator-iframe mechanism at boot time (unchanged).

## 3. Deleted assembly dependencies (the M3 exit checklist)

1. `__LOCUS_RUNTIME_CORE__` — the declared registry (published by shell.js,
   read by the entry) is GONE: zero reads, zero writes, enforced by
   `tests/runtime-boundary.test.cjs` G6 over sources and the built bundle.
2. Cross-file `globalThis.*` symbol injection (telemetry/workspace/vfs/
   network publishes) — GONE; G6b scans host-side sources for
   `globalThis.X =` / `window.X =` assignments: zero.
3. Classic-script load order — no host needs to load anything before the
   import; `tests/e2e-runtime-host.cjs` still pins `classicScriptTags === 0`.
4. eval/new Function host-side source assembly — GONE; G6c: zero
   occurrences in host-side sources. (The shipped worker/creator strings
   execute inside the Worker/iframe — the existing Python bootstrap
   mechanism, explicitly out of scope for this rule.)
5. `src/runtime/core.js` self-assembly chunk — deleted with the mechanism.

## 4. Public API changes

None breaking. Precisely:

- `createRuntime(opts)` stays async with the same signature, validation
  errors and worker-asset requirements (`A1d` in the standalone suite).
- `RuntimeHost`/`RuntimeSession` methods, result shapes, error semantics,
  prepare/barrier/boundary/classification semantics: byte-equivalent code
  moved from `src/runtime/index.js` (only the `core` parameter threading
  became direct module references; `capabilities().commands`/`limits` are
  built from the same imported registry/constants the M2c core table
  carried — `A2c` pins values equal to the module constants).
- **One removal of an error path that no longer exists**: the old entry
  threw "call createRuntime() first" from `createWorkspace`/
  `createMemoryWorkspace`/`shellCommandNames` when invoked before any
  `createRuntime()` call. With direct imports there is nothing to resolve,
  so the VFS exports work immediately (SA3 in the import-purity suite).
  No consumer relied on the late error; the standalone suite's A1c check
  now pins the complementary property (a leftover hostile registry global
  is ignored).
- `createPythonRuntime(opts)` gained ONE documented optional test seam,
  `opts.bootstrapManifest` (§5). No existing option changed.

## 5. New test seams (necessity, impact, adaptation)

The classic suites loaded shell.js by `eval(source)` and could rewrite
constants before evaluation. ES modules cannot do that, and the task
forbids eval-assembly of host-side sources. Two additive seams replace the
two rewrite-based techniques:

1. `createPythonRuntime({ bootstrapManifest })` (TEST-ONLY, same category
   as the pre-existing `bootstrapBudgets` option): a non-empty
   manifest-shaped array overriding the frozen `PYTHON_BOOTSTRAP_MANIFEST`
   for that instance only. Replaces python-bootstrap-integrity's
   TEST-variant source rewrite (synthetic sizes/hashes over tiny bytes)
   so the full acquisition pipeline runs deterministically offline.
   Impact: none in production (never set; single read site
   `this._manifestOverride || PYTHON_BOOTSTRAP_MANIFEST`; URLs stay
   `PYODIDE_BASE + entry.name` — I10 unchanged).
2. The host test page (`tests/runtime-host.html`) exposes the documented
   interpreter accessor, `GrepRegexRuntime` (for the pre-existing
   `_workerFactory` TEST-ONLY seam) and the worker asset strings. Same
   instrumentation surface the product page's `window.__locus` seams
   provided; the product page keeps its own.

## 6. Temporary dual-implementation notes

- The product repository keeps its in-repo Runtime; nothing there changes
  in M3a. This window is temporary (see PROVENANCE §"Dual-implementation
  period").
- `tests/fixtures/relay/fetch.js` duplicates the product's `functions/
  fetch.js` for the network gates. Removal gate: when M4 lands the product
  dependency lock, the relay contract tests should consume the relay from
  its owning repository (or a published contract fixture); this copy must
  not drift silently — it is pinned to the extraction baseline and any
  intentional divergence must be recorded here.

## 7. Test migration summary (details: TEST-COVERAGE-MAP.md)

23 unit suites + 8 browser suites run in this repository. The classic
eval-loading model is deleted: suites import the real ES modules (a
`tests/helpers/core.cjs` namespace bridge preserves the old `M.<Symbol>`
reading so assertion bodies stay byte-identical). The bash-driving suites
route through the PUBLIC `RuntimeSession.execute` (the Product `executeTool`
adapter is not extracted; its bash-branch result mapping `{output, success,
backend, operation}` is reproduced inline where a suite's assertions read
the tool shape). Telemetry-record assertions moved to the Product side with
the sink; the Runtime-pinned halves (result attribution, non-leak of the
produced output) stay here.
