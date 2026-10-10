# locus-runtime

[![CI](https://github.com/boccchi2993/locus-runtime/actions/workflows/ci.yml/badge.svg)](https://github.com/boccchi2993/locus-runtime/actions/workflows/ci.yml)

Browser-local Unix-like execution substrate for Locus: a Linux-like virtual
filesystem, a shell compatibility layer, Python through a verified Pyodide
bootstrap, isolated regex-grep workers, and a bounded anonymous network
transport. Framework-free ES modules — no Vue, no model knowledge, no product
state.

**Status: repository split complete; implementation merged into `main`.**
This repository is the authoritative Runtime implementation. It works independently
of [locus-harness](https://github.com/boccchi2993/locus-harness); [locus-product](https://github.com/boccchi2993/locus-product)
composes both cores through their public package APIs and pins tested commit pairs.
The original repository is extraction provenance, not a second implementation to maintain.
See [provenance](docs/PROVENANCE.md), the
[M4b mainline verification](https://github.com/boccchi2993/locus-product/blob/main/docs/M4B-MAINLINE-VERIFICATION.md),
and [maintenance TODO](TODO.md). Split completion does not claim every CI run passed;
known browser-startup failures remain documented.

## Install / use

The package is plain ESM and is consumed from a packed tarball (it is
`private` and not published to npm):

```bash
npm pack                                # → locus-runtime-0.1.0.tgz
npm install ./locus-runtime-0.1.0.tgz   # in a consumer project
```

```js
// Everything a host needs: the public entry + the worker assets.
import {
  createRuntime,            // → Promise<RuntimeHost>
  createWorkspace,          // → VirtualWorkspace (default: runtime command surface)
  createMemoryWorkspace,    // → byte-exact in-memory provider
  shellCommandNames,
} from 'locus-runtime';
// The filesystem PROVIDER surface (mount your own storage):
import {
  WorkspaceAdapter,
  LocalDirectoryWorkspace,
  OPFSWorkspace,
  normalizeWorkspacePath,
  ensureWorkspacePermission,
  vfsError,
} from 'locus-runtime/workspace';
import { PY_WORKER_SOURCE, GREP_WORKER_SOURCE } from 'locus-runtime/worker-assets';
```

Minimal browser host:

```js
const host = await createRuntime({
  workerAssets: { pyWorkerSource: PY_WORKER_SOURCE, grepWorkerSource: GREP_WORKER_SOURCE },
});
const session = host.createSession();

const vfs = createWorkspace();
vfs.mount('/mnt/workspace', createMemoryWorkspace({ name: 'workspace' }), 'read-write');

session.onStatus((snap) => console.log('python:', snap.interpreter));

// shell
const res = await session.execute({
  kind: 'shell',
  input: 'echo hello > /mnt/workspace/x.txt && cat /mnt/workspace/x.txt',
  context: { filesystem: vfs },
});
// res = { ok: true, output: 'hello\n', io: { in, out }, … }

// real Python (lazy: nothing downloads until the first python execution)
const py = await session.execute({
  kind: 'python',
  input: 'import sys\nprint(sys.version_info[0])',
  context: { filesystem: vfs },
});
// py = { ok: true, stdout: '3\n', … }

// session boundaries: reset is reusable, dispose is terminal (idempotent)
session.reset('between tasks');
session.dispose('host teardown');
// host.dispose('teardown') disposes every session
```

## Public API

`createRuntime(opts)` — opts: `{ workerAssets: { pyWorkerSource, grepWorkerSource } }`
(both required non-empty strings; invalid configuration rejects the returned Promise).
Returns a `Promise<RuntimeHost>`.

`RuntimeHost`:

- `contractVersion` — `1`.
- `capabilities()` — frozen declaration: `executionKinds`, `bootstrap.shaPinned`,
  `policyMechanisms`, `commands` (the real shell registry keys) and `limits`
  (the real bound constants). Declared, never version-guessed.
- `createSession()` → `RuntimeSession` (one interpreter instance per session).
- `dispose(reason?)` — terminal for the host and every session; idempotent.

`RuntimeSession`:

- `prepare(req)` — between-task configuration (`{ signal?, python?: PluginPayload | null }`).
  Waits for its turn on the serialization chain AND every execution in flight
  at call time; a cancel/reset/dispose landing during the wait refuses the
  configuration (cancellation-shaped for signals). A legitimate chained
  rebuild is never mistaken for a boundary.
- `execute(req)` — `{ kind: 'shell' | 'python', input, context }` where context
  is the task-frozen binding `{ filesystem, signal?, mutationPolicy?,
  authorization?, cwd? }`. Returns the honest tool-shaped report with a
  normalized `ok` (compute AND commit success; partial failure is never a
  success). A session boundary invalidates in-flight runs WITHOUT the caller
  aborting: dispatched provider operations settle and are reported honestly
  (additive `boundary` field, committed effects listed, no rollback).
- `status()` — `{ interpreter: 'cold'|'loading'|'ready', busyExecutions, extensionKey, disposed }`.
- `onStatus(fn)` — immediate snapshot on subscribe, then every edge;
  contained observers; returns unsubscribe.
- `reset(reason?)` / `dispose(reason?)` — reusable boundary / terminal.
- `describeCommands()` — the command/capability description generated from
  this runtime's own registry (null when absent, never fabricated).
- `pythonRuntime()` — Runtime-internal accessor for test/e2e seams only.

`MutationPolicy` (host-injected, optional): operation-aware `{ checkMove,
checkRemove, isPolicyRefusal }`. Absent policy = the neutral generic runtime.
The policy can reduce, never grant: read-only mounts, protected roots and
path-safety stay Runtime-owned.

Execution authorization (required for side-effecting network methods):
`context.authorization = { request(req, { signal }) → Promise<{ outcome:
'allow'|'deny'|'cancelled', scope: 'once'|'session' }> }`. Deny ≠ cancel;
side-effecting requests are dispatched EXACTLY ONCE (an ambiguous failure is
never retried across backends); GET/HEAD may fall back browser → relay once.

## Workspace providers (`locus-runtime/workspace`)

The root entry exposes the execution contract and the VFS factories; the
`./workspace` subpath exposes the provider LAYER beneath them — what a host
mounts its own storage through. Ownership split: the runtime provides the
generic providers and filesystem mechanisms; the HOST picks directories,
obtains OPFS handles, decides mount points and authorities, and owns
persistence, schema and product policy. Importing the subpath is pure: it
requests no permission, touches no OPFS/DOM, starts no worker.

- `WorkspaceAdapter` — the provider base class: `list/read/readBytes/write/
  remove/mkdir/exists/stat` (all async). Extend it to bring any backend; a
  missing method throws `not implemented`.
- `LocalDirectoryWorkspace(dirHandle)` — provider over a File System Access
  API directory handle (from `showDirectoryPicker()` or IndexedDB-restored
  handles). Read/write bytes and strings, recursive mkdir, sorted `list`.
- `OPFSWorkspace(dirHandle, { name? })` — provider over an Origin-Private
  File System directory (e.g. from
  `navigator.storage.getDirectory()`). Same surface; `name` labels the mount.
- `normalizeWorkspacePath(path) → string` — the ONE path algorithm every
  provider shares. Backslashes normalize to `/`, leading `/` and `.` segments
  are dropped, inner `..` resolves; `..` past the root throws
  `path escapes workspace: <path>`, drive letters/control characters throw
  `invalid path`, `:` segments throw `invalid path segment`. Call it in your
  own provider to inherit the same escape rules.
- `ensureWorkspacePermission(handle) → Promise<boolean>` — query-then-request
  `readwrite`. Resolves `true` when granted, `false` when the user denies
  (a denial is a return value, never a throw); `true` immediately for handles
  without the permission API.
- `vfsError(name, message) → Error` — the runtime's name-tagged error
  factory. Throw these from your own provider so the VFS/shell keep
  classifying faults: `NotFoundError` makes `exists()` return `false`;
  `ReadOnlyError`/`TypeMismatchError` surface as-is.

Mounting a handle the host obtained (the runtime never opens a picker and
never requests permission on your behalf):

```js
import { OPFSWorkspace, LocalDirectoryWorkspace, ensureWorkspacePermission } from 'locus-runtime/workspace';

// durable OPFS mount — the host owns the handle and the mount decision:
const root = await navigator.storage.getDirectory();
let homeDir = root;
for (const seg of ['home', 'locus']) {
  homeDir = await homeDir.getDirectoryHandle(seg, { create: true });
}
const vfs = createWorkspace();
vfs.mount('/home/locus', new OPFSWorkspace(homeDir, { name: 'home' }), 'read-write');

// user-picked folder — the host asks, then mounts:
const handle = await window.showDirectoryPicker();
if (await ensureWorkspacePermission(handle)) {
  vfs.mount('/mnt/workspace', new LocalDirectoryWorkspace(handle), 'external-read-write');
}
```

A host-custom provider extends the same base (see the consumer gate's
`f1CustomProvider` scenario in `tools/consumer-e2e/index.html` for a complete
worked example).

Importing the package is pure: no worker starts, no Python downloads, no DOM
is queried, no storage is opened, no global is defined. Python stays cold
until the first `kind: 'python'` execution (a text-only task downloads
nothing).

## Deployment notes (CSP, assets)

- The two worker sources ship as ES-module strings
  (`locus-runtime/worker-assets`) and are loaded by your bundler — no worker
  files, no DOM script tags, no CDN fetch of worker code.
- The Python worker is created by a strict-CSP `srcdoc` creator iframe
  (`default-src 'none'; connect-src 'none'; script-src 'unsafe-inline'
  'unsafe-eval'; worker-src blob:`; the page must allow inline iframes with
  `srcdoc` and blob: workers). From untrusted-Python-time onward the BROWSER
  makes network egress from the interpreter impossible.
- The pinned Pyodide 0.26.4 bootstrap downloads at runtime from
  `https://cdn.jsdelivr.net/pyodide/v0.26.4/full/` — every asset is
  size- and SHA-256-verified against the in-code manifest before the worker
  may receive it; a partially verified set is never cached or delivered.
  Serve the page over http(s) for best caching (`force-cache`); file:// works.
- `curl`-side-effecting methods route through the injected authorization
  port; read-like GET/HEAD relay fallback targets `/fetch` (a same-origin
  request-forwarding endpoint, configurable via `NetworkRuntime.relayPath`).
  Without a relay, non-hosted pages fail reads closed rather than retry.

## Development

```bash
npm ci
npm run build     # bundles the standalone host page (dist/tests/runtime-host.html)
npm test          # 23 Node unit suites (no internet, no browser)
npm run test:e2e  # 8 browser gates (real Chrome; real pinned Python CDN downloads)
```

The order matters: the boundary suite's G5 section scans the BUILT bundle in
`dist/`, so `npm test` requires `npm run build` first — on a fresh clone
without `dist/` the boundary gate fails closed (there is deliberately no
"skip when dist is absent" fallback).

Browser gates need headless Chrome (auto-located, or `CHROME=/path/to/chrome`).
The Python gates download the REAL pinned Pyodide set from the jsDelivr CDN
(SHA-256-pinned, budget-bounded) except the bootstrap-integrity and
plugin-runtime suites, which serve synthetic verified bytes locally.
No model, model key or paid API is ever contacted.

Layout: `src/index.js` (public entry) · `src/workspace-api.js` (provider
subpath entry) · `src/{workspace,vfs,network,shell}.js` (implementation
modules) · `src/worker-assets.js` (shipped worker sources) · `docs/`
(extraction design, provenance, coverage map, verification) · `tests/`
(unit suites + browser gates + the standalone host page).

## License

Apache-2.0. See [LICENSE](LICENSE).
