# M3a verification record — Runtime repository extraction

Status: M3a deliverable + review round 1 + review round 2. Extraction
candidate branch `refactor/extract-runtime` @ `0129c55` (§1–§6 record the
extraction-round evidence: commits `5918fe8` + `0129c55` over the minimal
`main` @ `5bedeeb`). §7 records REVIEW ROUND 1 (the public-provider-subpath,
consumer-lifecycle and network-dispatch-oracle round) — its evidence covers
this round's own commits on top. §8 records REVIEW ROUND 2 (mid-flight
observation timing, dispose re-query, fault-injection self-verification)
over the round baseline `9863607b79b32cc209847430244c70036ab3665a`. Source
baseline: `boccchi2993/Locus-browser-agent-runtime` @
`2aec76e78431382873be1db8a6db6310cc89c782`
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

## 8. Review round 2 — mid-flight observation timing, dispose re-query, fault-injection self-verification

Scope of the round: exactly the two review findings on the consumer gate's
ASSERTION POWER (gap A: boundary-window observations were read too early;
gap B: the second dispose's effect on refusal reasons was never
re-queried). **The Runtime implementation modules were NOT changed** —
`git diff 9863607b79b32cc209847430244c70036ab3665a..HEAD -- src/` is empty
(re-verified after the round's commits), and no RuntimeSession lifecycle
defect was found or is claimed fixed: the known problems were test
observation timing, and the real implementation passes all strengthened
checks. Round baseline: head `9863607b79b32cc209847430244c70036ab3665a`
of OPEN PR #1 (base `main` @ `5bedeeb`, state verified via the GitHub API
at round start); the round appends two commits — no history rewrite, no
merge, no touching of the source Locus repository or any product
worktree. Working checkout: `C:/Users/hua/Desktop/文档/Locus-runtime-m3a`;
consumer assembly: `C:/Users/hua/Desktop/文档/Locus-runtime-consumer-m3a-r2`
(a directory OUTSIDE the checkout, fresh for this round).

### 8.1 The two blind spots (both test-side)

1. **Gap A — boundary-window observations happened too early.** All three
   mid-flight scenarios (C4b reset, C4e caller abort, C4f dispose) read
   the post-boundary state SYNCHRONOUSLY in the same call stack as the
   boundary call (`busyAfterAbort`-style reads) and read `settled` only
   BEFORE the boundary. An implementation that released the busy seat or
   settled the run one MICROTASK after the boundary would have passed
   every round-1 check. The review demonstrated this with a controlled
   fault injection: public `status()` misreporting `busyExecutions: 0`
   one microtask after the caller abort — all round-1 C4e observations
   stayed green.
2. **Gap B — the second dispose was never re-queried.** Round-1 C4f-iv
   captured `executeRejection`/`prepareRejection` AFTER the FIRST dispose
   but BEFORE `dispose('second dispose call')`, then asserted "the first
   reason is kept" from those CACHED values. A second dispose that
   clobbered subsequent refusal reasons would have been invisible.

### 8.2 The fix — assertion timing and location (test code only)

- `tools/consumer-e2e/index.html` gains `schedulingTurnBarrier()`: ONE
  MessageChannel macrotask awaited between the boundary and the
  pre-release reads (both ports closed on resolve; the labeled 5 s
  timeout guards a broken channel only — it is not a timing assumption).
  When it resolves, every promise reaction and queueMicrotask the
  boundary could have scheduled HAS RUN while the provider release stays
  closed. No fixed sleep anywhere.
- All three scenarios now observe, in order: `entered` → pre-boundary
  state → boundary → same-stack read (`busyAfterBoundarySync`, kept ONLY
  as the recorded round-1 contrast — no check is load-bearing on it) →
  scheduling turn → PRE-RELEASE state (`settledBeforeRelease`,
  `busyBeforeRelease`, `parkedWriteCommittedBeforeRelease`,
  `secondWriteDispatchedBeforeRelease`) → `release()` → true settlement →
  finals. Every wait keeps its labeled timeout; cleanup stays in
  `finally` (settle the park, retire the session).
- `scenarioMidFlightDispose` additionally performs the SECOND dispose and
  then FRESH `execute`/`prepare` calls, recording
  `executeRejection2`/`prepareRejection2`/`secondDisposeError`/
  `busyAfterSecondDispose`/`dispatchesAfterSecondDispose`. The cached
  first-dispose rejections are still recorded (honest observations of the
  FIRST dispose) but no longer carry the "forever/idempotent" claim.
- The C4b/C4e/C4f check bodies moved into the NEW shared module
  `tools/consumer-e2e/lifecycle-contract.cjs`, used by BOTH the gate and
  the self-verification — one source of truth, the two cannot drift.
  Strengthened checks: C4b-i/C4e-i assert `settledBeforeRelease === false`
  and `busyBeforeRelease === 1` ACROSS the scheduling turn, BEFORE
  release; C4b-ii/C4e-ii/C4f-ii additionally assert nothing commits and
  nothing else dispatches between boundary and release (then the honest
  finals after release); C4f-v is NEW (after the second dispose, FRESH
  rejections keep the FIRST reason, never 'second dispose call'; the
  second dispose does not throw; busy stays 0; nothing new dispatches).
  C4e-iii/C4e-iv/C4b-iii/C4f-iii keep their round-1 bodies; C4f-iv is
  narrowed to its honest claim (the FIRST dispose's refusals).
- CI: the consumer job copies `lifecycle-contract.cjs` into the
  RUNNER_TEMP consumer directory (it is now necessary gate
  infrastructure). Everything else in the job is unchanged — the consumer
  is still assembled under `${{ runner.temp }}` and installs ONLY the
  tarball + its own vite.

### 8.3 The proof — controlled fault injection (test wrappers only)

`tools/consumer-e2e/selfcheck-faults.cjs` runs in the SAME assembled
consumer directory, same tarball, same built page as the normal gate. The
only extra piece is the page-side `wrapSessionFault` (index.html,
self-verification section): it wraps ONLY the public session surface for
one scenario run — no product switch, no internal test entry, no copied
execution algorithm — and the normal gate never constructs a wrapper.
Each proof asserts three things: the OLD judgment set stays green under
the fault (the old gate was blind), the fault is really visible to the
new observation, and the STRENGTHENED set fails exactly at the designated
check. A no-fault CONTROL (both scenarios) shows the REAL implementation
passing BOTH judgment sets in the same harness.

| Proof | Fault (wrapper behavior) | Old (round-1) judgment set | New (round-2) judgment set |
|---|---|---|---|
| A1 early busy-release | one microtask after the caller abort, public `status()` misreports `busyExecutions: 0`; the real execution keeps waiting at the provider barrier | ALL GREEN — the old gate could not see it | C4e-i FAILS (`busyBeforeRelease === 0`); every other check stays green (surgical) |
| A2 early settle | one microtask after the caller abort, the caller-visible promise resolves cancellation-shaped while the real write stays parked; `status()` stays honest | the same-stack C4e-i entry stays green (later legacy finals are RECORDED but not required — the real run settles concurrently with the probe) | C4e-i FAILS on `settledBeforeRelease === true` with `busyBeforeRelease === 1` — the settled assertion has teeth beyond the busy one |
| B dispose reason override | after the SECOND dispose call, fresh execute/prepare refusals are overridden with the second reason | ALL GREEN — the cached rejections predate the second dispose | C4f-v FAILS (fresh rejections carry the second reason); every other check stays green (surgical) |

Result on the final code (headless Chrome, full log
`selfcheck-results.log` in the consumer directory): **16/16 PASS** —
4 CONTROL, 4 A1, 3 A2 (+1 recorded note line), 4 B, 1 hygiene (zero
unhandled page errors across control + fault runs). One defect in the
SELF-CHECK HARNESS itself was found and fixed during the round: the first
fault-B wrapper hooked a synchronous throw, but the disposed session
surfaces its refusal as a REJECTED promise, so the override never fired
and the first B run honestly showed the fault NOT taking effect; the
wrapper now hooks the rejection. The faults prove the OLD assertions
blind — they are NOT evidence of a Runtime defect (see the CONTROL line
and the normal gate below).

### 8.4 Gates actually executed this round

| Gate | Result |
|---|---|
| `npm run build` + boundary gate + import purity (sanity) | build OK; boundary **22/22**; purity OK |
| `tests/runtime-session-lifecycle.test.mjs` (existing suite, unchanged) | **91/91** |
| Out-of-repo consumer gate, round-2 assembly: `npm pack` → fresh consumer directory OUTSIDE the checkout → tarball install → the consumer's OWN vite build → headless Chrome over the public exports | **40/40** (`consumer-gate-results.log`): C0/C0b, C1, C5/C5b, C6a/b/c, C4a, C4b-i…iii, C4e-i…iv, C4f-i…**v**, C4g + control, C2/b (REAL pinned-CDN Python boot), C3, C9a…C9e-ii, C8 — the strengthened C4b/C4e/C4f bodies (from the shared judgment module) execute here against the REAL implementation |
| Fault-injection self-verification (same consumer directory) | **16/16** (`selfcheck-results.log`) |

Check-count delta 39 → 40 is the new C4f-v; no round-1 check was renamed
away and no condition dropped — the C4b/C4e/C4f slots kept their names
with sharper conditions.

### 8.5 Executed this round vs. carried forward

- Actually executed this round: everything in §8.4 (plus the round's own
  first B run that exposed the harness defect, §8.3).
- NOT re-run locally (the implementation modules are byte-identical to
  the round baseline; rationale as in §7.3): the other seven browser
  suites and the unit suites beyond the lifecycle one. CI re-runs the
  full set on the pushed head.
- The historical **python-authority E3 SystemError** question stays OPEN
  and untouched (§3; root cause NOT confirmed — unchanged). This round's
  subject is test assertion power; its green runs say nothing about E3
  and must not be read as its resolution.

### 8.6 Unverified scope / honest boundary of this round

- The fault wrappers ran only in this round's local self-verification; CI
  runs the normal gate (with the shared judgment module copied into the
  consumer) but does NOT execute the self-check. The self-check is
  reproducible from the pushed tree: assemble a consumer directory (as
  the CI job does), then `node selfcheck-faults.cjs`.
- The self-check's A2 proof requires only the same-stack legacy entry to
  stay green; the remaining legacy entries are recorded without a
  pass/fail requirement (their outcome depends on how the real run's
  concurrent settlement interleaves with the probe — at best the old gate
  saw a LATE busy anomaly there, never the boundary-window settlement).
- Consumer isolation properties are unchanged from round 1 (§7.6/§7.7):
  assembly under RUNNER_TEMP, tarball-only install, C0/C0b oracle. This
  round's local consumer run is a sibling directory, as before; CI on the
  pushed head is the ubuntu-latest evidence for the updated job.
- No model, paid API or real relay is contacted. REAL network this round:
  only the consumer gate's pre-existing Python bootstrap download from
  the pinned jsDelivr CDN (recorded, as before). The self-check downloads
  nothing (no Python boots; the synthetic network target is never really
  fetched).
- Nothing in this round changed `src/`, and nothing in it should be read
  as a Runtime lifecycle fix; PR #1 remains OPEN, unmerged.

## 9. Review round 2 closeout — consume the dispose settlement observation

Baseline: `9fbeac730a9c38f53ae5d98b4e9e2519c9c34e7e`.
`scenarioMidFlightDispose` already returned `settledBeforeRelease`, but
the shared `disposeChecks` C4f-i omitted it. It now requires that value
to be exactly `false` and includes it in failure details. No `src/`
implementation changed.

The browser self-check now takes the real, passing dispose control and
changes only its observed `settledBeforeRelease` to `true`. Exactly C4f-i
must reject that observation. This is a judgment-sensitivity test, not a
claim that the real Runtime settled early. The normal consumer gate uses
the same strengthened judgment with unmodified real observations.

Actual closeout validation: the page's three lifecycle scenarios were run
under Node with minimal browser-global stubs, real Runtime imports and
MessageChannel scheduling; all normal shared judgments passed. Changing
only the dispose settlement observation was accepted before this fix and
is now rejected only by C4f-i. The existing early-busy, early-settlement
and second-dispose-reason fault observations still fail their designated
checks. `runtime-session-lifecycle` passed 91/91; JavaScript syntax and
`git diff --check` passed. `git diff -- src/` is empty.

Local limitation: no Chrome executable was available, so this closeout
did not locally rerun the packaged browser consumer or browser self-check.
The pushed commit triggers the existing CI consumer/browser gates; their
status is recorded in the PR separately rather than predicted here.
Historical Python E3 SystemError remains root-cause unconfirmed.
