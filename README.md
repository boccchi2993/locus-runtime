# locus-runtime

[![CI](https://github.com/boccchi2993/locus-runtime/actions/workflows/ci.yml/badge.svg)](https://github.com/boccchi2993/locus-runtime/actions/workflows/ci.yml)

Browser-local Unix-like execution substrate for Locus: a Linux-like virtual
filesystem, a shell compatibility layer, Python through a verified Pyodide
bootstrap, isolated regex-grep workers, and a bounded anonymous network
transport. Framework-free ES modules — no Vue, no model knowledge, no product
state.

**Status: extraction candidate (M3a).** This repository was extracted from
[boccchi2993/Locus-browser-agent-runtime](https://github.com/boccchi2993/Locus-browser-agent-runtime)
@ `2aec76e` (`refactor/repository-split-m2c`, PR #7 head) as the first step of
the three-repository split. Until the product's imports switch (M3c), the
product repository remains the authoritative implementation; see
[docs/PROVENANCE.md](docs/PROVENANCE.md).

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
(both required non-empty strings; invalid configuration fails synchronously).
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
npm test          # 23 Node unit suites (no internet, no browser)
npm run build     # bundles the standalone host page (dist/tests/runtime-host.html)
npm run test:e2e  # 8 browser gates (real Chrome; real pinned Python CDN downloads)
```

Browser gates need headless Chrome (auto-located, or `CHROME=/path/to/chrome`).
The Python gates download the REAL pinned Pyodide set from the jsDelivr CDN
(SHA-256-pinned, budget-bounded) except the bootstrap-integrity and
plugin-runtime suites, which serve synthetic verified bytes locally.
No model, model key or paid API is ever contacted.

Layout: `src/index.js` (public entry) · `src/{workspace,vfs,network,shell}.js`
(implementation modules) · `src/worker-assets.js` (shipped worker sources) ·
`docs/` (extraction design, provenance, coverage map, verification) ·
`tests/` (unit suites + browser gates + the standalone host page).

## License

Apache-2.0. See [LICENSE](LICENSE).
