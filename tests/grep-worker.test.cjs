// Grep regex worker isolation tests (F03).
//
// Part A drives the REAL worker source extracted from index.html inside a
// `vm` context (init/invalid/scan/count/limits/flags/line-splitting).
// Part B drives the real shell stack over a deterministic fake worker
// (tests/helpers/grep-fake-worker.cjs) to prove the session lifecycle:
// one worker per command, terminate on success/failure/timeout/cancel,
// bounded failures, no stale settlement, and FAIL-CLOSED when no worker
// can be created (never a main-thread fallback).
// Run: node tests/grep-worker.test.cjs

const fs = require('fs');
const vm = require('vm');
const path = require('path');
const { installGrepFakeWorker, FakeGrepWorker } = require('./helpers/grep-fake-worker.cjs');
const { GREP_WORKER_SOURCE } = require('./helpers/runtime.cjs');

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + detail : '')); }
}

// ---------- Part A harness: real worker source in a vm ----------
function makeWorker() {
  // M2a: the worker source is a runtime asset module (never index.html).
  const replies = [];
  const self = { postMessage: (msg) => replies.push(msg) };
  vm.runInNewContext(GREP_WORKER_SOURCE, { self: self });
  return { send: (msg) => self.onmessage({ data: msg }), replies: replies };
}

function partA() {
  // A1/A2: init verdicts
  const w = makeWorker();
  w.send({ id: 1, cmd: 'init', pattern: 'fo+', flags: '' });
  check('GW-A1 valid init answers ready', w.replies.length === 1 && w.replies[0].id === 1 && w.replies[0].type === 'ready', JSON.stringify(w.replies));

  const w2 = makeWorker();
  w2.send({ id: 1, cmd: 'init', pattern: '(', flags: '' });
  check('GW-A2 invalid init answers invalid_pattern with no engine detail',
    w2.replies.length === 1 && w2.replies[0].type === 'invalid_pattern'
    && !JSON.stringify(w2.replies).includes('Invalid regular expression'), JSON.stringify(w2.replies));

  // A3: normal scan — matching lines with 1-based line numbers
  const w3 = makeWorker();
  w3.send({ id: 2, cmd: 'init', pattern: 'foo', flags: '' });
  w3.send({ id: 3, cmd: 'scan', text: 'foo bar\nnothing\nfoofoo\nbar\n', countOnly: false, maxMatches: 500 });
  const r3 = w3.replies[1];
  check('GW-A3 scan returns matching lines with 1-based numbers',
    r3.type === 'result' && r3.matches.length === 2
    && r3.matches[0].lineNumber === 1 && r3.matches[0].line === 'foo bar'
    && r3.matches[1].lineNumber === 3 && r3.matches[1].line === 'foofoo'
    && r3.hitMatchLimit === false, JSON.stringify(r3));

  // A4: count mode counts every matching line (no cap)
  const w4 = makeWorker();
  w4.send({ id: 1, cmd: 'init', pattern: 'x', flags: '' });
  w4.send({ id: 2, cmd: 'scan', text: new Array(1201).fill('x').join('\n'), countOnly: true, maxMatches: null });
  check('GW-A4 count mode counts all matching lines', w4.replies[1].type === 'result' && w4.replies[1].count === 1201, JSON.stringify(w4.replies[1]));

  // A5: match budget — stops at the cap and reports hitMatchLimit
  const w5 = makeWorker();
  w5.send({ id: 1, cmd: 'init', pattern: 'm', flags: '' });
  w5.send({ id: 2, cmd: 'scan', text: 'm\nm\nn\nm\nm\n', countOnly: false, maxMatches: 2 });
  const r5 = w5.replies[1];
  check('GW-A5 scan stops at maxMatches with hitMatchLimit=true',
    r5.matches.length === 2 && r5.hitMatchLimit === true
    && r5.matches[1].lineNumber === 2, JSON.stringify(r5));

  // A6: budget consumed by the FINAL line — no truncation flag (parity with
  // the previous main-thread loop, which only flagged when lines remained)
  const w6 = makeWorker();
  w6.send({ id: 1, cmd: 'init', pattern: 'm', flags: '' });
  w6.send({ id: 2, cmd: 'scan', text: 'm\nm\n', countOnly: false, maxMatches: 2 });
  const r6 = w6.replies[1];
  check('GW-A6 exact-budget file does not set hitMatchLimit',
    r6.matches.length === 2 && r6.hitMatchLimit === false, JSON.stringify(r6));

  // A7: -i flag semantics
  const w7 = makeWorker();
  w7.send({ id: 1, cmd: 'init', pattern: 'foo', flags: 'i' });
  w7.send({ id: 2, cmd: 'scan', text: 'FOO\nfoo\nnope\n', countOnly: false, maxMatches: 500 });
  check('GW-A7 case-insensitive flag honored', w7.replies[1].matches.length === 2, JSON.stringify(w7.replies[1]));

  // A8: trailing-newline parity with the shell's splitLines()
  const cases = [
    ['a\nb\n', ['a', 'b']],
    ['a\nb', ['a', 'b']],
    ['', []],
    ['\n', []],
    ['a', ['a']],
  ];
  let splitOk = true, splitDetail = '';
  for (const [text, expect] of cases) {
    const wt = makeWorker();
    wt.send({ id: 1, cmd: 'init', pattern: '.', flags: '' });
    wt.send({ id: 2, cmd: 'scan', text: text, countOnly: true, maxMatches: null });
    const lines = wt.replies[1].count; // '.' matches every non-empty line
    if (lines !== expect.length) { splitOk = false; splitDetail = JSON.stringify(text) + ' → ' + lines; }
  }
  check('GW-A8 line splitting matches shell splitLines semantics', splitOk, splitDetail);

  // A9: scan before init and unknown commands fail bounded
  const w9 = makeWorker();
  w9.send({ id: 5, cmd: 'scan', text: 'x', countOnly: false, maxMatches: 500 });
  w9.send({ id: 6, cmd: 'nope' });
  check('GW-A9 uninitialized scan / unknown cmd answer internal_error',
    w9.replies.length === 2 && w9.replies[0].type === 'internal_error' && w9.replies[1].type === 'internal_error',
    JSON.stringify(w9.replies));
}

// ---------- Part B harness: real shell over the fake worker ----------
global.window = { location: { protocol: 'https:' } };
global.document = { getElementById: () => null };

const M = require('./helpers/core.cjs');

// M3a: bash routes through the PUBLIC runtime entry (the ES-module
// implementation is imported directly). Worker sources are
// never booted by this suite.
const { createRuntime } = require('../src/index.js');
// M3a review: the public entry assembles asynchronously — the session is
// resolved before the checks drive them.
const __hostPromise = createRuntime({
  workerAssets: { pyWorkerSource: '/* not booted in this suite */', grepWorkerSource: '/* not booted in this suite */' },
});
let __session = null;
const exec = (tool, input, workspace, opts) => {
  if (tool !== 'bash') throw new Error('runtime suites drive the bash tool only');
  return __session.execute({
    kind: 'shell',
    input,
    context: Object.assign({ filesystem: workspace }, opts || {}),
  }).then((res) => ({ output: res.output, success: !!res.ok, isError: !!res.isError, backend: res.backend, operation: res.operation }));
};

const Fake = installGrepFakeWorker(M);

// The session's admission queue moves the worker creation into the exec
// microtask chain — a synchronous last(Fake.instances) capture after
// exec() can be stale. Arm the scan drop at CREATION time instead:
// deterministic under any admission schedule.
function armNextWorkerScanDrop() {
  const prev = M.GrepRegexRuntime._workerFactory;
  M.GrepRegexRuntime._workerFactory = (...a) => {
    M.GrepRegexRuntime._workerFactory = prev;
    const wk = prev(...a);
    wk.dropCmds = new Set(['scan']);
    return wk;
  };
}

// Hierarchical in-memory workspace (same model as shell-compat3.test.cjs).
class TreeWS extends M.WorkspaceAdapter {
  constructor(files) {
    super();
    this.name = 'tree';
    this.files = {};
    this.dirs = new Set();
    for (const k in (files || {})) {
      this.files[k] = typeof files[k] === 'string' ? new TextEncoder().encode(files[k]) : files[k];
    }
  }
  _dirs() {
    const dirs = new Set(['']);
    for (const p in this.files) {
      const parts = p.split('/');
      for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
    }
    for (const d of this.dirs) {
      const parts = d.split('/');
      for (let i = 1; i <= parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
    }
    return dirs;
  }
  async list(p) {
    p = p ? M.normalizeWorkspacePath(p) : '';
    if (p && !this._dirs().has(p)) { const e = new Error('No such dir: ' + p); e.name = 'NotFoundError'; throw e; }
    const seen = new Map();
    const prefix = p ? p + '/' : '';
    for (const f in this.files) {
      if (!f.startsWith(prefix)) continue;
      const rest = f.slice(prefix.length);
      const seg = rest.split('/')[0];
      const kind = rest.includes('/') ? 'directory' : 'file';
      if (!seen.has(seg) || kind === 'directory') seen.set(seg, { name: seg, kind: seen.has(seg) && seen.get(seg).kind === 'directory' ? 'directory' : kind });
    }
    for (const d of this.dirs) {
      if (d.startsWith(prefix)) {
        const rest = d.slice(prefix.length);
        if (rest && !rest.includes('/')) seen.set(rest, { name: rest, kind: 'directory' });
      }
    }
    const entries = [...seen.values()];
    entries.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'directory' ? -1 : 1));
    return entries;
  }
  async readBytes(p) {
    p = M.normalizeWorkspacePath(p);
    if (!(p in this.files)) { const e = new Error('No such file: ' + p); e.name = 'NotFoundError'; throw e; }
    return this.files[p];
  }
  async write(p, d) { this.files[M.normalizeWorkspacePath(p)] = d; }
  async remove(p) { p = M.normalizeWorkspacePath(p); this.dirs.delete(p); delete this.files[p]; }
  async mkdir(p) {
    p = M.normalizeWorkspacePath(p);
    if (!p) return;
    const parts = p.split('/');
    for (let i = 1; i <= parts.length; i++) this.dirs.add(parts.slice(0, i).join('/'));
  }
  async exists(p) {
    try { p = M.normalizeWorkspacePath(p); } catch (e) { return false; }
    return p in this.files || this._dirs().has(p);
  }
  async stat(p) {
    p = M.normalizeWorkspacePath(p);
    if (p in this.files) return { kind: 'file', size: this.files[p].byteLength, modified: 0 };
    if (this._dirs().has(p)) return { kind: 'directory', size: 0, modified: null };
    const e = new Error('No such path: ' + p); e.name = 'NotFoundError'; throw e;
  }
}

const enc = (s) => new TextEncoder().encode(s);
const fixture = (files) => {
  const vfs = new M.VirtualWorkspace({ listCommands: () => Object.keys(M.SHELL_COMMANDS) });
  vfs.mount('/mnt/workspace', new TreeWS(files || {}), 'external-read-write');
  return vfs;
};
const last = (arr) => arr[arr.length - 1];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, ms) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > (ms || 2000)) throw new Error('until() timeout');
    await sleep(2);
  }
}

async function partB() {
  const unhandled = [];
  const onUnhandled = (e) => unhandled.push(e);
  process.on('unhandledRejection', onUnhandled);

  // GW1: valid regex, file operand — output unchanged, worker lifecycle clean
  let vfs = fixture({ 'f.txt': enc('foo here\nbar\nother foo\n') });
  let w0 = Fake.instances.length;
  let r = await exec('bash', 'grep foo f.txt', vfs, {});
  let w = last(Fake.instances);
  check('GW1 file grep output unchanged', r.output === 'foo here\nother foo' && r.success, JSON.stringify(r));
  check('GW1 worker created for the command', Fake.instances.length === w0 + 1, 'instances=' + Fake.instances.length);
  check('GW11 worker terminated after success', w.terminateCount === 1 && w.terminated, 'terminateCount=' + w.terminateCount);
  check('GW8 file scan posted with decoded text',
    w.sent.length === 2 && w.sent[0].cmd === 'init' && w.sent[1].cmd === 'scan'
    && w.sent[1].text === 'foo here\nbar\nother foo\n', JSON.stringify(w.sent.map((m) => m.cmd)));

  // GW2: -i unchanged
  vfs = fixture({ 'f.txt': enc('FOO upper\nfoo lower\n') });
  r = await exec('bash', 'grep -i foo f.txt', vfs, {});
  check('GW2 -i output unchanged', r.output === 'FOO upper\nfoo lower' && r.success, JSON.stringify(r));
  check('GW2 -i reaches the worker as flag i', last(Fake.instances).sent[0].flags === 'i', JSON.stringify(last(Fake.instances).sent[0]));

  // GW3: -n unchanged
  vfs = fixture({ 'f.txt': enc('foo\nbar\nfoo\n') });
  r = await exec('bash', 'grep -n foo f.txt', vfs, {});
  check('GW3 -n output unchanged', r.output === '1:foo\n3:foo' && r.success, JSON.stringify(r));

  // GW4: -c counts the TRUE total, above the 500-match presentation cap
  const big = new Array(1200).fill('matchline').join('\n') + '\n';
  vfs = fixture({ 'big.txt': enc(big) });
  r = await exec('bash', 'grep -c matchline big.txt', vfs, {});
  check('GW4 -c exact count above presentation cap', r.output === '1200' && r.success, JSON.stringify(r));

  // GW4b: normal mode caps matches at 500 + truncation notice (worker budget)
  r = await exec('bash', 'grep matchline big.txt', vfs, {});
  const outLines = r.output.split('\n');
  check('GW4b normal grep capped at 500 worker-returned matches + truncation notice',
    outLines.length === 501 && outLines[0] === 'matchline' && outLines[499] === 'matchline'
    && /\[grep: results truncated at traversal limits/.test(outLines[500]) && r.success,
    'lines=' + outLines.length + ' tail=' + JSON.stringify(outLines[500]));

  // GW5: recursive search unchanged
  vfs = fixture({
    'top.txt': enc('foo top\n'),
    'sub/inner.txt': enc('bar\nfoo deep\n'),
    'sub/deeper/leaf.txt': enc('foo leaf\n'),
  });
  r = await exec('bash', 'grep -r foo .', vfs, {});
  check('GW5 recursive output unchanged',
    r.output === './sub/deeper/leaf.txt:foo leaf\n./sub/inner.txt:foo deep\n./top.txt:foo top' && r.success,
    JSON.stringify(r));

  // GW6: invalid regex — bounded failure, no engine detail, worker still cleaned up
  vfs = fixture({ 'f.txt': enc('content\n') });
  w0 = Fake.instances.length;
  r = await exec('bash', "grep '(' f.txt", vfs, {});
  w = last(Fake.instances);
  check('GW6 invalid regex fails with the bounded message',
    !r.success && r.output === 'grep: invalid pattern (patterns use JavaScript regex syntax)', JSON.stringify(r));
  check('GW6 no raw engine/pattern echo', !r.output.includes('Invalid regular expression'), JSON.stringify(r));
  check('GW12 worker terminated after failure', w.terminateCount === 1, 'terminateCount=' + w.terminateCount);
  check('GW6 no scan was ever posted for an invalid pattern', w.sent.length === 1 && w.sent[0].cmd === 'init', JSON.stringify(w.sent.map((m) => m.cmd)));

  // GW7: stdin grep goes through the worker too
  vfs = fixture({});
  w0 = Fake.instances.length;
  r = await exec('bash', 'echo hello-foo | grep foo', vfs, {});
  w = last(Fake.instances);
  check('GW7 stdin grep output unchanged', r.output === 'hello-foo' && r.success, JSON.stringify(r));
  check('GW7 stdin grep used a fresh worker', Fake.instances.length === w0 + 1, 'instances=' + Fake.instances.length);
  check('GW7 stdin text scanned in worker', w.sent.some((m) => m.cmd === 'scan' && String(m.text).includes('hello-foo')), JSON.stringify(w.sent.map((m) => m.cmd)));

  // GW10: ONE worker per command across multiple operands
  vfs = fixture({ 'a.txt': enc('foo a\n'), 'b.txt': enc('nope\nfoo b\n') });
  w0 = Fake.instances.length;
  r = await exec('bash', 'grep foo a.txt b.txt', vfs, {});
  w = last(Fake.instances);
  check('GW10 multi-file grep constructs exactly one worker',
    Fake.instances.length === w0 + 1 && r.output === 'a.txt:foo a\nb.txt:foo b', 'instances=' + Fake.instances.length);
  check('GW10 pattern compiled once, two scans reuse it',
    w.sent.length === 3 && w.sent.filter((m) => m.cmd === 'init').length === 1 && w.sent.filter((m) => m.cmd === 'scan').length === 2,
    JSON.stringify(w.sent.map((m) => m.cmd)));

  // GW9/GB: recursive grep posts one scan per file through the same worker
  vfs = fixture({ 'd/1.txt': enc('foo\n'), 'd/2.txt': enc('bar\n') });
  w0 = Fake.instances.length;
  r = await exec('bash', 'grep -r foo d', vfs, {});
  w = last(Fake.instances);
  check('GW9 recursive grep uses one worker and per-file scans',
    Fake.instances.length === w0 + 1 && r.output === 'd/1.txt:foo'
    && w.sent.filter((m) => m.cmd === 'scan').length === 2, JSON.stringify(r) + ' scans=' + w.sent.filter((m) => m.cmd === 'scan').length);

  // T1: scan hangs → hard timeout TERMINATES the worker, bounded failure,
  // late reply ignored, next grep works
  vfs = fixture({ 'f.txt': enc('foo\n') });
  w0 = Fake.instances.length;
  const t0 = Date.now();
  const p1 = exec('bash', 'grep foo f.txt', vfs, {});
  armNextWorkerScanDrop();
  await until(() => Fake.instances.length > w0, 1000);
  w = last(Fake.instances);
    w.dropCmds = new Set(['scan']); // init completes; the scan never answers
  r = await p1;
  const elapsed = Date.now() - t0;
  check('T1 hanging regex scan fails with the bounded timeout message',
    !r.success && r.output === 'grep: regex evaluation timed out (the pattern may cause excessive backtracking; simplify it)',
    JSON.stringify(r));
  check('T1 timeout fires after GREP_REGEX_TIMEOUT_MS', elapsed >= M.GREP_REGEX_TIMEOUT_MS && elapsed < M.GREP_REGEX_TIMEOUT_MS * 5, 'elapsed=' + elapsed);
  check('T1 timeout TERMINATES the worker', w.terminateCount === 1 && w.terminated, 'terminateCount=' + w.terminateCount);
  w.lateDeliver({ id: w.sent.find((m) => m.cmd === 'scan').id, type: 'result', count: 999 });
  await sleep(20);
  check('T1 late reply after timeout ignored, no unhandled rejection', unhandled.length === 0, JSON.stringify(unhandled.map((e) => e.message)));
  r = await exec('bash', 'grep foo f.txt', vfs, {});
  check('T1 next grep after timeout recovers with a fresh worker',
    r.success && r.output === 'foo' && Fake.instances.length === w0 + 2, JSON.stringify(r) + ' instances=' + Fake.instances.length);

  // C1: cancellation during a pending scan → cancelled, never "timed out"
  vfs = fixture({ 'f.txt': enc('foo\n') });
  w0 = Fake.instances.length;
  const ac = new AbortController();
  const p2 = exec('bash', 'grep foo f.txt', vfs, { signal: ac.signal });
  armNextWorkerScanDrop();
  await until(() => Fake.instances.length > w0, 1000);
  w = last(Fake.instances);
    w.dropCmds = new Set(['scan']);
  await until(() => w.sent.some((m) => m.cmd === 'scan'));
  ac.abort();
  r = await p2;
  check('C1 cancelled scan reports bash: cancelled (not timeout)',
    !r.success && r.output === 'bash: cancelled', JSON.stringify(r));
  check('C1 cancellation terminates the worker exactly once', w.terminateCount === 1, 'terminateCount=' + w.terminateCount);
  w.lateDeliver({ id: w.sent.find((m) => m.cmd === 'scan').id, type: 'result', count: 1 });
  await sleep(20);
  check('C1 late reply after cancel ignored, no unhandled rejection', unhandled.length === 0, JSON.stringify(unhandled.map((e) => e.message)));

  // W1: worker crash mid-command → bounded failure, worker dead, next grep recovers
  vfs = fixture({ 'f.txt': enc('foo\n') });
  w0 = Fake.instances.length;
  const p3 = exec('bash', 'grep foo f.txt', vfs, {});
  armNextWorkerScanDrop();
  await until(() => Fake.instances.length > w0, 1000);
  w = last(Fake.instances);
    w.dropCmds = new Set(['scan']);
  await until(() => w.sent.some((m) => m.cmd === 'scan'));
  w.crash();
  r = await p3;
  check('W1 worker crash fails bounded', !r.success && r.output === 'grep: regex worker failed', JSON.stringify(r));
  check('W1 crash terminates the worker', w.terminateCount === 1, 'terminateCount=' + w.terminateCount);
  r = await exec('bash', 'grep foo f.txt', vfs, {});
  check('W1 next grep after crash recovers with a new worker',
    r.success && r.output === 'foo' && Fake.instances.length === w0 + 2, JSON.stringify(r));

  // U1: worker construction fails → grep fails CLOSED, never main-thread regex
  vfs = fixture({ 'f.txt': enc('foo\n') });
  w0 = Fake.instances.length;
  M.GrepRegexRuntime._workerFactory = () => { throw new Error('no workers in this browser'); };
  r = await exec('bash', 'grep foo f.txt', vfs, {});
  check('U1 worker unavailable fails closed with a bounded message',
    !r.success && r.output === 'grep: regex worker unavailable' && r.output !== 'foo', JSON.stringify(r));
  check('U1 no worker instance was created', Fake.instances.length === w0, 'instances=' + Fake.instances.length);
  M.GrepRegexRuntime._workerFactory = () => new Fake();
  r = await exec('bash', 'grep foo f.txt', vfs, {});
  check('U1 grep recovers once workers are available again', r.success && r.output === 'foo', JSON.stringify(r));

  // R1: result and abort race — whichever settles first wins, exactly once
  vfs = fixture({ 'f.txt': enc('foo\n') });
  const acR1 = new AbortController();
  const pR1 = exec('bash', 'grep foo f.txt', vfs, { signal: acR1.signal });
  armNextWorkerScanDrop();
  await until(() => Fake.instances.length > w0, 1000);
  w = last(Fake.instances);
    w.dropCmds = new Set(['scan']);
  await until(() => w.sent.some((m) => m.cmd === 'scan'));
  const scanIdR1 = w.sent.find((m) => m.cmd === 'scan').id;
  w.lateDeliver({ id: scanIdR1, type: 'result', matches: [{ lineNumber: 1, line: 'foo' }], hitMatchLimit: false });
  acR1.abort(); // after the worker reply — no second settlement, no re-delivery
  r = await pR1;
  // Round-2 classification contract: the abort landed before the execute
  // settled and the machinery never reported it, so the session classifies
  // the run honestly — failed, with the delivered result text KEPT in the
  // output and exactly one worker settlement (the old pin asked for a
  // clean success; the run's own result was never lost, only named).
  check('R1 single settlement: reply delivered exactly once, abort named, result text kept',
    w.terminateCount === 1 && r.success === false
    && /foo/.test(String(r.output)) && /cancelled/i.test(String(r.output)),
    JSON.stringify(r) + ' tc=' + w.terminateCount);

  vfs = fixture({ 'f.txt': enc('foo\n') });
  const acR2 = new AbortController();
  const pR2 = exec('bash', 'grep foo f.txt', vfs, { signal: acR2.signal });
  armNextWorkerScanDrop();
  await until(() => Fake.instances.length > w0, 1000);
  w = last(Fake.instances);
    w.dropCmds = new Set(['scan']);
  await until(() => w.sent.some((m) => m.cmd === 'scan'));
  acR2.abort();
  w.lateDeliver({ id: w.sent.find((m) => m.cmd === 'scan').id, type: 'result', matches: [{ lineNumber: 1, line: 'foo' }], hitMatchLimit: false });
  r = await pR2;
  check('R2 abort beats a late result — cancelled wins, stale reply ignored',
    !r.success && r.output === 'bash: cancelled' && w.terminateCount === 1, JSON.stringify(r));

  await sleep(20);
  check('GB no unhandled rejections across all races', unhandled.length === 0, JSON.stringify(unhandled.map((e) => e.message)));
  process.off('unhandledRejection', onUnhandled);
}

// ---------- Part C: static no-main-thread-regex invariant over shGrep ----------
function partC() {
  const text = fs.readFileSync(path.join(__dirname, '..', 'src', 'shell.js'), 'utf8').replace(/\r\n/g, '\n');
  const start = text.indexOf('async function shGrep(');
  const end = text.indexOf('async function shHead(', start);
  const body = text.slice(start, end);
  const bad = [];
  for (const pat of ['new RegExp', '.test(', '.exec(', '.match(']) {
    if (body.includes(pat)) bad.push(pat);
  }
  check('GW-C shGrep never compiles or tests the pattern on the main thread', bad.length === 0, 'found: ' + bad.join(', '));
  check('GW-C shGrep runs every scan through the worker session', body.includes('session.scan('), 'missing session.scan');
}

(async () => {
  __session = (await __hostPromise).createSession();
  partA();
  await partB();
  partC();
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('TEST RUNNER FAIL', e); process.exit(1); });
