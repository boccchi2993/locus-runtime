// ============================================================
//  NETWORK RUNTIME v1
//  Unified, provider-neutral, tool-neutral HTTP/HTTPS execution
//  substrate (docs/NETWORK-RUNTIME.md). Every future HTTP consumer
//  goes through request(); routing is decided HERE, not by the model
//  and not by the shell:
//
//    READ-LIKE (GET/HEAD)
//      direct browser fetch
//          ↓ only on genuine network failure (TypeError), once
//      edge relay (/fetch)
//
//    SIDE-EFFECTING (POST/PUT/PATCH/DELETE/OPTIONS)
//      backend chosen BEFORE the request starts
//        (same-origin → direct, cross-origin → relay),
//      gated by a user approval, dispatched EXACTLY ONCE —
//      an ambiguous failure is NEVER retried across backends
//      (a browser TypeError can mean the server already processed
//      the request: double POST / double payment / double delete).
//
//  An HTTP response — even 404/500/3xx — is an authoritative
//  application result and is NEVER re-sent through a different
//  backend (any method). Payloads are binary-safe: `bytes` is always
//  a Uint8Array, never a decoded string.
//
//  Resource semantics:
//  - anonymous by construction: credentials: 'omit', URL userinfo
//    rejected, no ambient cookies (explicit Cookie headers are
//    dropped for parity with the browser fetch boundary)
//  - only http:/https:, parsed with `new URL` (never regex);
//    fragments are never sent; the canonical identity is the
//    WHATWG origin (protocol//host:effective-port)
//  - every request has a client deadline covering headers AND body
//  - response bodies are stream-read with a hard byte cap; request
//    bodies have their own (smaller) hard cap
//  - timeouts / size caps / user cancellation are NOT network
//    failures: they never trigger a relay retry of the same request
//  - redirects: followed for GET/HEAD (finalUrl recorded, final
//    scheme re-validated); a side-effecting request NEVER follows a
//    redirect — a 3xx whose Location leaves the approved origin
//    fails with network_redirect_blocked
//  - SSRF: the edge relay refuses loopback/private/link-local
//    targets (including IPv4-mapped IPv6 spellings); the client
//    pre-checks every relay leg with the same policy. The direct
//    backend keeps the browser's own boundary.
//  - redirect credentials: origin-bound credentials (Authorization,
//    Proxy-Authorization) belong to the origin they were granted for.
//    The relay strips them before dispatching a cross-origin redirect
//    hop; a stripped credential never returns on a later hop.
//
//  Approval integration: side-effecting methods are the Approval
//  Framework's first production consumer — the Harness constructs
//  the canonical `network-write:<origin>` policy key, and the
//  consumer contract (pure validation → approval → bounds re-check →
//  FINAL liveness check → NO await → request begins) prevents TOCTOU.
//  Approval can reduce autonomy; it can never manufacture authority:
//  a granted approval never enables a non-HTTP scheme or method.
//
//  The runtime knows nothing about curl, shells, VFS, providers or
//  the model. The shell is a consumer: it parses CLI flags and passes
//  a normalized request + authorization (the Runtime-defined execution
//  authorization port, REPOSITORY-SPLIT-CONTRACTS §3.5). The port
//  carries NO chat identity: { conversationId, taskGeneration } and
//  friends are Harness/Product fields that the Product adapter adds on
//  its side of the boundary when it forwards the request to its
//  approval controller.
// ============================================================

// Ordinary download deadline (distinct from the model inference deadline).
const DIRECT_TIMEOUT_MS = 60000;
// Slightly longer than the relay's own 30s upstream timeout, so the
// relay's structured 504 arrives before the client gives up.
const RELAY_CLIENT_TIMEOUT_MS = 45000;
// Response cap, aligned with the relay's MAX_FETCH_RESPONSE_BYTES default.
const NETWORK_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
// Request bodies are small by design (API calls); a --data-binary of a
// huge file must fail BEFORE approval and BEFORE any send. Aligned with
// the relay's MAX_FETCH_REQUEST_BYTES default.
const NETWORK_MAX_REQUEST_BYTES = 2 * 1024 * 1024;
// v0 alias kept for existing consumers.
const NETWORK_MAX_BYTES = NETWORK_MAX_RESPONSE_BYTES;

// Harness-canonical policy key prefix for network write grants. The
// appended origin is the WHATWG-canonical origin of the PARSED URL —
// never a model/tool-provided string, path, or query.
const NETWORK_WRITE_POLICY_PREFIX = 'network-write:';

const READ_LIKE_METHODS = ['GET', 'HEAD'];
const SIDE_EFFECTING_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];
const REFUSED_METHODS = ['TRACE', 'CONNECT'];
// RFC 7230 token charset — anything outside is not an HTTP method.
const METHOD_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

// Browser-controlled / unsafe-to-spoof / ambient-credential request
// headers. Applied on the client AND re-applied on the relay (defense
// in depth). Authorization is deliberately NOT forbidden — the model may
// explicitly authenticate a request — but it never appears in logs,
// approval cards or telemetry (docs/NETWORK-RUNTIME.md).
const FORBIDDEN_HEADERS = new Set([
  'host', 'content-length', 'connection', 'transfer-encoding', 'upgrade',
  'te', 'trailer', 'keep-alive', 'expect', 'via', 'date',
  'cookie', 'cookie2', 'dnt', 'origin', 'referer',
  'accept-charset', 'accept-encoding',
  'access-control-request-headers', 'access-control-request-method',
]);
const FORBIDDEN_HEADER_PREFIXES = ['proxy-', 'sec-'];

const NetworkRuntime = {
  relayPath: '/fetch',
  maxResponseBytes: NETWORK_MAX_RESPONSE_BYTES,
  maxRequestBytes: NETWORK_MAX_REQUEST_BYTES,
  directTimeoutMs: DIRECT_TIMEOUT_MS,
  relayClientTimeoutMs: RELAY_CLIENT_TIMEOUT_MS,

  // ----------------------------------------------------------
  //  request(spec) → {
  //    status, statusText,
  //    headers:    {lowercase-name: value}   (last value wins),
  //    headerList: [[name, value]…]          (duplicates preserved),
  //    bytes: Uint8Array, finalUrl,
  //    backend: 'browser-direct' | 'edge-relay'   (telemetry/debug only)
  //  }
  //
  //  spec: {
  //    method        'GET' (default) | 'HEAD' | 'POST' | 'PUT' |
  //                  'PATCH' | 'DELETE' | 'OPTIONS'
  //    url           absolute http(s) URL (fragment is never sent)
  //    headers       {name: value}; forbidden headers are dropped
  //    body          string (UTF-8) | Uint8Array | ArrayBuffer | null
  //                  (side-effecting methods only)
  //    signal        task AbortSignal (cancellation, not rollback)
  //    authorization { request(req, opts) → { outcome, scope } }  — the
  //                  execution authorization port (§3.5); req carries the
  //                  plain-text action/resource/policyKey and NO identity
  //    timeoutMs      direct-attempt deadline (default 60s)
  //    relayTimeoutMs relay-attempt deadline (default 45s)
  //  }
  //
  //  Throws Error with e.networkCode from the taxonomy in
  //  docs/NETWORK-RUNTIME.md. The backend is chosen before the request
  //  starts and side effects are never retried.
  // ----------------------------------------------------------
  async request(spec) {
    const opts = spec && typeof spec === 'object' ? spec : {};
    const method = normalizeMethod(opts.method || 'GET');
    const readLike = isReadLikeMethod(method);
    const parsed = parseHttpUrl(opts.url); // invalid-url / scheme / userinfo
    const headers = filterRequestHeaders(opts.headers);
    const targetUrl = parsed.origin + parsed.pathname + parsed.search; // fragment-free
    const canonicalOrigin = parsed.origin;

    // ---- pure validation BEFORE any approval: nothing side-effecting
    // has happened, so there is nothing to approve yet — and a request
    // that cannot be sent is never offered for approval.
    let body = null;
    if (!readLike) {
      body = toRequestBody(opts.body);
      if (body && body.byteLength > NETWORK_MAX_REQUEST_BYTES) {
        throw makeNetError('network_request_too_large',
          'request body too large (limit ' + NETWORK_MAX_REQUEST_BYTES + ' bytes)');
      }
    } else if (opts.body != null) {
      throw new Error('GET/HEAD requests cannot carry a body');
    }

    // ---- backend selection + SSRF pre-check BEFORE the approval: both
    // are pure, and the chosen backend is FINAL. After a request is in
    // flight it is never re-routed or re-sent.
    const backend = selectBackend(readLike, canonicalOrigin);
    if (backend === 'edge-relay') {
      assertRelayTargetAllowed(parsed); // client-side SSRF pre-check
    }

    const externalSignal = opts.signal || null;

    // ---- approval (side-effecting methods only; the Runtime-defined
    // execution authorization port — docs/APPROVALS.md consumer contract).
    // The port brings its own identity context on the consumer side; the
    // Runtime passes none (contract §3.5).
    if (!readLike) {
      const authorization = opts.authorization && typeof opts.authorization.request === 'function'
        ? opts.authorization : null;
      if (!authorization) {
        throw makeNetError('network_approval_unavailable',
          'side-effecting network requests require an execution authorization port (none is wired)');
      }
      const summary = method + ' ' + canonicalOrigin + parsed.pathname;
      const detail = body && body.byteLength
        ? 'Request body size: ' + formatByteSize(body.byteLength)
        : null;
      const decision = await authorization.request({
        kind: 'permission',
        action: { type: 'network-request', summary: summary, detail: detail },
        resource: { type: 'network-origin', key: canonicalOrigin, label: canonicalOrigin },
        policyKey: NETWORK_WRITE_POLICY_PREFIX + canonicalOrigin,
      }, { signal: externalSignal });
      if (decision.outcome !== 'allow') {
        // Deny ≠ cancel: a denial is a deterministic user decision; a
        // task cancellation flows through the signal and is NEVER
        // reported as a denial (docs/NETWORK-RUNTIME.md).
        if (decision.outcome === 'cancelled') throw makeNetCancelledError();
        throw makeNetError('network_denied', 'network request denied by user');
      }
      // Safe preparation (post-approval, pre-side-effect): re-check the
      // request bounds, then the FINAL task-liveness check.
      if (body && body.byteLength > NETWORK_MAX_REQUEST_BYTES) {
        throw makeNetError('network_request_too_large',
          'request body too large (limit ' + NETWORK_MAX_REQUEST_BYTES + ' bytes)');
      }
      throwIfSignalAborted(externalSignal);
      // NO await between here and the start of the request.
    }

    return await this._perform(backend, readLike, method, targetUrl, parsed,
      headers, body, externalSignal, opts);
  },

  // Read-like GET convenience wrapper (v0 entry point, unchanged
  // semantics: direct first, transparent relay fallback on TypeError).
  async fetch(url, options) {
    return await this.request({
      method: 'GET',
      url: url,
      signal: options && options.signal,
      timeoutMs: options && options.timeoutMs,
      relayTimeoutMs: options && options.relayTimeoutMs,
    });
  },

  // Perform the request on the pre-selected backend. Read-like requests
  // may fall back browser → relay ONCE on a genuine network failure;
  // side-effecting requests never do (zero automatic retries).
  async _perform(backend, readLike, method, targetUrl, parsed, headers, body,
    externalSignal, opts) {
    if (backend === 'browser-direct') {
      try {
        return await this._direct(method, targetUrl, headers, body,
          externalSignal, opts.timeoutMs || DIRECT_TIMEOUT_MS);
      } catch (e) {
        // FALLBACK BOUNDARY: only a failure of the initial fetch()
        // transport invocation itself (DirectTransportFailure) may hand a
        // GET/HEAD over to the relay. Everything after a Response exists —
        // header handling, status handling, body reads, size accounting —
        // is a post-Response failure and is NEVER re-sent elsewhere.
        if (!readLike || !(e instanceof DirectTransportFailure)) {
          throw mapWriteDispatchError(e, 'network_direct_failed');
        }
        // GET/HEAD safe fallback: reads duplicate harmlessly. The relay
        // leg is still subject to the relay's private-address policy —
        // refuse here for the same deterministic error without the
        // wasted round-trip.
        if (isPrivateHostname(parsed.hostname)) {
          assertRelayTargetAllowed(parsed); // throws network_private_address_blocked
        }
        if (!isHostedPage()) {
          throw new Error(
            'network request failed: the target could not be reached and no request-forwarding '
            + 'service is available when the app is not served over HTTP(S)');
        }
      }
    }
    try {
      // Legacy GET ?url= form for headerless GET requests (kept for wire
      // compatibility); everything else — headerless HEAD, GET/HEAD with
      // headers and all side-effecting methods — uses the POST /fetch
      // JSON envelope, which preserves the method exactly.
      if (method === 'GET' && !Object.keys(headers).length) {
        return await this._relayGet(targetUrl, externalSignal, opts.relayTimeoutMs);
      }
      return await this._relayRequest(method, targetUrl, headers, body,
        externalSignal, opts.relayTimeoutMs);
    } catch (e) {
      if (e && e.networkCode) {
        // Classified (relay structured error / timeout / cap / …): a
        // dispatched side effect still needs the ambiguity verdict.
        if (!readLike) throw mapWriteDispatchError(e, 'network_relay_failed');
        throw e;
      }
      if (readLike && isNetworkFailure(e)) {
        // The fetch TypeError text embeds the full request URL — never
        // reuse it: report the failure with the bounded constant instead.
        throw makeNetError('network_relay_failed',
          'network request failed: the request could not be dispatched');
      }
      throw mapWriteDispatchError(e, 'network_relay_failed');
    }
  },

  async _direct(method, url, headers, body, externalSignal, timeoutMs) {
    const readLike = isReadLikeMethod(method);
    if (externalSignal && externalSignal.aborted) throw makeNetCancelledError();
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    const onExternalAbort = () => controller.abort();
    if (externalSignal) externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    try {
      let res;
      try {
        // TRANSPORT PHASE — the only fallback-eligible failure of the
        // direct attempt. Abort (cancel/timeout) is not a transport
        // TypeError and is classified below instead.
        res = await fetch(url, {
          method: method,
          // Side-effecting requests must not follow redirects: the browser
          // reports redirect:'manual' as an opaque response whose target
          // cannot be inspected, so it is blocked outright instead of
          // replaying an approved body somewhere else.
          redirect: readLike ? 'follow' : 'manual',
          credentials: 'omit', // anonymous by construction — never send ambient cookies
          headers: Object.keys(headers || {}).length ? headers : undefined,
          body: readLike ? undefined : (body || undefined),
          signal: controller.signal,
        });
      } catch (e) {
        if (externalSignal && externalSignal.aborted) throw makeNetCancelledError();
        if (timedOut) throw makeNetTimeoutError(timeoutMs);
        if (e instanceof TypeError) throw new DirectTransportFailure(e);
        throw e;
      }
      // A Response exists. From here on NO backend fallback is possible:
      // the request reached the HTTP layer, so any failure is a
      // post-Response failure of THIS attempt.
      if (!readLike && isRedirectResponse(res)) {
        throw makeNetError('network_redirect_blocked',
          'redirect blocked: side-effecting requests cannot be redirected to another origin');
      }
      const headersAndList = headersFromResponse(res.headers);
      const finalUrl = res.url || url;
      assertFinalScheme(finalUrl);
      return {
        status: res.status,
        statusText: res.statusText || '',
        headers: headersAndList.object,
        headerList: headersAndList.list,
        bytes: await readBytesCapped(res, NETWORK_MAX_RESPONSE_BYTES, controller.signal),
        finalUrl: finalUrl,
        backend: 'browser-direct',
      };
    } catch (e) {
      if (externalSignal && externalSignal.aborted) throw makeNetCancelledError();
      if (timedOut) throw makeNetTimeoutError(timeoutMs);
      throw e;
    } finally {
      clearTimeout(timer);
      if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
    }
  },

  // Relay fallback for READ-LIKE requests (legacy GET ?url= form).
  async _relayGet(url, externalSignal, timeoutMs) {
    return fetchWithDeadline(this.relayPath + '?url=' + encodeURIComponent(url), {
      method: 'GET',
      credentials: 'omit',
    }, timeoutMs || RELAY_CLIENT_TIMEOUT_MS, externalSignal, async (res, signal) => {
      return await consumeRelayResponse(res, signal, url);
    });
  },

  // Relay request for everything else: the POST /fetch JSON envelope
  // carries method/target/headers/body; the relay re-validates
  // everything server-side (docs/NETWORK-RUNTIME.md).
  async _relayRequest(method, url, headers, body, externalSignal, timeoutMs) {
    const envelope = { method: method, url: url, headers: headers || {} };
    if (body && body.byteLength) envelope.bodyBase64 = bytesToBase64(body);
    return fetchWithDeadline(this.relayPath, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(envelope),
      credentials: 'omit',
    }, timeoutMs || RELAY_CLIENT_TIMEOUT_MS, externalSignal, async (res, signal) => {
      return await consumeRelayResponse(res, signal, url);
    });
  },
};

// ------------------------------------------------------------
//  Shared relay response consumption (X-Locus-Relay-Error handling,
//  final-URL exposure, bounded byte read) — normalized ONCE here so
//  the relay's wire shape never leaks to consumers.
// ------------------------------------------------------------
async function consumeRelayResponse(res, signal, targetUrl) {
  // The relay's OWN failures (bad URL, unsupported method, private
  // target, timeout, size cap, redirect block) are marked with
  // X-Locus-Relay-Error and carry a JSON {error:{code, message}} body —
  // read INSIDE the same deadline, then surface with the relay's
  // classification; never treat them as upstream content.
  if (res.headers.get('x-locus-relay-error')) {
    let code = null;
    let msg = 'network request failed (HTTP ' + res.status + ')';
    try {
      const j = await raceAbort(res.json(), signal);
      if (j && j.error && j.error.message) msg = j.error.message;
      if (j && j.error && j.error.code) code = j.error.code;
    } catch (e) {
      if (e && (e.cancelled || e.timeout)) throw e;
    }
    throw makeNetError(code || 'network_relay_failed', 'network request failed: ' + msg);
  }
  const headersAndList = headersFromResponse(res.headers);
  const finalUrl = res.headers.get('x-locus-final-url') || targetUrl;
  assertFinalScheme(finalUrl);
  return {
    status: res.status,
    statusText: res.statusText || '',
    headers: headersAndList.object,
    headerList: headersAndList.list,
    bytes: await readBytesCapped(res, NETWORK_MAX_RESPONSE_BYTES, signal),
    finalUrl: finalUrl,
    backend: 'edge-relay',
  };
}

// ------------------------------------------------------------
//  Request validation + classification
// ------------------------------------------------------------

function isReadLikeMethod(method) {
  return READ_LIKE_METHODS.indexOf(method) !== -1;
}

// v1 accepts exactly the seven ordinary methods and rejects
// TRACE/CONNECT and custom verbs (docs/NETWORK-RUNTIME.md).
function normalizeMethod(raw) {
  const name = String(raw || '').trim().toUpperCase();
  if (!name || !METHOD_PATTERN.test(name)
    || (READ_LIKE_METHODS.indexOf(name) === -1
      && SIDE_EFFECTING_METHODS.indexOf(name) === -1)) {
    throw makeNetError('network_unsupported_method',
      'unsupported HTTP method: ' + (name || '(empty)')
      + ' (only GET, HEAD, POST, PUT, PATCH, DELETE and OPTIONS are available)');
  }
  return name;
}

// Only http:/https: URLs; credentials embedded in the URL are rejected —
// requests must be anonymous. Returns the WHATWG-canonicalized URL.
function parseHttpUrl(url) {
  let parsed;
  try {
    parsed = new URL(String(url || ''));
  } catch (e) {
    // UNPARSEABLE USER INPUT IS NOT SAFE DIAGNOSTIC TEXT: the raw input is
    // never echoed (it may carry secrets, may be megabytes, and has no
    // reliable structure to redact) — the message is a bounded constant.
    throw makeNetError('network_invalid_url', 'invalid URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw makeNetError('network_unsupported_scheme',
      'unsupported URL scheme: ' + parsed.protocol + ' (only http: and https: are available)');
  }
  if (parsed.username || parsed.password) {
    throw new Error('credentials in URLs are not allowed (anonymous requests only)');
  }
  return parsed;
}

// The backend decision needs the page's own origin (a same-origin
// side-effecting request may go direct). null when the page has no real
// origin (file://, non-browser test context).
function pageOrigin() {
  try {
    if (typeof window === 'undefined' || !window.location) return null;
    const loc = window.location;
    if ((loc.protocol === 'http:' || loc.protocol === 'https:') && loc.host) {
      return loc.protocol + '//' + loc.host;
    }
  } catch (e) { /* no window: non-browser context */ }
  return null;
}

// BACKEND MUST BE CHOSEN BEFORE THE REQUEST STARTS (docs/NETWORK-RUNTIME.md):
//   read-like       → browser first (relay fallback handled in _perform)
//   side-effecting  → same-origin: browser; everything else: relay.
// There is no ambiguous-failure re-route after send for side effects.
function selectBackend(readLike, canonicalOrigin) {
  if (readLike) return 'browser-direct';
  const page = pageOrigin();
  if (page && page === canonicalOrigin) return 'browser-direct';
  return 'edge-relay';
}

// ------------------------------------------------------------
//  SSRF pre-check (client-side mirror of the relay's own guard —
//  functions/fetch.js carries the SAME classifier and both are tested
//  against the SAME attack-vector tables in tests/network-runtime.test.cjs
//  and tests/fetch.test.mjs; keep the two implementations in sync).
//  The relay must never be driven against loopback/private/link-local
//  targets, so the client refuses them before choosing the relay.
//
//  Classification flow per hostname: strip IPv6 brackets / trailing dot →
//  named-host policy (localhost family) → IP-family parse (IPv6 literal vs
//  IPv4 scalar) → numeric normalization → range classification.
//  IPv4-mapped IPv6 (::ffff:0:0/96) is decoded to its IPv4 form and
//  classified as IPv4, so [::ffff:127.0.0.1] and its WHATWG-canonical
//  spelling [::ffff:7f00:1] are both loopback. Literal IPs arrive
//  WHATWG-canonicalized (the URL parser already reduced decimal/octal/hex
//  IPv4 spellings); the parser below also normalizes those scalar forms
//  directly so non-URL callers cannot bypass. A public DNS name that
//  RESOLVES to a private address cannot be detected here — a documented
//  limitation, re-checked server-side by the relay where possible
//  (docs/NETWORK-RUNTIME.md, "Known limitation").
// ------------------------------------------------------------
function isPrivateHostname(hostname) {
  let h = String(hostname || '').toLowerCase().trim();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1); // IPv6 literal
  if (h.endsWith('.')) h = h.slice(0, -1); // FQDN trailing dot
  if (!h) return false;
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === 'localhost.localdomain' || h.endsWith('.localhost.localdomain')) return true;
  if (h.indexOf(':') !== -1) return isPrivateIpv6Literal(h);
  const v4 = parseIpv4Host(h);
  return v4 !== null && isPrivateIpv4Value(v4);
}

// Classify a colon-containing IPv6 literal (canonical WHATWG form).
function isPrivateIpv6Literal(h) {
  if (h === '::' || h === '::1') return true; // unspecified / loopback
  const mapped = /^::ffff:(.+)$/.exec(h); // IPv4-mapped ::ffff:0:0/96
  if (mapped) {
    const rest = mapped[1];
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(rest)) return isPrivateHostname(rest); // dotted form
    const groups = rest.split(':');
    // Canonical mapped form: exactly two 16-bit hex groups, e.g. 7f00:1.
    if (groups.length === 2 && groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) {
      const hi = parseInt(groups[0], 16);
      const lo = parseInt(groups[1], 16);
      const ipv4 = [(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff].join('.');
      return isPrivateHostname(ipv4);
    }
    return false;
  }
  const first = h.split(':')[0] || '';
  if (/^[0-9a-f]{1,4}$/.test(first)) {
    const n = parseInt(first, 16);
    if ((n & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
    if ((n & 0xffc0) === 0xfe80) return true; // fe80::/10 link local
  }
  return false;
}

// Parse a hostname as an IPv4 address the way the WHATWG URL parser does:
// 1-4 dot-separated numeric parts (decimal / 0x hex / leading-0 octal),
// the last part carrying the remaining magnitude (e.g. 127.1 → 127.0.0.1,
// 2130706433 and 0x7f000001 → 127.0.0.1). Returns the 32-bit value, or
// null when the hostname is a domain name rather than an IPv4 literal.
function parseIpv4Host(h) {
  const parts = h.split('.');
  if (parts.length > 1 && parts[parts.length - 1] === '') parts.pop();
  if (parts.length === 0 || parts.length > 4) return null;
  const numbers = [];
  for (let i = 0; i < parts.length; i++) {
    const n = parseIpv4Number(parts[i]);
    if (n === null) return null;
    const isLast = i === parts.length - 1;
    if (!isLast && n > 255) return null;
    if (isLast && n >= Math.pow(256, 5 - parts.length)) return null;
    numbers.push(n);
  }
  let value = 0;
  for (let i = 0; i < parts.length - 1; i++) value = value * 256 + numbers[i];
  value = value * Math.pow(256, 5 - parts.length) + numbers[parts.length - 1];
  return value >>> 0;
}

// One IPv4 part with WHATWG radix detection. Non-numeric → null (the
// whole hostname is then a domain, not an address).
function parseIpv4Number(s) {
  if (!s) return null;
  let radix = 10;
  let digits = s;
  if (s.length >= 2 && s[0] === '0' && (s[1] === 'x' || s[1] === 'X')) {
    radix = 16;
    digits = s.slice(2);
  } else if (s.length >= 2 && s[0] === '0') {
    radix = 8;
    digits = s.slice(1);
  }
  if (digits === '') return 0;
  const ok = radix === 16 ? /^[0-9a-fA-F]+$/
    : radix === 8 ? /^[0-7]+$/
      : /^[0-9]+$/;
  if (!ok.test(digits)) return null;
  return Number.parseInt(digits, radix);
}

// IPv4 range policy: 0.0.0.0/8, 10/8, 127/8, 169.254/16, 172.16/12,
// 192.168/16. Nothing wider (no full bogon table).
function isPrivateIpv4Value(value) {
  const a = (value >>> 24) & 0xff;
  const b = (value >>> 16) & 0xff;
  return a === 0 || a === 10 || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168);
}

function assertRelayTargetAllowed(parsed) {
  if (isPrivateHostname(parsed.hostname)) {
    throw makeNetError('network_private_address_blocked',
      'refusing to reach a private or loopback address: ' + parsed.hostname);
  }
}

// ------------------------------------------------------------
//  Header policy (docs/NETWORK-RUNTIME.md): drop browser-controlled /
//  unsafe headers, reject CR/LF injection attempts. Authorization and
//  application-defined headers pass — authenticated API calls are
//  ordinary HTTP usage.
// ------------------------------------------------------------
function filterRequestHeaders(input) {
  if (input == null) return {};
  if (typeof input !== 'object') throw new Error('headers must be an object');
  const out = {};
  for (const key of Object.keys(input)) {
    const name = String(key).trim().toLowerCase();
    if (!name) continue;
    if (FORBIDDEN_HEADERS.has(name)
      || FORBIDDEN_HEADER_PREFIXES.some((p) => name.startsWith(p))) {
      continue;
    }
    const value = String(input[key]);
    if (/[\r\n]/.test(name) || /[\r\n]/.test(value)) {
      throw makeNetError('network_invalid_header', 'invalid header value (control characters)');
    }
    out[name] = value;
  }
  return out;
}

function toRequestBody(raw) {
  if (raw == null) return null;
  if (raw instanceof Uint8Array) return raw;
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  if (typeof raw === 'string') return new TextEncoder().encode(raw);
  throw new Error('request body must be a Uint8Array, ArrayBuffer or string');
}

function formatByteSize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}

// ------------------------------------------------------------
//  Error taxonomy — every failure carries a stable e.networkCode.
//  Browser implementation details (CORS topology, backend names) stay
//  OUT of model-facing messages; they live in the code and telemetry.
//  Legacy markers (timeout/tooLarge/cancelled/AbortError) are preserved
//  so existing classification keeps working.
// ------------------------------------------------------------
function makeNetError(code, message) {
  const e = new Error(message);
  e.networkCode = code;
  return e;
}

// Internal control-flow marker, deliberately NOT part of the public
// error taxonomy: the initial fetch() invocation itself failed with a
// genuine transport TypeError. Only this error may trigger the GET/HEAD
// relay fallback (see _perform). Errors after a Response exists — header
// parsing, status handling, body reads, size accounting, internal JS —
// are never wrapped, so they can never re-enter a backend fallback.
class DirectTransportFailure extends Error {
  constructor(cause) {
    // The browser's TypeError text embeds the full request URL (e.g.
    // "Failed to parse URL from <url>"), so it is NEVER reused as this
    // error's message — the message stays a bounded constant. The cause
    // is kept on the object only; no model-visible, telemetry or
    // persistence path serializes it.
    super('network transport failure');
    this.name = 'DirectTransportFailure';
    this.cause = cause;
  }
}

// Model/telemetry-safe URL summary: origin + pathname only. Query
// strings, fragments and userinfo routinely carry secrets and are never
// rendered into tool output, errors or telemetry (they still go on the
// wire untouched — this is display isolation, not request mutation).
// IPv6 hosts render bracketed via the WHATWG origin. Unparseable input
// degrades to a bounded placeholder — raw input is never echoed back.
function safeNetworkUrlForDisplay(url) {
  try {
    const u = new URL(String(url || ''));
    if (u.origin && u.origin !== 'null') return u.origin + (u.pathname || '/');
  } catch (e) { /* fall through */ }
  return '(unparseable URL)';
}

function makeNetTimeoutError(timeoutMs) {
  const e = makeNetError('network_timeout',
    'network request timed out after ' + timeoutMs + 'ms');
  e.name = 'NetworkTimeoutError';
  e.timeout = true;
  return e;
}

function makeNetTooLargeError(maxBytes) {
  const e = makeNetError('network_response_too_large',
    'response too large (limit ' + maxBytes + ' bytes)');
  e.name = 'NetworkTooLargeError';
  e.tooLarge = true;
  return e;
}

function makeNetCancelledError() {
  const e = makeNetError('network_aborted', 'network request cancelled');
  e.name = 'AbortError';
  e.cancelled = true;
  return e;
}

// A failure AFTER a side-effecting request was dispatched: the request
// may or may not have reached the server. Never retried — not on the
// other backend, not at all. Errors that are already classified
// (timeout / cancel / cap / redirect / relay code) pass through.
function mapWriteDispatchError(e, fallbackCode) {
  if (e && e.networkCode) {
    // Already classified. For a dispatched side effect, a transport-level
    // failure (direct failure / relay failure / deadline) is ambiguous:
    // the upstream server may already have processed the request.
    // Definitive pre-dispatch refusals (denied / aborted / redirect /
    // private / scheme / method / caps) stay unflagged.
    if (e.networkCode === fallbackCode || e.networkCode === 'network_timeout') {
      e.ambiguous = true;
      if (!/NOT retried/.test(e.message)) {
        e.message = e.message
          + ' (the request may or may not have reached the server; it was NOT retried)';
      }
    }
    return e;
  }
  if (e && (e.timeout || e.cancelled || e.tooLarge)) return e; // legacy markers, no code
  const err = e instanceof TypeError
    ? makeNetError(fallbackCode,
      'network request failed after dispatch; it may or may not have reached the server, '
      + 'so it was NOT retried')
    : makeNetError(fallbackCode, e && e.message ? e.message : String(e));
  err.ambiguous = true; // the request WAS dispatched: never retry, never re-route
  return err;
}

function throwIfSignalAborted(signal) {
  if (!signal) return;
  if (signal.aborted) throw makeNetCancelledError();
}

// Genuine network/CORS failures reject fetch() with a TypeError in every
// browser. HTTP error statuses resolve normally and never reach here;
// our own timeout/cap/cancellation errors carry explicit markers and are
// deliberately NOT TypeErrors, so they can never be misread as CORS.
function isNetworkFailure(e) {
  return e instanceof TypeError;
}

// A redirect the DIRECT backend surfaced for a side-effecting request:
// browsers report redirect:'manual' as an opaque response (status 0),
// non-browser runtimes surface the plain 3xx.
function isRedirectResponse(res) {
  return res.status === 0 || (res.status >= 300 && res.status < 400);
}

// The FINAL URL after any followed redirects must still be http(s).
// Browsers enforce this per hop, but the harness re-checks what it can
// see (res.url / X-Locus-Final-URL).
function assertFinalScheme(finalUrl) {
  try {
    const u = new URL(finalUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      throw makeNetError('network_redirect_blocked',
        'redirect blocked: the final URL is not http(s)');
    }
  } catch (e) {
    if (e && e.networkCode) throw e; // else: unparseable final URL — leave to caller's fallback
  }
}

function pageProtocol() {
  try {
    return (typeof window !== 'undefined' && window.location && window.location.protocol) || '';
  } catch (e) {
    return '';
  }
}

function isHostedPage() {
  const p = pageProtocol();
  return p === 'http:' || p === 'https:';
}

// Build the lowercase object form AND the duplicate-preserving pair
// list in one pass (Set-Cookie style duplicates must survive).
function headersFromResponse(headers) {
  const object = {};
  const list = [];
  try {
    headers.forEach((v, k) => {
      object[k.toLowerCase()] = v;
      list.push([k.toLowerCase(), v]);
    });
  } catch (e) {}
  return { object: object, list: list };
}

// fetch + FULL body consumption + cleanup in ONE lifecycle: the deadline
// and the external abort listener stay armed until the body has been read
// to completion (or has failed / been capped / been cancelled).
// consume(res) must read the entire body it needs.
async function fetchWithDeadline(url, init, timeoutMs, externalSignal, consume) {
  if (externalSignal && externalSignal.aborted) throw makeNetCancelledError();
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  const onExternalAbort = () => controller.abort();
  if (externalSignal) externalSignal.addEventListener('abort', onExternalAbort, { once: true });
  try {
    const res = await fetch(url, Object.assign({}, init, { signal: controller.signal }));
    return await consume(res, controller.signal);
  } catch (e) {
    if (externalSignal && externalSignal.aborted) throw makeNetCancelledError();
    if (timedOut) throw makeNetTimeoutError(timeoutMs);
    throw e;
  } finally {
    clearTimeout(timer);
    if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
  }
}

// Read a response body with a hard byte cap (streaming when possible, so
// oversized responses are cut off mid-stream instead of after a full
// unbounded read into memory). `signal` is the deadline/cancellation
// signal: every pending read is raced against it, so a stalled body still
// loses the race even if the underlying stream never reacts to abort.
async function readBytesCapped(res, maxBytes, signal) {
  let contentLength = NaN;
  try {
    contentLength = Number.parseInt(res.headers && res.headers.get
      ? (res.headers.get('content-length') || '') : '', 10);
  } catch (e) { /* ignore */ }
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw makeNetTooLargeError(maxBytes);
  }
  if (!res.body || typeof res.body.getReader !== 'function') {
    const buf = await raceAbort(res.arrayBuffer(), signal);
    if (buf.byteLength > maxBytes) throw makeNetTooLargeError(maxBytes);
    return new Uint8Array(buf);
  }
  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await raceAbort(reader.read(), signal);
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        cancelReaderQuietly(reader);
        throw makeNetTooLargeError(maxBytes);
      }
      chunks.push(value);
    }
  } catch (e) {
    if (e && e.tooLarge) throw e;
    if (e && (e.cancelled || e.name === 'AbortError')) {
      cancelReaderQuietly(reader);
      throw makeNetCancelledError();
    }
    throw e; // genuine mid-body network failure (TypeError) or stream error
  } finally {
    try { reader.releaseLock(); } catch (e) { /* lock may already be released */ }
  }
  const merged = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

// Best-effort stream cleanup on the way out (timeout / cancel / size
// cap). NEVER awaited: the underlying source's cancel() may return a
// promise that never settles (a stalled stream need not react to
// cancellation), and awaiting it would block the caller's exit path
// indefinitely — after the race was already lost. The rejection handler
// is attached immediately so a failed cleanup never surfaces as an
// unhandled rejection.
function cancelReaderQuietly(reader) {
  try {
    const p = reader.cancel();
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch (e) { /* synchronous cancel failure: ignore */ }
}

// Race a promise against an abort signal. Rejects with the standard
// cancellation error as soon as the signal fires, without waiting for the
// promise (which may never settle — e.g. a stalled response body).
function raceAbort(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(makeNetCancelledError());
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(makeNetCancelledError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
      (e) => { signal.removeEventListener('abort', onAbort); reject(e); }
    );
  });
}

// Chunked base64 (btoa's string argument has practical call-size limits).
function bytesToBase64(bytes) {
  let out = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(out);
}

// ============================================================
//  M3a (repository extraction): ES module exports. The M2a classic
//  globalThis publishes are gone — shell.js imports NetworkRuntime /
//  safeNetworkUrlForDisplay directly; the wider taxonomy helpers stay
//  module-internal (consumers use the documented error codes).
// ============================================================
export {
  NetworkRuntime,
  safeNetworkUrlForDisplay,
  isPrivateHostname,
  NETWORK_MAX_REQUEST_BYTES,
  NETWORK_MAX_RESPONSE_BYTES,
  RELAY_CLIENT_TIMEOUT_MS,
};
