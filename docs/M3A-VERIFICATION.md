# M3a verification record — Runtime repository extraction

Status: M3a deliverable + review round 1. Extraction candidate branch
`refactor/extract-runtime` @ `0129c55` (§1–§6 record the extraction-round
evidence: commits `5918fe8` + `0129c55` over the minimal `main` @ `5bedeeb`).
§7 records REVIEW ROUND 1 (the public-provider-subpath, consumer-lifecycle
and network-dispatch-oracle round) — its evidence covers this round's own
commits on top. Source baseline:
`boccchi2993/Locus-browser-agent-runtime` @ `2aec76e78431382873be1db8a6db6310cc89c782`
(branch `refactor/repository-split-m2c`, head of OPEN PR #7, base
`refactor/repository-split-m2b` — verified via the GitHub API at extraction
start; no product branch rewritten, no PR merged). Companion documents:
[EXTRACTION-PLAN.md](EXTRACTION-PLAN.md) (per-file map incl. source blobs,
deletions, API deltas, §1b call audit),
[TEST-COVERAGE-MAP.md](TEST-COVERAGE-MAP.md) (per-suite migration mapping +
review-round additions §5),
[PROVENANCE.md](PROVENANCE.md) (license/third-party/dual-implementation).

Environment: Windows 10, Git Bash, Node v24.10.0, npm 11.6.1, headless
Chrome (CDP, each suite's own launch; CHROME auto-located at
`C:/Program Files/Google/Chrome/Application/chrome.exe`, v154). Target
checkout: `C:/Users/hua/Desktop/文档/Locus-runtime-m3a` (an independent
repository — NOT a worktree of the product repo; the product worktrees were
not touched).

## 1. Gates

| Gate | Command | Result |
|---|---|---|
| Clean install | `npm ci` (in the pushed-branch clone) | exit 0, lockfile clean |
| Unit gate | `npm test` (after build) | **23/23 suites, 1216 PASS checks**, exit 0 (both in the working checkout and the clean clone) |
| Import purity | `node tools/verify-import-purity.mjs` | OK — zero globalThis leaks, no `__LOCUS_RUNTIME_CORE__`, `shellCommandNames` = 17 |
| Build | `npm run build` | exit 0; `dist/tests/runtime-host.html` + `assets/runtimeHost-*.js` (147.21 kB) |
| Boundary gate | `node tests/runtime-boundary.test.cjs` | 20/20 (over sources AND the built bundle) |
| Pack + content check | `npm pack` | 101,471 bytes; contents EXACTLY `package/src/**`, `package/LICENSE`, `package/README.md`, `package/package.json` — no tests, no dist, no tmp logs, no keys, no Product/Harness files |
| Browser: runtime host | `e2e-runtime-host.cjs` (packaged page, vite preview) | **22/22** — H0b/c pure-module host (zero classic scripts, registry absent), B1 cold-load zero CDN fetches, B2 shell stays cold, B3 real grep worker + timeout kill, B4 REAL Python + VFS write-back, B5 status events, C two-session isolation, L live boundary semantics |
| Browser: grep | `e2e-grep.cjs` (packaged host page) | **19/19** — worker isolation, heartbeat, hard timeout, cancellation, fail-closed, semantics |
| Browser: network | `e2e-network.cjs` (self-contained; REAL relay fixture + target servers) | **60/60 PASS lines, exit 0** — direct/relay routing, 404 authoritative, approval allow/deny/session-grant/cancel-TOCTOU over the scripted port, once-only dispatch, binary `-o` byte-exact, response caps, private/mapped-IPv6 blocks, redirect credential stripping, secret redaction, N16c/d evil-Origin relay refusals (server-side, real handler) |
| Browser: python authority (F3 subject) | `e2e-python-authority.cjs` (packaged host page, real Pyodide, probe-server request counters) | **56/56, exit 0** — see §3 (F3) |
| Browser: python browser authority | `e2e-python-browser-authority.cjs` | **102/102** — CSP boundary model + in-memory bootstrap (REAL jsDelivr download, SHA-256-pinned) |
| Browser: bootstrap integrity | `e2e-python-bootstrap.cjs` (local synthetic-byte asset server) | **27/27** — hosted + file:// verified acquisition, corrupt/stall/silent faults, verified-cache rebuild zero-network |
| Browser: plugin runtime | `e2e-python-plugin-runtime.cjs` | **33/33** — offline wheel install, integrity adversarials, crash/reset recovery |
| Browser: active content | `verify-active-content.cjs` (relay fixture) | **3/3** — control exfiltrates, real handler neutralizes |
| Out-of-repo consumer | `consumer-gate.cjs` in `../Locus-runtime-consumer-m3a` (a directory OUTSIDE this checkout; installs ONLY the packed tarball + its own vite; imports ONLY `locus-runtime` and `locus-runtime/worker-assets`; no source path, no symlink) | **16/16** — C0 bundle has zero `file:`/absolute/sibling-source references; C1 VFS shell write/read; C2 REAL Python (real pinned CDN boot) + write-back; C3 status events cold→ready; C4a pre-aborted refusal, C4b reset boundary over a parked write (dispatched write commits, boundary reported, session reusable), C4d dispose terminal; C5 injected generic mutation policy refuses with composed reason + read-only authority never granted; C6 authorization deny → `network_denied`, one ask, zero dispatch; C7 capabilities/describeCommands/purity; C8 zero page errors |
| Clean checkout | `git clone --branch refactor/extract-runtime` of the PUSHED branch → `npm ci && npm run build && npm test` | clone @ `0129c55`; all green (see §2 for the one first-run ordering finding) |
| CI (GitHub Actions, ubuntu-latest) | first PR-branch runs of `.github/workflows/ci.yml` | **GREEN — run 36883712482** (`unit` + `build` incl. pack content check + boundary + `consumer` out-of-repo tarball gate + `browser` gates, all four jobs success; all 8 browser suites PASS on the runner, incl. python-authority and the consumer). Two first-run findings fixed before the green run, see §2 (7) |

## 2. First failures during this round — preserved, then fixed (never assertion-loosened)

1. **Clean-clone `npm test`: runtime-boundary G5 FAIL (`dist` absent)** — the
   boundary gate scans the BUILT bundle; a fresh clone has no `dist/` until
   `npm run build`. Same ordering fact as the source repo's M2c record (its
   G5 first failure). Fix: the documented gate order is
   `npm ci && npm run build && npm test` (CI's build job runs build →
   boundary; the unit job's boundary scans run in the build job). Gate strict
   — no skip-when-absent fallback was added.
2. **e2e-grep first runs "hung"** — an artifact of `| tail` pipe buffering
   plus two real bugs underneath: (a) `H.H.GrepRegexRuntime` (a doubled
   replacement), (b) `distServer` referenced from `finally` outside its
   declaration scope. Fixed in the driver; suite then 19/19.
3. **e2e-network first run: page script 185s timeout** — the scripted
   authorization port ignored `opts.signal`, so the N7 cancel-while-pending
   case never settled (the real ApprovalController resolves cancelled asks).
   The port now implements the consumer contract's cancellation semantics
   (deny ≠ cancel). Suite then 60/60.
4. **e2e-python-authority first run: E10f FAIL** — the bundle-path discovery
   still read the PRODUCT `dist/index.html`; this repo's packaged page is
   `dist/tests/runtime-host.html` with an `../assets/` reference. Fixed the
   discovery (oracle unchanged: responseStatus 0 + zero bytes = CSP-blocked).
   Suite then 56/56.
5. **Consumer gate first run: one FAIL** — a dead check line in the DRIVER
   itself (a Promise in a boolean context); the real C7 check passed. Driver
   fixed; gate then 16/16.
6. **CI run 1: unit job FAIL** — the same G5 build-ordering fact as (1);
   the workflow now builds before the unit gate (local documented order
   unchanged).
7. **CI run 2: browser job FAIL (runtime-host suite only)** — the
   orchestrator's readiness probe requested `/`, which this dist does not
   serve (there is no root index.html; the host page lives at
   `/tests/runtime-host.html`), so the probe 404-looped into its timeout
   while the server was up. The probe now requests the actual page URL
   (found on CI; 7/8 suites had already passed in that run). Run 3 green.

All original failing outputs were captured (CI logs are retained on the
runs; the local ones were captured in-session) and none led to a weakened
assertion — every fix is in migrated test driver code, the loading model,
or CI plumbing.

## 3. F3 — python-authority E3 (`SystemError: error return without exception set`)

Facts carried forward (unchanged by this round): in the SOURCE repo's M2c
sequential full-e2e run, E3/E3c failed twice with a Pyodide JS→Python
exception-bridging SystemError instead of the JsException carrying the
policy marker, while the enforcement boundary held (E3b and E16: ZERO
requests); the source-repo root cause remains NOT confirmed — the
"sequential-run load-type flake" attribution was withdrawn there, and the
named follow-up (a deterministic load-generator experiment against the
bridge) has still not been performed. No product code fix exists to regress
(the F04a stabilization was test-side only).

This round's data points (extraction):

- **Extraction standalone run (this repo, own Chrome, packaged host page):
  56/56, E3 green on the FIRST attempt — no re-observe fired** (`# E1 cold
  boot took 2s`, CDN prewarmed). Same disposition as the M2c standalone
  re-run: a data point, not a proof.
- The suite's checks moved VERBATIM (same probe-server request counters,
  same single re-observe logic, same `isPythonNetworkDenied` predicate; the
  only diffs are the page seam — packaged runtime host instead of the
  product page — and the E10f bundle-path discovery). The delta is recorded
  in TEST-COVERAGE-MAP §2.
- Nothing on the extraction path touched the worker source, the creator
  CSP, the lockdown, or the denial machinery — worker-assets.js and the
  shell.js authority code are byte-identical to the baseline modulo the
  ESM export/import frame (boundary gate G1–G7 + the browser suites are
  the evidence).

Standing conclusion: unchanged — root cause NOT confirmed; extraction adds
one more standalone green data point and narrows nothing further. The
named follow-up experiment remains open for the Runtime repository now.

## 4. Real-model / real-network disclosure

- No model requests, no model keys, no paid APIs anywhere in this round.
- REAL network (intended, recorded): the verified Pyodide bootstrap
  downloads in e2e-python-authority, e2e-python-browser-authority (~50 MB
  from jsDelivr, SHA-256-pinned), the consumer gate's real Python boot, and
  the CDN prewarm fetch in python-authority. The bootstrap-integrity and
  plugin-runtime suites use LOCAL synthetic-byte servers (zero CDN). The
  network gate's target/relay servers are all local (127.0.0.1 +
  host-resolver-rules mappings); deny cases prove zero dispatch.
- Denial-cased probe servers in python-authority received ZERO requests
  across the entire suite (E16) — the same oracle discipline as the
  baseline.

## 5. Unverified scope / honest boundary

- **CI reproducibility is now PROVEN, not just designed**: run 36883712482
  (ubuntu-latest, Node 24, runner Chrome) passes all four jobs. The
  Windows-local runs in §1 remain the primary recorded evidence; CI is the
  reproducibility proof.
- The consumer gate ran in a sibling directory of this checkout (not a
  remote machine); its isolation property is enforced by construction —
  it installs the tarball, imports only the public exports, and C0 asserts
  the consumer BUNDLE contains no source path — but a fully networked
  "install from a registry" consumption path does not exist by design
  (no publish).
- `npm ci` reproducibility uses the committed package-lock.json (vite only).
  The clean-clone gate proves the checkout is self-contained.
- Interactive human browser passes were not performed; the gates are
  deterministic CDP drivers, as in the source baseline.
- The historical full-app runtime battery (`tests/e2e.html`) and the
  product-page suites were intentionally NOT migrated (coverage map §3);
  the source repo keeps running them against its in-repo implementation.

## 6. Exit assessment

M3a's exit criterion — "a repository that installs, builds, tests, and can
be consumed from outside without Product/Harness source" — is met on the
recorded evidence: clean install/build/test on the pushed branch, the full
unit + browser gate set green on the extracted implementation, the packaged
tarball consumed by an out-of-repo browser host exercising the whole public
contract (VFS/shell, real Python, status events, cancel/reset/dispose,
policy and authorization injection), and the deleted assembly dependencies
enforced structurally. Not done by design: npm publish, deployment, PR
merge, Harness extraction, and any product-side import switch (M3c).

## 7. Review round 1 — public provider subpath, consumer lifecycle gates, network dispatch oracle

Scope of the round: the review's three findings (F1 public provider
interface, F2 external-consumer mid-flight lifecycle gates, F3 consumer
network denial counting) plus consumer CI isolation, provenance blob
columns and the development-order documentation fix. **The Runtime
implementation modules were NOT changed**: the only `src/` addition is the
NEW one-way re-export file `src/workspace-api.js` (`git diff 722fe17..HEAD --
src/index.js src/workspace.js src/vfs.js src/network.js src/shell.js
src/worker-assets.js` is empty). F2 was a verification gap, not a found
regression — the implementation semantics were already pinned by the in-repo
lifecycle suite (X-A/X-B) and now also hold through the public consumer
surface.

### 7.1 F1 — baseline failure evidence (unmodified `722fe17` tarball)

The review-round consumer checks were run against the EXISTING package
(tarball built from `722fe17`, installed into a fresh consumer directory) —
they fail exactly at the public-interface gap, before any fix:

1. `vite build` of the consumer page refuses the import:
   `[commonjs--resolver] Missing "./workspace" specifier in "locus-runtime" package` —
   the consumer cannot even build.
2. Node-side minimal repro against the installed package:
   `import('locus-runtime/workspace')` →
   `ERR_PACKAGE_PATH_NOT_EXPORTED — Package subpath './workspace' is not defined by "exports"`.
3. The root entry exposes exactly `createMemoryWorkspace, createRuntime,
   createWorkspace, shellCommandNames` — no provider symbol is reachable,
   and deep imports are blocked by the exports map.

After the fix (same checks, same consumer harness, only the tarball
re-packed): 39/39 consumer checks PASS (§7.3).

### 7.2 The published surface and its audit

Published via the new `locus-runtime/workspace` subpath
(`src/workspace-api.js`, one-way re-exports only — boundary G6e enforces
zero local implementation): `WorkspaceAdapter`, `LocalDirectoryWorkspace`,
`OPFSWorkspace`, `normalizeWorkspacePath`, `ensureWorkspacePermission`,
`vfsError`. The audit behind the exact set (source-Product callers,
ownership, and why `VirtualWorkspace` stays unpublished behind the
equivalent `createWorkspace` factory) is EXTRACTION-PLAN §1b. The
`vfsError` addition beyond the five review-named symbols is audit-driven:
`src/extensions.js` throws it five times and the providers must stay
runtime-classifiable without copying the factory.

### 7.3 Gates actually executed THIS round

| Gate | Result |
|---|---|
| `npm ci` → `npm run build` → `npm test` (Windows, local) | **23/23 suites pass** (1216 pre-existing + new SA5–SA5d checks; suite count unchanged) |
| Boundary gate `tests/runtime-boundary.test.cjs` | **22/22** (the extraction round's 20 checks + G6e "the subpath declares no implementation" + G1's scan now covering the new entry file) |
| Import purity `tools/verify-import-purity.mjs` | OK — root + workspace subpath exports, zero global leaks |
| `npm pack` content | `package/src/**` (incl. `workspace-api.js`), LICENSE, README, package.json — nothing else |
| Out-of-repo consumer gate (tarball, own vite, own Chrome; assembled in a directory OUTSIDE the checkout — the new CI isolation, rehearsed locally) | **39/39 PASS** — C0/C0b, C1, C5/b, C6a/b/c (dispatch counting), C4a, C4b-i…iii, C4e-i…iv, C4f-i…iv, C4g + control, C2/b, C3, C9a…C9e-ii, C8 |
| Browser: runtime-host (`e2e-runtime-host.cjs`, vite preview) | **22/22** — the entry-assembly surface this round's exports change could touch |
| CI (GitHub Actions) | triggered by the push; the consumer job now assembles under `RUNNER_TEMP` (see §7.6) |

Gate selection rationale: the implementation modules are byte-identical to
the extraction baseline, so the python/worker/bootstrap/network browser
specialists were NOT mechanically re-run locally (their coverage is
unchanged and CI re-runs the full set on the pushed head); the runtime-host
gate was run because it is the browser consumer of the package entry
surface.

### 7.4 First failures during this round — captured, then fixed (never assertion-loosened)

1. **Consumer gate `C0b` FAIL on the baseline run (gate's own bug)** — the
   check resolved `locus-runtime/package.json`, but an exports map that
   deliberately does not export `./package.json` (baseline AND fixed package
   alike) always throws. Fixed the ORACLE, not the package: resolve the root
   entry and derive the package root; the resolved path is printed for the
   build log and asserted to stay inside the consumer directory.
2. **`vite build` failure on the BASELINE package** — `Missing "./workspace"
   specifier`: this is the F1 defect itself, preserved as evidence (§7.1),
   fixed by the subpath export.
3. **`C6a` FAIL on the first fixed-package run (404 from the local test
   server)** — the new check assumed every dispatch is visible to a page
   `fetch` recorder. The runtime's documented backend decision routes
   cross-origin side-effecting requests through the SAME-ORIGIN
   `POST /fetch` envelope (a debug probe confirmed
   `backend: "edge-relay"`); the recorder never sees them. Fix: the oracle
   now covers BOTH dispatch paths — the page recorder for browser-direct
   (GET allow control) and a counting stub on the consumer's own test server
   for the relay envelope (POST allow control) — each with its positive
   control, deny then asserts BOTH counters move by zero. No runtime rule
   was relaxed and the stub forwards nothing anywhere.
4. **`C9b` FAIL (`newGlobals: ["0","__consumer"]`, gate's own bug)** — the
   purity probe snapshotted window keys at module top, so the driver's own
   boot-time names counted as "leaks". Fixed: the snapshot is taken
   immediately around the dynamic import (the property actually under
   test).
5. **`C9c` FAIL (`listRoot` missing `c.txt`)** — the scenario listed the
   root before writing the inner-`..` entry. Reordered; the check is
   unchanged.
6. **`npm install` kept the OLD package after swapping the tarball** — the
   consumer's lockfile pinned the first tarball's integrity. Removed
   lockfile + node_modules and reinstalled (CI assembles in a fresh
   directory and never hits this).
7. **`HEAD:src/workspace-api.js` present before commit** — the file was
   staged mid-round; verified post-commit instead. (Process note, no gate
   impact.)

### 7.5 Carried-forward results vs. this round

- Carried forward from the extraction round (§1, unchanged code — NOT
  re-executed locally this round): grep 19, network 60, python-authority 56,
  python-browser-authority 102, python-bootstrap 27, python-plugin-runtime
  33, active-content 3, and the 23-suite unit battery's pre-existing
  checks (re-run green this round — the battery IS part of §7.3's `npm
  test`).
- The historical **python-authority E3 `SystemError`** question stays OPEN
  and untouched (see §3; root cause not confirmed, follow-up experiment
  still pending). It is a DIFFERENT subject from this round's network
  dispatch-counting finding — this round's green C6a/b/c says nothing about
  it and must not be read as its resolution.

### 7.6 CI isolation + docs

- The consumer CI job now assembles the consumer under
  `${{ runner.temp }}/locus-consumer-e2e` (fixture page, generic Chrome
  driver `tests/helpers/chrome.cjs` copied as the driver, gate, tarball) and
  installs/runs there — no checkout-internal consumer directory, no
  fallback to checkout `node_modules`/`src`. The gate prints the resolved
  package location (C0b asserts it is inside the consumer's own
  `node_modules`).
- `PROVENANCE.md`'s claim that the per-file map carries source blobs is now
  TRUE: EXTRACTION-PLAN §2 has the source-blob column (real
  `git rev-parse <baseline>:<path>` values; the wheel fixture row carries
  the directory TREE sha; split/new files say so explicitly — no
  target-file hash substituted for a source blob).
- README's Development order is now `npm ci` → `npm run build` → `npm test`
  → `npm run test:e2e`, with the boundary-G5 build-artifact dependency
  stated (fail-closed, no skip-when-absent fallback).

### 7.7 Unverified scope / honest boundary of this round

- The full 8-gate browser battery was not re-run locally this round (code
  unchanged; rationale in §7.3). CI runs it on the pushed head.
- CI on the pushed head is the acceptance evidence for the new consumer-job
  isolation shape on ubuntu-latest; the local rehearsal ran on Windows.
- The consumer gate's OPFS scenario runs in a real Chrome profile — it
  creates and removes ONLY its test-named directory
  (`locus-consumer-gate-<random>`); no user storage is touched.
- No model, paid API or real relay is contacted. The synthetic test target
  is never really fetched (recorder + stub answer deterministically). REAL
  network in this round's runs: only the pre-existing consumer Python
  bootstrap download from the pinned jsDelivr CDN (recorded, as before).
