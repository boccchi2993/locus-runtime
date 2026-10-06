// Cloudflare Pages Function: /fetch
//
// Anonymous public-HTTP(S) resource relay for NetworkRuntime v1
// (docs/NETWORK-RUNTIME.md). Semantically SEPARATE from /proxy: /proxy is
// the model-API relay (POST, JSON, auth headers forwarded); /fetch fetches
// ordinary public internet resources on behalf of the browser.
//
// Two request forms — one endpoint, no second proxy:
// - GET /fetch?url=<encoded>   legacy GET-only form (kept for compatibility)
// - POST /fetch                JSON envelope { method, url, headers,
//                              bodyBase64 } used by NetworkRuntime for
//                              header-bearing GET/HEAD and all
//                              side-effecting methods
//
// Guardrails:
// - methods: GET/HEAD/POST/PUT/PATCH/DELETE/OPTIONS only
//   (TRACE/CONNECT/custom → 405)
// - http/https targets only (file:/ftp:/data:/javascript:/ws: rejected);
//   URL userinfo rejected
// - private/loopback/link-local targets refused (SSRF): localhost,
//   127.0.0.0/8, ::1, 0.0.0.0/8, 169.254.0.0/16 (incl. metadata IPs),
//   10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, fc00::/7, fe80::/10
//   (incl. IPv4-mapped). Hostname-string validation only — a public name
//   that RESOLVES private is a documented limitation
//   (docs/NETWORK-RUNTIME.md).
// - no implicit credentials ever: the caller's own Cookie/Authorization
//   headers are never forwarded; envelope headers pass the same
//   forbidden-header filter as the client (Cookie/Sec-*/Proxy-*/hop-by-hop
//   dropped; a model-provided Authorization IS forwarded — the upstream
//   response's Set-Cookie is stripped, the relay never writes any cookie
//   jar)
// - upstream timeout (FETCH_TIMEOUT_MS, default 30s) → 504; it covers the
//   FULL lifecycle: request start → headers → body complete
// - request body cap (MAX_FETCH_REQUEST_BYTES, default 2MB) → 413
// - response size cap (MAX_FETCH_RESPONSE_BYTES, default 16MB) → 413
// - redirects followed up to MAX_FETCH_REDIRECTS (default 5), every hop
//   re-validated for scheme and private addresses: read-like requests
//   follow any origin; side-effecting requests follow SAME-ORIGIN hops
//   only (307/308 re-send method+body, 301/302/303 downgrade to a
//   body-less GET — the side effect is never replayed elsewhere) and a
//   cross-origin hop is refused
// - the final post-redirect URL is exposed via X-Locus-Final-URL
// - the relay's own errors carry X-Locus-Relay-Error: 1 and a JSON
//   {error:{code, message}} body so the client can distinguish relay
//   failures from authoritative upstream HTTP responses
// - responses are de-privileged for direct rendering: X-Content-Type-Options:
//   nosniff on every response, plus Content-Security-Policy: sandbox on
//   active content types
// - POST envelope AND legacy GET form: a present Origin header must
//   match the deployment origin (blocks other web pages — including the
//   legacy GET form — from driving the relay; not an auth system for
//   non-browser clients — docs/NETWORK-RUNTIME.md, "Relay openness")

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Expose-Headers': 'X-Locus-Final-URL, X-Locus-Relay-Error',
  'Access-Control-Max-Age': '86400',
  'X-Content-Type-Options': 'nosniff',
};

// MIME main types (parameters stripped, lowercased) that a browser would
// execute or render as active content when navigated to directly.
const ACTIVE_CONTENT_TYPES = new Set([
  'text/html',
  'application/xhtml+xml',
  'image/svg+xml',
  'text/javascript',
  'application/javascript',
  'application/x-javascript',
]);

// Statuses that must carry a null body; the Response constructor throws a
// TypeError if constructed with a body for any of these.
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

const RELAY_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);

// Mirror of src/network.js FORBIDDEN_HEADERS / prefixes (defense in
// depth: the client filters, the relay re-filters).
const FORBIDDEN_HEADERS = new Set([
  'host', 'content-length', 'connection', 'transfer-encoding', 'upgrade',
  'te', 'trailer', 'keep-alive', 'expect', 'via', 'date',
  'cookie', 'cookie2', 'dnt', 'origin', 'referer',
  'accept-charset', 'accept-encoding',
  'access-control-request-headers', 'access-control-request-method',
]);
const FORBIDDEN_HEADER_PREFIXES = ['proxy-', 'sec-'];

// Upstream response headers never copied onto the client-facing response:
// hop-by-hop machinery, the ambient-credential channel, and the recomputed
// length.
const STRIPPED_RESPONSE_HEADERS = new Set([
  'connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'te',
  'trailer', 'proxy-connection', 'set-cookie', 'content-length',
]);
const STRIPPED_RESPONSE_HEADER_PREFIXES = ['proxy-', 'sec-'];

function getMaxResponseBytes(env) {
  const configured = Number.parseInt(env.MAX_FETCH_RESPONSE_BYTES || '', 10);
  return Number.isFinite(configured) && configured > 0 ? configured : 16 * 1024 * 1024;
}

function getMaxRequestBytes(env) {
  const configured = Number.parseInt(env.MAX_FETCH_REQUEST_BYTES || '', 10);
  return Number.isFinite(configured) && configured > 0 ? configured : 2 * 1024 * 1024;
}

function getTimeoutMs(env) {
  const configured = Number.parseInt(env.FETCH_TIMEOUT_MS || '', 10);
  return Number.isFinite(configured) && configured > 0 ? configured : 30000;
}

function getMaxRedirects(env) {
  const configured = Number.parseInt(env.MAX_FETCH_REDIRECTS || '', 10);
  return Number.isFinite(configured) && configured >= 0 ? configured : 5;
}

function relayError(status, message, code) {
  return Response.json(
    { error: { code: code || 'network_relay_failed', message } },
    { status, headers: { ...CORS_HEADERS, 'X-Locus-Relay-Error': '1' } },
  );
}

function parseTarget(rawTarget) {
  if (!rawTarget) return { error: relayError(400, 'Missing url parameter', 'network_invalid_url') };
  let target;
  try {
    target = new URL(rawTarget);
  } catch {
    return { error: relayError(400, 'Invalid url parameter', 'network_invalid_url') };
  }
  if (target.protocol !== 'https:' && target.protocol !== 'http:') {
    return { error: relayError(403, 'Only HTTP(S) URLs are supported', 'network_unsupported_scheme') };
  }
  if (target.username || target.password) {
    return { error: relayError(403, 'Credentials in URLs are not allowed', 'network_invalid_url') };
  }
  if (isPrivateHostname(target.hostname)) {
    return { error: relayError(403, 'Private and loopback targets are not allowed', 'network_private_address_blocked') };
  }
  return { target };
}

// Hostname-string SSRF validation — the SAME classifier as
// src/network.js (the two implementations MUST stay in sync; both are
// tested against the SAME attack-vector tables in tests/fetch.test.mjs
// and tests/network-runtime.test.cjs). Per hostname: strip brackets /
// trailing dot → localhost family → IP-family parse → numeric
// normalization → range classification. IPv4-mapped IPv6
// (::ffff:0:0/96) is decoded to its IPv4 form and classified as IPv4,
// so [::ffff:127.0.0.1] and its WHATWG-canonical spelling
// [::ffff:7f00:1] are both loopback. Literal IPs arrive
// WHATWG-canonicalized (the URL parser reduced decimal/octal/hex IPv4
// spellings); the parser below also normalizes those scalar forms
// directly. See the header comment for the documented DNS-rebinding
// limitation.
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

// Envelope header filter — mirrors the client-side policy exactly.
function filterForwardHeaders(rawHeaders) {
  const out = {};
  for (const key of Object.keys(rawHeaders || {})) {
    const name = String(key).trim().toLowerCase();
    if (!name) continue;
    if (FORBIDDEN_HEADERS.has(name)
      || FORBIDDEN_HEADER_PREFIXES.some((p) => name.startsWith(p))) {
      continue;
    }
    const value = String(rawHeaders[key]);
    if (/[\r\n]/.test(name) || /[\r\n]/.test(value)) {
      return { error: relayError(400, 'Invalid header value (control characters)', 'network_invalid_header') };
    }
    out[name] = value;
  }
  return { headers: out };
}

// Origin-bound credentials belong to the origin they were granted for.
// When a followed redirect leaves the current origin, these headers are
// removed BEFORE the next hop is dispatched; a stripped credential never
// returns on a later hop (stripping is monotonic — each hop dispatches
// with the PREVIOUS hop's headers). Request-headers only: the response
// header path uses its own strip lists. Cookie is unreachable here (the
// forbidden-header filter already drops it).
const ORIGIN_BOUND_CREDENTIAL_HEADERS = new Set(['authorization', 'proxy-authorization']);

function headersWithoutOriginBoundCredentials(headers) {
  const out = {};
  for (const key of Object.keys(headers || {})) {
    if (ORIGIN_BOUND_CREDENTIAL_HEADERS.has(String(key).toLowerCase())) continue;
    out[key] = headers[key];
  }
  return out;
}

// Execute the upstream request with manual redirect handling: every hop
// is re-validated for scheme and private addresses. Read-like requests
// follow redirects to any origin, with origin-bound credentials stripped
// on every cross-origin hop; side-effecting requests follow same-origin
// hops only (307/308 keep method+body; 301/302/303 downgrade to a
// body-less GET — the side effect is never replayed against another
// origin) and a cross-origin hop is refused. `controller` is owned by the
// caller and governs fetch AND the body-read lifecycle.
async function executeUpstream({ method, target, headers, body, maxRedirects, sideEffecting, controller }) {
  let current = target.href;
  let currentMethod = method;
  let currentBody = body;
  let currentHeaders = headers || {};
  let upstream = null;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    try {
      upstream = await fetch(current, {
        method: currentMethod,
        headers: currentHeaders,
        body: currentMethod === 'GET' || currentMethod === 'HEAD' ? undefined : currentBody,
        redirect: 'manual',
        signal: controller.signal,
      });
    } catch (e) {
      if (controller.signal.aborted) {
        return { error: relayError(504, 'Upstream timed out after ' + (controller._locusTimeoutMs || 30000) + 'ms', 'network_timeout') };
      }
      return { error: relayError(502, 'Upstream request failed') };
    }

    if (upstream.status >= 300 && upstream.status < 400) {
      const location = upstream.headers.get('location');
      if (!location) break; // redirect without Location: pass through as-is
      if (hop === maxRedirects) {
        return { error: relayError(508, 'Too many redirects (max ' + maxRedirects + ')', 'network_redirect_blocked') };
      }
      let next;
      try {
        next = new URL(location, current); // relative redirects resolve against the current hop
      } catch {
        return { error: relayError(502, 'Upstream returned an invalid redirect Location') };
      }
      if (next.protocol !== 'https:' && next.protocol !== 'http:') {
        return { error: relayError(403, 'Redirect target is not HTTP(S)', 'network_unsupported_scheme') };
      }
      if (isPrivateHostname(next.hostname)) {
        return { error: relayError(403, 'Private and loopback redirect targets are not allowed', 'network_private_address_blocked') };
      }
      const currentOrigin = new URL(current).origin;
      if (sideEffecting && next.origin !== currentOrigin) {
        return { error: relayError(403, 'Cross-origin redirect blocked for side-effecting requests', 'network_redirect_blocked') };
      }
      // CREDENTIAL AUTHORITY IS ORIGIN-BOUND: before dispatching a hop to
      // a different origin, strip Authorization / Proxy-Authorization from
      // the NEXT hop's headers. Never mutate the previous hop's object —
      // each hop keeps its own header set, so stripping is monotonic
      // (A → B → A does NOT restore the credential).
      if (next.origin !== currentOrigin) {
        currentHeaders = headersWithoutOriginBoundCredentials(currentHeaders);
      }
      if (sideEffecting && currentMethod !== 'GET' && currentMethod !== 'HEAD'
        && (upstream.status === 301 || upstream.status === 302 || upstream.status === 303)) {
        currentMethod = 'GET'; // method downgrade: the side effect is NOT replayed
        currentBody = undefined;
      }
      current = next.href;
      upstream = null;
      continue;
    }
    break; // final, authoritative HTTP response
  }

  if (!upstream) return { error: relayError(502, 'Upstream request failed') };
  return { upstream, finalUrl: current };
}

// Read an upstream response body with a hard byte cap. The caller's
// AbortController governs the whole body lifetime: a mid-body stall
// aborted by the timer surfaces as `timedOut` (→ 504), never as a
// size-cap or generic error.
async function readResponseCapped(upstream, maxBytes, controller) {
  const contentLength = Number.parseInt(upstream.headers.get('content-length') || '', 10);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    return { error: relayError(413, 'Upstream response too large', 'network_response_too_large') };
  }

  if (!upstream.body) {
    return { bytes: new Uint8Array(await upstream.arrayBuffer()) };
  }

  const reader = upstream.body.getReader();
  const chunks = [];
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel().catch(() => {});
        return { error: relayError(413, 'Upstream response too large', 'network_response_too_large') };
      }
      chunks.push(value);
    }
  } catch (e) {
    if (controller && controller.signal.aborted) return { timedOut: true };
    throw e;
  } finally {
    reader.releaseLock();
  }

  const merged = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes: merged };
}

// Frame the authoritative upstream response for the client: filtered
// headers, byte-exact body, final-URL exposure, de-privileged rendering.
// HEAD requests never carry a body: the declared entity length is
// forwarded when the upstream provided one, and nothing is read.
async function buildUpstreamResponse(upstream, finalUrl, maxBytes, controller, timeoutMs, method) {
  let bytes = new Uint8Array(0), bodyError, timedOut;
  if (method !== 'HEAD') {
    try {
      ({ bytes, error: bodyError, timedOut } = await readResponseCapped(upstream, maxBytes, controller));
    } catch (e) {
      if (controller.signal.aborted) {
        return relayError(504, 'Upstream timed out after ' + timeoutMs + 'ms', 'network_timeout');
      }
      return relayError(502, 'Upstream body read failed');
    }
    if (timedOut) return relayError(504, 'Upstream timed out after ' + timeoutMs + 'ms', 'network_timeout');
    if (bodyError) return bodyError;
  }

  const headers = new Headers(CORS_HEADERS);
  headers.set('X-Locus-Final-URL', finalUrl);
  // Pass the upstream's own headers through (minus hop-by-hop machinery,
  // the ambient-credential channel and the recomputed length) so the
  // client sees ordinary HTTP response headers. append() — never set() —
  // so genuinely duplicated upstream headers are never collapsed by THIS
  // code; where the underlying Fetch implementation has already combined
  // duplicates into one comma-joined value, that observable
  // representation is forwarded as-is (docs/NETWORK-RUNTIME.md).
  upstream.headers.forEach((value, name) => {
    const n = name.toLowerCase();
    if (STRIPPED_RESPONSE_HEADERS.has(n)
      || STRIPPED_RESPONSE_HEADER_PREFIXES.some((p) => n.startsWith(p))) {
      return;
    }
    headers.append(name, value);
  });
  if (NULL_BODY_STATUSES.has(upstream.status) || method === 'HEAD') {
    if (method === 'HEAD') {
      const declared = upstream.headers.get('content-length');
      headers.set('Content-Length',
        declared && /^\d+$/.test(declared) ? declared : '0');
    }
    return new Response(null, { status: upstream.status, headers });
  }
  const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
  const mime = contentType.split(';', 1)[0].trim().toLowerCase();
  if (ACTIVE_CONTENT_TYPES.has(mime)) {
    headers.set('Content-Security-Policy', 'sandbox');
  }
  headers.set('Content-Type', contentType);
  headers.set('Content-Length', String(bytes.byteLength));
  return new Response(bytes, { status: upstream.status, headers });
}

// Shared pipeline for both request forms. One AbortController governs the
// whole lifecycle: fetch start → headers → body complete.
async function handleRelayRequest({ method, target, headers, body, env }) {
  const timeoutMs = getTimeoutMs(env);
  const maxBytes = getMaxResponseBytes(env);
  const maxRedirects = getMaxRedirects(env);
  const sideEffecting = method !== 'GET' && method !== 'HEAD';

  const controller = new AbortController();
  controller._locusTimeoutMs = timeoutMs;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const executed = await executeUpstream({
      method, target, headers, body, maxRedirects, sideEffecting, controller,
    });
    if (executed.error) return executed.error;
    return await buildUpstreamResponse(executed.upstream, executed.finalUrl, maxBytes, controller, timeoutMs, method);
  } finally {
    clearTimeout(timer);
  }
}

// Read a request body with a hard byte cap (Content-Length is checked
// first; a chunked body is bounded by the stream loop).
async function readRequestCapped(request, maxBytes) {
  const contentLength = Number.parseInt(request.headers.get('content-length') || '', 10);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    return { error: relayError(413, 'Request body too large', 'network_request_too_large') };
  }
  if (!request.body) return { bytes: new Uint8Array(0) };
  const reader = request.body.getReader();
  const chunks = [];
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel().catch(() => {});
        return { error: relayError(413, 'Request body too large', 'network_request_too_large') };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes: merged };
}

function decodeBase64(b64) {
  try {
    const bin = atob(String(b64 || ''));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

// Same-origin enforcement shared by BOTH request forms (the legacy GET
// form and the POST envelope): a present Origin header must match the
// deployment origin — parsed with the URL/origin parser, never string
// matching, so lookalike suffix/prefix hosts and scheme/port variants
// are refused. A browser never sends Origin on a same-origin GET, so the
// internal legacy fallback is unaffected; other web pages cannot forge
// Origin. Non-browser clients sending no Origin remain the documented,
// bounded openness of this relay (not an auth system —
// docs/NETWORK-RUNTIME.md, "Relay openness").
function originEnforcementError(req) {
  const origin = req.headers.get('origin');
  if (!origin) return null;
  let deploymentOrigin = null;
  try {
    deploymentOrigin = new URL(req.url).origin;
  } catch { /* request URL is always absolute in Pages */ }
  if (deploymentOrigin && origin !== deploymentOrigin) {
    return relayError(403, 'Cross-origin use of this endpoint is not allowed', 'network_relay_failed');
  }
  return null;
}

// ------------------------------------------------------------
//  GET /fetch (legacy form: GET-only, no header/body channel)
// ------------------------------------------------------------
export async function onRequestGet(context) {
  const req = context.request;
  const env = context.env || {};

  const originError = originEnforcementError(req);
  if (originError) return originError;

  const pageUrl = new URL(req.url);
  const { target, error: targetError } = parseTarget(pageUrl.searchParams.get('url'));
  if (targetError) return targetError;

  return await handleRelayRequest({ method: 'GET', target, headers: undefined, body: undefined, env });
}

// ------------------------------------------------------------
//  POST /fetch (NetworkRuntime v1 envelope)
// ------------------------------------------------------------
export async function onRequestPost(context) {
  const req = context.request;
  const env = context.env || {};

  // Same-origin enforcement for the envelope form (shared with the
  // legacy GET form above): a present Origin must match the deployment.
  const originError = originEnforcementError(req);
  if (originError) return originError;

  const maxRequestBytes = getMaxRequestBytes(env);
  let raw;
  {
    const { bytes, error } = await readRequestCapped(req, maxRequestBytes);
    if (error) return error;
    raw = new TextDecoder().decode(bytes);
  }
  let envelope;
  try {
    envelope = JSON.parse(raw);
  } catch {
    return relayError(400, 'Invalid JSON envelope', 'network_invalid_url');
  }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    return relayError(400, 'Invalid JSON envelope', 'network_invalid_url');
  }

  const method = String(envelope.method || '').trim().toUpperCase();
  if (!RELAY_METHODS.has(method)) {
    return relayError(405, 'Unsupported HTTP method: ' + (method || '(empty)'), 'network_unsupported_method');
  }

  const { target, error: targetError } = parseTarget(envelope.url);
  if (targetError) return targetError;

  const { headers, error: headerError } = filterForwardHeaders(envelope.headers);
  if (headerError) return headerError;

  let body;
  if (envelope.bodyBase64 != null) {
    if (method === 'GET' || method === 'HEAD') {
      return relayError(400, 'GET/HEAD requests cannot carry a body', 'network_invalid_url');
    }
    body = decodeBase64(envelope.bodyBase64);
    if (!body) return relayError(400, 'Invalid base64 body', 'network_invalid_url');
    if (body.byteLength > maxRequestBytes) {
      return relayError(413, 'Request body too large', 'network_request_too_large');
    }
  }

  return await handleRelayRequest({ method, target, headers, body, env });
}

// OPTIONS /fetch (CORS preflight)
export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}
