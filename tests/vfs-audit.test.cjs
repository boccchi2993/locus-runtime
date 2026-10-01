// VFS audit remediation tests (F-01..F-05), node, no internet:
//   F-01 binary `>>` / `2>>` append is byte-preserving, bounded, atomic
//   F-02 empty VFS directories are synced into the Python mirror (cwd works)
//   F-03 Python-created/-deleted directories persist through the commit
//   F-04 task-bound VFS fork: a workspace switch can never rebind a task
//   F-05 curl -o onto a DIRECTORY fails before any network request
// Drives the REAL shell.js/vfs.js commit logic and the REAL worker source
// from index.html (fake Pyodide FS), like worker-output.test.cjs.
// Run: node tests/vfs-audit.test.cjs

const vm = require('vm');

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + detail : '')); }
}

// ---------- real browser-layer sources in one shared scope ----------
global.window = { location: { protocol: 'https:' } };
global.document = { getElementById: () => null };
const M = require('./helpers/core.cjs');

// M2a: bash routes through the PUBLIC runtime entry. Worker sources are
// never booted by this suite.
const { createRuntime } = require('../src/index.js');
// M2a review: the public entry assembles asynchronously — the session is
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
  }).then((res) => ({ output: res.output, success: !!res.ok, isError: !!res.isError, backend: res.backend, operation: res.operation }))
    // M3a: the Product adapter also CAUGHT session rejections and reported
    // them as failed tool results ('tool execution failed: …' — e.g. a
    // pre-aborted execute throws AbortError at admission). The Runtime
    // suite keeps that mapping so the check bodies stay untouched.
    .catch((e) => ({
      output: 'tool execution failed: ' + (e && e.message ? e.message : String(e)),
      success: false,
      isError: true,
      backend: 'browser',
      operation: null,
    }));
};

function bareVfs(withWorkspace) {
  // M2a: the PRODUCT home skeleton is passed explicitly (this suite
  // asserts product-shaped mirror contents, PD1e).
  const vfs = new M.VirtualWorkspace({
    listCommands: () => Object.keys(M.SHELL_COMMANDS),
    homeSkeleton: ['.skills', '.config/locus/mcp', '.cache/locus'],
  });
  if (withWorkspace) {
    vfs.mount('/mnt/workspace', new M.MemoryWorkspace({ name: 'ws' }), 'external-read-write');
  }
  return vfs;
}

const bytesEq = (u8, arr) => !!u8 && u8.byteLength === arr.length && arr.every((b, i) => u8[i] === b);
const hexPrefix = (u8, n) => Array.from((u8 || []).slice(0, n)).join(',');

// M1b: python runs on an INJECTED interpreter instance (what the product
// wiring does). One suite instance; every bash call gets it via opts.
const { freshRuntime } = require('./helpers/runtime.cjs');
let pyrt = null; // the session drives THIS instance — resolved at run() start

// ---------- python worker stub (main-thread commit tests) ----------
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
// Same stub, but also captures every message sent to the worker.
function captureWorker(result) {
  const msgs = [];
  pyrt._ensureWorker = () => {};
  pyrt.worker = {
    postMessage(msg) {
      msgs.push(msg);
      const p = pyrt._pending.get(msg.id);
      queueMicrotask(() => {
        clearTimeout(p.timer);
        pyrt._pending.delete(msg.id);
        p.resolve(result);
      });
    },
  };
  return msgs;
}
const OK_RESULT = {
  stdout: '', stderr: '', error: null,
  files: [], deleted: [], createdDirs: [], deletedDirs: [],
  uncollectedFiles: [], stdoutTruncated: false, stderrTruncated: false,
};
const okResult = (over) => Object.assign({}, OK_RESULT, over);

// ---------- real worker source with a fake Pyodide (worker-side tests) ----------
// M2a: the worker source is a runtime asset module (never index.html).
const { PY_WORKER_SOURCE: workerSrc } = require('./helpers/runtime.cjs');

function makeFakePy(mutate) {
  const files = new Map([['/', 'DIR'], ['/tmp', 'DIR']]); // ABS path -> Uint8Array | 'DIR'
  const rmtrees = [];
  const api = {
    FS: {
      mkdirTree(p) {
        const parts = String(p).split('/').filter(Boolean);
        let cur = '';
        for (const part of parts) { cur += '/' + part; files.set(cur, 'DIR'); }
      },
      writeFile(p, data) { files.set(p, data); },
      readFile(p) {
        const v = files.get(p);
        if (v === undefined || v === 'DIR') throw new Error('readFile: no such file ' + p);
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
      rmdir(p) { files.delete(p); },
      chmod() {},
    },
    _rmtrees: rmtrees,
    _files: files,
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
      if (mutate && String(code).indexOf('os.chdir') === -1) mutate(api.FS, files);
    },
    async loadPackagesFromImports() {},
    async loadPackage(pkgs) {
      if (String(pkgs) !== 'pandas') throw new Error('unexpected package request: ' + pkgs);
    },
    setStdout() {},
    setStderr() {},
  };
  return api;
}

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

async function run() {
  __session = (await __hostPromise).createSession();
  pyrt = __session.pythonRuntime();
  // ================================================================
  //  F-01 — byte-preserving append
  // ================================================================
  {
    // BA1: non-UTF-8 bytes survive `>>` exactly
    const vfs = bareVfs(false);
    await vfs.write('/tmp/bin.dat', new Uint8Array([0x00, 0xFF, 0xFE, 0x80, 0x41]));
    const r = await exec('bash', 'echo X >> /tmp/bin.dat', vfs);
    const after = await vfs.readBytes('/tmp/bin.dat');
    check('BA1 binary >> byte-exact prefix + utf8 payload', r.success
      && bytesEq(after, [0x00, 0xFF, 0xFE, 0x80, 0x41, 0x58, 0x0A]),
      hexPrefix(after, 8));

    // BA2: PNG-like signature untouched
    await vfs.write('/tmp/img.png', new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]));
    const r2 = await exec('bash', 'echo tail >> /tmp/img.png', vfs);
    const png = await vfs.readBytes('/tmp/img.png');
    check('BA2 PNG header byte-exact after >>', r2.success
      && bytesEq(png.slice(0, 8), [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
      && png.byteLength === 8 + 5, hexPrefix(png, 8));

    // BA3: stderr append (2>>) uses the same byte-safe primitive
    await vfs.write('/tmp/err.dat', new Uint8Array([0x00, 0xFF, 0xFE, 0x80]));
    const r3 = await exec('bash', 'cat /missing 2>> /tmp/err.dat', vfs);
    const err = await vfs.readBytes('/tmp/err.dat');
    check('BA3 binary 2>> preserves original bytes', !r3.success
      && bytesEq(err.slice(0, 4), [0x00, 0xFF, 0xFE, 0x80]) && err.byteLength > 4,
      hexPrefix(err, 4) + ' len=' + (err && err.byteLength));

    // BA4: text append behaviour unchanged
    const vfs4 = bareVfs(false);
    await exec('bash', 'echo hello > /tmp/t.txt', vfs4);
    await exec('bash', 'echo again >> /tmp/t.txt', vfs4);
    check('BA4 text append unchanged', new TextDecoder().decode(await vfs4.readBytes('/tmp/t.txt')) === 'hello\nagain\n');

    // BA5: quota failure — original file untouched
    const vfs5 = bareVfs(false);
    vfs5.mount('/tmp', new M.MemoryWorkspace({ name: 'tmp', maxBytes: 100 }), 'read-write');
    await vfs5.write('/tmp/q.txt', new Uint8Array(90));
    const r5 = await exec('bash', 'echo 0123456789abcdef >> /tmp/q.txt', vfs5);
    check('BA5 append quota failure is loud + source intact', !r5.success
      && r5.output.includes('exceeds maxBytes')
      && (await vfs5.readBytes('/tmp/q.txt')).byteLength === 90, JSON.stringify(r5.output));

    // BA6: oversized existing target — loud failure, no truncate, no OOM
    const big = new Uint8Array(17 * 1024 * 1024); // over APPEND_MAX_EXISTING_BYTES (16 MiB)
    big[0] = 0x89;
    const wsBig = new M.MemoryWorkspace({ name: 'ws', maxBytes: 64 * 1024 * 1024, maxFileBytes: 64 * 1024 * 1024 });
    await wsBig.write('big.bin', big);
    const vfs6 = bareVfs(false);
    vfs6.mount('/mnt/workspace', wsBig, 'external-read-write');
    const r6 = await exec('bash', 'echo x >> /mnt/workspace/big.bin', vfs6);
    check('BA6 oversized append target refused loudly, source intact', !r6.success
      && r6.output.includes('append limit')
      && (await vfs6.readBytes('/mnt/workspace/big.bin')).byteLength === big.byteLength,
      JSON.stringify(r6.output));

    // BA7: cancellation before the write leaves the source untouched
    const vfs7 = bareVfs(false);
    await vfs7.write('/tmp/c.txt', new TextEncoder().encode('old\n'));
    const ac = new AbortController();
    ac.abort();
    const r7 = await exec('bash', 'echo new >> /tmp/c.txt', vfs7, { signal: ac.signal });
    check('BA7 cancelled append never writes', !r7.success
      && new TextDecoder().decode(await vfs7.readBytes('/tmp/c.txt')) === 'old\n', JSON.stringify(r7.output));
  }

  // ================================================================
  //  F-02 — empty directories reach the Python mirror (cwd works)
  // ================================================================
  {
    // PD1: the sync-in message carries REAL VFS directories (all data mounts)
    const vfs = bareVfs(true);
    await vfs.mkdir('/tmp/empty');
    await vfs.mkdir('/mnt/download/empty');
    await vfs.mkdir('/mnt/workspace/emptydir');
    const msgs = captureWorker(okResult());
    const r = await exec('bash', 'cd /tmp/empty && python -c "x"', vfs);
    const msg = msgs[0];
    const dirsOf = (root) => {
      const m = msg.mounts.find((mm) => mm.root === root);
      return m ? m.directories || [] : null;
    };
    check('PD1a python cwd is the shell cwd', r.success && msg.cwd === '/tmp/empty', msg.cwd);
    check('PD1b empty /tmp dir synced into the mirror manifest', dirsOf('/tmp').includes('/tmp/empty'),
      JSON.stringify(dirsOf('/tmp')));
    check('PD1c empty /mnt/download dir synced', dirsOf('/mnt/download').includes('/mnt/download/empty'));
    check('PD1d empty /mnt/workspace dir synced', dirsOf('/mnt/workspace').includes('/mnt/workspace/emptydir'));
    check('PD1e skeleton home dirs synced', dirsOf('/home/locus').includes('/home/locus/.skills')
      && dirsOf('/home/locus').includes('/home/locus/.config/locus/mcp'), JSON.stringify(dirsOf('/home/locus')));

    // PD2: worker-side — syncIn materializes empty dirs in the mirror
    const job = await runWorkerJobs([{
      mounts: [{ root: '/mnt/workspace', readOnly: false, files: [], directories: ['/mnt/workspace/emptydir'] }],
    }]);
    check('PD2 syncIn creates empty dirs in the Pyodide mirror',
      job.py._files.get('/mnt/workspace/emptydir') === 'DIR'
      && job.results[0].createdDirs.length === 0 && job.results[0].deletedDirs.length === 0,
      JSON.stringify([...job.py._files.keys()]));

    // PD3: a bogus cwd is NOT fabricated — only VFS-confirmed dirs are added
    const vfs3 = bareVfs(false);
    const msgs3 = captureWorker(okResult());
    await exec('bash', 'python -c "x"', vfs3, {}); // cwd = /home/locus (default)
    const home3 = msgs3[0].mounts.find((m) => m.root === '/home/locus');
    check('PD3 default cwd needs no fabrication (mount root)', msgs3[0].cwd === '/home/locus'
      && !home3.directories.includes('/home/locus'), JSON.stringify(home3.directories));
  }

  // ================================================================
  //  F-03 — worker-side directory diff
  // ================================================================
  {
    // PW1: python mkdir → createdDirs
    const j1 = await runWorkerJobs([{
      mutate: (FS) => FS.mkdirTree('/mnt/workspace/newempty'),
      mounts: [{ root: '/mnt/workspace', readOnly: false, files: [], directories: [] }],
    }]);
    check('PW1 python-created empty dir reported in createdDirs',
      j1.results[0].createdDirs.join(',') === '/mnt/workspace/newempty', JSON.stringify(j1.results[0]));

    // PW2: nested creation is parent-before-child
    const j2 = await runWorkerJobs([{
      mutate: (FS) => FS.mkdirTree('/mnt/download/a/b/c'),
      mounts: [{ root: '/mnt/download', readOnly: false, files: [], directories: [] }],
    }]);
    check('PW2 nested mkdir parent-first order',
      j2.results[0].createdDirs.join(',') === '/mnt/download/a,/mnt/download/a/b,/mnt/download/a/b/c',
      JSON.stringify(j2.results[0].createdDirs));

    // PW3: python rmdir → deletedDirs
    const j3 = await runWorkerJobs([{
      mutate: (FS) => FS.rmdir('/tmp/goner'),
      mounts: [{ root: '/tmp', readOnly: false, files: [], directories: ['/tmp/goner'] }],
    }]);
    check('PW3 python-deleted empty dir reported in deletedDirs',
      j3.results[0].deletedDirs.join(',') === '/tmp/goner', JSON.stringify(j3.results[0].deletedDirs));

    // PW4: nested deletion is child-before-parent
    const j4 = await runWorkerJobs([{
      mutate: (FS) => { FS.rmdir('/tmp/x/y'); FS.rmdir('/tmp/x'); },
      mounts: [{ root: '/tmp', readOnly: false, files: [], directories: ['/tmp/x', '/tmp/x/y'] }],
    }]);
    check('PW4 nested rmdir child-first order',
      j4.results[0].deletedDirs.join(',') === '/tmp/x/y,/tmp/x', JSON.stringify(j4.results[0].deletedDirs));

    // PW5: /tmp dirs synced in by a previous run are cleaned up (not stale)
    const j5 = await runWorkerJobs([
      { mounts: [{ root: '/tmp', readOnly: false, files: [], directories: ['/tmp/persist'] }] },
      { mounts: [{ root: '/tmp', readOnly: false, files: [], directories: [] }] },
    ]);
    check('PW5 second syncIn removes exactly the dirs it created under /tmp',
      !j5.py._files.has('/tmp/persist')
      && j5.results[1].createdDirs.length === 0 && j5.results[1].deletedDirs.length === 0,
      JSON.stringify([...j5.py._files.keys()]) + ' | ' + JSON.stringify(j5.results[1].deletedDirs));

    // PW6: old main threads (no `directories` field) stay compatible
    const j6 = await runWorkerJobs([{
      mounts: [{ root: '/mnt/workspace', readOnly: false, files: [{ path: '/mnt/workspace/f.txt', b64: btoa('a') }] }],
    }]);
    check('PW6 mounts without directories field stay compatible',
      Array.isArray(j6.results[0].createdDirs) && j6.results[0].createdDirs.length === 0
      && Array.isArray(j6.results[0].deletedDirs) && j6.results[0].deletedDirs.length === 0
      && j6.results[0].files.length === 0, JSON.stringify(j6.results[0].createdDirs));
  }

  // ================================================================
  //  F-03 — main-thread directory commit
  // ================================================================
  {
    // DC1: created dirs persist across every writable mount
    const vfs = bareVfs(true);
    mockWorkerResult(okResult({
      createdDirs: ['/tmp/a', '/home/locus/a', '/mnt/download/a', '/mnt/workspace/a'],
    }));
    const r = await exec('bash', 'python -c "x"', vfs);
    const isDir = async (p) => (await vfs.stat(p)).kind === 'directory';
    check('DC1 python mkdir persists on /tmp, /home/locus, /mnt/download, /mnt/workspace', r.success
      && r.output.includes('[mkdir: /tmp/a, /home/locus/a, /mnt/download/a, /mnt/workspace/a]')
      && await isDir('/tmp/a') && await isDir('/home/locus/a')
      && await isDir('/mnt/download/a') && await isDir('/mnt/workspace/a'), JSON.stringify(r.output));
    const ls = await exec('bash', 'ls /tmp', vfs);
    check('DC1b shell sees the python-created dir', ls.success && ls.output.split('\n').includes('a/'), ls.output);

    // DC2: read-only mount — provider untouched, loud conflict
    const vfs2 = bareVfs(false);
    mockWorkerResult(okResult({ createdDirs: ['/mnt/upload/a'] }));
    const r2 = await exec('bash', 'python -c "x"', vfs2);
    check('DC2 python mkdir on /mnt/upload refused, provider unchanged', !r2.success
      && r2.output.includes('read-only filesystem')
      && (await vfs2.list('/mnt/upload')).length === 0, JSON.stringify(r2.output));

    // DC3: deleted empty dirs persist
    const vfs3 = bareVfs(false);
    await vfs3.mkdir('/tmp/goner');
    mockWorkerResult(okResult({ deletedDirs: ['/tmp/goner'] }));
    const r3 = await exec('bash', 'python -c "x"', vfs3);
    check('DC3 python rmdir persists', r3.success && !(await vfs3.exists('/tmp/goner'))
      && r3.output.includes('[deleted: /tmp/goner]'), JSON.stringify(r3.output));

    // DC4: nested create a/b/c all exist afterwards
    const vfs4 = bareVfs(false);
    mockWorkerResult(okResult({ createdDirs: ['/tmp/n', '/tmp/n/m', '/tmp/n/m/o'] }));
    const r4 = await exec('bash', 'python -c "x"', vfs4);
    check('DC4 nested empty dirs all committed', r4.success
      && await isDir2(vfs4, '/tmp/n') && await isDir2(vfs4, '/tmp/n/m') && await isDir2(vfs4, '/tmp/n/m/o'),
      JSON.stringify(r4.output));

    // DC5: file→directory type change is a loud refusal, file preserved
    const vfs5 = bareVfs(false);
    await vfs5.write('/tmp/f.txt', 'data');
    mockWorkerResult(okResult({ createdDirs: ['/tmp/f.txt'], deleted: ['/tmp/f.txt'] }));
    const r5 = await exec('bash', 'python -c "x"', vfs5);
    check('DC5 file→dir type change refused loudly, file intact', !r5.success
      && r5.output.includes('type changes are not committed')
      && new TextDecoder().decode(await vfs5.readBytes('/tmp/f.txt')) === 'data'
      && (await vfs5.stat('/tmp/f.txt')).kind === 'file', JSON.stringify(r5.output));

    // DC6: directory→file type change fails loudly, directory preserved
    const vfs6 = bareVfs(false);
    await vfs6.mkdir('/tmp/d');
    mockWorkerResult(okResult({ files: [{ path: '/tmp/d', b64: btoa('x') }], deletedDirs: ['/tmp/d'] }));
    const r6 = await exec('bash', 'python -c "x"', vfs6);
    check('DC6 dir→file type change fails loudly, dir intact', !r6.success
      && r6.output.includes('write-back failed')
      && (await vfs6.stat('/tmp/d')).kind === 'directory', JSON.stringify(r6.output));

    // DC7: any conflict blocks directory deletions (no destructive half-state)
    const vfs7 = bareVfs(false);
    await vfs7.mkdir('/tmp/keep');
    mockWorkerResult(okResult({ createdDirs: ['/mnt/upload/a'], deletedDirs: ['/tmp/keep'] }));
    const r7 = await exec('bash', 'python -c "x"', vfs7);
    check('DC7 conflict blocks directory deletions, sources preserved', !r7.success
      && await isDir2(vfs7, '/tmp/keep')
      && r7.output.includes('directory deletions skipped'), JSON.stringify(r7.output));

    // DC8: a committed dir is synced back in on the NEXT python run
    const msgs8 = captureWorker(okResult());
    await exec('bash', 'python -c "x"', vfs); // vfs from DC1, has /tmp/a
    const tmp8 = msgs8[0].mounts.find((m) => m.root === '/tmp');
    check('DC8 committed dirs round-trip into the next sync-in', tmp8.directories.includes('/tmp/a'),
      JSON.stringify(tmp8.directories));

    // DC9: read-only rmdir refused
    const vfs9 = bareVfs(false);
    mockWorkerResult(okResult({ deletedDirs: ['/mnt/upload/sub'] }));
    const r9 = await exec('bash', 'python -c "x"', vfs9);
    check('DC9 python rmdir on /mnt/upload refused', !r9.success
      && r9.output.includes('read-only filesystem'), JSON.stringify(r9.output));
  }

  // ================================================================
  //  F-04 — task-bound VFS fork (mount identity isolation)
  // ================================================================
  {
    const v = new M.VirtualWorkspace({ listCommands: () => Object.keys(M.SHELL_COMMANDS) });
    const w1 = new M.MemoryWorkspace({ name: 'w1' });
    v.mount('/mnt/workspace', w1, 'external-read-write');
    const taskVfs = v.fork(); // bound at task start

    check('FK1 fork is an independent mount table over shared providers',
      taskVfs !== v && taskVfs.isLocusVFS === true && taskVfs.mounts !== v.mounts
      && taskVfs.mounts.every((m, i) => m !== v.mounts[i] && m.provider === v.mounts[i].provider));

    // workspace switch: the live VFS now routes to W2
    const w2 = new M.MemoryWorkspace({ name: 'w2' });
    v.mount('/mnt/workspace', w2, 'external-read-write');

    // a late async operation of the OLD task resumes and writes
    await taskVfs.write('/mnt/workspace/late.txt', 'old task write');
    check('FK2 old task writes land in W1, never W2',
      new TextDecoder().decode(await w1.readBytes('late.txt')) === 'old task write'
      && !(await w2.exists('late.txt')));
    check('FK2b workspace identity: task bound to w1, live VFS on w2',
      taskVfs.workspaceName === 'w1' && v.workspaceName === 'w2');

    // same guarantee through the whole shell path
    const sh = await M.runShellCommand('echo late > /mnt/workspace/via-shell.txt', taskVfs);
    check('FK3 shell write through a task fork routes to W1 only', !sh.isError
      && await w1.exists('via-shell.txt') && !(await w2.exists('via-shell.txt')), JSON.stringify(sh.output));

    // unmount on the live VFS cannot unbind the task either
    v.unmount('/mnt/workspace');
    check('FK4 unmount on live VFS leaves the task fork intact',
      taskVfs.workspaceName === 'w1' && v.workspaceName === null
      && !(await v.exists('/mnt/workspace/late.txt')));

    // internal mounts are shared providers: the machine stays coherent
    await v.write('/tmp/shared.txt', 's');
    check('FK5 internal mounts shared between live VFS and fork',
      (await taskVfs.read('/tmp/shared.txt')) === 's');
  }

  // ================================================================
  //  F-05 — curl -o onto a directory fails before the network
  // ================================================================
  {
    let calls = 0;
    const realFetch = global.fetch;
    global.fetch = async () => { calls++; return new Response('data', { status: 200, headers: { 'content-type': 'application/octet-stream' } }); };
    try {
      const vfs = bareVfs(false);
      const r1 = await exec('bash', 'curl -o /mnt/download https://example.test/x', vfs);
      check('CD1 curl -o /mnt/download (a directory) fails BEFORE fetch', !r1.success
        && r1.output.includes('is a directory') && calls === 0, r1.output + ' | calls=' + calls);

      const r2 = await exec('bash', 'curl -o /tmp https://example.test/x', vfs);
      check('CD2 curl -o /tmp (a directory) fails BEFORE fetch', !r2.success
        && r2.output.includes('is a directory') && calls === 0, r2.output + ' | calls=' + calls);

      // the good path is unaffected: a file target still downloads
      const r3 = await exec('bash', 'curl -o /mnt/download/f.bin https://example.test/x', vfs);
      check('CD3 curl -o file target still downloads', r3.success && calls === 1
        && new TextDecoder().decode(await vfs.readBytes('/mnt/download/f.bin')) === 'data',
        r3.output + ' | calls=' + calls);
    } finally {
      global.fetch = realFetch;
    }
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

async function isDir2(vfs, p) {
  return (await vfs.stat(p)).kind === 'directory';
}

run().catch((e) => { console.error('TEST RUNNER FAIL', e); process.exit(1); });
