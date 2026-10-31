// Lightweight contract tests for tests/helpers/chrome.cjs. These tests use a
// local fake CDP HTTP endpoint; they do not launch real Chrome.
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const {
  listenWithRetry,
  parseDevToolsActivePort,
  readDevToolsActivePort,
  startServiceWithRetry,
  targetMatches,
  urlMatches,
  waitForCdp,
  waitForPageTarget,
} = require('./helpers/chrome.cjs');

function fakeChrome(port) {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => true;
  return {
    kind: 'chrome',
    executable: 'fake-chrome.exe',
    child,
    pid: 43210,
    port,
    startedAt: Date.now(),
    exitCode: null,
    signal: null,
    spawnError: null,
    exited: false,
  };
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

// ---- additions (test/ci-stability): DevToolsActivePort parsing + the
// EADDRINUSE port-retry. Existing checks above are untouched. ----
async function mainPortStability() {
  // DevToolsActivePort parsing
  assert.deepStrictEqual(
    parseDevToolsActivePort('37261\n/devtools/browser/abc\n'),
    { port: 37261, browserPath: '/devtools/browser/abc' },
    'DevToolsActivePort parses port + browser path');
  assert.deepStrictEqual(
    parseDevToolsActivePort('1234\r\n/devtools/browser/x\r\n'),
    { port: 1234, browserPath: '/devtools/browser/x' },
    'DevToolsActivePort tolerates CRLF');
  assert.deepStrictEqual(
    parseDevToolsActivePort('65535'),
    { port: 65535, browserPath: null },
    'DevToolsActivePort without a second line parses to a null browser path');
  for (const bad of ['', 'not-a-port\n/x', '0\n/x', '70000\n/x', '1234.5\n/x']) {
    assert.throws(() => parseDevToolsActivePort(bad),
      (e) => e.code === 'EDEVTOOLSACTIVEPORT_MALFORMED',
      'DevToolsActivePort rejects malformed content: ' + JSON.stringify(bad));
  }

  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'locus-devtools-port-test-'));
  const missingPath = path.join(tmp, 'DevToolsActivePort');
  assert.strictEqual(readDevToolsActivePort(missingPath), null,
    'a not-yet-written DevToolsActivePort reads as null (file late)');
  const malformedPath = path.join(tmp, 'malformed');
  fs.writeFileSync(malformedPath, 'abc\n/x');
  const malformed = readDevToolsActivePort(malformedPath);
  assert.strictEqual(malformed.port, null, 'a malformed file yields no port');
  assert.ok(String(malformed.error).includes('malformed DevToolsActivePort'),
    'a malformed file carries the parse error');
  const okPath = path.join(tmp, 'DevToolsActivePort');
  fs.writeFileSync(okPath, '37261\n/devtools/browser/abc\n');
  assert.deepStrictEqual(readDevToolsActivePort(okPath),
    { port: 37261, browserPath: '/devtools/browser/abc', path: okPath },
    'readDevToolsActivePort returns port + browserPath + path');

  // waitForCdp: a LATE DevToolsActivePort resolves the debug port
  const discoveryServer = http.createServer((req, res) => {
    if (req.url === '/json/version') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/browser/fake2' }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const discoveryPort = await listen(discoveryServer);
  try {
    const latePath = path.join(tmp, 'late-DevToolsActivePort');
    const lateChrome = fakeChrome(null);
    lateChrome.devToolsActivePortPath = latePath;
    setTimeout(() => {
      fs.writeFileSync(latePath, discoveryPort + '\n/devtools/browser/late\n');
    }, 120);
    const version2 = await waitForCdp(lateChrome, { timeoutMs: 5000, pollIntervalMs: 20 });
    assert.ok(version2.webSocketDebuggerUrl, 'a late DevToolsActivePort resolves CDP readiness');
    assert.strictEqual(lateChrome.port, discoveryPort, 'the debug port comes from the DevToolsActivePort file');
    assert.strictEqual(lateChrome.devToolsActivePort.port, discoveryPort, 'the parsed port is recorded on the handle');
    assert.strictEqual(typeof lateChrome.devToolsActivePort.appearedAfterMs, 'number',
      'the file-appearance time is recorded');

    const neverPath = path.join(tmp, 'never-DevToolsActivePort');
    const neverChrome = fakeChrome(null);
    neverChrome.devToolsActivePortPath = neverPath;
    await assert.rejects(
      waitForCdp(neverChrome, { timeoutMs: 300, pollIntervalMs: 20 }),
      (error) => error.message.includes('CDP browser endpoint unavailable: readiness timeout')
        && error.message.includes('DevToolsActivePort: never appeared during the wait'),
      'a missing DevToolsActivePort times out with file diagnostics');
  } finally {
    await new Promise((resolve) => discoveryServer.close(resolve));
  }

  // listenWithRetry: a genuinely blocked port is retried on a fresh one
  const blocker = net.createServer();
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  const blockedPort = blocker.address().port;
  try {
    const freshFreePort = async () => {
      const s = net.createServer();
      await new Promise((r) => s.listen(0, '127.0.0.1', r));
      const p = s.address().port;
      await new Promise((r) => s.close(r));
      return p;
    };
    const logs = [];
    const bound = await listenWithRetry(() => net.createServer(), blockedPort, {
      allocatePort: freshFreePort,
      log: (line) => logs.push(line),
    });
    assert.notStrictEqual(bound.port, blockedPort, 'the bind moved off the blocked port');
    assert.strictEqual(bound.server.address().port, bound.port,
      'the returned server listens on the returned port');
    assert.deepStrictEqual(logs, ['port ' + blockedPort + ' in use, retrying with ' + bound.port],
      'the retry logs "port X in use, retrying with Y"');
    await new Promise((resolve) => bound.server.close(resolve));

    const logs2 = [];
    await assert.rejects(
      listenWithRetry(() => net.createServer(), blockedPort, {
        allocatePort: async () => blockedPort,
        log: (line) => logs2.push(line),
      }),
      (error) => error.code === 'EADDRINUSE'
        && error.message.includes('(EADDRINUSE retry exhausted; ports tried: '
          + [blockedPort, blockedPort, blockedPort, blockedPort].join(', ') + ')'),
      'retry exhaustion throws a complete error naming every port tried');
    assert.strictEqual(logs2.length, 3, 'exactly three retries are logged before exhaustion');

    await assert.rejects(
      listenWithRetry(() => net.createServer(), 99999, { log: () => {} }),
      (error) => !String(error.message || '').includes('ports tried'),
      'a non-EADDRINUSE bind failure is not retried');

    // startServiceWithRetry: the child-process service shape — first
    // attempt fails with an EADDRINUSE-tagged error, second succeeds.
    const serviceLogs = [];
    let serviceAttempts = 0;
    const service = await startServiceWithRetry(async (port) => {
      serviceAttempts++;
      if (serviceAttempts === 1) {
        const e = new Error('vite preview could not bind port ' + port + ' (EADDRINUSE)');
        e.code = 'EADDRINUSE';
        throw e;
      }
      return { startedOn: port };
    }, blockedPort, {
      allocatePort: async () => blockedPort + 1,
      log: (line) => serviceLogs.push(line),
    });
    assert.strictEqual(serviceAttempts, 2, 'the service start ran twice (second attempt succeeded)');
    assert.strictEqual(service.handle.startedOn, blockedPort + 1, 'the handle is the second attempt');
    assert.deepStrictEqual(serviceLogs, ['port ' + blockedPort + ' in use, retrying with ' + (blockedPort + 1)],
      'the service retry logs the same "port X in use, retrying with Y" line');
  } finally {
    await new Promise((resolve) => blocker.close(resolve));
  }

  console.log('all chrome port-stability tests passed');
}

async function main() {
  let mode = 'delayed';
  let versionRequests = 0;
  let listRequests = 0;
  const server = http.createServer((req, res) => {
    if (req.url === '/json/version') {
      versionRequests++;
      if (mode === 'delayed' && versionRequests < 3) {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end('{}');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/browser/fake' }));
      return;
    }
    if (req.url === '/json/list') {
      listRequests++;
      const correct = {
        type: 'page',
        title: 'Expected',
        url: `http://127.0.0.1:${server.address().port}/expected?x=1`,
        webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/page/correct',
      };
      const wrong = {
        type: 'page',
        title: 'Wrong page',
        url: `http://127.0.0.1:${server.address().port}/wrong?x=1`,
        webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/page/wrong',
      };
      const targets = mode === 'delayed' && listRequests < 3
        ? [{ type: 'page', title: 'New tab', url: 'about:blank' }, { type: 'service_worker', url: 'chrome-extension://x' }]
        : mode === 'timeout'
          ? [wrong, { type: 'service_worker', title: 'worker', url: 'chrome-extension://x' }]
          : [wrong, correct];
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(targets));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const port = await listen(server);
  try {
    const chrome = fakeChrome(port);
    const version = await waitForCdp(chrome, { timeoutMs: 1000, pollIntervalMs: 20 });
    assert.ok(version.webSocketDebuggerUrl, 'delayed CDP readiness resolves');
    const target = await waitForPageTarget(chrome, `http://127.0.0.1:${port}/expected/?x=1`, {
      timeoutMs: 1000,
      pollIntervalMs: 20,
    });
    assert.strictEqual(target.title, 'Expected', 'delayed page target resolves');
    assert.strictEqual(listRequests, 3, 'about:blank and wrong targets are ignored');
    assert.ok(urlMatches(target.url, `http://127.0.0.1:${port}/expected/?x=1`), 'URL matching parses components');
    assert.strictEqual(targetMatches({ type: 'service_worker', url: target.url }, target.url), false,
      'non-page target is ignored');

    mode = 'timeout';
    versionRequests = 0;
    listRequests = 0;
    chrome.cdpVersion = null;
    await assert.rejects(
      waitForPageTarget(chrome, `http://127.0.0.1:${port}/expected?x=1`, { timeoutMs: 180, pollIntervalMs: 20 }),
      (error) => error.message.includes('Page target unavailable')
        && error.message.includes('debug port=' + port)
        && error.message.includes('/json/list snapshot')
        && error.message.includes('Wrong page'),
      'timeout includes target diagnostics',
    );

    const earlyExit = fakeChrome(port + 1);
    setTimeout(() => {
      earlyExit.exited = true;
      earlyExit.exitCode = 7;
      earlyExit.child.exitCode = 7;
      earlyExit.child.emit('exit', 7, null);
    }, 20);
    await assert.rejects(
      waitForCdp(earlyExit, { timeoutMs: 1000, pollIntervalMs: 20 }),
      (error) => error.message.includes('CDP browser endpoint unavailable')
        && error.message.includes('exitCode=7'),
      'early process exit fails immediately with exit code',
    );
    console.log('all chrome helper tests passed');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function mainAll() {
  await main();
  await mainPortStability();
}

mainAll().catch((error) => { console.error(error && error.stack || error); process.exitCode = 1; });
