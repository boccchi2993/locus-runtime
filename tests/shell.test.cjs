// Shell regression tests (node): quoted-aware tokenizer, python write-back
// failure semantics (F04), external-edit conflicts (F11), skipped-path
// overwrite protection (F10), cancellation.
// PythonRuntime's worker is stubbed at the message boundary — the same
// technique as the audit's R3 reproduction.
// Run: node tests/shell.test.cjs

global.window = { location: { protocol: 'https:' } };
global.document = { getElementById: () => null }; // PythonRuntime._setStatus touches the status bar

const M = require('./helpers/core.cjs');

// M2a: bash routes through the PUBLIC runtime entry. Worker sources are
// never booted by this suite.
const { createRuntime } = require('../src/index.js');
// M2a review: the public entry assembles asynchronously — the session is
// resolved before the checks drive it.
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
// Node has no real Worker: grep regex execution runs through the TEST-ONLY deterministic fake.
const { installGrepFakeWorker } = require('./helpers/grep-fake-worker.cjs');
installGrepFakeWorker(M);

// Wrap a legacy adapter the way asVfs does internally, but keep a handle on
// the VFS so tests can assert through absolute paths.
function wrapVfs(adapter, opts) {
  const vfs = new M.VirtualWorkspace(Object.assign({ listCommands: () => Object.keys(M.SHELL_COMMANDS) }, opts || {}));
  if (adapter) vfs.mount('/mnt/workspace', adapter, 'external-read-write');
  return vfs;
}

// --- byte-exact in-memory workspace ---
class MemWS extends M.WorkspaceAdapter {
  constructor(files) {
    super();
    this.name = 'mem';
    this.files = {};
    this.writeFail = new Set(); // paths whose write() throws
    for (const k in (files || {})) this.files[k] = new TextEncoder().encode(files[k]);
  }
  async list() { return Object.keys(this.files).map((n) => ({ name: n, kind: 'file' })); }
  async read(p) { return new TextDecoder().decode(await this.readBytes(p)); }
  async readBytes(p) {
    p = M.normalizeWorkspacePath(p);
    if (!(p in this.files)) { const e = new Error('No such file: ' + p); e.name = 'NotFoundError'; throw e; }
    return this.files[p];
  }
  async write(p, data) {
    p = M.normalizeWorkspacePath(p);
    if (this.writeFail.has(p)) throw new Error('disk full');
    this.files[p] = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
  }
  async remove(p) { p = M.normalizeWorkspacePath(p); delete this.files[p]; }
  async mkdir(p) { p = M.normalizeWorkspacePath(p); if (p && p in this.files) { const e = new Error('type mismatch'); e.name = 'TypeMismatchError'; throw e; } }
  async exists(p) { try { p = M.normalizeWorkspacePath(p); } catch (e) { return false; } return p === '' || p in this.files; }
  async stat(p) {
    p = M.normalizeWorkspacePath(p);
    if (p === '') return { kind: 'directory', size: 0, modified: 0 };
    if (!(p in this.files)) { const e = new Error('No such file: ' + p); e.name = 'NotFoundError'; throw e; }
    return { kind: 'file', size: this.files[p].byteLength, modified: 0 };
  }
}

function b64(s) { return Buffer.from(s, 'utf8').toString('base64'); }

// M1b: the shell executes python on an INJECTED interpreter instance.
// One instance is created for this suite and handed to every bash call
// via opts.pythonRuntime (exactly what the product wiring does); the
// worker boundary stub is installed on that instance.
const { freshRuntime } = require('./helpers/runtime.cjs');
let pyrt = null; // the session drives THIS instance — resolved at run() start
function withPyrt(opts) { return Object.assign({ pythonRuntime: pyrt }, opts || {}); }

// Stub the worker boundary: postMessage resolves the pending request with
// the given result (after running mutate() to simulate external edits).
function mockWorkerResult(result, mutate) {
  pyrt._ensureWorker = () => {};
  pyrt.worker = {
    postMessage(msg) {
      const p = pyrt._pending.get(msg.id);
      queueMicrotask(async () => {
        if (mutate) await mutate();
        clearTimeout(p.timer);
        pyrt._pending.delete(msg.id);
        p.resolve(result);
      });
    },
  };
}

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + detail : '')); }
}

async function run() {
  __session = (await __hostPromise).createSession();
  pyrt = __session.pythonRuntime();
  // ---------- T. tokenizer: quoted > / >> are text, never redirects (F15) ----------
  const ws = new MemWS();
  const t1 = await exec('bash', 'echo ">" victim.txt', ws);
  check('T1 quoted > prints text, writes nothing', t1.success && t1.output === '> victim.txt'
    && !('victim.txt' in ws.files), JSON.stringify(t1.output));

  const t2 = await exec('bash', 'echo "a >> b"', ws);
  check('T2 quoted >> inside text', t2.success && t2.output === 'a >> b' && Object.keys(ws.files).length === 0,
    JSON.stringify(t2.output));

  const t3 = await exec('bash', "echo '>' victim.txt", ws);
  check('T3 single-quoted > also text', t3.success && t3.output === '> victim.txt' && !('victim.txt' in ws.files));

  const t4 = await exec('bash', 'echo "unclosed', ws);
  check('T4 unclosed quote → clear error', !t4.success && t4.output.includes('unclosed quote'), t4.output);

  const t5 = await exec('bash', 'echo done > out.txt', ws);
  check('T5 real redirect still works', t5.success && new TextDecoder().decode(ws.files['out.txt'] || []) === 'done\n');

  const t6 = await exec('bash', 'echo hi >> out.txt', ws);
  check('T6 real append still works', t6.success && new TextDecoder().decode(ws.files['out.txt']) === 'done\nhi\n');

  // ---------- T2x. composition works; still-unsupported syntax fails loudly ----------
  const t7 = await exec('bash', 'echo hello | grep hell', ws);
  check('T7 pipe works', t7.success && t7.output === 'hello', t7.output);
  const t8 = await exec('bash', 'ls; pwd', ws);
  check('T8 semicolon sequence works', t8.success && t8.output.includes('out.txt') && t8.output.includes('/'), t8.output);
  const t7b = await exec('bash', 'ls || pwd', ws);
  check('T7b || skips rhs on success', t7b.success && t7b.output.includes('out.txt')
    && !t7b.output.includes('\n/'), t7b.output);
  const t9 = await exec('bash', 'cat out.txt > other.txt', ws);
  check('T9 redirect is generic (not echo-only)', t9.success
    && new TextDecoder().decode(ws.files['other.txt'] || []) === new TextDecoder().decode(ws.files['out.txt']),
    JSON.stringify(t9.output));

  // ---------- P. python write-back: failed target stops deletions (F04) ----------
  const wsP = new MemWS({ 'old.txt': 'original' });
  wsP.writeFail.add('new.txt');
  mockWorkerResult({ stdout: '', stderr: '', error: null, files: [{ path: '/mnt/workspace/new.txt', b64: b64('renamed') }], deleted: ['/mnt/workspace/old.txt'] });
  const p1 = await exec('bash', "python -c 'print(1)'", wsP, withPyrt());
  check('P1 failed write → tool reports failure', p1.success === false, JSON.stringify(p1.output));
  check('P1b source file preserved', new TextDecoder().decode(wsP.files['old.txt'] || []) === 'original');
  check('P1c deletions explicitly skipped', p1.output.includes('deletions skipped'), p1.output);
  check('P1d write failure reported (ABS path)', p1.output.includes('write-back failed: /mnt/workspace/new.txt'), p1.output);

  // successful rename still commits both sides
  const wsP2 = new MemWS({ 'old.txt': 'original' });
  mockWorkerResult({ stdout: '', stderr: '', error: null, files: [{ path: '/mnt/workspace/new.txt', b64: b64('original') }], deleted: ['/mnt/workspace/old.txt'] });
  const p2 = await exec('bash', "python -c 'print(1)'", wsP2, withPyrt());
  check('P2 rename commits both sides', p2.success === true && !('old.txt' in wsP2.files)
    && new TextDecoder().decode(wsP2.files['new.txt']) === 'original', JSON.stringify(p2.output));

  // ---------- C. external edits during the run are never overwritten (F11) ----------
  const wsC = new MemWS({ 'a.txt': 'before' });
  mockWorkerResult(
    { stdout: '', stderr: '', error: null, files: [{ path: '/mnt/workspace/a.txt', b64: b64('python version') }], deleted: [] },
    () => { wsC.files['a.txt'] = new TextEncoder().encode('user edit'); }, // external edit mid-run
  );
  const c1 = await exec('bash', "python -c 'print(1)'", wsC, withPyrt());
  check('C1 external edit conflict reported', c1.success === false && c1.output.includes('conflict: /mnt/workspace/a.txt'),
    JSON.stringify(c1.output));
  check('C1b user content preserved', new TextDecoder().decode(wsC.files['a.txt']) === 'user edit');

  // deletion of an externally modified file is refused
  const wsC2 = new MemWS({ 'a.txt': 'before' });
  mockWorkerResult(
    { stdout: '', stderr: '', error: null, files: [], deleted: ['/mnt/workspace/a.txt'] },
    () => { wsC2.files['a.txt'] = new TextEncoder().encode('user edit'); },
  );
  const c2 = await exec('bash', "python -c 'print(1)'", wsC2, withPyrt());
  check('C2 external edit blocks deletion', c2.success === false && ('a.txt' in wsC2.files)
    && c2.output.includes('deletion skipped'), JSON.stringify(c2.output));

  // unchanged file: python edit commits cleanly
  const wsC3 = new MemWS({ 'a.txt': 'before' });
  mockWorkerResult({ stdout: '', stderr: '', error: null, files: [{ path: '/mnt/workspace/a.txt', b64: b64('after') }], deleted: [] });
  const c3 = await exec('bash', "python -c 'print(1)'", wsC3, withPyrt());
  check('C3 clean modify commits', c3.success === true && new TextDecoder().decode(wsC3.files['a.txt']) === 'after');

  // ---------- S. unsynced (skipped) paths are never overwritten (F10) ----------
  const bigFile = new Uint8Array(6 * 1024 * 1024).fill(7); // over the 5 MiB per-file sync limit
  const wsS = new MemWS();
  wsS.files['big.bin'] = bigFile;
  mockWorkerResult({ stdout: '', stderr: '', error: null, files: [{ path: '/mnt/workspace/big.bin', b64: b64('python created') }], deleted: [] });
  const s1 = await exec('bash', "python -c 'print(1)'", wsS, withPyrt());
  check('S1 python file at skipped path refused', s1.success === false && s1.output.includes('conflict: /mnt/workspace/big.bin')
    && s1.output.includes('not synced into Python'), JSON.stringify(s1.output));
  check('S1b real file untouched', wsS.files['big.bin'].byteLength === bigFile.byteLength
    && wsS.files['big.bin'][0] === 7);
  check('S1c skip reported with path', s1.output.includes('NOT visible to Python') && s1.output.includes('big.bin'),
    JSON.stringify(s1.output).slice(0, 200));

  // ---------- N. no workspace: the bare machine still persists into /home/locus ----------
  const nVfs = wrapVfs(null);
  mockWorkerResult({ stdout: '', stderr: '', error: null, files: [{ path: '/home/locus/out.txt', b64: b64('x') }], deleted: [] });
  const n1 = await exec('bash', "python -c 'print(1)'", nVfs, withPyrt());
  check('N1 no workspace → output commits to /home/locus (ABS)', n1.success === true
    && new TextDecoder().decode(await nVfs.readBytes('/home/locus/out.txt')) === 'x'
    && n1.output.includes('[written: /home/locus/out.txt]'),
    JSON.stringify(n1.output));

  // a python output outside every writable mount is refused with a conflict
  const nVfs2 = wrapVfs(null);
  mockWorkerResult({ stdout: '', stderr: '', error: null, files: [{ path: '/usr/evil.txt', b64: b64('x') }], deleted: [] });
  const n2 = await exec('bash', "python -c 'print(1)'", nVfs2, withPyrt());
  check('N2 python output on structural path → conflict, not written', n2.success === false
    && n2.output.includes('conflict: /usr/evil.txt') && !(await nVfs2.exists('/usr/evil.txt')),
    JSON.stringify(n2.output));

  // ---------- X. cancellation before the run ----------
  const ac = new AbortController();
  ac.abort();
  const x1 = await M.runShellCommand("python -c 'print(1)'", new MemWS(), { signal: ac.signal, pythonRuntime: pyrt });
  check('X1 pre-aborted python → cancelled', x1.isError && x1.output.includes('cancelled'), x1.output);

  // ---------- Y. cancellation landing DURING async pre-checks (Finding 4) ----------

  // Y1: abort inside the conflict pre-check's readBytes → the write must NOT start
  const wsY1 = new MemWS({ 'a.txt': 'before' });
  const acY1 = new AbortController();
  let readsY1 = 0;
  const origReadY1 = wsY1.readBytes.bind(wsY1);
  wsY1.readBytes = async (p) => {
    readsY1++;
    const data = await origReadY1(p);
    if (p === 'a.txt' && readsY1 === 2) acY1.abort(); // 1st read = snapshot, 2nd = conflict check
    return data;
  };
  mockWorkerResult({ stdout: '', stderr: '', error: null, files: [{ path: '/mnt/workspace/a.txt', b64: b64('python') }], deleted: [], uncollectedFiles: [] });
  const y1 = await exec('bash', "python -c 'x'", wsY1, withPyrt({ signal: acY1.signal }));
  check('Y1 cancel during write pre-check → no write starts',
    new TextDecoder().decode(wsY1.files['a.txt']) === 'before', new TextDecoder().decode(wsY1.files['a.txt']));
  check('Y1b reported as not-persisted + failure', y1.success === false && y1.output.includes('cancelled before write'),
    JSON.stringify(y1.output));

  // Y2: abort inside the delete verification read → the remove must NOT start
  const wsY2 = new MemWS({ 'b.txt': 'keep' });
  const acY2 = new AbortController();
  let readsY2 = 0;
  const origReadY2 = wsY2.readBytes.bind(wsY2);
  wsY2.readBytes = async (p) => {
    readsY2++;
    const data = await origReadY2(p);
    if (p === 'b.txt' && readsY2 === 2) acY2.abort();
    return data;
  };
  mockWorkerResult({ stdout: '', stderr: '', error: null, files: [], deleted: ['/mnt/workspace/b.txt'], uncollectedFiles: [] });
  const y2 = await exec('bash', "python -c 'x'", wsY2, withPyrt({ signal: acY2.signal }));
  check('Y2 cancel during delete verification → file preserved',
    !!wsY2.files['b.txt'] && new TextDecoder().decode(wsY2.files['b.txt']) === 'keep');
  check('Y2b delete reported as not executed + failure', y2.success === false && y2.output.includes('cancelled before commit'),
    JSON.stringify(y2.output));

  // Y3: abort during workspace collection → the python run never starts
  const wsY3 = new MemWS({ 'c.txt': 'data' });
  const acY3 = new AbortController();
  const origListY3 = wsY3.list.bind(wsY3);
  wsY3.list = async (p) => { acY3.abort(); return origListY3(p); };
  let startedY3 = 0;
  pyrt._ensureWorker = () => {};
  pyrt.worker = { postMessage() { startedY3++; } };
  const y3 = await exec('bash', "python -c 'x'", wsY3, withPyrt({ signal: acY3.signal }));
  check('Y3 cancel during collection → worker never starts', startedY3 === 0 && !y3.success
    && y3.output.includes('cancelled'), 'started=' + startedY3 + ' out=' + JSON.stringify(y3.output));

  // Y4: echo >> — abort during the read of the old content → no write
  // (append reads raw BYTES via readBytes — the cancellation gate sits
  // between the read and the single write).
  const wsY4 = new MemWS({ 'log.txt': 'old\n' });
  const acY4 = new AbortController();
  const origReadY4 = wsY4.readBytes.bind(wsY4);
  wsY4.readBytes = async (p) => { const t = await origReadY4(p); acY4.abort(); return t; };
  const y4 = await exec('bash', 'echo new >> log.txt', wsY4, { signal: acY4.signal });
  check('Y4 echo >> cancel during read → no write', y4.success === false
    && new TextDecoder().decode(wsY4.files['log.txt']) === 'old\n', JSON.stringify(y4.output));

  // Y5: curl -o — abort after the fetch resolves → no file written
  const wsY5 = new MemWS();
  const acY5 = new AbortController();
  const origFetch = global.fetch;
  global.fetch = async () => {
    acY5.abort();
    return new Response('data', { status: 200, headers: { 'content-type': 'text/plain' } });
  };
  const y5 = await exec('bash', 'curl -o dl.txt https://example.test/x', wsY5, { signal: acY5.signal });
  global.fetch = origFetch;
  check('Y5 curl -o cancel after fetch → no write', y5.success === false && !('dl.txt' in wsY5.files),
    JSON.stringify(y5.output));

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.error('TEST RUNNER FAIL', e); process.exit(1); });
