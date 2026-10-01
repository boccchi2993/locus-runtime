// Workspace regression tests (node): stat options, exists() semantics,
// append preservation, snapshot skipped-path manifest.
// Uses a WebIDL-conforming FileSystemDirectoryHandle stub (options arg must
// be an object or omitted, like the real browser API) — this is the mock
// that caught F01; native-handle behavior is additionally covered by the
// OPFS-backed e2e tests in tests/e2e.html.
// Run: node tests/workspace.test.cjs

global.window = { location: { protocol: 'https:' } };

const M = require('./helpers/core.cjs');

// --- WebIDL-conforming handle stub backed by a JS object tree ---
function assertOptions(opts) {
  if (opts !== undefined && opts !== null && typeof opts !== 'object') {
    throw new TypeError('options must be an object'); // what real browsers throw for a boolean
  }
}
function makeDirHandle(name, tree) {
  // tree: { files: {name: string|Uint8Array}, dirs: {name: tree}, failPerm: Set<name> }
  const handle = {
    name,
    kind: 'directory',
    async getFileHandle(n, opts) {
      assertOptions(opts);
      if (tree.failPerm && tree.failPerm.has(n)) {
        const e = new Error('Permission denied'); e.name = 'NotAllowedError'; throw e;
      }
      if (tree.files && n in tree.files) {
        return {
          kind: 'file',
          async getFile() {
            const data = tree.files[n];
            const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
            return { size: bytes.byteLength, lastModified: 123, arrayBuffer: async () => bytes.buffer.slice(0) };
          },
          async createWritable() {
            return {
              async write(chunk) {
                tree.files[n] = typeof chunk === 'string' ? chunk : new Uint8Array(chunk);
              },
              async close() {},
            };
          },
        };
      }
      if (opts && opts.create) {
        tree.files[n] = '';
        return handle.getFileHandle(n);
      }
      const e = new Error('not found'); e.name = 'NotFoundError'; throw e;
    },
    async getDirectoryHandle(n, opts) {
      assertOptions(opts);
      if (tree.dirs && n in tree.dirs) return makeDirHandle(n, tree.dirs[n]);
      // Real browsers throw TypeMismatchError when a FILE occupies the name.
      if (tree.files && n in tree.files) {
        const e = new Error('type mismatch'); e.name = 'TypeMismatchError'; throw e;
      }
      if (opts && opts.create) {
        tree.dirs[n] = { files: {}, dirs: {} };
        return makeDirHandle(n, tree.dirs[n]);
      }
      const e = new Error('not found'); e.name = 'NotFoundError'; throw e;
    },
    async removeEntry(n) {
      if (tree.files && n in tree.files) { delete tree.files[n]; return; }
      const e = new Error('not found'); e.name = 'NotFoundError'; throw e;
    },
    async *entries() {
      for (const n of Object.keys(tree.dirs || {})) yield [n, { name: n, kind: 'directory' }];
      for (const n of Object.keys(tree.files || {})) yield [n, { name: n, kind: 'file' }];
    },
  };
  return handle;
}

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + detail : '')); }
}

async function run() {
  const tree = {
    files: { 'a.txt': 'hello\n', 'data.csv': 'x,1\n' },
    dirs: { sub: { files: { 'b.txt': 'nested' }, dirs: {} } },
  };
  const ws = new M.LocalDirectoryWorkspace(makeDirHandle('root', tree));

  // ---------- W1. stat works against WebIDL-conforming handles (F01) ----------
  const st = await ws.stat('a.txt');
  check('W1 stat file', st.kind === 'file' && st.size === 6, JSON.stringify(st));
  const stDir = await ws.stat('sub');
  check('W2 stat directory', stDir.kind === 'directory', JSON.stringify(stDir));
  const stNested = await ws.stat('sub/b.txt');
  check('W3 stat nested file', stNested.kind === 'file' && stNested.size === 6, JSON.stringify(stNested));

  // ---------- W2. exists(): only NotFoundError → false ----------
  check('W4 exists true', (await ws.exists('a.txt')) === true);
  check('W5 exists missing → false', (await ws.exists('missing.txt')) === false);
  check('W6 exists missing nested → false', (await ws.exists('sub/nope.txt')) === false);
  tree.failPerm = new Set(['secret.txt']);
  tree.files['secret.txt'] = 's3cret';
  let permErr = null;
  try { await ws.exists('secret.txt'); } catch (e) { permErr = e; }
  check('W7 exists permission error propagates (NOT false)', permErr && permErr.name === 'NotAllowedError',
    permErr && permErr.name);
  delete tree.failPerm;

  // ---------- W3. cat through stat ----------
  const cat = await M.runShellCommand('cat a.txt', ws);
  check('W8 cat reads file', !cat.isError && cat.output.replace(/\n$/, '') === 'hello', JSON.stringify(cat.output));

  // ---------- W4. echo >> preserves existing content ----------
  await M.runShellCommand('echo first > log.txt', ws);
  await M.runShellCommand('echo second >> log.txt', ws);
  await M.runShellCommand('echo third >> log.txt', ws);
  // Appends write raw BYTES (binary-safe); the fake handle may therefore
  // hold a string (truncate write) or an ArrayBuffer (append write).
  const w9v = tree.files['log.txt'];
  const w9text = typeof w9v === 'string' ? w9v : new TextDecoder().decode(w9v);
  check('W9 append preserves old content', w9text === 'first\nsecond\nthird\n',
    JSON.stringify(w9text));

  // ---------- W5. python snapshot collects real files, skips with paths ----------
  const collected = await M.collectWorkspaceFiles(ws);
  const paths = collected.files.map((f) => f.path).sort();
  check('W10 snapshot includes real files', paths.includes('a.txt') && paths.includes('sub/b.txt'),
    paths.join(','));
  check('W11 snapshot byte content', collected.files.find((f) => f.path === 'a.txt')
    && atob(collected.files.find((f) => f.path === 'a.txt').b64) === 'hello\n');
  check('W12 no skips under limits', collected.skipped.length === 0, JSON.stringify(collected.skipped));

  // oversized file → skipped WITH its path (not just a count)
  const bigTree = { files: { 'big.bin': new Uint8Array(6 * 1024 * 1024), 'small.txt': 'ok' }, dirs: {} };
  const bigWs = new M.LocalDirectoryWorkspace(makeDirHandle('big', bigTree));
  const collected2 = await M.collectWorkspaceFiles(bigWs);
  check('W13 oversized file skipped', collected2.files.length === 1 && collected2.files[0].path === 'small.txt');
  check('W14 skip recorded with path and reason',
    collected2.skipped.length === 1 && collected2.skipped[0].path === 'big.bin'
    && collected2.skipped[0].reason.includes('per-file limit'), JSON.stringify(collected2.skipped));

  // ---------- W6. write/remove round-trip ----------
  await ws.write('new.txt', 'data');
  check('W15 write creates file', tree.files['new.txt'] === 'data');
  await ws.remove('new.txt');
  check('W16 remove deletes file', !('new.txt' in tree.files));

  // ---------- W7. mkdir primitive ----------
  const mkTree = { files: { 'f.txt': 'x' }, dirs: {} };
  const mkWs = new M.LocalDirectoryWorkspace(makeDirHandle('mk', mkTree));
  await mkWs.mkdir('a');
  check('W17 mkdir creates a directory', 'a' in mkTree.dirs);
  await mkWs.mkdir('a/b');
  check('W18 mkdir creates nested directories', 'b' in mkTree.dirs.a.dirs);
  await mkWs.mkdir('c/d/e');
  check('W19 mkdir creates missing parents', !!(mkTree.dirs.c && mkTree.dirs.c.dirs.d && mkTree.dirs.c.dirs.d.dirs.e));
  await mkWs.mkdir('a'); // existing directory → deterministic no-op
  check('W20 mkdir existing directory is a no-op success', 'a' in mkTree.dirs);
  let fileClash = null;
  try { await mkWs.mkdir('f.txt'); } catch (e) { fileClash = e; }
  check('W21 mkdir over an existing file fails', !!fileClash, 'no error');
  let escapeErr = null;
  try { await mkWs.mkdir('../escape'); } catch (e) { escapeErr = e; }
  check('W22 mkdir escape rejected by confinement', escapeErr && escapeErr.message.includes('escapes workspace'),
    escapeErr && escapeErr.message);
  await mkWs.mkdir('/'); // workspace root: already exists → no-op
  check('W23 mkdir workspace root is a no-op', true);

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.error('TEST RUNNER FAIL', e); process.exit(1); });
