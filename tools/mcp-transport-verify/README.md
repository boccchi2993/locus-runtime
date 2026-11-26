# MCP transport verification — direct / relay × JSON / SSE

A measurement, not a gate. It answers one question in a **real Chrome**:
can the two Locus network backends carry MCP Streamable HTTP traffic — a
JSON response and a `text/event-stream` (SSE) response — today?

It exists because C3-CREDENTIALS-MCP §7 puts the phase-2 MCP client in the
runtime and names Streamable HTTP, the session id, the protocol-version
header and SSE as its transport, while at the baselines below **neither
repository contains an MCP client**: `shell.js` has no `mcp` command, and
`text/event-stream`, `mcp-session-id` and `protocol-version` occur nowhere
in locus-runtime `src/` or locus-product `src/` + `functions/`. What can be
measured is therefore the transport the client would sit on.

Nothing leaves the machine: the "MCP server" is a local stand-in
(`mcp-test-server.cjs`), the bearer is a TEST constant, and the browser is
driven over CDP on loopback.

## Result at a glance

Measured 2026-11-26 with the harness at `b529179c1642d80c985088aa948d318badb16503`
(clean tree) — evidence: [`results/2026-11-26-chrome157-win32.json`](results/2026-11-26-chrome157-win32.json).

| | runtime under test | product checkout (relay source) |
|---|---|---|
| commit | `080a6001df716b28db1d60444c49e280664a5dd2` (`origin/main`; `src/` untouched by the harness commit) | `e5a2942c030511a7c0906b3da0c7befd3f31953f` (`origin/main`) |
| file | `src/network.js`, SHA-256 `2f05ecdd…76d94` | `functions/fetch.js`, SHA-256 `7b9e64d2…b5f6a` |
| browser | Chrome/157.0.8103.79 (headless), Node v24.10.0, Windows 10.0.26200 | |

### Verdicts

Two layers are measured per combination, because the answer differs and the
fix lives in a different file for each.

| combination | platform (raw browser `fetch`) | runtime (`NetworkRuntime` + the real relay) |
|---|---|---|
| direct × JSON | **supported** | **supported** |
| direct × SSE | **supported** | **not_supported** — 3 criteria failed |
| relay × JSON | **supported** | **supported** |
| relay × SSE | **not_supported** — 3 criteria failed | **not_supported** — 3 criteria failed |

- **direct × JSON and relay × JSON work end to end**: the response for the
  request id arrives within milliseconds, the bearer reaches the upstream,
  and `MCP-Session-Id` is readable by the client.
- **direct × SSE**: the browser itself streams (the response arrives ~5 s
  before the upstream closes) and a cancel ends the read at once. Through
  `NetworkRuntime` the same response is readable only when the upstream
  closes, and a deadline shorter than the stream discards it. The gap is in
  `src/network.js`, not in the browser.
- **relay × SSE fails in the relay itself**: the response is delivered only
  when the upstream closes, a browser cancel does not close the upstream,
  and a stream held open longer than the relay's 30 s deadline is replaced
  by a 504 — the response the upstream had already sent is lost. The
  positive control (below) passes the same probes with a streaming relay,
  so this is the relay's code, not the test environment. `NetworkRuntime`
  buffers on top of that.
- **No combination was `env_unavailable` or `not_verified` in this run.**
  What was *not* verified is listed under [Not verified](#not-verified).

### The four recorded quantities, combination by combination

Times are ms after the probe started; the upstream stamps are on the same
wall clock as the browser's. The SSE stand-in sends its response event at
~300 ms and then holds the connection for 5 s.

| combination | browser receives the response | upstream closes | `MCP-Session-Id` readable | read ends after cancel |
|---|---|---|---|---|
| direct × JSON | at once (4–5 ms) | at once, by the server | yes — cross-origin **only if the server sends `Access-Control-Expose-Headers`** (`D-J2`: hidden without it) | n/a |
| direct × SSE | raw `fetch`: 306 ms, 5 s before the close. `NetworkRuntime`: only at the close (5306–5309 ms) | 5303–5308 ms, by the server (hold expiry) | yes | yes, in 0 ms — and the cancel closes the upstream (`D-S2`: 311 ms, `D-S4`: 1009 ms) |
| relay × JSON | at once (10–11 ms) | at once, by the server (7–9 ms) | yes | n/a |
| relay × SSE | only at the close (5309–5322 ms); **never** when the stream outlives the relay deadline (`R-S3`/`R-S6`: 504 / `network_timeout` at 30 s) | 5306–5320 ms, by the server — **a cancel at 1 s does not close it** (`R-S2`, `R-S5`); 30002 ms by the relay's own deadline abort (`R-S3`, `R-S6`) | yes whenever a response exists; none on the 504 | browser side: yes, in 0 ms. **Upstream: no** — the relay keeps reading until the upstream closes |

### Probes — real relay (`functions/fetch.js`)

| probe | client | mode | HTTP | browser hdr | browser resp | browser end | upstream event | upstream close | closed by | MCP-Session-Id | cancel → settled | outcome |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `D-J1` | fetch | json | 200 | 4 | 4 | 4 | — | 4 | server | readable | — | response for id 1001 received |
| `D-J2` | fetch | json | 200 | 6 | 6 | 6 | — | 5 | server | hidden | — | response for id 1002 received |
| `D-J3` | nr-direct | json | 200 | — | 5 | 5 | — | 4 | server | readable | — | response for id 1003 received |
| `D-J4` | nr-request | json | 200 | — | 5 | 5 | — | 3 | server | readable | — | response for id 1004 received |
| `D-S1` | fetch | sse | 200 | 2 | 306 | 5303 | 306 | 5303 | server | readable | — | response for id 1005 received |
| `D-S2` | fetch | sse | 200 | 3 | 310 | 311 | 309 | 311 | client | readable | 310 → 0 | response for id 1006 received |
| `D-S3` | nr-direct | sse | 200 | — | 5306 | 5306 | 310 | 5305 | server | readable | — | response for id 1007 received |
| `D-S4` | nr-direct | sse | — | — | — | 1009 | 304 | 1009 | client | n/a | 1009 → 0 | no response: network_aborted |
| `D-S5` | nr-direct | sse | — | — | — | 1008 | 308 | 1009 | client | n/a | — | no response: network_timeout |
| `D-S6` | nr-request | sse | 200 | — | 5309 | 5309 | 303 | 5308 | server | readable | — | response for id 1010 received |
| `D-S7` | nr-request | sse | — | — | — | 1008 | 309 | 1009 | client | n/a | — | no response: network_timeout |
| `R-J1` | fetch | json | 200 | 10 | 10 | 10 | — | 7 | server | readable | — | response for id 1012 received |
| `R-J2` | nr-request | json | 200 | — | 11 | 11 | — | 9 | server | readable | — | response for id 1013 received |
| `R-S1` | fetch | sse | 200 | 5309 | 5309 | 5309 | 307 | 5307 | server | readable | — | response for id 1014 received |
| `R-S2` | fetch | sse | — | — | — | 1002 | 308 | 5318 | server | n/a | 1002 → 0 | no response: AbortError |
| `R-S4` | nr-request | sse | 200 | — | 5322 | 5322 | 307 | 5320 | server | readable | — | response for id 1016 received |
| `R-S5` | nr-request | sse | — | — | — | 1009 | 309 | 5306 | server | n/a | 1009 → 0 | no response: network_aborted |
| `R-S3` | fetch | sse | 504 | 30007 | — | 30008 | 307 | 30002 | client | unreadable | — | no matching response (HTTP 504) |
| `R-S6` | nr-request | sse | — | — | — | 30008 | 308 | 30002 | client | n/a | — | no response: network_timeout |

Column notes: *browser hdr / resp / end* = the `fetch()` promise settled / the
JSON-RPC response for the request id became readable / the read finished;
*upstream event / close* = the stand-in wrote the SSE event / saw the
connection close; *closed by* `client` = the peer closed first (the browser,
or the relay aborting its own upstream fetch); *cancel → settled* = the
outstanding read settling after `AbortController.abort()`; *n/a* = there was
no HTTP response to read a header from.

Details the table does not show (all in the evidence file):

- `R-S3`: the 504 carries `X-Locus-Relay-Error: 1` and the body
  `{"error":{"code":"network_timeout","message":"Upstream timed out after 30000ms"}}`;
  the relay handler returned after 29998 ms.
- `R-S6`: `networkCode: "network_timeout"`, `ambiguous: true`, message
  `network request failed: Upstream timed out after 30000ms (the request may
  or may not have reached the server; it was NOT retried)`.
- `D-S5`: `network request timed out after 1000ms` (a caller-supplied
  `timeoutMs`; the 60 s default was not waited out). `D-S7` is the same
  failure through `request()`, flagged `ambiguous: true`.
- `D-S2`: a read issued after the cancel is rejected with `AbortError`.
- `R-J2`, `R-S4`, `R-S5`, `R-S6` report `backend: "edge-relay"`: at this
  baseline `selectBackend()` sends every cross-origin POST through the
  relay. `D-J4`, `D-S6`, `D-S7` (`backend: "browser-direct"`) are the only
  direct POSTs `request()` can select — same-origin targets. The
  cross-origin direct numbers therefore come from `NetworkRuntime._direct()`
  called directly.

## Rerun

Needs Node 22 or later (global `WebSocket`; the evidence was measured on
Node 24), headless Chrome (`CHROME` env, `--chrome`, or the standard
location) and a locus-product checkout for `functions/fetch.js` (default:
the sibling directory `../locus-product`; override with `--product`).

```bash
# in a locus-runtime checkout, next to a locus-product checkout
npm run verify:mcp-transport            # = node tools/mcp-transport-verify/verify.cjs --control
node tools/mcp-transport-verify/verify.cjs --product /path/to/locus-product --control \
  --out tools/mcp-transport-verify/results/<date>-<browser>-<os>.json   # keep the evidence
node tools/mcp-transport-verify/verify.cjs --skip-long                   # skip the two 30 s relay-deadline probes
node tools/mcp-transport-verify/mcp-test-server.cjs                      # the stand-in alone, for a browser by hand
```

A full run takes about two minutes; most of it is the two relay-deadline
probes, which wait out the relay's real 30 s timeout (concurrently). The
report names the runtime commit and whether its tree was clean, the product
commit and the SHA-256 of the relay file, so "measured at commit X" can be
checked against the evidence.

Exit codes — a measurement never fails on an unfavorable verdict:

| code | meaning |
|---|---|
| 0 | every probe was measured (verdicts may be `not_supported`) |
| 2 | harness failure: a probe crashed, was not measured, or the positive control had a criterion measure false |
| 3 | test environment unavailable (Chrome missing, relay source missing, …): affected combinations are reported `env_unavailable` with the reason |

Options: `--hold-ms` (SSE hold after the event, default 5000),
`--long-hold-ms` (default 35000, must exceed the relay timeout),
`--bearer`, `--out -` (JSON to stdout), `--help`.

## How it measures

**Topology.** The page is served from `http://127.0.0.1:<app>` together
with `/fetch` (the real `functions/fetch.js` handlers) and a same-origin copy
of the stand-in under `/mcp/*`. The cross-origin stand-in is
`http://mcp.test.local:<mcp>/mcp/{json,sse}`: the name is not a
private/loopback *string*, so the relay's hostname policy accepts it, and it
is mapped to `127.0.0.1` by `--host-resolver-rules` in Chrome and by a fetch
patch in the harness process for the relay's upstream leg — the technique
`tests/e2e-network.cjs` uses. Only name resolution is patched; the relay's
code runs untouched.

**The browser → relay leg** stands in for the Pages runtime: the browser's
request becomes an `undici` `Request` with its own headers (`Origin`
included, so the relay's same-origin enforcement runs for real), `env` is
`{}` (production defaults), the response body is streamed through unchanged,
and `request.signal` is aborted when the browser goes away mid-request. The
last two exist so that a relay which streams and honours the disconnect is
*observable* doing so; the harness does not assume the deployed runtime
behaves the same way (see [Not verified](#not-verified)).

**Clients.** Each probe is one MCP-shaped JSON-RPC POST (`Content-Type:
application/json`, `Accept: application/json, text/event-stream`,
`MCP-Protocol-Version`, a literal TEST bearer), sent by one of:

| client | what it is |
|---|---|
| `fetch` | raw browser `fetch` + a `ReadableStream` reader — the platform control group; on the relay path it posts the relay envelope by hand |
| `nr-direct` | `NetworkRuntime._direct()` — the runtime's direct backend code, pointed at the cross-origin stand-in (internal on purpose: see the `selectBackend` note above) |
| `nr-request` | `NetworkRuntime.request()` — the public substrate every runtime HTTP consumer is routed through, with a scripted allow-once authorization port |

**Probe plan.** JSON: cross-origin `fetch` with and without the server's
expose header, `_direct`, same-origin `request()`; relayed `fetch`, relayed
`request()`. SSE (response at ~300 ms, then held): plain read, cancel after
the response, cancel while the response is outstanding (1 s), a deadline
shorter than the hold (1 s), for each client. On the relay, additionally a
35 s hold — longer than the relay's 30 s upstream timeout.

**Criteria and thresholds.** A layer is `supported` only when every
criterion measures true; any criterion false makes it `not_supported`; a
missing measurement makes it `not_verified`; a missing prerequisite makes it
`env_unavailable`. "Streaming" means the response reached the browser more
than 100 ms before the upstream closed. "A cancel ends the read" means the
outstanding read settled within 1000 ms; "reaches the upstream" means the
stand-in saw the peer close within 2000 ms of the cancel. The rulebook is
`verdictsFor()` in `verify.cjs`; every criterion and its value are in the
report.

## Where the relay would need to change

`locus-product/functions/fetch.js` at
`e5a2942c030511a7c0906b3da0c7befd3f31953f`. Line numbers are that commit's.
This section records what was measured against each location; it is not a
design — a streaming relay touches decisions (caps, deadlines) that belong to
the owner.

| # | location | what the code does today | measured evidence |
|---|---|---|---|
| R1 | `readResponseCapped()` L382–420 (read loop L396–405) and `buildUpstreamResponse()` L426–474 (awaits it at L430; `Content-Length` L472; `new Response(bytes, …)` L473) | reads the upstream body to EOF, then builds the client response from the complete byte array | `R-S1`: upstream event 307 ms, upstream close 5307 ms, browser headers **and** response 5309 ms. Control `C-S1`, same probes: headers 4 ms, response 308 ms, close 5311 ms |
| R2 | `handleRelayRequest()` L480–499: the `AbortController` (L486) is aborted only by the timer (L488); `context.request.signal` is never read — the callers (L582, L649) pass `{ method, target, headers, body, env, redirectMode }` | a browser disconnect does not cancel the upstream read | `R-S2`: browser gone at 1002 ms; the bridge had aborted `request.signal`; the handler returned **200 at 5318 ms** to a client that was no longer there; upstream closed by the **server**. `R-S5` likewise (1008 / 5305 ms). Control `C-S2`: upstream closed by the **client** at 1004 ms |
| R3 | `getTimeoutMs()` L113–116 (default 30000) with the 504 at L433 and L437 | one deadline covers headers *and the whole body*; when it fires, the response is replaced by a 504 | `R-S3` (35 s hold): HTTP **504** at 30007 ms with `{"error":{"code":"network_timeout","message":"Upstream timed out after 30000ms"}}`, upstream aborted by the relay at 30002 ms — although the upstream had sent the response at 307 ms. `R-S6`: `network_timeout`, `ambiguous: true`. Control `C-S3`: response 311 ms, stream complete at 35310 ms |

Not a required change, for the record:

| location | finding |
|---|---|
| header pass-through, L450–457 | `MCP-Session-Id` reaches the client intact (`R-J1`, `R-S1`, `R-J2`, `R-S4`: readable and equal to the value the stand-in issued) |
| `filterForwardHeaders()` L258–274 | `Authorization`, `Accept`, `Content-Type` and `MCP-Protocol-Version` arrive at the upstream unchanged: the bearer check passed and the stand-in's 406 rule (Accept must name both media types) was never triggered |
| `CORS_HEADERS` expose list, L61 | lists only `X-Locus-Final-URL, X-Locus-Relay-Error`. Irrelevant in the measured topology, where the page and `/fetch` share an origin; it would hide `MCP-Session-Id` from a cross-origin caller, which `originEnforcementError()` (L555–566) refuses anyway |

Read from the code, **not measured**: the response cap in `readResponseCapped()`
(L399–403, `received > maxBytes` → 413) is a running total over the whole
stream, so a long-lived SSE response would eventually be refused even if R1
were fixed without also revisiting the cap.

## The runtime client has the same gap

`src/network.js` at `080a6001df716b28db1d60444c49e280664a5dd2` (the harness
does not change it):

| location | what the code does today | measured evidence |
|---|---|---|
| `readBytesCapped()` L1128–1173 (loop L1146–1155), used by `_direct()` L390 and `consumeRelayResponse()` L478 | `request()` resolves only after the whole body has been read; there is no way to consume a response before EOF | `D-S3`: upstream event 310 ms, response readable at 5306 ms. `D-S6` (same-origin `request()`): 5309 ms. Control `C-S4`: even with a streaming relay, 5319 ms |
| deadlines `DIRECT_TIMEOUT_MS` L75 / `RELAY_CLIENT_TIMEOUT_MS` L78, armed in `_direct()` L339 and `fetchWithDeadline()` L1107 | the deadline covers headers and body, so a stream open longer than it fails and the response the upstream had already sent is discarded | `D-S5`, `D-S7`: `network_timeout`, no response (with a caller-supplied 1000 ms deadline) |
| `raceAbort()` L1192–1203 with the external signal | cancellation is prompt — no gap here | `D-S4`, `R-S5`, `C-S5`: settled 0–1 ms after the cancel, `network_aborted` |

## Positive control

A negative result is only worth what the instrument is worth.
`control-relay.mjs` is the smallest relay that passes the upstream body
through as a stream and aborts the upstream fetch on `request.signal` —
nothing else: no caps, no redirect handling, no timeout, a fixed-host
allowlist instead of the SSRF classifier, and it only answers for the
harness's own stand-in. It is **not** a proposed relay. `--control` re-runs
the relay combinations with it in place of `functions/fetch.js`.

| probe | client | mode | HTTP | browser hdr | browser resp | browser end | upstream event | upstream close | closed by | MCP-Session-Id | cancel → settled | outcome |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `C-J1` | fetch | json | 200 | 6 | 6 | 6 | — | 3 | server | readable | — | response for id 2012 received |
| `C-J2` | nr-request | json | 200 | — | 6 | 6 | — | 4 | server | readable | — | response for id 2013 received |
| `C-S1` | fetch | sse | 200 | 4 | 308 | 5313 | 307 | 5311 | server | readable | — | response for id 2014 received |
| `C-S2` | fetch | sse | 200 | 4 | 309 | 1002 | 308 | 1004 | client | readable | 1001 → 0 | response for id 2015 received |
| `C-S4` | nr-request | sse | 200 | — | 5319 | 5319 | 308 | 5318 | server | readable | — | response for id 2016 received |
| `C-S5` | nr-request | sse | — | — | — | 1006 | 310 | 1008 | client | n/a | 1006 → 1 | no response: network_aborted |
| `C-S3` | fetch | sse | 200 | 6 | 311 | 35310 | 309 | 35309 | server | readable | — | response for id 2018 received |
| `C-S6` | nr-request | sse | 200 | — | 35310 | 35310 | 309 | 35308 | server | readable | — | response for id 2019 received |

| combination | platform | runtime |
|---|---|---|
| relay × JSON | **supported** | **supported** |
| relay × SSE | **supported** | **not_supported** — 1 criterion failed (`C-S4`: `NetworkRuntime` still buffers) |

The relay-leg view of the two cancel probes, from the harness bridge:

| probe | browser went away (ms after the relay request) | relay handler returned (ms) | `request.signal` already aborted when the handler finished | upstream closed by / at (ms) |
|---|---|---|---|---|
| `R-S2` | 1002 | 5318 | yes | server / 5318 |
| `R-S5` | 1008 | 5305 | yes | server / 5306 |
| `C-S2` | 1000 | 1 | no (it had already returned) | client / 1004 |
| `C-S5` | 1006 | 2 | no (it had already returned) | client / 1008 |

So the difference between `R-*` and `C-*` is the relay code and nothing else:
with a streaming relay the platform layer passes both relay combinations,
and the one criterion still failing is `NetworkRuntime`'s own buffering. A
rerun after a relay change should show `R-S1`'s browser *hdr* dropping from
~5300 ms to a few ms, `R-S2`/`R-S5`'s *closed by* turning `client`, and
`R-S3`/`R-S6` receiving their responses.

## Not verified

Whatever the verdicts above say, none of this was exercised:

- **The deployed Cloudflare edge.** `functions/fetch.js` ran as its real
  handlers dispatched in Node (undici `Request`/`Response`). The
  workerd/Pages runtime — edge buffering, whether a client disconnect
  aborts `request.signal` there, header handling at the edge — was not
  exercised. The relay verdicts recorded here follow from the relay's own
  control flow (R1–R3), which that runtime executes unchanged; what remains
  untested is its behaviour around any streaming relay that replaces it. For reference, `origin/stable` — which
  the product AGENTS.md defines as the deployed version — points at the same
  commit as `origin/main`, so the relay source measured is the one recorded
  as deployed.
- **HTTPS / TLS and HTTP/2 / HTTP/3**: the stand-in is plain HTTP/1.1 on loopback.
- **Real MCP servers**: the stand-in answers each POST with exactly one
  response for the request id. Servers that send notifications or
  server-initiated requests before the response, batch payloads, or several
  events per stream were not exercised; neither was whether a given vendor
  sends the CORS headers the direct path needs.
- **The standalone server-to-client stream** (`GET <endpoint>` with
  `text/event-stream`) and **session termination** (`DELETE <endpoint>`).
- **A bearer resolved through the C3 credentials port** (`$NAME` in the
  `Authorization` header, `redirect: "manual"`, echo redaction): the probes
  send a literal TEST bearer header.
- **Protocol-version negotiation failures** (400/404 on
  `MCP-Protocol-Version`), 429/retry, resumability via `Last-Event-ID`, OAuth.
- **The default deadlines** (60 s direct, 45 s relay client): the deadline
  probes use a caller-supplied 1000 ms, which exercises the same code path.
- **Browsers other than** the Chrome recorded in the report.

## Run history

Kept because the first failure of a candidate is part of its record.

| run | harness state | outcome |
|---|---|---|
| Node smoke test, no browser | draft | Pipeline works. One harness defect fixed before any browser run: the hand-built relay envelope lacked `bodyBase64` (the stand-in correctly answered 400). An earlier ad-hoc shell command had also passed a malformed base URL — a mistake in that command, not in the harness. |
| browser run 1 | draft, no control | 19 probes measured; verdicts as above. Not kept as evidence: nothing yet showed the instrument could report `supported` on the relay path. |
| browser run 2 | + positive control | Control passed; verdicts as above. Found: the bridge held response headers until the first body write (control headers 312 ms instead of ~4 ms) — fixed. |
| environment paths | — | Chrome missing → 8 × `env_unavailable`, exit 3. Relay source missing → relay combinations `env_unavailable`, direct combinations measured, exit 3. `--skip-long` exposed a harness bug: the control check demanded `supported` and reported a false "control did not pass" — fixed to reject only a criterion that measured false. |
| **candidate `2f535683`** | first committed harness, clean tree | Every probe measured, verdicts as above, control passed — **then exit 2**: `--out` pointed into a `results/` directory that did not exist and the report write threw `ENOENT`. No JSON artifact for this run. |
| **candidate `b529179c`** | fix: create the report directory; print the report if the write fails | **The evidence recorded here.** Exit 0; 19 + 8 probes; control passed. Measurement logic unchanged from `2f535683`. |

Across every browser run the verdicts were identical, and every timing was
within about 15 ms of the values above.

## Files

| file | role |
|---|---|
| `mcp-test-server.cjs` | the stand-in: MCP-shaped POST endpoint with JSON and SSE responses, TEST bearer, per-request server-side log |
| `harness.html`, `harness.js` | the browser half: the three clients, SSE frame parsing, wall-clock stamps |
| `control-relay.mjs` | the positive control |
| `verify.cjs` | driver: servers, the relay bridge, Chrome over CDP, the probe plan, the rulebook, the report |
| `results/` | evidence reports (JSON) |

The harness does not use `tests/fixtures/relay/fetch.js`: that copy predates
C3 (no `redirect: "manual"`) and differs from the product relay, so the real
file is loaded from a product checkout instead.
