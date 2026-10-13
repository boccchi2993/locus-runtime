// Shell compatibility round 4 tests (node): mkdir / cp / touch.
// cp is verified against mv's conventions where they are shared (bounds,
// preflight-before-any-write, verify-as-you-go) and against its OWN key
// difference: sources on read-only mounts are copyable because cp never
// removes anything.
// Run: node tests/shell-compat4.test.cjs

global.window = { location: { protocol: 'https:' } };
global.document = { getElementById: () => null };

const M = require('./helpers/core.cjs');

// M2a: bash routes through the PUBLIC runtime entry. Worker sources are
// never booted by this suite.
const { createRuntime } = require('../src/index.js');
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

function bareVfs(adapter) {
  const vfs = new M.VirtualWorkspace({ listCommands: () => Object.keys(M.SHELL_COMMANDS) });
  if (adapter) vfs.mount('/mnt/workspace', adapter, 'external-read-write');
  return vfs;
}

// --- hierarchical in-memory workspace (same model as shell-compat2.test.cjs) ---
class TreeWS extends M.WorkspaceAdapter {
  constructor(files) {
    super();
    this.name = 'tree';
    this.files = {};
    this.dirs = new Set(); // explicit (possibly empty) directories
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
      if (!d.startsWith(prefix)) continue;
      const rest = d.slice(prefix.length);
      if (rest.includes('/')) continue; // not a direct child
      seen.set(rest, { name: rest, kind: 'directory' });
    }
    const entries = [...seen.values()];
    entries.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'directory' ? -1 : 1));
    return entries;
  }
  async read(p) { return new TextDecoder().decode(await this.readBytes(p)); }
  async readBytes(p) {
    p = M.normalizeWorkspacePath(p);
    if (!(p in this.files)) { const e = new Error('No such file: ' + p); e.name = 'NotFoundError'; throw e; }
    return this.files[p];
  }
  async write(p, data) {
    p = M.normalizeWorkspacePath(p);
    this.files[p] = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
  }
  async remove(p) {
    p = M.normalizeWorkspacePath(p);
    this.dirs.delete(p);
    delete this.files[p];
  }
  async mkdir(p) {
    p = M.normalizeWorkspacePath(p);
    if (!p) return;
    if (p in this.files) { const e = new Error('type mismatch'); e.name = 'TypeMismatchError'; throw e; }
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

const dec = (b) => new TextDecoder().decode(b || new Uint8Array());
const sameBytes = (a, b) => !!a && !!b && a.byteLength === b.byteLength && a.every((v, i) => v === b[i]);

function fixture() {
  return new TreeWS({
    'a.txt': 'foo\nbar\nfoo again\n',
    'b.txt': 'second\n',
    'sub/c.txt': 'in sub\n',
    'sub/deep/d.txt': 'deep\n',
    'dir with space/note.txt': 'space ok\n',
  });
}

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + detail : '')); }
}

async function run() {
  __session = (await __hostPromise).createSession();

  // ---------- MK. mkdir ----------
  {
    const ws = fixture();
    const mk1 = await exec('bash', 'mkdir out', ws);
    check('MK1 mkdir creates a directory', mk1.success && (await ws.stat('out')).kind === 'directory', mk1.output);
    const mk2 = await exec('bash', 'mkdir out', ws);
    check('MK2 mkdir twice without -p fails (File exists)', !mk2.success && mk2.output.includes('File exists'), mk2.output);
    const mk3 = await exec('bash', 'mkdir -p out', ws);
    check('MK3 mkdir -p on an existing directory succeeds', mk3.success && (await ws.stat('out')).kind === 'directory', mk3.output);

    const mk4 = await exec('bash', 'mkdir a/b/c', fixture());
    check('MK4 missing parents without -p fails', !mk4.success && mk4.output.includes('no such directory')
      && !(await (async () => { const w = fixture(); return w._dirs().has('a'); })()), mk4.output);

    const ws5 = fixture();
    const mk5 = await exec('bash', 'mkdir -p a/b/c', ws5);
    check('MK5 mkdir -p creates every level', mk5.success
      && (await ws5.stat('a')).kind === 'directory'
      && (await ws5.stat('a/b')).kind === 'directory'
      && (await ws5.stat('a/b/c')).kind === 'directory', mk5.output);

    const ws6 = fixture();
    await exec('bash', 'echo x > f6.txt', ws6);
    const mk6 = await exec('bash', 'mkdir f6.txt', ws6);
    const mk6b = await exec('bash', 'mkdir -p f6.txt', ws6);
    check('MK6 existing file fails with and without -p', !mk6.success && !mk6b.success
      && mk6.output.includes('File exists') && mk6b.output.includes('File exists')
      && dec(ws6.files['f6.txt']) === 'x\n', mk6.output + ' | ' + mk6b.output);

    const mk7 = await exec('bash', 'mkdir /mnt/upload/mk7', fixture());
    check('MK7 mkdir on a read-only mount fails', !mk7.success && mk7.output.includes('read-only filesystem'), mk7.output);

    const ws8 = fixture();
    await exec('bash', 'mkdir out8', ws8);
    const ls8 = await exec('bash', 'ls', ws8);
    check('MK8 empty directory is listed by ls', ls8.success && ls8.output.split('\n').includes('out8/'), ls8.output);
  }

  // ---------- TC. touch ----------
  {
    const ws = fixture();
    const tc1 = await exec('bash', 'touch new1.txt', ws);
    check('TC1 touch creates an empty file', tc1.success && ('new1.txt' in ws.files)
      && ws.files['new1.txt'].byteLength === 0, tc1.output + ' | ' + JSON.stringify(ws.files['new1.txt'] && ws.files['new1.txt'].byteLength));

    const ws2 = fixture();
    const tc2 = await exec('bash', 'touch a.txt', ws2);
    check('TC2 touch of an existing file leaves content unchanged', tc2.success
      && dec(ws2.files['a.txt']) === 'foo\nbar\nfoo again\n', tc2.output);

    const ws3 = fixture();
    await exec('bash', 'mkdir d3', ws3);
    const tc3 = await exec('bash', 'touch d3', ws3);
    check('TC3 touch of an existing directory succeeds and changes nothing', tc3.success
      && (await ws3.stat('d3')).kind === 'directory', tc3.output);

    const tc4 = await exec('bash', 'touch nodir/x.txt', fixture());
    check('TC4 missing parent fails', !tc4.success && tc4.output.includes('no such directory'), tc4.output);

    const tc5 = await exec('bash', 'touch /mnt/upload/tc5.txt', fixture());
    check('TC5 touch on a read-only mount fails', !tc5.success && tc5.output.includes('read-only filesystem'), tc5.output);
  }

  // ---------- CP. copy ----------
  {
    const ws = fixture();
    const cp1 = await exec('bash', 'cp a.txt copy1.txt', ws);
    check('CP1 file → new name, byte-identical, source kept', cp1.success
      && dec(ws.files['copy1.txt']) === 'foo\nbar\nfoo again\n'
      && dec(ws.files['a.txt']) === 'foo\nbar\nfoo again\n', cp1.output);

    const ws2 = fixture();
    const cp2 = await exec('bash', 'cp a.txt sub', ws2);
    check('CP2 file → existing directory takes the basename', cp2.success
      && dec(ws2.files['sub/a.txt']) === 'foo\nbar\nfoo again\n'
      && ('a.txt' in ws2.files), cp2.output);

    const ws3 = fixture();
    const cp3 = await exec('bash', 'cp a.txt b.txt', ws3);
    check('CP3 existing destination fails loudly, both unchanged', !cp3.success
      && cp3.output.includes('destination exists')
      && dec(ws3.files['a.txt']) === 'foo\nbar\nfoo again\n' && dec(ws3.files['b.txt']) === 'second\n', cp3.output);

    const cp4 = await exec('bash', 'cp -f a.txt b.txt', fixture());
    check('CP4 -f is rejected', !cp4.success && cp4.output.includes('-f is not supported'), cp4.output);

    const cp5 = await exec('bash', 'cp sub dst5', fixture());
    check('CP5 directory without -r fails', !cp5.success && cp5.output.includes('is a directory (use -r)'), cp5.output);

    const ws6 = fixture();
    await ws6.mkdir('sub/empty6');
    const cp6 = await exec('bash', 'cp -r sub subcopy', ws6);
    check('CP6 cp -r copies the whole tree, source intact', cp6.success
      && dec(ws6.files['subcopy/c.txt']) === 'in sub\n'
      && dec(ws6.files['subcopy/deep/d.txt']) === 'deep\n'
      && (await ws6.stat('subcopy/empty6')).kind === 'directory'
      && dec(ws6.files['sub/c.txt']) === 'in sub\n'
      && (await ws6.stat('sub/empty6')).kind === 'directory', cp6.output);

    const ws7 = fixture();
    const cp7 = await exec('bash', 'cp a.txt b.txt sub', ws7);
    check('CP7 multiple sources into a directory', cp7.success
      && dec(ws7.files['sub/a.txt']) === 'foo\nbar\nfoo again\n'
      && dec(ws7.files['sub/b.txt']) === 'second\n', cp7.output);

    const cp8 = await exec('bash', 'cp a.txt b.txt missing8', fixture());
    check('CP8 multiple sources without a directory target fails', !cp8.success
      && cp8.output.includes('not a directory (required with multiple sources)'), cp8.output);

    // THE cp-vs-mv difference: a source on a read-only mount is copyable.
    const upVfs = bareVfs();
    const uploadBytes = new TextEncoder().encode('uploaded\ncontent\n');
    upVfs.resolveMount('/mnt/upload').provider.addFile(new File([uploadBytes], 'up.txt'));
    const cp9 = await exec('bash', 'cp /mnt/upload/up.txt /home/locus/cp9.txt', upVfs);
    const cp9got = await upVfs.readBytes('/home/locus/cp9.txt');
    check('CP9 read-only mount → writable home succeeds, byte-identical', cp9.success
      && sameBytes(cp9got, uploadBytes), cp9.output);

    const ws10 = fixture();
    const upVfs10 = bareVfs(ws10);
    const uploadProvider10 = upVfs10.resolveMount('/mnt/upload').provider;
    const uploadCountBefore = uploadProvider10.files.size;
    const cp10 = await exec('bash', 'cp a.txt /mnt/upload/cp10.txt', upVfs10);
    check('CP10 copy INTO a read-only mount fails before writing', !cp10.success
      && cp10.output.includes('read-only filesystem')
      && uploadProvider10.files.size === uploadCountBefore, cp10.output);

    const ws11 = fixture();
    const cp11 = await exec('bash', 'cp -r sub sub/inner', ws11);
    check('CP11 directory into itself is refused', !cp11.success
      && cp11.output.includes('cannot copy a directory into itself')
      && dec(ws11.files['sub/c.txt']) === 'in sub\n', cp11.output);

    const bigFiles = {};
    for (let i = 0; i < 1001; i++) bigFiles['big/f' + i + '.txt'] = 'x';
    const wsBig = new TreeWS(bigFiles);
    const cp12 = await exec('bash', 'cp -r big dst', wsBig);
    check('CP12 entry limit fails during pre-scan, nothing created', !cp12.success
      && cp12.output.includes('copy limit') && !(await wsBig.exists('dst'))
      && ('big/f0.txt' in wsBig.files) && ('big/f1000.txt' in wsBig.files), cp12.output);

    const ws13 = fixture();
    const ac13 = new AbortController();
    ac13.abort();
    // A pre-cancelled signal is rejected at the session's admission gate
    // (rejected promise), long before cp's own cancellation gates.
    const cp13 = await exec('bash', 'cp a.txt cp13.txt', ws13, { signal: ac13.signal })
      .then(() => null, (e) => e);
    check('CP13 pre-cancelled signal writes nothing', !!cp13 && cp13.cancelled === true
      && !('cp13.txt' in ws13.files), String(cp13) + ' | ' + JSON.stringify(Object.keys(ws13.files)));

    const binBytes = new Uint8Array([0x00, 0xFF, 0x7F, 0x80, 0x00, 0xFE, 0x10]);
    const ws14 = fixture();
    ws14.files['bin14.bin'] = binBytes;
    const cp14 = await exec('bash', 'cp bin14.bin bin14copy.bin', ws14);
    check('CP14 binary copy is byte-identical', cp14.success && sameBytes(ws14.files['bin14copy.bin'], binBytes)
      && sameBytes(ws14.files['bin14.bin'], binBytes), cp14.output);

    // CP15: two sources whose basenames collide on the destination directory.
    // The second source must be refused in preflight — nothing is written.
    const ws15 = new TreeWS({ 'x/f.txt': 'FIRST\n', 'y/f.txt': 'SECOND\n' });
    await ws15.mkdir('out');
    const cp15 = await exec('bash', 'cp x/f.txt y/f.txt out', ws15);
    check('CP15 colliding sources refused in preflight, nothing written', !cp15.success
      && cp15.output.includes('would overwrite')
      && !(await ws15.exists('out/f.txt'))
      && dec(ws15.files['x/f.txt']) === 'FIRST\n'
      && dec(ws15.files['y/f.txt']) === 'SECOND\n', cp15.output + ' | out/f.txt='
      + JSON.stringify(ws15.files['out/f.txt'] ? dec(ws15.files['out/f.txt']) : 'absent'));
  }

  // ---------- MV-DUP. mv two sources onto one destination (data-loss fix) ----------
  {
    // The same collision cp refuses: before the fix, mv committed the first
    // source (deleting it), then overwrote the destination with the second
    // source — the first file's content was permanently lost.
    const ws = new TreeWS({ 'x/f.txt': 'FIRST\n', 'y/f.txt': 'SECOND\n' });
    await ws.mkdir('out');
    const mvDup = await exec('bash', 'mv x/f.txt y/f.txt out', ws);
    check('MV-DUP1 colliding sources refused before any commit', !mvDup.success
      && mvDup.output.includes('would overwrite')
      && !(await ws.exists('out/f.txt'))
      && dec(ws.files['x/f.txt']) === 'FIRST\n'
      && dec(ws.files['y/f.txt']) === 'SECOND\n', mvDup.output + ' | x/f.txt='
      + JSON.stringify(ws.files['x/f.txt'] ? dec(ws.files['x/f.txt']) : 'ABSENT')
      + ' y/f.txt=' + JSON.stringify(ws.files['y/f.txt'] ? dec(ws.files['y/f.txt']) : 'ABSENT')
      + ' out/f.txt=' + JSON.stringify(ws.files['out/f.txt'] ? dec(ws.files['out/f.txt']) : 'absent'));
  }

  // ---------- CMB. combinations and registry surfacing ----------
  {
    const ws = fixture();
    const cmb1 = await exec('bash', 'mkdir -p out && cp a.txt out/ && ls out', ws);
    check('CMB1 mkdir -p && cp && ls pipeline', cmb1.success
      && cmb1.output.split('\n').includes('a.txt')
      && dec(ws.files['out/a.txt']) === 'foo\nbar\nfoo again\n', cmb1.output + ' | ' + JSON.stringify(Object.keys(ws.files)));

    const h = await exec('bash', 'help', fixture());
    check('CMB2 help lists mkdir, cp and touch', h.success && h.output.includes('mkdir [-p] <dir>...')
      && h.output.includes('cp [-r|-R] <src>... <dest>') && h.output.includes('touch <file>...'), h.output.slice(0, 400));
    const w = await exec('bash', 'which cp mkdir touch', fixture());
    check('CMB2b which resolves the new commands under /usr/bin', w.success
      && w.output === '/usr/bin/cp\n/usr/bin/mkdir\n/usr/bin/touch', w.output);
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.error('TEST RUNNER FAIL', e); process.exit(1); });
