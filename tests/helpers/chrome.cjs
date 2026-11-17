const fs = require('fs');
const fsp = require('fs/promises');
const net = require('net');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { spawn } = require('child_process');

// Readiness budgets. DEFAULT_TIMEOUT_MS stays the generic poll budget
// (server readiness, page targets, runtime conditions). Waiting for CHROME
// itself to come up is the one budget that raced CI: the runner's first
// cold start has been observed to need >15s before the debug endpoint
// answers (see RT-CI-001 in TODO.md — CDP readiness timeouts at phase=cdp
// elapsedMs≈15000/15186-class signatures on runs 36987973661 and
// 37461978810). DEFAULT_CDP_TIMEOUT_MS applies ONLY to waitForCdp — no
// product-assertion timeout is touched. (Ported from the product
// repository's tests/helpers/chrome.cjs, PR "test/ci-stability".)
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_CDP_TIMEOUT_MS = 60000;
const DEFAULT_POLL_INTERVAL_MS = 100;
const OUTPUT_TAIL_LINES = 80;
const OUTPUT_TAIL_CHARS = 12000;

const defaultChromePath = process.platform === 'win32'
  ? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
  : 'google-chrome';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function appendTail(handle, field, chunk) {
  const text = String(chunk);
  handle[field] = (handle[field] + text).split(/\r?\n/).slice(-OUTPUT_TAIL_LINES).join('\n');
  if (handle[field].length > OUTPUT_TAIL_CHARS) {
    handle[field] = handle[field].slice(-OUTPUT_TAIL_CHARS);
  }
}

function launchManagedProcess(executable, args, options = {}) {
  const child = spawn(executable, args, {
    cwd: options.cwd,
    env: options.env,
    shell: false,
    windowsHide: process.platform === 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const handle = {
    child,
    executable,
    args: [...args],
    label: options.label || executable,
    startedAt: Date.now(),
    pid: child.pid || null,
    port: options.port || null,
    profileDir: options.profileDir || null,
    stdoutTail: '',
    stderrTail: '',
    exitCode: null,
    signal: null,
    spawnError: null,
    exited: false,
  };

  child.stdout?.on('data', (chunk) => appendTail(handle, 'stdoutTail', chunk));
  child.stderr?.on('data', (chunk) => appendTail(handle, 'stderrTail', chunk));
  child.once('error', (error) => {
    handle.spawnError = error;
  });
  child.once('exit', (code, signal) => {
    handle.exitCode = code;
    handle.signal = signal;
    handle.exited = true;
  });
  return handle;
}

function isProcessAlive(handle) {
  if (!handle || !handle.child) return false;
  if (handle.spawnError || handle.exited) return false;
  return handle.child.exitCode === null && handle.child.signalCode === null;
}

function processStatus(handle) {
  return {
    alive: isProcessAlive(handle),
    pid: handle?.pid ?? handle?.child?.pid ?? null,
    exitCode: handle?.exitCode ?? handle?.child?.exitCode ?? null,
    signal: handle?.signal ?? handle?.child?.signalCode ?? null,
    spawnError: handle?.spawnError ? String(handle.spawnError.message || handle.spawnError) : null,
  };
}

function waitForExit(handle, timeoutMs) {
  if (!handle?.child || !isProcessAlive(handle)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let done = false;
    const finish = (exited) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      handle.child.removeListener('exit', onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(!isProcessAlive(handle)), timeoutMs);
    handle.child.once('exit', onExit);
  });
}

function forceKillTree(handle) {
  const pid = handle?.pid || handle?.child?.pid;
  if (!pid) return Promise.resolve();
  if (process.platform === 'win32') {
    return new Promise((resolve) => {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        timeout: 5000,
      }, () => resolve());
    });
  }
  try { handle.child.kill('SIGKILL'); } catch (e) {}
  return Promise.resolve();
}

async function removeProfile(profileDir) {
  if (!profileDir) return null;
  try {
    await fsp.rm(profileDir, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
    return null;
  } catch (error) {
    return error;
  }
}

async function closeManagedProcess(handle, options = {}) {
  if (!handle) return { exited: true, profileRemoved: true };
  if (handle._closePromise) return handle._closePromise;
  handle._closePromise = (async () => {
    const gracefulTimeoutMs = options.gracefulTimeoutMs ?? 1200;
    let exited = !isProcessAlive(handle);
    if (!exited) {
      try { handle.child.kill(); } catch (e) {}
      // Node's Windows child.kill() is not tree-aware and can leave Chrome's
      // renderer/GPU children behind. Run the bounded tree cleanup while the
      // owned parent PID is still available; taskkill is a no-op if the
      // graceful request already finished the process.
      if (process.platform === 'win32') await forceKillTree(handle);
      exited = await waitForExit(handle, gracefulTimeoutMs);
    }
    if (!exited) {
      await forceKillTree(handle);
      exited = await waitForExit(handle, options.forceTimeoutMs ?? 2500);
    }
    const profileError = handle.preserveProfile ? null : await removeProfile(handle.profileDir);
    return { exited, profileRemoved: !profileError, profileError };
  })();
  return handle._closePromise;
}

async function closeChrome(handle, options = {}) {
  return closeManagedProcess(handle, options);
}

// NOTE: racy by design — listen(0) reserves a port, close() releases it,
// and between the release and the consumer's bind ANOTHER process can take
// the port (the same release/rebind race product measured on CI as
// EADDRINUSE 127.0.0.1:33221 in e2e-credentials.cjs). Only use it for
// SERVICE ports (test http servers, per-suite vite preview), and always
// pair the bind with listenWithRetry() / startServiceWithRetry() so an
// EADDRINUSE retries on a freshly allocated port. Chrome's debug port must
// NOT go through here at all — launchChrome passes
// --remote-debugging-port=0 and lets Chrome pick + report its own port.
function allocateFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : null;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

// Parse the DevToolsActivePort file Chrome writes into its --user-data-dir
// once the debug server is listening (line 1: the port, line 2: the
// browser-target path). Throws a tagged error (code
// EDEVTOOLSACTIVEPORT_MALFORMED) on malformed content.
function parseDevToolsActivePort(content) {
  const lines = String(content).split(/\r?\n/);
  const portText = (lines[0] || '').trim();
  if (!/^\d+$/.test(portText)) {
    const error = new Error('malformed DevToolsActivePort: first line is not a decimal port: '
      + JSON.stringify(String(content).slice(0, 200)));
    error.code = 'EDEVTOOLSACTIVEPORT_MALFORMED';
    throw error;
  }
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    const error = new Error('malformed DevToolsActivePort: port out of range: '
      + JSON.stringify(String(content).slice(0, 200)));
    error.code = 'EDEVTOOLSACTIVEPORT_MALFORMED';
    throw error;
  }
  return { port, browserPath: (lines[1] || '').trim() || null };
}

// Read + parse the file. Returns:
//   null                                  — file not there yet (Chrome still starting)
//   { port, browserPath, path }           — parsed
//   { port: null, error, raw, path }      — present but malformed (kept out
//                                           of the polling fast path; the
//                                           next poll may see a complete file)
function readDevToolsActivePort(filePath) {
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    // ENOENT = not written yet; any other transient read error (e.g.
    // Windows sharing violations while Chrome creates the file) is also
    // treated as "not ready" — the next poll re-reads, and the timeout
    // diagnostics re-check the file fresh.
    return null;
  }
  try {
    return { ...parseDevToolsActivePort(content), path: filePath };
  } catch (e) {
    return { port: null, error: e.message, raw: String(content).slice(0, 200), path: filePath };
  }
}

// True when an error is the bind-race class (EADDRINUSE). The vite preview
// reports it through the child's stderr text, in-process servers through
// error.code — both shapes match here.
function isPortInUseError(error) {
  if (!error) return false;
  if (error.code === 'EADDRINUSE') return true;
  return /EADDRINUSE|address already in use/.test(String(error.message || error));
}

// Infrastructure retry for SERVICE ports (never a test re-run): start(port)
// is called once with the initially allocated port and, when it fails with
// EADDRINUSE, again on freshly allocated ports — at most maxRetries times
// (default 3), logging "port X in use, retrying with Y" for every retry.
// Callers must invoke this BEFORE any product check runs, so a retry can
// never mask a gate verdict. start(port) must fully release a failed
// attempt (a child that died binding must be reaped) and must reject with
// an EADDRINUSE-class error for the retry to trigger — other failures are
// rethrown untouched. Resolves { handle, port, portsTried }; on exhaustion
// throws the last error annotated with every port that was tried.
async function startServiceWithRetry(start, initialPort, options = {}) {
  const maxRetries = options.maxRetries ?? 3;
  const allocatePort = options.allocatePort || allocateFreePort;
  const log = options.log || console.log;
  const portInUse = options.isPortInUse || isPortInUseError;
  const tried = [];
  let port = initialPort;
  for (;;) {
    tried.push(port);
    try {
      const handle = await start(port);
      return { handle, port, portsTried: tried };
    } catch (error) {
      if (!portInUse(error)) throw error;
      if (tried.length > maxRetries) {
        error.message = String(error.message || error)
          + ' (EADDRINUSE retry exhausted; ports tried: ' + tried.join(', ') + ')';
        throw error;
      }
      const next = await allocatePort();
      log('port ' + port + ' in use, retrying with ' + next);
      port = next;
    }
  }
}

// listenWithRetry: bind an in-process net/http server with the EADDRINUSE
// retry above. serverFactory(port) must return a FRESH unlistened server
// per call (handlers may close over the port argument). The transient
// error listener is removed on success so later runtime errors keep their
// normal (loud) semantics. Resolves { server, port, portsTried }.
async function listenWithRetry(serverFactory, initialPort, options = {}) {
  const bound = await startServiceWithRetry(async (port) => {
    const server = serverFactory(port);
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        server.removeListener('error', onError);
        reject(error);
      };
      server.once('error', onError);
      server.listen(port, options.host || '127.0.0.1', () => {
        server.removeListener('error', onError);
        resolve(server);
      });
    });
    return server;
  }, initialPort, options);
  return { server: bound.handle, port: bound.port, portsTried: bound.portsTried };
}

function resolveChromeExecutable(configured) {
  const executable = configured || process.env.CHROME || defaultChromePath;
  if (path.isAbsolute(executable) && !fs.existsSync(executable)) {
    throw new Error('Chrome executable not found: ' + executable);
  }
  return executable;
}

async function launchChrome(url, options = {}) {
  const executable = resolveChromeExecutable(options.chromePath);
  const profileDir = options.profileDir || await fsp.mkdtemp(path.join(os.tmpdir(), 'locus-e2e-chrome-'));
  try {
    // Suites reuse profile dirs on purpose (persistence reload, image
    // restart cases) — a leftover DevToolsActivePort from the PREVIOUS
    // chrome would point waitForCdp at the dead instance's port. Remove it
    // so the only file waitForCdp can ever read is the one THIS chrome
    // writes for the port it chose.
    await fsp.rm(path.join(profileDir, 'DevToolsActivePort'), { force: true });
    const args = [
      '--headless=new',
      '--disable-gpu',
      // Required by the managed Windows runner: without it Chrome's
      // renderer/GPU sandbox crashes before a page CDP session can attach.
      '--no-sandbox',
      '--no-first-run',
      '--no-default-browser-check',
      '--remote-debugging-address=127.0.0.1',
      // Port 0: Chrome picks its OWN free debug port and reports it by
      // writing <profileDir>/DevToolsActivePort (waitForCdp reads it). The
      // previous allocateFreePort()-then-bind dance had the same
      // release/rebind race as every other preallocated port.
      '--remote-debugging-port=0',
      '--user-data-dir=' + profileDir,
      ...(options.extraArgs || []),
      url,
    ];
    const handle = launchManagedProcess(executable, args, {
      label: options.label || 'Chrome',
      port: null,
      profileDir,
      cwd: options.cwd,
      env: options.env,
    });
    handle.url = url;
    handle.kind = 'chrome';
    handle.preserveProfile = !!options.preserveProfile;
    handle.port = null; // resolved from DevToolsActivePort by waitForCdp
    handle.devToolsActivePortPath = path.join(profileDir, 'DevToolsActivePort');
    handle.devToolsActivePort = null; // { port, browserPath, appearedAfterMs } once parsed
    handle.devToolsActivePortFirstSeenMs = null; // when the file first appeared
    return handle;
  } catch (error) {
    if (!options.profileDir) await removeProfile(profileDir);
    throw error;
  }
}

async function fetchJson(url, fetchImpl, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    const body = await response.text();
    let data = null;
    try { data = JSON.parse(body); } catch (e) {}
    return { status: response.status, body, data, error: null };
  } catch (error) {
    return { status: null, body: '', data: null, error: String(error && error.message || error) };
  } finally {
    clearTimeout(timer);
  }
}

function cdpUrl(handle, suffix) {
  return `http://127.0.0.1:${handle.port}${suffix}`;
}

function targetSummary(target) {
  return {
    type: target?.type || null,
    title: target?.title || '',
    url: target?.url || '',
  };
}

async function collectDiagnostics(handle, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  let version = options.lastVersion;
  let targets = options.lastTargets;
  if (handle?.kind === 'chrome' && handle.port) {
    if (version === undefined) version = await fetchJson(cdpUrl(handle, '/json/version'), fetchImpl, 250);
    if (targets === undefined) targets = await fetchJson(cdpUrl(handle, '/json/list'), fetchImpl, 250);
  }
  // DevToolsActivePort at diagnostic time: the file-recorded observation
  // (when Chrome first wrote it, what it parsed to) plus a FRESH read so a
  // timeout report always answers "did the file ever appear?".
  let devToolsActivePort = null;
  if (handle?.kind === 'chrome' && handle.devToolsActivePortPath) {
    devToolsActivePort = {
      path: handle.devToolsActivePortPath,
      resolvedPort: handle.port || null,
      firstSeenAfterMs: handle.devToolsActivePortFirstSeenMs ?? null,
      parsed: handle.devToolsActivePort || null,
      now: readDevToolsActivePort(handle.devToolsActivePortPath),
    };
  }
  const status = processStatus(handle);
  return {
    phase: options.phase || 'readiness',
    elapsedMs: options.elapsedMs ?? (handle?.startedAt ? Date.now() - handle.startedAt : null),
    executable: handle?.executable || null,
    pid: status.pid,
    alive: status.alive,
    exitCode: status.exitCode,
    signal: status.signal,
    spawnError: status.spawnError,
    port: handle?.port || null,
    url: options.url || handle?.url || null,
    version,
    targets,
    devToolsActivePort,
    stderrTail: handle?.stderrTail || '',
    stdoutTail: handle?.stdoutTail || '',
    lastValue: options.lastValue,
    lastError: options.lastError,
  };
}

function formatDiagnostics(message, diagnostics) {
  const d = diagnostics || {};
  const version = d.version;
  const targets = d.targets;
  const versionText = version === undefined
    ? 'not collected'
    : version?.error
      ? 'unavailable: ' + version.error
      : `HTTP ${version.status} ${String(version.body || '').slice(0, 1000)}`;
  let targetText = targets === undefined
    ? 'not collected'
    : targets?.error
      ? 'unavailable: ' + targets.error
      : Array.isArray(targets?.data)
        ? targets.data.map(targetSummary).map((t) => JSON.stringify(t)).join('\n') || '(none)'
        : `HTTP ${targets.status} ${String(targets.body || '').slice(0, 1000)}`;
  if (targetText.length > 8000) targetText = targetText.slice(-8000);
  let portFileText = null;
  if (d.devToolsActivePort) {
    const f = d.devToolsActivePort;
    const nowText = f.now === null
      ? 'absent at diagnostic time'
      : f.now.port
        ? 'present now (port ' + f.now.port + ')'
        : 'present now but malformed: ' + f.now.error;
    const seenText = f.firstSeenAfterMs === null
      ? 'never appeared during the wait'
      : 'first appeared after ' + f.firstSeenAfterMs + 'ms';
    const parsedText = f.parsed ? ' resolved to port ' + f.parsed.port : '';
    portFileText = 'DevToolsActivePort: ' + seenText + parsedText + '; ' + nowText;
  }
  return [
    message,
    `phase=${d.phase || 'readiness'} elapsedMs=${d.elapsedMs ?? 'unknown'}`,
    `Chrome executable=${d.executable || 'unknown'}`,
    `PID=${d.pid ?? 'unknown'} alive=${d.alive === true ? 'yes' : 'no'} exitCode=${d.exitCode ?? 'null'} signal=${d.signal || 'none'}`,
    `debug port=${d.port ?? 'unknown'} url=${d.url || 'unknown'}`,
    portFileText,
    `/json/version result: ${versionText}`,
    `/json/list snapshot:\n${targetText}`,
    `stderr tail:\n${d.stderrTail || '(empty)'}`,
    `stdout tail:\n${d.stdoutTail || '(empty)'}`,
    d.lastError ? `last error=${d.lastError}` : '',
  ].filter(Boolean).join('\n');
}

async function readinessError(message, handle, options = {}) {
  const diagnostics = await collectDiagnostics(handle, options);
  return new Error(formatDiagnostics(message, diagnostics));
}

async function waitForCdp(handle, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_CDP_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const started = Date.now();
  let lastVersion;
  let lastTargets;
  let lastPortFile;

  // Phase 1 — Chrome cold start. With --remote-debugging-port=0 the debug
  // port only becomes known when Chrome writes DevToolsActivePort into the
  // profile dir. This phase shares the overall timeoutMs budget with the
  // HTTP poll below; on a cold CI runner it is the phase that needed more
  // than 15s (see the readiness-timeout evidence in the header comment).
  while (handle.kind === 'chrome' && !handle.port) {
    if (!isProcessAlive(handle)) {
      throw await readinessError('CDP browser endpoint unavailable: Chrome exited before readiness', handle, {
        phase: 'cdp', elapsedMs: Date.now() - started, lastVersion, lastTargets, lastPortFile,
      });
    }
    lastPortFile = readDevToolsActivePort(handle.devToolsActivePortPath);
    if (lastPortFile) {
      // ??= (not === null): test doubles and future callers may build
      // chrome handles without this field pre-initialized.
      handle.devToolsActivePortFirstSeenMs ??= Date.now() - started;
      if (lastPortFile.port) {
        handle.port = lastPortFile.port;
        handle.devToolsActivePort = {
          port: lastPortFile.port,
          browserPath: lastPortFile.browserPath,
          appearedAfterMs: handle.devToolsActivePortFirstSeenMs,
        };
        break;
      }
    }
    if (Date.now() - started >= timeoutMs) {
      throw await readinessError('CDP browser endpoint unavailable: readiness timeout', handle, {
        phase: 'cdp', elapsedMs: Date.now() - started, lastVersion, lastTargets, lastPortFile,
      });
    }
    await sleep(Math.min(pollIntervalMs, Math.max(1, timeoutMs - (Date.now() - started))));
  }

  // Phase 2 — the debug endpoint answers HTTP.
  while (Date.now() - started < timeoutMs) {
    if (!isProcessAlive(handle)) {
      throw await readinessError('CDP browser endpoint unavailable: Chrome exited before readiness', handle, {
        phase: 'cdp', elapsedMs: Date.now() - started, lastVersion, lastTargets, lastPortFile,
      });
    }
    lastVersion = await fetchJson(cdpUrl(handle, '/json/version'), fetchImpl, Math.min(500, Math.max(50, pollIntervalMs * 2)));
    if (lastVersion.status === 200 && lastVersion.data?.webSocketDebuggerUrl) {
      handle.cdpVersion = lastVersion.data;
      return lastVersion.data;
    }
    if (!isProcessAlive(handle)) {
      throw await readinessError('CDP browser endpoint unavailable: Chrome exited before readiness', handle, {
        phase: 'cdp', elapsedMs: Date.now() - started, lastVersion, lastTargets, lastPortFile,
      });
    }
    await sleep(Math.min(pollIntervalMs, Math.max(1, timeoutMs - (Date.now() - started))));
  }
  throw await readinessError('CDP browser endpoint unavailable: readiness timeout', handle, {
    phase: 'cdp', elapsedMs: Date.now() - started, lastVersion, lastTargets, lastPortFile,
  });
}

function normalizePathname(value) {
  const pathname = value || '/';
  return pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
}

function urlMatches(actualUrl, expectedUrl) {
  try {
    const actual = new URL(actualUrl);
    const expected = new URL(expectedUrl);
    return actual.protocol.toLowerCase() === expected.protocol.toLowerCase()
      && actual.hostname.toLowerCase() === expected.hostname.toLowerCase()
      && actual.port === expected.port
      && normalizePathname(actual.pathname) === normalizePathname(expected.pathname)
      && actual.search === expected.search;
  } catch (e) {
    return false;
  }
}

function targetMatches(target, expected) {
  if (!target || target.type !== 'page') return false;
  if (!expected) return true;
  if (typeof expected === 'function') return !!expected(target);
  if (expected instanceof RegExp) return expected.test(target.url || '');
  if (typeof expected === 'string') return urlMatches(target.url || '', expected);
  if (expected.url) return urlMatches(target.url || '', expected.url);
  return false;
}

async function listTargets(handle, fetchImpl) {
  return fetchJson(cdpUrl(handle, '/json/list'), fetchImpl, 500);
}

async function waitForPageTarget(handle, expected, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const started = Date.now();
  if (!handle.cdpVersion) {
    await waitForCdp(handle, { timeoutMs, pollIntervalMs, fetchImpl });
  }
  let lastVersion;
  let lastTargets;
  while (Date.now() - started < timeoutMs) {
    if (!isProcessAlive(handle)) {
      throw await readinessError('Page target unavailable: Chrome exited before target appeared', handle, {
        phase: 'page-target', elapsedMs: Date.now() - started, lastVersion, lastTargets,
      });
    }
    lastTargets = await listTargets(handle, fetchImpl);
    if (Array.isArray(lastTargets.data)) {
      const target = lastTargets.data.find((item) => targetMatches(item, expected));
      if (target) {
        handle.pageTarget = target;
        return target;
      }
    }
    await sleep(Math.min(pollIntervalMs, Math.max(1, timeoutMs - (Date.now() - started))));
  }
  throw await readinessError('Page target unavailable: no matching page target before timeout', handle, {
    phase: 'page-target', elapsedMs: Date.now() - started, lastVersion, lastTargets,
  });
}

async function waitForHttp(url, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const started = Date.now();
  let lastResponse;
  while (Date.now() - started < timeoutMs) {
    const server = options.process;
    if (server && !isProcessAlive(server)) {
      throw await readinessError('HTTP server unavailable: process exited before readiness', server, {
        phase: 'server', elapsedMs: Date.now() - started, url, lastError: server.spawnError?.message,
      });
    }
    lastResponse = await fetchJson(url, fetchImpl, Math.min(750, Math.max(100, pollIntervalMs * 3)));
    if (lastResponse.status !== null && lastResponse.status >= 200 && lastResponse.status < 300) {
      return lastResponse;
    }
    await sleep(Math.min(pollIntervalMs, Math.max(1, timeoutMs - (Date.now() - started))));
  }
  throw await readinessError('HTTP server unavailable: readiness timeout', options.process, {
    phase: 'server', elapsedMs: Date.now() - started, url, lastError: lastResponse?.error,
  });
}

async function waitForRuntimeCondition(connection, expression, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const predicate = options.predicate || ((value) => !!value);
  const started = Date.now();
  let lastValue;
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      const result = await connection.send('Runtime.evaluate', {
        expression,
        returnByValue: true,
      });
      lastValue = result?.result?.value;
      if (predicate(lastValue)) return lastValue;
    } catch (error) {
      lastError = String(error && error.message || error);
    }
    await sleep(Math.min(pollIntervalMs, Math.max(1, timeoutMs - (Date.now() - started))));
  }
  throw await readinessError(options.description || 'Browser runtime condition unavailable: timeout', options.process, {
    phase: options.phase || 'runtime-condition',
    elapsedMs: Date.now() - started,
    lastValue: JSON.stringify(lastValue),
    lastError,
  });
}

async function connectToTarget(target) {
  if (!target?.webSocketDebuggerUrl) throw new Error('CDP page target has no webSocketDebuggerUrl');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const onOpen = () => { cleanup(); resolve(); };
    const onError = (event) => { cleanup(); reject(new Error('CDP websocket open failed: ' + (event?.message || 'unknown error'))); };
    const cleanup = () => {
      ws.removeEventListener('open', onOpen);
      ws.removeEventListener('error', onError);
    };
    ws.addEventListener('open', onOpen);
    ws.addEventListener('error', onError);
  });
  let id = 0;
  const pending = new Map();
  const rejectPending = (error) => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  };
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const entry = pending.get(message.id);
    pending.delete(message.id);
    clearTimeout(entry.timer);
    message.error ? entry.reject(new Error(JSON.stringify(message.error))) : entry.resolve(message.result);
  });
  ws.addEventListener('close', () => rejectPending(new Error('CDP websocket closed')));
  ws.addEventListener('error', (event) => rejectPending(new Error('CDP websocket error: ' + (event?.message || 'unknown error'))));
  return {
    ws,
    send(method, params = {}) {
      const requestTimeoutMs = Number.isFinite(params.timeout)
        ? Math.max(10000, params.timeout + 5000)
        : 10000;
      return new Promise((resolve, reject) => {
        const messageId = ++id;
        const timer = setTimeout(() => {
          if (!pending.has(messageId)) return;
          pending.delete(messageId);
          reject(new Error(`CDP request timed out after ${requestTimeoutMs}ms: ${method}`));
        }, requestTimeoutMs);
        pending.set(messageId, { resolve, reject, timer });
        try {
          ws.send(JSON.stringify({ id: messageId, method, params }));
        } catch (error) {
          pending.delete(messageId);
          clearTimeout(timer);
          reject(error);
        }
      });
    },
    close() {
      try { ws.close(); } catch (e) {}
    },
  };
}

module.exports = {
  allocateFreePort,
  closeChrome,
  closeManagedProcess,
  collectDiagnostics,
  connectToTarget,
  formatDiagnostics,
  isPortInUseError,
  isProcessAlive,
  launchChrome,
  launchManagedProcess,
  listenWithRetry,
  parseDevToolsActivePort,
  processStatus,
  readDevToolsActivePort,
  startServiceWithRetry,
  targetMatches,
  urlMatches,
  waitForCdp,
  waitForHttp,
  waitForPageTarget,
  waitForRuntimeCondition,
};
