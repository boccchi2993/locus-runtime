# M3a verification record — Runtime repository extraction

Status: M3a deliverable. Extraction candidate branch `refactor/extract-runtime`
@ `0129c55` (this record's evidence covers commits `5918fe8` + `0129c55` over
the minimal `main` @ `5bedeeb`). Source baseline:
`boccchi2993/Locus-browser-agent-runtime` @ `2aec76e78431382873be1db8a6db6310cc89c782`
(branch `refactor/repository-split-m2c`, head of OPEN PR #7, base
`refactor/repository-split-m2b` — verified via the GitHub API at extraction
start; no product branch rewritten, no PR merged). Companion documents:
[EXTRACTION-PLAN.md](EXTRACTION-PLAN.md) (per-file map, deletions, API deltas),
[TEST-COVERAGE-MAP.md](TEST-COVERAGE-MAP.md) (per-suite migration mapping),
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

All original failing outputs were captured in-session and are characterized
above; none led to a weakened assertion — every fix is in migrated test
driver code or in the loading model.

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

- **CI workflow is designed and committed but its first GitHub-Actions run
  happens on the extraction PR.** All recorded evidence above is
  Windows-local. The workflow's browser jobs require Chrome on the runner
  (ubuntu-latest provides it); the consumer job re-assembles the harness
  from `tools/consumer-e2e/` and installs ONLY the tarball.
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
