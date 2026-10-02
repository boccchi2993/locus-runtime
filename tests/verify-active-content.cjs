// F05 verification: active content served by the /fetch relay must not
// execute as a same-origin page. This test forwards responses from the
// REAL functions/fetch.js handler (only the upstream payload is mocked)
// through a local HTTP server, navigates REAL headless Chrome to it, and
// checks whether the payload ran.
//
//   /set-secret  app page: sessionStorage.setItem('apiKey', 'sk-demo')
//   /control     payload WITHOUT isolation headers (pre-fix behavior)
//   /fixed       response produced by the real onRequestGet handler
//
// Expected: control exfiltrates (GET /exfil?k=sk-demo hits the server);
// the real handler's response neutralizes the payload (CSP sandbox), so no
// /exfil hit and window.__pwned unset. If functions/fetch.js ever loses
// its isolation headers, the FIXED check fails — the test exercises the
// shipped artifact, not a handwritten header copy.
//
// Run: node tests/verify-active-content.cjs
// Uses its own isolated Chrome instance. No external network needed.

const http = require('http');
const {
  closeChrome,
  connectToTarget,
  launchChrome,
  waitForCdp,
  waitForHttp,
  waitForPageTarget,
  waitForRuntimeCondition,
} = require('./helpers/chrome.cjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PAYLOAD = '<!doctype html><html><body><script>\n' +
  'window.__pwned = true;\n' +
  'document.title = "PWNED";\n' +
  'try { fetch("/exfil?k=" + encodeURIComponent(sessionStorage.getItem("apiKey") || "none")); } catch (e) {}\n' +
  '</script></body></html>';

const UPSTREAM_URL = 'https://evil.test/p';

// Mock only the UPSTREAM network: the real handler's fetch() of the target
// URL returns our harmless-but-active payload. Everything else (status,
// headers incl. CSP/nosniff, body) comes from the real handler.
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  if (String(url) === UPSTREAM_URL) {
    return new Response(PAYLOAD, {
      status: 200,
      headers: { 'content-type': 'text/html', 'content-length': String(Buffer.byteLength(PAYLOAD)) },
    });
  }
  // CDP / local HTTP calls made by this script itself use undici's fetch —
  // route them back to the real implementation.
  return realFetch(url, opts);
};

const exfilHits = [];
let handler; // real onRequestGet from functions/fetch.js

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/set-secret') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><script>sessionStorage.setItem("apiKey","sk-demo");document.title="APP";</script>');
  } else if (u.pathname === '/control') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(PAYLOAD);
  } else if (u.pathname === '/fixed') {
    try {
      const cfRes = await handler({
        request: new Request('http://local.test/fetch?url=' + encodeURIComponent(UPSTREAM_URL)),
        env: {},
      });
      const headers = {};
      cfRes.headers.forEach((v, k) => { headers[k] = v; });
      delete headers['content-length']; // re-computed by res.end with the exact body
      res.writeHead(cfRes.status, headers);
      res.end(Buffer.from(await cfRes.arrayBuffer()));
    } catch (e) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('handler threw: ' + (e && e.stack || e));
    }
  } else if (u.pathname === '/exfil') {
    exfilHits.push(u.searchParams.get('k'));
    res.writeHead(204);
    res.end();
  } else {
    res.writeHead(404);
    res.end();
  }
});

async function main() {
  let chrome;
  let cdp;
  let httpPort;
  try {
    // M3a: the relay fixture is a provenance-noted copy of the product
    // repository's functions/fetch.js (the reference /fetch contract).
    handler = (await import('./fixtures/relay/fetch.js')).onRequestGet;
    if (typeof handler !== 'function') throw new Error('onRequestGet not exported by tests/fixtures/relay/fetch.js');

    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        httpPort = server.address().port;
        resolve();
      });
    });
    await waitForHttp(`http://127.0.0.1:${httpPort}/set-secret`, { timeoutMs: 5000, pollIntervalMs: 50 });
    chrome = await launchChrome('about:blank', {
      chromePath: process.env.CHROME,
      label: 'active-content Chrome',
    });
    await waitForCdp(chrome, { timeoutMs: 15000, fetchImpl: realFetch });
    const target = await waitForPageTarget(chrome, 'about:blank', {
      timeoutMs: 15000,
      fetchImpl: realFetch,
    });
    cdp = await connectToTarget(target);
    const send = cdp.send.bind(cdp);

    const visit = async (path) => {
      await send('Page.enable');
      await send('Page.navigate', { url: `http://127.0.0.1:${httpPort}${path}` });
      await waitForRuntimeCondition(cdp, 'document.readyState === "complete"', {
        process: chrome,
        phase: 'active-content-navigation:' + path,
        description: 'Active-content page did not finish loading: ' + path,
        timeoutMs: 5000,
      });
      const res = await send('Runtime.evaluate', {
        expression: 'JSON.stringify({pwned: !!window.__pwned, title: document.title})',
        returnByValue: true,
      });
      return JSON.parse(res.result.value);
    };

    let passed = 0, failed = 0;
    const check = (name, cond, detail) => {
      if (cond) { passed++; console.log('PASS ' + name); }
      else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + detail : '')); }
    };

    // Node-side: the real handler must actually emit the isolation headers.
    const cfRes = await handler({
      request: new Request('http://local.test/fetch?url=' + encodeURIComponent(UPSTREAM_URL)),
      env: {},
    });
    check('HANDLER emits CSP sandbox + nosniff for text/html',
      cfRes.headers.get('content-security-policy') === 'sandbox'
      && cfRes.headers.get('x-content-type-options') === 'nosniff'
      && cfRes.status === 200,
      'csp=' + cfRes.headers.get('content-security-policy') + ' status=' + cfRes.status);

    await visit('/set-secret');

    // control: same payload WITHOUT isolation headers → script executes and
    // can read same-origin sessionStorage after navigation
    const before = exfilHits.length;
    const control = await visit('/control');
    const exfilDeadline = Date.now() + 2000;
    while (exfilHits.length === before && Date.now() < exfilDeadline) await sleep(50);
    check('CONTROL payload executes without isolation (proves the risk is real)',
      control.pwned === true && exfilHits.length > before && exfilHits[exfilHits.length - 1] === 'sk-demo',
      JSON.stringify(control) + ' exfil=' + JSON.stringify(exfilHits));

    // fixed: the response the REAL handler produces → script never runs
    const beforeFixed = exfilHits.length;
    const fixed = await visit('/fixed');
    check('FIXED real-handler payload neutralized (no script execution, no exfil)',
      fixed.pwned === false && fixed.title !== 'PWNED' && exfilHits.length === beforeFixed,
      JSON.stringify(fixed) + ' exfil=' + JSON.stringify(exfilHits));

    console.log('\n' + passed + ' passed, ' + failed + ' failed');
    process.exitCode = failed ? 1 : 0;
  } finally {
    try { cdp?.close(); } catch (e) {}
    if (chrome) {
      const cleanup = await closeChrome(chrome);
      if (!cleanup.exited) console.error('active-content Chrome did not exit after bounded cleanup');
      if (!cleanup.profileRemoved) console.error('active-content Chrome profile cleanup failed: ' + cleanup.profileError);
    }
    if (server.listening) {
      await new Promise((resolve) => server.close(() => resolve()));
    }
  }
}

main().catch((e) => { console.error('VERIFY FAIL:', e && e.stack || e); process.exitCode = 1; });
