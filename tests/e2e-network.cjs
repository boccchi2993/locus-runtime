// NetworkRuntime v1 browser e2e (M3a extraction form; source suite ran as
// the 'network' suite of the product orchestrator).
//
// Self-contained: builds the runtime host page, serves it from a
// local HTTP origin together with the REAL relay code
// (tests/fixtures/relay/fetch.js — a provenance-noted copy of the product
// repository's functions/fetch.js, the actual Cloudflare Pages Function
// handlers dispatched through undici Request/Response), and runs a second
// local "internet" target server. Drives the packaged browser shell
// (`curl` through the public RuntimeSession) plus a SCRIPTED execution
// authorization port — the Runtime has no approval UI; the port carries
// the same decision contract (allow once / deny / session grant / cancel),
// and the interactive wait/decide flow mirrors what the ApprovalCard did.
//
// Topology:
//   app origin   http://127.0.0.1:APP    dist/ + /fetch (real relay) + /locus/echo
//   target origin http://127.0.0.1:TARGET (the "internet": CORS-ok, hostile,
//                404, echo, once-only, binary, oversized …)
//   api.test.local / api2.test.local  →  mapped to 127.0.0.1 by Chrome
//   (--host-resolver-rules) and by a fetch patch inside the relay process,
//   so the relay's hostname-based private-address policy accepts them.
//
// Covered matrix (docs/NETWORK-RUNTIME.md, §e2e N1-N12): direct GET,
// hostile GET → relay, authoritative 404 (no relay retry), POST approval
// (Allow once / Deny / session grant exact-origin / cancel TOCTOU /
// ambiguous no-retry), binary -o byte-exactness, response caps, private
// relay block and Authorization non-leakage.
const { spawnSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');
const {
  allocateFreePort,
  closeChrome,
  connectToTarget,
  launchChrome,
  waitForCdp,
  waitForPageTarget,
  waitForRuntimeCondition,
} = require('./helpers/chrome.cjs');

const ROOT = path.join(__dirname, '..');
const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0xFF, 0xFE, 0x80,
  ...Array.from({ length: 244 }, (_, i) => (i * 31 + 7) & 0xFF),
]);
const BIG_BYTES = 17 * 1024 * 1024; // > 16 MiB response cap

// ---------- shared counters (both servers live in this process) ----------
const hits = Object.create(null);
let relayCalls = 0;
const authSeen = Object.create(null); // origin A's view of a redirected credential
function hit(p) { hits[p] = (hits[p] || 0) + 1; }

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function json(res, status, body, headers) {
  const h = Object.assign({ 'content-type': 'application/json' }, headers || {});
  res.writeHead(status, h);
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

// ---------- target server (stands in for the internet) ----------
const BIG = Buffer.alloc(BIG_BYTES, 0x41);
function startTargetServer(port) {
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      const p = req.url.split('?')[0];
      const cors = { 'access-control-allow-origin': '*' };
      if (p === '/target/counts') {
        return json(res, 200, { hits, relay: relayCalls, auth: authSeen }, cors);
      }
      hit(p);
      if (p === '/target/cors-ok') {
        return json(res, 200, { cors: 'ok' }, cors);
      }
      if (p === '/target/cred-check') {
        // redirect landing origin (B): reports what credentials it received
        return json(res, 200, { authorization: req.headers.authorization || null }, cors);
      }
      if (p === '/target/redirect-away') {
        // origin A: records its own view, then 302s to a DIFFERENT origin
        authSeen.redirectAway = req.headers.authorization || null;
        res.writeHead(302, { location: 'http://api2.test.local:' + port + '/target/cred-check' });
        return res.end();
      }
      if (p === '/target/redirect-mapped') {
        res.writeHead(302, { location: 'http://[::ffff:127.0.0.1]:' + port + '/target/mapped-catch' });
        return res.end();
      }
      if (p === '/target/mapped-catch') {
        return json(res, 200, { reached: true }, cors);
      }
      if (p === '/target/head') {
        // deliberately NO CORS headers: the direct HEAD attempt must fail
        // so the relay HEAD fallback is exercised; the method seen here is
        // recorded for the fidelity assertion.
        authSeen.headMethod = req.method;
        res.writeHead(200, { 'content-type': 'text/plain', 'x-head': 'yes' });
        return res.end();
      }
      if (p === '/target/hostile') {
        // deliberately NO CORS headers: the page cannot read the response
        res.writeHead(200, { 'content-type': 'text/plain' });
        return res.end('hostile-secret-body');
      }
      if (p === '/target/notfound') {
        // N17d: record what the wire ACTUALLY delivered — query-string
        // redaction is display-only, the request itself is untouched.
        authSeen.notfoundQuery = req.url;
        return json(res, 404, { error: 'not found' }, cors);
      }
      if (p === '/target/echo' && (req.method === 'POST' || req.method === 'PUT')) {
        const body = await readBody(req);
        return json(res, 200, {
          method: req.method,
          authorization: req.headers.authorization || null,
          contentType: req.headers['content-type'] || null,
          xCustom: req.headers['x-custom'] || null,
          bodyLen: body.length,
          bodyB64: body.toString('base64'),
        }, cors);
      }
      if (p === '/target/once-only') {
        await readBody(req).catch(() => {});
        // The side effect "happened" — now the response is lost.
        setImmediate(() => req.socket.destroy());
        return;
      }
      if (p === '/target/binary') {
        res.writeHead(200, Object.assign({
          'content-type': 'image/png',
          'content-length': String(PNG_BYTES.length),
        }, cors));
        return res.end(PNG_BYTES);
      }
      if (p === '/target/big') {
        res.writeHead(200, Object.assign({
          'content-type': 'application/octet-stream',
          'content-length': String(BIG_BYTES),
        }, cors));
        return res.end(BIG);
      }
      if (p === '/target/big-stream') {
        res.writeHead(200, Object.assign({ 'content-type': 'application/octet-stream' }, cors));
        let sent = 0;
        const chunk = Buffer.alloc(1024 * 1024, 0x42);
        const timer = setInterval(() => {
          if (sent >= BIG_BYTES || res.destroyed) { clearInterval(timer); return res.end(); }
          sent += chunk.length;
          res.write(chunk);
        }, 5);
        return;
      }
      res.writeHead(404);
      res.end('no such target');
    });
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

// ---------- app server (dist + REAL relay handlers + same-origin echo) ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
};
const echoLog = Object.create(null);
function startAppServer(port, distDir, relay) {
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      const p = req.url.split('?')[0];
      if (p === '/fetch') {
        relayCalls++;
        const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req);
        const headers = Object.assign({}, req.headers);
        delete headers.host;
        delete headers['content-length'];
        delete headers.connection;
        let request;
        try {
          request = new Request('http://127.0.0.1:' + port + req.url, {
            method: req.method,
            headers,
            body,
          });
        } catch (e) {
          return json(res, 400, { error: { code: 'network_invalid_url', message: 'bad relay request' } });
        }
        const handler = req.method === 'POST' ? relay.onRequestPost
          : req.method === 'OPTIONS' ? relay.onRequestOptions : relay.onRequestGet;
        let resp;
        try {
          resp = await handler({ request, env: {} });
        } catch (e) {
          return json(res, 500, { error: { code: 'network_relay_failed', message: String(e && e.message || e) } });
        }
        const outHeaders = {};
        resp.headers.forEach((v, k) => { outHeaders[k] = v; });
        res.writeHead(resp.status, outHeaders);
        if (resp.status === 204 || resp.status === 205 || resp.status === 304) return res.end();
        return res.end(Buffer.from(await resp.arrayBuffer()));
      }
      if (p === '/locus/echo' && (req.method === 'POST' || req.method === 'PUT')) {
        hit('/locus/echo');
        const body = await readBody(req);
        echoLog[p] = {
          method: req.method,
          authorization: req.headers.authorization || null,
          bodyLen: body.length,
        };
        return json(res, 200, { echoed: body.length, method: req.method }, {
          'access-control-allow-origin': '*',
        });
      }
      // static dist/
      let rel = p === '/' ? '/index.html' : p;
      const file = path.join(distDir, rel);
      if (!file.startsWith(distDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404);
        return res.end('not found');
      }
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

// ---------- page driver ----------
const PAGE_SCRIPT = String.raw`
(async () => {
  const out = [];
  const check = (name, cond, detail) =>
    out.push((cond ? 'PASS ' : 'NET-FAIL ') + name + (detail !== undefined ? ' | ' + String(detail).slice(0, 300) : ''));
  // M3a: the scripted execution-authorization port. The Runtime has no
  // approval UI; this port carries the same decision contract the product
  // ApprovalController implements (single pending ask, allow once / deny /
  // exact-origin session grant, deny != cancel). waitAsk/decide replace
  // waitCard/clickBtn; the assertions on the ASK CONTENT (N4b/c/d) read
  // the request object the Runtime constructed — the same object the card
  // used to render.
  function makeApprovalPort() {
    const grants = new Set();
    let pending = null; // { req, resolve }
    return {
      port: {
        request: (req, opts) => {
          if (grants.has(req.policyKey)) return Promise.resolve({ outcome: 'allow', scope: 'session' });
          if (pending) return Promise.reject(new Error('authorization port: a request is already pending'));
          return new Promise((resolve) => {
            pending = { req, resolve };
            // Consumer contract: a task cancellation while the ask is
            // pending resolves it as CANCELLED (deny != cancel — N7 pins
            // the distinction through this port exactly as the real
            // ApprovalController provides it).
            const signal = opts && opts.signal;
            const onAbort = () => {
              if (pending && pending.req === req) {
                const p = pending;
                pending = null;
                p.resolve({ outcome: 'cancelled', scope: 'once' });
              }
            };
            if (signal) {
              if (signal.aborted) onAbort();
              else signal.addEventListener('abort', onAbort, { once: true });
            }
          });
        },
      },
      hasPending: () => !!pending,
      ask: () => pending ? pending.req : null,
      decide: (decision) => {
        const p = pending;
        if (!p) return false;
        pending = null;
        if (decision && decision.outcome === 'allow' && decision.scope === 'session') grants.add(p.req.policyKey);
        p.resolve(decision);
        return true;
      },
      stateText: () => JSON.stringify({ pending: pending ? pending.req : null, grants: [...grants] }),
    };
  }
  const approval = makeApprovalPort();
  const H = window.__host;
  const exec = (cmd, opts) => H.exec(cmd, Object.assign({ authorization: approval.port }, opts || {}));
  const counts = async () => {
    const r = await fetch(TARGET + '/target/counts');
    return await r.json();
  };
  const waitAsk = async (ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 5000)) {
      if (approval.hasPending()) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return false;
  };
  const askGone = async (ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 5000)) {
      if (!approval.hasPending()) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return false;
  };
  const decide = (label) => {
    if (label === 'Allow once') return approval.decide({ outcome: 'allow', scope: 'once' });
    if (label === 'Allow for this session') return approval.decide({ outcome: 'allow', scope: 'session' });
    if (label === 'Deny') return approval.decide({ outcome: 'deny', scope: 'once' });
    return false;
  };
  const askText = () => JSON.stringify(approval.ask());
  // Counter snapshots — assertions use DELTAS so the suite never depends
  // on absolute counts accumulated by earlier steps.
  const snapshot = async () => await counts();

  // ---------- N1 direct GET (CORS-enabled, cross-origin) ----------
  {
    const s = await snapshot();
    const r = await exec('curl ' + TARGET + '/target/cors-ok');
    const c = await snapshot();
    check('N1 direct GET succeeds', r.success && r.output.includes('"cors":"ok"'), JSON.stringify(r));
    check('N1b backend browser-direct, relay untouched', r.backend === 'browser-direct' && c.relay === s.relay,
      r.backend + ' relayDelta=' + (c.relay - s.relay));
    check('N1c exactly one target hit', (c.hits['/target/cors-ok'] || 0) - (s.hits['/target/cors-ok'] || 0) === 1,
      JSON.stringify(c.hits));
  }

  // ---------- N2 hostile GET → transparent relay ----------
  {
    const s = await snapshot();
    const r = await exec('curl ' + API + '/target/hostile');
    const c = await snapshot();
    check('N2 hostile GET succeeds via relay', r.success && r.output.includes('hostile-secret-body'), JSON.stringify(r));
    check('N2b model sees ordinary HTTP (edge-relay, one retry)',
      r.backend === 'edge-relay' && c.relay - s.relay === 1 && (c.hits['/target/hostile'] || 0) - (s.hits['/target/hostile'] || 0) === 2,
      r.backend + ' relayDelta=' + (c.relay - s.relay) + ' hits=' + JSON.stringify(c.hits));
  }

  // ---------- N3 404 is authoritative — no relay retry ----------
  {
    const s = await snapshot();
    const r = await exec('curl ' + TARGET + '/target/notfound');
    const c = await snapshot();
    check('N3 404 reported', !r.success && r.output.includes('HTTP 404'), JSON.stringify(r));
    check('N3b no relay retry after real HTTP response', c.relay === s.relay && r.backend === 'browser-direct',
      'relayDelta=' + (c.relay - s.relay) + ' backend=' + r.backend);
  }

  // ---------- N4 POST + approval Allow once (+ secret never on the card) ----------
  {
    const s = await snapshot();
    const p = exec("curl -X POST " + API + "/target/echo -H 'Authorization: Bearer sekrit-N4' -H 'X-Custom: custom-N4' -d 'n4-body'");
    const card = await waitAsk();
    const ask4 = approval.ask();
    check('N4 approval card appears', card, 'no card');
    check('N4b Authorization never rendered', !askText().includes('sekrit-N4'), 'leaked');
    check('N4c card asks for the canonical origin', ask4 && ask4.action && ask4.action.summary === 'POST ' + API + '/target/echo'
      && ask4.resource && ask4.resource.key === API, askText().slice(0, 200));
    check('N4d body-size detail without content', ask4 && ask4.action && /Request body size: 7 B/.test(ask4.action.detail || '')
      && !askText().includes('n4-body'), 'detail missing or body shown');
    check('N4e Allow once clicked', decide('Allow once'), 'no ask');
    const r = await p;
    const c = await snapshot();
    check('N4f request sent exactly once via relay', r.success && c.relay - s.relay === 1 && r.backend === 'edge-relay',
      JSON.stringify(r));
    check('N4g wire carries Authorization + exact body',
      r.output.includes('Bearer sekrit-N4') && r.output.includes('"bodyB64":"' + btoa('n4-body') + '"'),
      JSON.stringify(r.output));
    check('N4h card closed', await askGone(), 'ask stuck');
  }

  // ---------- N5 POST + Deny → deterministic error, task continues ----------
  {
    const s = await snapshot();
    const p = exec('curl -X POST ' + API + '/target/echo -d \'n5-body\'');
    await waitAsk();
    decide('Deny');
    const r = await p;
    const c = await snapshot();
    check('N5 deny → deterministic result, zero attempts',
      !r.success && r.output === 'curl: network request denied by user'
      && (c.hits['/target/echo'] || 0) === (s.hits['/target/echo'] || 0) && c.relay === s.relay,
      JSON.stringify(r) + ' relayDelta=' + (c.relay - s.relay));
  }

  // ---------- N6 session grant: exact origin only ----------
  {
    const s = await snapshot();
    const p = exec('curl -X POST ' + API + '/target/echo -d \'n6a\'');
    await waitAsk();
    decide('Allow for this session');
    const r = await p;
    const c1 = await snapshot();
    check('N6 grant covers same origin', r.success && (c1.hits['/target/echo'] || 0) - (s.hits['/target/echo'] || 0) === 1,
      JSON.stringify(r));
    // second POST to the SAME origin: no ask
    const p2 = exec('curl -X POST ' + API + '/target/echo -d \'n6b\'');
    const asked = await waitAsk(1200);
    let r2 = null;
    if (asked) { decide('Deny'); r2 = await p2; }
    else r2 = await p2;
    const c2 = await snapshot();
    check('N6b same-origin write does not ask again', !asked && r2.success
      && (c2.hits['/target/echo'] || 0) - (c1.hits['/target/echo'] || 0) === 1, 'asked=' + asked);
    // a DIFFERENT origin still asks
    const p3 = exec('curl -X POST ' + API2 + '/target/echo -d \'n6c\'');
    const asked3 = await waitAsk();
    check('N6c sibling origin asks again', asked3, 'no ask');
    decide('Deny');
    const r3 = await p3;
    const c3 = await snapshot();
    check('N6d sibling origin deny → not sent', !r3.success
      && (c3.hits['/target/echo'] || 0) === (c2.hits['/target/echo'] || 0), JSON.stringify(r3));
  }

  // ---------- N7 cancel while pending (TOCTOU start) ----------
  {
    const s = await snapshot();
    window.__n7ac = new AbortController();
    const p = exec('curl -X POST ' + API2 + '/target/echo -d \'n7-body\'', { signal: window.__n7ac.signal });
    const card = await waitAsk();
    check('N7 card appears', card, 'no ask');
    window.__n7ac.abort();
    const r = await p;
    const c = await snapshot();
    check('N7b cancel → cancelled (not denied), zero attempts',
      !r.success && r.output === 'curl: cancelled'
      && (c.hits['/target/echo'] || 0) === (s.hits['/target/echo'] || 0) && c.relay === s.relay,
      JSON.stringify(r) + ' relayDelta=' + (c.relay - s.relay));
    check('N7c card closed after cancel', await askGone(), 'ask stuck');
  }

  // ---------- N8 ambiguous failure after dispatch → NO retry ----------
  {
    const s = await snapshot();
    const r = await exec('curl -X POST ' + API + '/target/once-only -d \'n8-body\'');
    const c = await snapshot();
    check('N8 ambiguous failure reported honestly',
      !r.success && /NOT retried|may or may not have reached/.test(r.output), JSON.stringify(r));
    check('N8b exactly ONE upstream attempt (no duplicate side effect)',
      (c.hits['/target/once-only'] || 0) - (s.hits['/target/once-only'] || 0) === 1 && c.relay - s.relay === 1,
      'hitsDelta=' + ((c.hits['/target/once-only'] || 0) - (s.hits['/target/once-only'] || 0))
      + ' relayDelta=' + (c.relay - s.relay));
  }

  // ---------- N9 binary -o byte-exact ----------
  {
    const r = await exec('curl -o /mnt/download/net-n9.bin ' + TARGET + '/target/binary');
    let bytes = null;
    try { bytes = await window.__host.vfs.readBytes('/mnt/download/net-n9.bin'); } catch (e) {}
    const expected = PNG_BYTES_ARRAY;
    const exact = !!bytes && bytes.length === expected.length && expected.every((b, i) => bytes[i] === b);
    check('N9 binary download byte-exact', r.success && exact, JSON.stringify(r.output));
  }

  // ---------- N10 response caps (Content-Length + streaming) ----------
  {
    const s = await snapshot();
    const r = await exec('curl ' + API + '/target/big');
    const c = await snapshot();
    check('N10 oversized response bounded', !r.success && r.output.includes('too large'), JSON.stringify(r.output));
    check('N10b cap is not a network failure → no relay retry', c.relay === s.relay, 'relayDelta=' + (c.relay - s.relay));
    const r2 = await exec('curl ' + API + '/target/big-stream');
    check('N10c streaming oversized response aborted mid-stream',
      !r2.success && r2.output.includes('too large'), JSON.stringify(r2.output));
  }

  // ---------- N11 private target on the relay leg → blocked pre-approval ----------
  {
    const s = await snapshot();
    const p = exec('curl -X POST ' + TARGET + '/target/echo -d \'n11\'');
    const card = await waitAsk(1000);
    let r = null;
    if (card) { decide('Allow once'); r = await p; }
    else r = await p;
    const c = await snapshot();
    check('N11 private cross-origin POST blocked before any send',
      !r.success && r.output.includes('private or loopback'), JSON.stringify(r));
    check('N11b no approval asked, no relay call, no echo hit',
      !card && c.relay === s.relay && (c.hits['/target/echo'] || 0) === (s.hits['/target/echo'] || 0),
      'card=' + card + ' relayDelta=' + (c.relay - s.relay) + ' echoDelta='
      + ((c.hits['/target/echo'] || 0) - (s.hits['/target/echo'] || 0)));
  }

  // ---------- N12 secrets never leak into telemetry / events ----------
  {
    // M3a: the Runtime records no execution telemetry; the authorization
    // port state is the only approval-side store.
    const tele = '[]';
    const store = approval.stateText();
    check('N12 Authorization absent from telemetry and approval state',
      !tele.includes('sekrit-N4') && !store.includes('sekrit-N4'), 'leaked');
    check('N12b no approval left pending', !approval.hasPending(), 'ask present');
  }

  // ---------- N13 cross-origin redirect strips Authorization (N-F01) ----------
  {
    const s = await snapshot();
    const r = await exec('curl -H \'Authorization: Bearer N13\' ' + API + '/target/redirect-away');
    const c = await snapshot();
    check('N13 origin A received the credential',
      c.auth && c.auth.redirectAway === 'Bearer N13', JSON.stringify(c.auth));
    check('N13b landing origin B did NOT receive it',
      r.success && r.output.includes('"authorization":null'), JSON.stringify(r.output));
    check('N13c one relay leg (the direct leg only adds a preflight OPTIONS hit)',
      c.relay - s.relay === 1
      && (c.hits['/target/redirect-away'] || 0) - (s.hits['/target/redirect-away'] || 0) === 2
      && (c.hits['/target/cred-check'] || 0) - (s.hits['/target/cred-check'] || 0) === 1,
      'relayDelta=' + (c.relay - s.relay) + ' hits=' + JSON.stringify(c.hits));
  }

  // ---------- N14 mapped IPv6 private target blocked pre-approval (N-F02) ----------
  {
    const s = await snapshot();
    const p = exec('curl -X POST "http://[::ffff:127.0.0.1]:' + TARGET_PORT + '/target/echo" -d \'n14\'');
    const card = await waitAsk(1000);
    let r = null;
    if (card) { decide('Allow once'); r = await p; }
    else r = await p;
    const c = await snapshot();
    check('N14 mapped-IPv6 loopback POST blocked before any send',
      !r.success && r.output.includes('private or loopback'), JSON.stringify(r));
    check('N14b no approval asked, no relay call, no echo hit',
      !card && c.relay === s.relay && (c.hits['/target/echo'] || 0) === (s.hits['/target/echo'] || 0),
      'card=' + card + ' relayDelta=' + (c.relay - s.relay) + ' echoDelta='
      + ((c.hits['/target/echo'] || 0) - (s.hits['/target/echo'] || 0)));
  }

  // ---------- N15 public → mapped-private redirect blocked (N-F02) ----------
  {
    const s = await snapshot();
    const r = await exec('curl ' + API + '/target/redirect-mapped');
    const c = await snapshot();
    check('N15 redirect to mapped-IPv6 loopback refused by the relay leg',
      !r.success && r.output.includes('Private and loopback redirect targets are not allowed'),
      JSON.stringify(r));
    check('N15b the private hop was never attempted',
      (c.hits['/target/mapped-catch'] || 0) === 0 && c.relay - s.relay === 1,
      'mappedHits=' + (c.hits['/target/mapped-catch'] || 0) + ' relayDelta=' + (c.relay - s.relay));
  }

  // ---------- N16 legacy GET relay still reachable from the app origin (N-F03) ----------
  {
    const s = await snapshot();
    // browser same-origin GET /fetch carries no mismatched Origin: the
    // legacy path must keep working (the target is the mapped
    // api.test.local name — literal 127.0.0.1 is refused by the relay's
    // private-address policy). Evil-Origin rejection is proven
    // server-side in main() against the real handler.
    const lr = await fetch('/fetch?url=' + encodeURIComponent(API + '/target/cors-ok'));
    check('N16 legacy GET relay works from the app origin', lr.status === 200, 'status=' + lr.status);
    check('N16b same-origin legacy leg made exactly one relay call',
      (await counts()).relay - s.relay === 1, 'relayDelta=' + ((await counts()).relay - s.relay));
  }

  // ---------- N17 query secret absent from output and telemetry (N-F04) ----------
  {
    const r = await exec('curl "' + TARGET + '/target/notfound?token=SECRET_QUERY_123"');
    check('N17 404 reported without the query secret',
      !r.success && r.output.includes('HTTP 404') && !r.output.includes('SECRET_QUERY_123'),
      JSON.stringify(r.output));
    check('N17b safe display keeps the path',
      r.output.includes('/target/notfound'), JSON.stringify(r.output));
    const tele = typeof Telemetry !== 'undefined' && Telemetry.records ? JSON.stringify(Telemetry.records) : '[]';
    check('N17c telemetry records hide the query secret', !tele.includes('SECRET_QUERY_123'), 'leaked');
    const c17 = await counts();
    check('N17d wire kept the query secret (display-only redaction)',
      ((c17.auth && c17.auth.notfoundQuery) || '').includes('SECRET_QUERY_123'),
      JSON.stringify(c17.auth));
  }

  // ---------- N18 mid-body TypeError after Response → no relay fallback (N-F06) ----------
  {
    const s = await snapshot();
    const orig = window.fetch;
    window.fetch = async function (u, o) {
      window.fetch = orig; // wrap only the next call: the direct attempt
      const res = await orig.call(window, u, o);
      const bad = new ReadableStream({
        start(ctrl) { ctrl.enqueue(new TextEncoder().encode('half')); },
        pull() { throw new TypeError('simulated mid-body failure'); },
      });
      return new Response(bad, { status: res.status, statusText: res.statusText, headers: res.headers });
    };
    const r = await exec('curl ' + TARGET + '/target/cors-ok');
    const c = await snapshot();
    check('N18 post-Response body TypeError fails the direct leg without a relay retry',
      !r.success && r.output.includes('NOT retried'), JSON.stringify(r));
    check('N18b zero relay calls (a real Response existed)',
      c.relay === s.relay && (c.hits['/target/cors-ok'] || 0) - (s.hits['/target/cors-ok'] || 0) === 1,
      'relayDelta=' + (c.relay - s.relay));
  }

  // ---------- N19 HEAD fallback remains HEAD (N-F09) ----------
  {
    const s = await snapshot();
    const r = await exec('curl -I ' + API + '/target/head');
    const c = await snapshot();
    check('N19 curl -I shows real response headers via the fallback',
      r.success && r.output.includes('HTTP 200') && r.output.includes('x-head: yes'), JSON.stringify(r.output));
    check('N19b no HEAD body surfaced', !r.output.includes('hostile-secret'), JSON.stringify(r.output));
    check('N19c one relay leg, upstream saw method HEAD',
      c.relay - s.relay === 1 && c.auth && c.auth.headMethod === 'HEAD',
      'relayDelta=' + (c.relay - s.relay) + ' headMethod=' + (c.auth && c.auth.headMethod));
  }

  // ---------- N20 malformed URL is never echoed raw (R-NF04C) ----------
  {
    const s = await snapshot();
    const r = await exec('curl "ht tp://example.com/?token=SECRET_BROWSER_E2E"');
    const c = await snapshot();
    check('N20 malformed URL fails bounded without echoing raw input',
      !r.success && r.output.includes('invalid URL')
      && !r.output.includes('SECRET_BROWSER_E2E') && !r.output.includes('ht tp'),
      JSON.stringify(r.output));
    check('N20b zero network attempts (no relay leg, no target hit)',
      c.relay - s.relay === 0
      && (c.hits['/target/cors-ok'] || 0) === (s.hits['/target/cors-ok'] || 0)
      && (c.hits['/target/hostile'] || 0) === (s.hits['/target/hostile'] || 0),
      'relayDelta=' + (c.relay - s.relay));
    const tele = typeof Telemetry !== 'undefined' && Telemetry.records ? JSON.stringify(Telemetry.records) : '[]';
    check('N20c telemetry hides the malformed sentinel', !tele.includes('SECRET_BROWSER_E2E'), 'leaked');
  }

  // ---------- N21 substrate metadata stays out of model-visible output (R-NF05A′) ----------
  {
    const direct = await exec('curl ' + TARGET + '/target/cors-ok');
    check('N21 browser-direct route: output names no backend',
      direct.success && !direct.output.includes('backend:')
      && !direct.output.includes('browser-direct') && !direct.output.includes('edge-relay'),
      JSON.stringify(direct.output));
    const relayed = await exec('curl -I ' + API + '/target/head');
    check('N21b edge-relay route: output names no backend',
      relayed.success && relayed.output.includes('HTTP 200')
      && !relayed.output.includes('backend:')
      && !relayed.output.includes('browser-direct') && !relayed.output.includes('edge-relay'),
      JSON.stringify(relayed.output));
    check('N21c internal tool result still carries the backend',
      direct.backend === 'browser-direct' && relayed.backend === 'edge-relay',
      JSON.stringify({ direct: direct.backend, relayed: relayed.backend }));
    // M3a: N21d moved to the Product tool-adapter suite — the telemetry
    // record with backend attribution is the executeTool sink; the Runtime
    // pins the internal-result half in N21c above.
    check('N21d the Runtime records no execution telemetry at all',
      typeof Telemetry === 'undefined', 'a Telemetry global leaked into the runtime page');
  }

  return out.join('\n');
})()`;
// TARGET_PORT: injected numeric port for mapped-IPv6 literals (the origin
// string form 'http://127.0.0.1:<port>' cannot be reused inside a URL host).


async function main() {
  let failed = false;
  let chrome = null;
  let servers = [];
  try {
    // 1. dist — ALWAYS rebuilt: this suite exercises the CURRENT runtime
    // sources, never a stale bundle left over from an earlier run.
    const distDir = path.join(ROOT, 'dist');
    {
      const build = spawnSync(process.execPath, [path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'build'], {
        stdio: 'inherit', cwd: ROOT,
      });
      if (build.status !== 0) throw new Error('vite build failed');
    }

    // 2. ports
    const appPort = await allocateFreePort();
    const targetPort = await allocateFreePort();

    // 3. relay import + upstream fetch patch (test-host mapping only)
    // M3a: the relay fixture is a provenance-noted copy of the product
    // repository's functions/fetch.js (the reference /fetch contract).
    const relay = await import('file://' + path.join(ROOT, 'tests', 'fixtures', 'relay', 'fetch.js').replace(/\\/g, '/'));
    const realFetch = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      const u = typeof input === 'string' ? input : (input && input.url) || String(input);
      const m = /^http:\/\/(api\.test\.local|api2\.test\.local)(:\d+)?/.exec(u);
      if (m) return realFetch(u.replace(m[0], 'http://127.0.0.1:' + targetPort), init);
      return realFetch(input, init);
    };

    // 4. servers
    servers.push(await startTargetServer(targetPort));
    servers.push(await startAppServer(appPort, distDir, relay));
    const appUrl = 'http://127.0.0.1:' + appPort + '/tests/runtime-host.html';
    const targetOrigin = 'http://127.0.0.1:' + targetPort;

    // 5. browser
    chrome = await launchChrome(appUrl, {
      chromePath: process.env.CHROME,
      label: 'network Chrome',
      extraArgs: [
        '--window-size=1440,900',
        '--host-resolver-rules=MAP api.test.local 127.0.0.1,MAP api2.test.local 127.0.0.1',
      ],
    });
    await waitForCdp(chrome, { timeoutMs: 15000 });
    const target = await waitForPageTarget(chrome, appUrl, { timeoutMs: 15000 });
    const cdp = await connectToTarget(target);
    await waitForRuntimeCondition(cdp,
      '!!(window.__host && window.__host.ready && window.__host.vfs)',
      { process: chrome, phase: 'network-app-boot', description: 'network e2e unavailable: app did not boot', timeoutMs: 20000 });

    // 6. inject topology constants, then run the matrix
    const script = PAGE_SCRIPT.replace('(async () => {',
      '(async () => {\n'
      + '    const TARGET = ' + JSON.stringify(targetOrigin) + ';\n'
      + '    const API = ' + JSON.stringify('http://api.test.local:' + targetPort) + ';\n'
      + '    const API2 = ' + JSON.stringify('http://api2.test.local:' + targetPort) + ';\n'
      + '    const TARGET_PORT = ' + JSON.stringify(String(targetPort)) + ';\n'
      + '    const PNG_BYTES_ARRAY = ' + JSON.stringify(Array.from(PNG_BYTES)) + ';');
    const result = await cdp.send('Runtime.evaluate', {
      expression: script,
      awaitPromise: true,
      returnByValue: true,
      timeout: 180000,
    });
    const report = result && result.result && result.result.value;
    if (!report) {
      console.error('NO REPORT: ' + JSON.stringify(result).slice(0, 500));
      failed = true;
    } else {
      console.log(report);
      if (report.includes('NET-FAIL')) failed = true;
    }

    // N16 server-side (against the REAL handler): a hostile browser Origin
    // cannot drive the legacy GET relay; no Origin still can.
    {
      const evil = await relay.onRequestGet({
        request: new Request('http://127.0.0.1:' + appPort + '/fetch?url='
          + encodeURIComponent(targetOrigin + '/target/cors-ok'),
        { headers: { origin: 'https://evil.test' } }),
        env: {},
      });
      console.log((evil.status === 403 ? 'PASS ' : 'NET-FAIL ')
        + 'N16c evil Origin legacy GET rejected (got ' + evil.status + ')');
      if (evil.status !== 403) failed = true;
      const lookalike = await relay.onRequestGet({
        request: new Request('http://127.0.0.1:' + appPort + '/fetch?url='
          + encodeURIComponent(targetOrigin + '/target/cors-ok'),
        { headers: { origin: 'https://127.0.0.1.evil.test' } }),
        env: {},
      });
      console.log((lookalike.status === 403 ? 'PASS ' : 'NET-FAIL ')
        + 'N16d lookalike Origin legacy GET rejected (got ' + lookalike.status + ')');
      if (lookalike.status !== 403) failed = true;
    }
  } catch (error) {
    console.error(error && error.stack || error);
    failed = true;
  } finally {
    if (chrome) {
      const cleanup = await closeChrome(chrome);
      if (!cleanup.exited) console.error('network Chrome did not exit after bounded cleanup');
    }
    for (const s of servers) {
      try { await new Promise((r) => s.close(r)); } catch (e) { /* best effort */ }
    }
  }
  process.exit(failed ? 1 : 0);
}

main();
