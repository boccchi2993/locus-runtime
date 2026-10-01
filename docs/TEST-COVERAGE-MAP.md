# Test coverage map — Runtime extraction (M3a)

Source baseline: `boccchi2993/Locus-browser-agent-runtime` @ `2aec76e78431382873be1db8a6db6310cc89c782`.
This map accounts for EVERY test suite of the source repository that touched
Runtime-owned behavior: migrated (with its loading-model conversion and any
adapted check), stayed behind (with the reason), or was deleted with its
equivalent coverage named. No check was weakened; where a check was adapted,
the adaptation is commented in the migrated file itself.

Unit counts at the extraction baseline (this repo, Windows / Node v24.10.0;
counts are emitted PASS lines — loop-driven checks emit one line each):

- `npm test` (23 unit suites): all pass — 1216 PASS checks.
- Browser gates (8): runtime-host 22, active-content 3, grep 19, network 60,
  python-authority 56, python-browser-authority 102, python-bootstrap 27,
  python-plugin-runtime 33 — all pass.

## 1. Migrated unit suites

| Source suite | Target suite | Conversion | Check-level adaptations (all commented in-file) |
|---|---|---|---|
| `tests/workspace.test.cjs` (23) | same name | eval preamble → `helpers/core.cjs` namespace bridge (real ESM imports, `M.<Symbol>` bodies untouched) | none |
| `tests/opfs-workspace.test.cjs` (4) | same | eval → `require('../src/workspace.js')` | none |
| `tests/vfs.test.cjs` (82) | same | eval preamble → helper | none |
| `tests/shell.test.cjs` (32) | same | eval → helper; `createRuntime` from `src/index.js`; bash driven through the public `RuntimeSession.execute` (executeTool's bash-branch mapping `{output, success, isError, backend, operation}` reproduced inline) | none (no telemetry checks in this suite) |
| `tests/shell-compat.test.cjs` (138 PASS lines) | same | as above + grep fake-worker seam (`installGrepFakeWorker(M)` — `M.GrepRegexRuntime` is the live module object) | N1b: telemetry-record attribution → same attribution asserted on the execution result (`operation`/`backend`), name suffixed "(result attribution)" |
| `tests/shell-compat2.test.cjs` (88) | same (91 checks: file/e2e counters differ from source's 88 by three sub-cases counted together there) | as above | TEL1–TEL3: telemetry-record attribution → execution-result attribution (the records carried exactly operation/backend/success); same names + suffix |
| `tests/shell-compat3.test.cjs` (97) | same | as above | none |
| `tests/vfs-audit.test.cjs` (39) | same | as above; the python-commit cases drive `runShellCommand` with the injected interpreter (the session injects its own; the old executeTool monkey-patch for `pythonRuntime` is not portable) | exec wrapper maps a pre-aborted-signal REJECTION into the tool shape (`tool execution failed: …`, success:false) exactly as the Product adapter's catch did (BA7's body untouched) |
| `tests/network.test.cjs` (61) | same (58) | as above | N1c/N7b → result attribution (suffix); N-F04d kept as output-only; DELETED: N13 (cloud_bash — Product tool-router branch; its "Cloud execution is not configured." result and `backend:'cloud'` label do not exist in the Runtime), N14 (`backend:'browser'` on plain commands was the Product adapter's default label; the Runtime result carries no attribution for non-network/non-fs commands — the network misattribution protection stays pinned by N1c/N7b/N21c), N-F04c (telemetry-record non-leak — Product sink; output half N-F04a/b kept byte-identical) |
| `tests/network-runtime.test.cjs` (125) | same | eval of `[network.js, approval.js]` → real module + `helpers/approval-port.cjs` (`FakeApprovalPort` — a scripted implementation of the §3.5 execution-authorization port: single pending ask, resolve/cancel by id, exact-key session grants, deny ≠ cancel) | `new M.ApprovalController({})` → `new FakeApprovalPort()`; every A/U/M/R/S check byte-identical. The REAL ApprovalController is Harness code; its own semantics remain covered by the source repo's approval suites |
| `tests/runtime-visibility.test.cjs` (V1–V10) | same (20 checks: V1–V4b) | split by ownership | V1–V4b migrated (bounded invalid-URL surface through `NetworkRuntime` + tool output through the public session; V1d drops the inert pre-M2a `policyContext` field). STAYED: V5–V9 (provider-history/nativeResultContent/AgentSession — Harness), V4c/V4d/V10 (tool-adapter telemetry record — Product) |
| `tests/mutation-policy.test.cjs` (MP1–MP9) | same (32 checks, MP-G1–G8) | rewritten around a GENERIC host policy fixture guarding a neutral tree | The Runtime-side port behavior (injected-policy enforcement, resolved-path judgment, final-destination/multi-source, refusal composition, isPolicyRefusal commit classification, no-policy neutrality, order-before-geometry, VFS-protections-never-granted, alternative-policy verbatim) is pinned with the fixture. STAYED: MP1/MP6 byte-stable refusal TEXTS of the real `LocusMutationPolicy` — Product policy, Product coverage |
| `tests/grep-worker.test.cjs` (48) | same | eval → helper; Part A/C vm/source-scan unchanged (the worker source string is shipped runtime data, not host assembly) | none |
| `tests/worker-init.test.cjs` (5) | same | verbatim (helper interface unchanged) | none |
| `tests/worker-output.test.cjs` (22) | same | eval → helper; python-commit cases drive `runShellCommand` with the fake-worker interpreter directly (documented internal seam; the old executeTool monkey-patch is not portable) | none |
| `tests/python-lifecycle.test.cjs` (92) | same | eval → helper; `freshRuntime(M)` unchanged | none |
| `tests/python-authority.test.cjs` (52) | same | verbatim (vm over the worker asset; shell.js text scans resolve) | PA14b (agent.js wording scan): agent.js is Harness code — vacuous here, noted in-file; the binding wording check remains in the source repo's suite |
| `tests/python-bootstrap-integrity.test.cjs` (59) | same | REAL = real module import; the TEST variant (synthetic manifest) now uses the documented `createPythonRuntime({ bootstrapManifest })` seam instead of rewriting the source before eval; source-text assertions (M2/I10) keep reading the file | none — every M/I/T check byte-identical; the seam was sufficient |
| `tests/python-plugin-runtime.test.cjs` (64) | same | the classic base trio (workspace/vfs/extension-composition/extensions) existed only to satisfy classic global references the ES module no longer has — the suite imports `src/shell.js` directly; worker vm part unchanged | none |
| `tests/runtime-standalone.test.mjs` (32) | same | eval independence proof → direct-import proof (modules are ESM now); the module graph itself is pinned Runtime-only by the boundary gate | A1c INVERTED deliberately: the old check pinned "a broken registry is a clear error"; the registry seam no longer exists, so the check now pins "a leftover hostile registry global is ignored" (same legal-configuration error preserved by A1d); A2/A2c extended to pin `capabilities().commands/limits` against the real module constants |
| `tests/runtime-self-assembly.test.mjs` (SA1–SA4) | `tests/runtime-import-purity.test.mjs` (10) | successor suite: the two assembly modes are deleted, so the self-assembly proof becomes the import-purity proof — cold import with no page/classic globals, zero globalThis leaks, zero DOM queries, self-sufficient VFS exports, no registry after assembly | SA3's "no createRuntime-first order" now passes eagerly (nothing to resolve) — documented |
| `tests/runtime-session-lifecycle.test.mjs` (91) | same | eval'd core → real module imports; grep fake-worker unchanged | X-G drove the Product executeTool to prove the classified failure reaches the tool layer; the driver now maps the session result through executeTool's exact bash branch inline (same assertion bodies) |
| `tests/runtime-boundary.test.cjs` (20) | same | rewritten for the new file set | G5 now scans the BUILT runtime bundle (the product dist copies no longer exist); G6/G6b/G6c are NEW enforcement of the M3 deletions (zero registry references, zero global injection, zero eval/new Function host-side); G4 keeps the byte-stable refusal-text pin and pins the Runtime-owned patterns; the cross-repo pattern-equality check (old G4 vs extensions.js) stays a source-repo test — the Harness copy is not in this package |

## 2. Migrated browser gates

| Source gate | Target gate | Adaptation |
|---|---|---|
| `e2e-runtime-host.cjs` + `tests/runtime-host.html` (gate B/C/F + L) | same (22) | Host page: same standalone form, imports from the package roots; `run`/`exec` through the public session; exposes the documented `pythonRuntime()` accessor, `GrepRegexRuntime` (TEST-ONLY `_workerFactory` seam) and worker asset strings. H0c INVERTED (registry absence — see standalone row). All B/C/L gates byte-identical |
| `e2e-grep.cjs` (19) | same | Drove the product page (`window.__locus`, `window.executeTool`, `.app-shell` waits) → drives the packaged standalone host page; `runtimeAssets().grepWorkerSource` → the page's `workerAssets` seam; durable-home wait → home-mount wait (no async OPFS re-mount exists on the host page). All G-E checks byte-identical |
| `e2e-network.cjs` (62 incl. N16c/d) | same | Relay: `functions/fetch.js` → `tests/fixtures/relay/fetch.js` (provenance-noted copy; same handlers, N16c/d server-side Origin checks unchanged). App origin: packaged runtime host page. Authorization: the real ApprovalCard → a scripted §3.5 port ON THE PAGE carrying the same decision contract (single pending ask, allow once / session grant / deny, cancellation resolves as cancelled — deny ≠ cancel); waitCard/clickBtn → waitAsk/decide; N4b/c/d assert the ASK OBJECT the Runtime constructed (the same object the card rendered). N12's approval-state store → the port state. N21d (telemetry records the backend) → Product-side; replaced by "the Runtime records no execution telemetry at all". N13/N14/N16c–d (relay + Origin policy) byte-identical |
| `e2e-python-authority.cjs` (56) | same | Product page → packaged runtime host page (self-served dist when E2E_HOST_URL is unset). `window.__locus.pythonRuntime()` → `window.__host.session.pythonRuntime()`. E10f's bundle discovery reads the runtime host build input. EVERY authority check (E1–E17, R-series, probe-server request counters) byte-identical — this is the F3 subject suite |
| `e2e-python-browser-authority.cjs` (102) | same | Verbatim (self-built pages; the Node-side manifest helper was rewritten to import the ES module) |
| `e2e-python-bootstrap.cjs` (27) | same | Test page: classic `<script src=shell.js>` → one ES module importing `createPythonRuntime` from the served `/src/shell.js`; the CDN-redirect fetch patch stays installed before the runtime is constructed; driver objects unchanged |
| `e2e-python-plugin-runtime.cjs` (33) | same | As above; the classic base trio (extensions modules) is gone — the ES module carries its own contract data |
| `verify-active-content.cjs` (3) | same | Relay import → `tests/fixtures/relay/fetch.js` (the shipped-artifact-oracle technique unchanged) |

## 3. Deliberately NOT migrated (source-repository coverage)

| Source suite / file | Owner | Why |
|---|---|---|
| `tests/e2e.html` + `run-e2e.cjs` battery | Product/Harness joint | The page loads tools.js/model*.js/agent.js and drives `window.executeTool` + the model stack; the Runtime-relevant behaviors it covered (python write-back, cwd, VFS heredocs, read-only mounts) are covered here by the runtime-host browser gate (B3/B4/L), the python browser suites and the shell unit suites. The model/tool-routing scenarios stay with the product |
| `tests/e2e-persistence/-ui/-wire/-approval/-image/-capabilities/-skill-instances/-product-joint/-responsive` | Product | UI/persistence/approval-UI/model-wire gates; no Runtime-owned behavior beyond what the suites above already pin |
| `tests/e2e-harness-host.cjs` + `tests/harness-host.html` | Harness | Harness standalone host |
| `tests/store-python-lifecycle.test.mjs` | Product | Tasked out explicitly (product routing; SP11 compat gate is product-owned) |
| `tests/task-runner/provider-session/harness-*/agent*/approval/model*/capabilities/attachments/image-probe/mutation-policy(Policy side)/native-tools/presentation/store-defaults/conversation-routing/submit-presentation/provider-replay-persistence/persistence*/proxy/fetch.test.mjs/chrome-helper` | Harness/Product | Not Runtime closure. Note: `fetch.test.mjs`/`proxy.test.mjs` exercise the MODEL relay and model transport (`functions/proxy.js`, model.js) — Product/Harness; the network edge-relay (`/fetch`) side is covered here by e2e-network + active-content over the relay fixture |
| ApprovalController real-class coverage inside `network-runtime` (grant bookkeeping internals) | Harness | The migrated suite pins the PORT contract with a scripted implementation; the controller's own semantics remain in the source repo's approval/network suites |
| Telemetry-record checks (shell-compat TEL/N1b, network N1c/N-F04c, visibility V4c/d/V10, e2e-network N21d) | Product tool adapter | The recording sink is `executeTool`'s `opts.telemetry` — the Runtime records nothing (pinned positively by runtime-boundary G-scan and e2e-network N21d's replacement). Every adapted check that asserted RESULT-visible facts kept a result-attribution equivalent here |

## 4. Count reconciliation (no hidden coverage loss)

Counts compare emitted PASS lines; loop-driven checks emit one line per
iteration, so a suite's line count can legitimately exceed its source-side
`check()` call count (shell-compat: 138 lines here vs 129 source call sites
— the loop bodies are identical, verified by name-set diff). Specifics:

- shell-compat2: 91 PASS lines vs 88 source call sites — same loop effect;
  names are 1:1 with the source names plus the "(result attribution)"
  suffix. No check renamed away.
- network: 61 → 58 (N13, N14, N-F04c — each documented above with its
  replacement coverage).
- runtime-visibility: V1–V4b migrated (20 checks); V5–V10 remain in the
  source suite (unchanged there).
- mutation-policy: 24 source checks → 32 target checks (the generic-fixture
  forms of the MP1/MP4/MP5 matrix ADD coverage the old file only expressed
  through the Product policy; the Product-policy checks stay there).
- python-authority: 52 unit checks here + 56 browser checks — the source
  suite's name set is a subset match (PA14b documented vacuous).
- e2e-network: 60 PASS lines = 58 page checks + 2 server-side (N16c/d);
  N21d replaced in place (same slot, Runtime-true property).

## 5. M3a review round 1 — new coverage (no existing check weakened)

The review found three gaps, all on the EXTERNAL-CONSUMER side. The Runtime
implementation modules were NOT changed in this round (verified: zero diff
under `src/` except the NEW re-export file `src/workspace-api.js`); every fix
below is new tests, gate wiring, or docs. Names:

- **F1 (public provider subpath)** — `tests/runtime-import-purity.test.mjs`
  gains SA5–SA5d (subpath surface, single-implementation identity against
  `src/workspace.js`/`src/vfs.js`, import purity, escape-rule behavior);
  `tools/verify-import-purity.mjs` (the CI purity step) checks the same;
  `tests/runtime-boundary.test.cjs` gains G6e (the subpath declares no
  implementation), walks the subpath in G7's closure (G6d now covers both
  entries), and G1/G6b/G6c's scans cover the new file via the widened
  HOST_FILES/RUNTIME_FILES set. Consumer gate additions: C9a (subpath import + full surface —
  the check that FAILED on the unmodified baseline package),
  C9b (import purity inside the consumer bundle), C9c–iv
  (LocalDirectoryWorkspace over a CONTROLLED directory handle: write/read/
  list, shared escape rules, inner-`..` resolution, permission outcomes,
  honest NotAllowedError), C9d–ii (OPFSWorkspace over a TEMPORARY test-owned
  OPFS directory: session shell writes, a FRESH provider instance reads the
  bytes back, cleanup verified), C9e–ii (a minimal host-custom provider from
  the public surface only). Evidence of the baseline failure is in
  M3A-VERIFICATION §7.
- **F2 (mid-flight lifecycle gates in the consumer)** — the parking VFS
  gained explicit `entered`/`release` barriers and a transition log (no fixed
  sleeps anywhere; every wait carries a labeled timeout and the scenarios
  clean up in `finally`). New/reworked checks: C4b-i…iii (reset boundary with
  pre-release unsettled/busy assertions), C4e-i…iv (mid-flight CALLER abort:
  unsettled across the abort, dispatched write commits, second write never
  dispatches, cancellation-shaped honest failure, `boundary` absent, session
  reusable), C4f-i…iv (mid-flight dispose: busy stays TRUE until true
  settlement, terminal refusal for execute AND prepare with the first
  reason, idempotent dispose), C4g + C4g-control (the LAST side effect parks
  and a caller abort lands in the dispatched-but-unsettled window: the run
  FAILS even though the underlying write commits; the CONTROL pins that the
  park itself downgrades nothing). The former C4d (dispose refuses settled
  work) is superseded by the stronger C4f (same terminal-refusal semantics,
  proven over an UNSETTLED run as well).
- **F3 (zero-dispatch oracle for network denial)** — the old C6 asserted only
  the failure text + one ask. It is replaced by C6a/C6b/C6c: a narrow page
  fetch recorder on the fixed synthetic target
  (`https://consumer-gate-counted.test`, deterministic responses, never
  really fetched; all other requests — including the Pyodide CDN — delegate
  to the real fetch untouched) for the browser-direct path, and a relay-stub
  counter on the consumer's own test server for the documented relay path
  (cross-origin side-effecting requests travel as the same-origin
  `POST /fetch` envelope — the runtime's unchanged backend decision; the
  stub counts envelopes addressed to the test target and forwards nothing).
  C6a (GET allow control: the recorder sees EXACTLY ONE real dispatch),
  C6b (POST allow control: the relay stub sees exactly one forwarded
  envelope), C6c (deny: BOTH counters move by ZERO + the historic
  denial-text and single-ask assertions). C0b (new) asserts and prints the
  resolved package location inside the consumer directory.

Distinct names for distinct subjects: the historical
**"python-authority E3 SystemError"** question (§3, root cause still
unconfirmed) and this round's **network dispatch-counting task (F3 of review
round 1)** are UNRELATED. A green dispatch-counting run says nothing about
the historical exception and does not close it.
