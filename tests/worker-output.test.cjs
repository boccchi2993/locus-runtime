// Worker output-collection tests (Finding 1, protocol v2): drives the REAL
// worker source from index.html with a fake Pyodide FS, and the REAL
// shell.js commit logic with the worker boundary stubbed.
//
// Scenarios:
//  - >200 output files: the 201st (a rename target) must be reported as a
//    STRUCTURED uncollected path, and the shell commit must refuse deletions.
//  - output volume cap: same structured reporting; caps are GLOBAL across mounts.
//  - multi-mount diff: changes under different roots keep ABSOLUTE paths.
//  - read-only mounts: the worker echoes changes; the main-thread commit
//    rejects them and the provider bytes are never touched.
//  - /tmp is Pyodide-owned: syncIn deletes exactly the files IT wrote.
//  - size is checked BEFORE reading/base64-encoding a huge file.
//  - normal rename and plain delete still work.
// Run: node tests/worker-output.test.cjs

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + detail : '')); }
}

// ---------- real worker source with a fake Pyodide ----------
// M2a: the worker source is a runtime asset module (never index.html).
const { PY_WORKER_SOURCE: workerSrc } = require('./helpers/runtime.cjs');

function makeFakePy(mutate) {
  // Pyodide's real FS always has / and /tmp.
  const files = new Map([['/', 'DIR'], ['/tmp', 'DIR']]); // full ABS path -> Uint8Array | 'DIR' | any raw value
  const reads = [];
  const chmods = [];
  const rmtrees = [];
  const api = {
    FS: {
      mkdirTree(p) {
        // record every component as a directory so readdir/stat agree
        const parts = String(p).split('/').filter(Boolean);
        let cur = '';
        for (const part of parts) { cur += '/' + part; files.set(cur, 'DIR'); }
      },
      writeFile(p, data) { files.set(p, data); },
      readFile(p) {
        const v = files.get(p);
        if (v === undefined || v === 'DIR') throw new Error('readFile: no such file ' + p);
        reads.push(p);
        return v;
      },
      readdir(dir) {
        const out = ['.', '..'];
        const prefix = dir === '/' ? '/' : dir + '/';
        for (const k of files.keys()) {
          if (!k.startsWith(prefix)) continue;
          const rest = k.slice(prefix.length);
          if (rest && !rest.includes('/')) out.push(rest);
        }
        return out;
      },
      stat(p) {
        const v = files.get(p);
        if (v === undefined) throw new Error('stat: no such file ' + p);
        return { mode: v === 'DIR' ? 1 : 2, size: v === 'DIR' ? 0 : v.byteLength };
      },
      isDir(mode) { return mode === 1; },
      unlink(p) { files.delete(p); },
      chmod(p, mode) { chmods.push(p + ':' + (mode).toString(8)); },
    },
    _reads: reads,
    _chmods: chmods,
    _rmtrees: rmtrees,
    _files: files,
    // subtree-delete shim: only ever invoked for the managed roots
    runPython(code) {
      const m = /shutil\.rmtree\(("(?:[^"\\]|\\.)*")/.exec(String(code));
      if (m) {
        const root = JSON.parse(m[1]);
        rmtrees.push(root);
        for (const k of [...files.keys()]) {
          if (k === root || k.startsWith(root + '/')) files.delete(k);
        }
      }
    },
    async runPythonAsync(code) {
      // called for the os.chdir shim AND the user code; mutate is idempotent
      if (mutate && String(code).indexOf('os.chdir') === -1) mutate(api.FS, files);
    },
    async loadPackagesFromImports() {},
    // F04a: the worker calls loadPackage with the DECLARED runtime packages
    // during bootstrap (never loadPackagesFromImports with user code).
    async loadPackage(pkgs) {
      if (String(pkgs) !== 'pandas') throw new Error('unexpected package request: ' + pkgs);
    },
    setStdout() {},
    setStderr() {},
  };
  return api;
}

// Run worker jobs (protocol v2 messages) in one shared worker context.
// Returns { results, py } — py._reads records every readFile (proves size
// checks happen BEFORE reads), py._chmods / py._rmtrees record FS calls.
async function runWorkerJobs(jobs) {
  const posted = [];
  let py = null;
  const c = vm.createContext({
    self: { postMessage(msg) { if (msg.type === 'result') posted.push(msg); } },
    // Worker-global primitives the F04a lockdown expects to find and deny.
    fetch: function () {},
    XMLHttpRequest: function () {},
    WebSocket: function () {},
    importScripts() {},
    loadPyodide: async () => { if (!py) py = makeFakePy(jobs[posted.length] && jobs[posted.length].mutate); return py; },
    atob, btoa, TextEncoder, TextDecoder,
  });
  vm.runInContext(workerSrc, c);
  // Protocol v3: deliver the in-memory bootstrap assets first (unit stubs —
  // the sandbox provides loadPyodide; the asm stub defines the factory the
  // real loader would skip loading for).
  await vm.runInContext(`self.onmessage({ data: ${JSON.stringify({
    id: 1, cmd: 'bootstrap',
    assets: {
      'pyodide.js': { text: '/* unit stub: loadPyodide comes from the sandbox */' },
      'pyodide.asm.js': { text: 'var _createPyodideModule = function () {};' },
    },
  })} })`, c);
  const results = [];
  for (const job of jobs) {
    const msg = {
      id: 100 + results.length,
      cmd: 'run',
      code: job.code || 'x',
      cwd: job.cwd || '/mnt/workspace',
      mounts: job.mounts || [],
    };
    await vm.runInContext(`self.onmessage({ data: ${JSON.stringify(msg)} })`, c);
    for (let i = 0; i < 200 && results.length === posted.length && !posted[results.length]; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    if (!posted[results.length]) throw new Error('worker posted no result');
    results.push(posted[results.length]);
  }
  return { results, py };
}
const runWorkerJob = async (mutate, mounts) => (await runWorkerJobs([{ mutate, mounts }])).results[0];

const wsMount = (files) => [{ root: '/mnt/workspace', readOnly: false, files: files || [] }];

// ---------- real shell.js commit path (worker boundary stubbed) ----------
global.window = { location: { protocol: 'https:' } };
global.document = { getElementById: () => null };
const M = require('./helpers/core.cjs');

// M1b: python runs on an INJECTED interpreter instance (what the product
// wiring does). One suite instance; every bash call gets it via opts.
const { freshRuntime } = require('./helpers/runtime.cjs');
let pyrt = null; // the bash seam drives THIS instance — resolved at run() start
const exec = (tool, input, workspace, opts) => {
  if (tool !== 'bash') throw new Error('this suite drives bash via the internal runShellCommand seam');
  return M.runShellCommand(input, workspace, Object.assign({ pythonRuntime: pyrt }, opts || {}))
    .then((res) => Object.assign({}, res, { success: !res.isError }));
};

function bareVfs(adapter) {
  const vfs = new M.VirtualWorkspace({ listCommands: () => Object.keys(M.SHELL_COMMANDS) });
  if (adapter) vfs.mount('/mnt/workspace', adapter, 'external-read-write');
  return vfs;
}

class MemWS extends M.WorkspaceAdapter {
  constructor(files) {
    super();
    this.name = 'mem';
    this.files = {};
    for (const k in (files || {})) this.files[k] = new TextEncoder().encode(files[k]);
  }
  async list() { return Object.keys(this.files).map((n) => ({ name: n, kind: 'file' })); }
  async read(p) { return new TextDecoder().decode(await this.readBytes(p)); }
  async readBytes(p) {
    p = M.normalizeWorkspacePath(p);
    if (!(p in this.files)) { const e = new Error('No such file: ' + p); e.name = 'NotFoundError'; throw e; }
    return this.files[p];
  }
  async write(p, data) { p = M.normalizeWorkspacePath(p); this.files[p] = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data); }
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

function mockWorkerResult(result) {
  pyrt._ensureWorker = () => {};
  pyrt.worker = {
    postMessage(msg) {
      const p = pyrt._pending.get(msg.id);
      queueMicrotask(() => {
        clearTimeout(p.timer);
        pyrt._pending.delete(msg.id);
        p.resolve(result);
      });
    },
  };
}

async function run() {
  pyrt = freshRuntime(M);
  // ---------- O1. >200 outputs: rename target becomes the 201st → structured uncollected ----------
  const o1job = await runWorkerJobs([{
    mutate: (FS) => {
      FS.unlink('/mnt/workspace/old.txt'); // python renamed old.txt → renamed
      for (let i = 1; i <= 200; i++) {
        FS.writeFile('/mnt/workspace/f' + String(i).padStart(3, '0') + '.txt', new TextEncoder().encode('x'));
      }
      FS.writeFile('/mnt/workspace/renamed', new TextEncoder().encode('original'));
    },
    mounts: wsMount([{ path: '/mnt/workspace/old.txt', b64: btoa('original') }]),
  }]);
  const o1 = o1job.results[0];
  check('O1 rename target reported as STRUCTURED uncollected ABS path',
    Array.isArray(o1.uncollectedFiles) && o1.uncollectedFiles.indexOf('/mnt/workspace/renamed') !== -1,
    'uncollectedFiles=' + JSON.stringify(o1.uncollectedFiles));
  check('O1b deletion list still returned with ABS paths (shell decides, not worker)',
    Array.isArray(o1.deleted) && o1.deleted.indexOf('/mnt/workspace/old.txt') !== -1, JSON.stringify(o1.deleted));
  check('O1c managed root was rmtree-ed by syncIn, never / or /tmp',
    o1job.py._rmtrees.join(',') === '/mnt/workspace', JSON.stringify(o1job.py._rmtrees));

  // shell commit: with an incomplete changeset, the source must survive and the run must FAIL
  const ws1 = new MemWS({ 'old.txt': 'original' });
  mockWorkerResult({
    stdout: '', stderr: '', error: null,
    files: [], // the rename target was never collected
    deleted: ['/mnt/workspace/old.txt'],
    uncollectedFiles: ['/mnt/workspace/renamed'],
    stdoutTruncated: false, stderrTruncated: false,
  });
  const r1 = await exec('bash', "python -c 'x'", ws1);
  check('O1d incomplete changeset → source preserved',
    !!ws1.files['old.txt'] && new TextDecoder().decode(ws1.files['old.txt']) === 'original');
  check('O1e incomplete changeset → tool reports failure', r1.success === false, JSON.stringify(r1.output));
  check('O1f uncollected path surfaced (ABS)', r1.output.includes('/mnt/workspace/renamed'), JSON.stringify(r1.output));

  // ---------- O2. volume cap: uncollected files block deletes too ----------
  const ws2 = new MemWS({ 'old.txt': 'original' });
  mockWorkerResult({
    stdout: '', stderr: '', error: null,
    files: [{ path: '/mnt/workspace/part1.bin', b64: btoa('part') }],
    deleted: ['/mnt/workspace/old.txt'],
    uncollectedFiles: ['/mnt/workspace/part2.bin', '/mnt/workspace/part3.bin'],
  });
  const r2 = await exec('bash', "python -c 'x'", ws2);
  check('O2 volume-cap uncollected → source preserved + failure',
    r2.success === false && !!ws2.files['old.txt'] && new TextDecoder().decode(ws2.files['old.txt']) === 'original'
    && !!ws2.files['part1.bin'] && new TextDecoder().decode(ws2.files['part1.bin']) === 'part',
    JSON.stringify(r2.output));

  // ---------- O3. huge file: size checked BEFORE read/base64 ----------
  const o3job = await runWorkerJobs([{
    mutate: (FS) => {
      const big = { get byteLength() { return 30 * 1024 * 1024; } };
      FS.writeFile('/mnt/workspace/huge.bin', big);
      FS.writeFile('/mnt/workspace/small.txt', new TextEncoder().encode('ok'));
    },
    mounts: wsMount([]),
  }]);
  const o3 = o3job.results[0];
  check('O3 huge file uncollected without reading it',
    Array.isArray(o3.uncollectedFiles) && o3.uncollectedFiles.indexOf('/mnt/workspace/huge.bin') !== -1
    && o3job.py._reads.indexOf('/mnt/workspace/huge.bin') === -1,
    JSON.stringify(o3.uncollectedFiles) + ' reads=' + JSON.stringify(o3job.py._reads));
  check('O3b small file still collected with ABS path',
    (o3.files || []).some((f) => f.path === '/mnt/workspace/small.txt'), JSON.stringify((o3.files || []).map((f) => f.path)));

  // ---------- O4. stdout truncation is NOT a changeset failure ----------
  const ws4 = new MemWS({ 'old.txt': 'original' });
  mockWorkerResult({
    stdout: 'lots', stderr: '', error: null,
    files: [{ path: '/mnt/workspace/new.txt', b64: btoa('n') }],
    deleted: ['/mnt/workspace/old.txt'],
    uncollectedFiles: [],
    stdoutTruncated: true,
  });
  const r4 = await exec('bash', "python -c 'x'", ws4);
  check('O4 stdout truncation alone stays success, rename commits',
    r4.success === true && !('old.txt' in ws4.files) && !!ws4.files['new.txt']
    && r4.output.includes('stdout truncated'), JSON.stringify(r4.output).slice(0, 200));

  // ---------- O5. plain delete and normal rename unaffected ----------
  const ws5 = new MemWS({ 'gone.txt': 'x' });
  mockWorkerResult({ stdout: '', stderr: '', error: null, files: [], deleted: ['/mnt/workspace/gone.txt'], uncollectedFiles: [] });
  const r5 = await exec('bash', "python -c 'x'", ws5);
  check('O5 plain delete still works', r5.success === true && !('gone.txt' in ws5.files));

  const ws6 = new MemWS({ 'old.txt': 'original' });
  mockWorkerResult({
    stdout: '', stderr: '', error: null,
    files: [{ path: '/mnt/workspace/renamed', b64: btoa('original') }],
    deleted: ['/mnt/workspace/old.txt'],
    uncollectedFiles: [],
  });
  const r6 = await exec('bash', "python -c 'x'", ws6);
  check('O6 normal rename still works', r6.success === true && !('old.txt' in ws6.files)
    && new TextDecoder().decode(ws6.files['renamed']) === 'original');

  // ---------- O7. multi-mount diff: every mount root is walked, ABS paths ----------
  const o7job = await runWorkerJobs([{
    mutate: (FS) => {
      FS.writeFile('/mnt/workspace/w.txt', new TextEncoder().encode('w'));
      FS.writeFile('/mnt/download/d.txt', new TextEncoder().encode('d'));
      FS.writeFile('/tmp/t.txt', new TextEncoder().encode('t'));
    },
    mounts: [
      { root: '/mnt/workspace', readOnly: false, files: [{ path: '/mnt/workspace/old.txt', b64: btoa('o') }] },
      { root: '/mnt/download', readOnly: false, files: [] },
      { root: '/tmp', readOnly: false, files: [] },
    ],
  }]);
  const o7 = o7job.results[0];
  const o7paths = (o7.files || []).map((f) => f.path).sort();
  check('O7 diff walks every mount root with ABS paths',
    o7paths.join(',') === '/mnt/download/d.txt,/mnt/workspace/w.txt,/tmp/t.txt',
    JSON.stringify(o7paths));
  check('O7c unchanged synced file is NOT re-reported', !o7paths.includes('/mnt/workspace/old.txt'), JSON.stringify(o7paths));
  check('O7b managed roots rmtree-ed, /tmp NOT rmtree-ed',
    o7job.py._rmtrees.indexOf('/mnt/workspace') !== -1
    && o7job.py._rmtrees.indexOf('/mnt/download') !== -1
    && o7job.py._rmtrees.indexOf('/tmp') === -1
    && o7job.py._rmtrees.indexOf('/') === -1, JSON.stringify(o7job.py._rmtrees));

  // ---------- O8. global caps are shared across mounts ----------
  const o8job = await runWorkerJobs([{
    mutate: (FS) => {
      for (let i = 1; i <= 200; i++) FS.writeFile('/mnt/workspace/g' + String(i).padStart(3, '0') + '.txt', new TextEncoder().encode('x'));
      FS.writeFile('/mnt/download/overflow.txt', new TextEncoder().encode('y'));
    },
    mounts: [
      { root: '/mnt/workspace', readOnly: false, files: [] },
      { root: '/mnt/download', readOnly: false, files: [] },
    ],
  }]);
  const o8 = o8job.results[0];
  check('O8 file cap is global across mounts (201st uncollected)',
    (o8.files || []).length === 200
    && (o8.uncollectedFiles || []).indexOf('/mnt/download/overflow.txt') !== -1,
    'files=' + (o8.files || []).length + ' uncollected=' + JSON.stringify(o8.uncollectedFiles));

  // ---------- O9. read-only mount: worker echoes, main thread refuses ----------
  const o9job = await runWorkerJobs([{
    mutate: (FS) => { FS.writeFile('/mnt/upload/input.txt', new TextEncoder().encode('hacked')); },
    mounts: [
      { root: '/mnt/upload', readOnly: true, files: [{ path: '/mnt/upload/input.txt', b64: btoa('original') }] },
    ],
  }]);
  const o9 = o9job.results[0];
  const o9entry = (o9.files || []).find((f) => f.path === '/mnt/upload/input.txt');
  check('O9 worker echoes read-only-mount change (ABS path, new bytes)',
    !!o9entry && atob(o9entry.b64) === 'hacked', JSON.stringify(o9.files));
  check('O9b read-only mount files chmod 0o444 on sync-in (best effort)',
    o9job.py._chmods.some((c) => c === '/mnt/upload/input.txt:444'), JSON.stringify(o9job.py._chmods));

  // main-thread commit rejects it and never touches provider bytes
  const vfs9 = bareVfs(null);
  const up9 = vfs9.resolveMount('/mnt/upload').provider;
  const upBytes = new TextEncoder().encode('original');
  up9.addFile({ name: 'input.txt', size: upBytes.byteLength, arrayBuffer: async () => upBytes.slice().buffer });
  mockWorkerResult({
    stdout: '', stderr: '', error: null,
    files: [{ path: '/mnt/upload/input.txt', b64: btoa('hacked') }],
    deleted: [], uncollectedFiles: [],
  });
  const r9 = await exec('bash', "python -c 'x'", vfs9);
  check('O9c read-only change rejected at commit with clear conflict',
    r9.success === false
    && r9.output.includes('conflict: /mnt/upload/input.txt')
    && r9.output.includes('read-only filesystem: changes under /mnt/upload are never committed'),
    JSON.stringify(r9.output));
  check('O9d provider bytes never touched',
    new TextDecoder().decode(await vfs9.readBytes('/mnt/upload/input.txt')) === 'original');

  // read-only DELETE attempt is likewise refused
  mockWorkerResult({
    stdout: '', stderr: '', error: null,
    files: [], deleted: ['/mnt/upload/input.txt'], uncollectedFiles: [],
  });
  const r9b = await exec('bash', "python -c 'x'", vfs9);
  check('O9e read-only delete rejected at commit', r9b.success === false
    && r9b.output.includes('read-only filesystem')
    && (await vfs9.exists('/mnt/upload/input.txt')), JSON.stringify(r9b.output));

  // ---------- O10. /tmp cleanup: only the files syncIn wrote are removed ----------
  const o10job = await runWorkerJobs([
    { mounts: [{ root: '/tmp', readOnly: false, files: [{ path: '/tmp/synced.txt', b64: btoa('a') }] }] },
    { mounts: [{ root: '/tmp', readOnly: false, files: [] }] },
  ]);
  check('O10 second syncIn unlinks exactly the previous /tmp files',
    !o10job.py._files.has('/tmp/synced.txt') && o10job.py._rmtrees.indexOf('/tmp') === -1,
    'files=' + JSON.stringify([...o10job.py._files.keys()]) + ' rmtrees=' + JSON.stringify(o10job.py._rmtrees));

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.error('TEST RUNNER FAIL', e); process.exit(1); });
