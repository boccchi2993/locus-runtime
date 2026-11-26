// POSITIVE CONTROL for verify.cjs — TEST ONLY, never deployed, NOT a
// proposed relay.
//
// The harness reports relay verdicts by measuring, so a negative result is
// only worth what the instrument is worth. This file is the instrument's
// control: the smallest thing that does the two jobs the real relay is
// measured on —
//   (a) passes the upstream body through AS A STREAM (headers first, body
//       chunks as they arrive, no read-to-EOF in between);
//   (b) aborts the upstream fetch when the browser goes away
//       (context.request.signal) —
// and nothing else. Run with `--control`: the relay combinations are measured
// a second time with this module in place of functions/fetch.js. If the
// control passes where the real relay fails, the failure is in the relay
// code under test, not in the harness, its bridge or the fetch mapping; if
// the control fails too, the environment is at fault and the relay verdicts
// must be read as not verified.
//
// Deliberately NOT production-shaped: a fixed-host allowlist instead of the
// SSRF classifier, no caps, no redirect handling, no timeout, no Origin check.
// It only ever answers for the harness's own loopback stand-in.
const ALLOWED_HOST = 'mcp.test.local';
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
// hop-by-hop machinery and the ambient-credential channel, as functions/fetch.js strips them
const STRIPPED = new Set([
  'connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'te', 'trailer',
  'proxy-connection', 'set-cookie', 'content-length',
]);
const FORBIDDEN = new Set([
  'host', 'content-length', 'connection', 'transfer-encoding', 'upgrade', 'te',
  'trailer', 'keep-alive', 'expect', 'via', 'date', 'cookie', 'cookie2', 'dnt',
  'origin', 'referer', 'accept-charset', 'accept-encoding',
  'access-control-request-headers', 'access-control-request-method',
]);

function fail(status, message, code) {
  return Response.json({ error: { code: code || 'network_relay_failed', message } }, {
    status, headers: { 'access-control-allow-origin': '*', 'x-locus-relay-error': '1' },
  });
}

function parseTarget(raw) {
  let target;
  try { target = new URL(String(raw || '')); } catch (e) { return { error: fail(400, 'Invalid url', 'network_invalid_url') }; }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    return { error: fail(403, 'Only HTTP(S) URLs are supported', 'network_unsupported_scheme') };
  }
  if (target.username || target.password) return { error: fail(403, 'Credentials in URLs are not allowed', 'network_invalid_url') };
  if (target.hostname !== ALLOWED_HOST) {
    return { error: fail(403, 'Only the harness stand-in host is allowed', 'network_private_address_blocked') };
  }
  return { url: target.href };
}

// The two jobs: dispatch with the caller's signal, return the body unread.
async function passThrough(method, url, headers, body, signal) {
  let upstream;
  try {
    upstream = await fetch(url, {
      method,
      headers,
      body: method === 'GET' || method === 'HEAD' ? undefined : body,
      redirect: 'manual',
      signal,
    });
  } catch (e) {
    return fail(502, 'Upstream request failed');
  }
  const out = new Headers({
    'access-control-allow-origin': '*',
    'x-content-type-options': 'nosniff',
    'x-locus-final-url': url,
  });
  upstream.headers.forEach((value, name) => {
    if (!STRIPPED.has(name)) out.append(name, value);
  });
  const noBody = upstream.status === 204 || upstream.status === 205 || upstream.status === 304 || method === 'HEAD';
  return new Response(noBody ? null : upstream.body, { status: upstream.status, headers: out });
}

export async function onRequestPost(context) {
  const request = context.request;
  let envelope;
  try { envelope = await request.json(); } catch (e) { return fail(400, 'Invalid JSON envelope', 'network_invalid_url'); }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    return fail(400, 'Invalid JSON envelope', 'network_invalid_url');
  }
  const method = String(envelope.method || '').trim().toUpperCase();
  if (!METHODS.has(method)) return fail(405, 'Unsupported HTTP method', 'network_unsupported_method');
  const target = parseTarget(envelope.url);
  if (target.error) return target.error;
  const headers = {};
  for (const key of Object.keys(envelope.headers || {})) {
    const name = String(key).trim().toLowerCase();
    if (!name || FORBIDDEN.has(name) || name.startsWith('proxy-') || name.startsWith('sec-')) continue;
    headers[name] = String(envelope.headers[key]);
  }
  let body;
  if (envelope.bodyBase64 != null) {
    try {
      body = Uint8Array.from(atob(String(envelope.bodyBase64)), (c) => c.charCodeAt(0));
    } catch (e) {
      return fail(400, 'Invalid base64 body', 'network_invalid_url');
    }
  }
  return passThrough(method, target.url, headers, body, request.signal);
}

export async function onRequestGet(context) {
  const request = context.request;
  const target = parseTarget(new URL(request.url).searchParams.get('url'));
  if (target.error) return target.error;
  return passThrough('GET', target.url, {}, undefined, request.signal);
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': '*',
    },
  });
}
