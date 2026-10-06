// Shell compatibility round 3 tests (node): evidence-driven common commands
// from real dogfood — head/tail -N shorthand, head/tail -c byte mode,
// separated input/output caps, grep -c, the /dev/null redirection sink,
// sort (-n/-r/-u) and which (registry lookup).
// Run: node tests/shell-compat3.test.cjs

global.window = { location: { protocol: 'https:' } };
global.document = { getElementById: () => null };

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

function bareVfs(adapter) {
  const vfs = new M.VirtualWorkspace({ listCommands: () => Object.keys(M.SHELL_COMMANDS) });
  if (adapter) vfs.mount('/mnt/workspace', adapter, 'external-read-write');
  return vfs;
}

// --- hierarchical in-memory workspace (same model as shell-compat.test.cjs) ---
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

function fixture(files) {
  // Overrides merge over the defaults (fixture({ 'big.txt': ... }) keeps the
  // base files, mirroring a real workspace with everything in it).
  return new TreeWS(Object.assign({
    'lines.txt': 'L1\nL2\nL3\nL4\nL5\nL6\nL7\n',
    'names.txt': 'banana\n10\n2\n1\napple\nbanana\n',
    'a.txt': 'foo\nbar\nfoo again\n',
    'b.txt': 'foo\nnothing here\n',
    'sub/c.txt': 'foo in sub\n',
    'zh.txt': '你好', // exactly 6 UTF-8 bytes
  }, files));
}

// ~2.5 MiB deterministic text: N rows of fixed width; first/last rows marked.
function bigText(rows) {
  const parts = [];
  for (let i = 0; i < rows; i++) {
    if (i === 0) parts.push('FIRST-row-marker\n');
    else if (i === rows - 1) parts.push('LAST-row-marker\n');
    else parts.push('row-' + i + '-' + 'y'.repeat(44) + '\n');
  }
  return parts.join('');
}

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + detail : '')); }
}

async function run() {
  __session = (await __hostPromise).createSession();
  // ---------- HT. head / tail shorthand, byte mode, caps ----------
  {
    const ws = fixture();
    const h1 = await exec('bash', 'head -3 lines.txt', ws);
    check('HT1 head -N shorthand', h1.success && h1.output === 'L1\nL2\nL3', h1.output);
    const t1 = await exec('bash', 'tail -2 lines.txt', ws);
    check('HT2 tail -N shorthand', t1.success && t1.output === 'L6\nL7', t1.output);

    const h2 = await exec('bash', 'head -n3 lines.txt', ws);
    check('HT3 head -nN compact regression', h2.success && h2.output === 'L1\nL2\nL3', h2.output);
    const t2 = await exec('bash', 'tail -n+5 lines.txt', ws);
    check('HT4 tail -n+N compact regression', t2.success && t2.output === 'L5\nL6\nL7', t2.output);

    const h3 = await exec('bash', 'head -c 11 lines.txt', ws);
    check('HT5 head -c N', h3.success && h3.output === 'L1\nL2\nL3\nL4', JSON.stringify(h3.output));
    const t3 = await exec('bash', 'tail -c 6 lines.txt', ws);
    check('HT6 tail -c N', t3.success && t3.output === 'L6\nL7\n', JSON.stringify(t3.output));

    const h4 = await exec('bash', 'head -c11 lines.txt', ws);
    check('HT7 head -cN compact', h4.success && h4.output === 'L1\nL2\nL3\nL4', h4.output);
    const t4 = await exec('bash', 'tail -c6 lines.txt', ws);
    check('HT8 tail -cN compact', t4.success && t4.output === 'L6\nL7\n', JSON.stringify(t4.output));

    const p1 = await exec('bash', 'echo hello world | head -c 5', ws);
    check('HT9 pipeline stdin byte mode (head)', p1.success && p1.output === 'hello', p1.output);
    const p2 = await exec('bash', 'echo hello world | tail -c 5', ws);
    check('HT9b pipeline stdin byte mode (tail)', p2.success && p2.output === 'world', p2.output);

    const h5 = await exec('bash', 'head "-3"', ws);
    check('HT10 quoted "-N" stays an operand (file not found)', !h5.success
      && h5.output.includes('-3: no such file or directory'), h5.output);

    const c1 = await exec('bash', 'head -n 3 -c 10 lines.txt', ws);
    check('HT11a -n + -c conflict', !c1.success && c1.output.includes('cannot combine line and byte count'), c1.output);
    const c2 = await exec('bash', 'tail -c 10 -n 3 lines.txt', ws);
    check('HT11b -c + -n conflict (either order)', !c2.success && c2.output.includes('cannot combine line and byte count'), c2.output);
    const c3 = await exec('bash', 'tail -n +3 -c 10 lines.txt', ws);
    check('HT11c -n +N + -c conflict', !c3.success && c3.output.includes('cannot combine line and byte count'), c3.output);

    const z1 = await exec('bash', 'head -0 lines.txt', ws);
    const z2 = await exec('bash', 'tail -0 lines.txt', ws);
    const z3 = await exec('bash', 'head -c 0 lines.txt', ws);
    check('HT12 count 0 is legal and empty', z1.success && z1.output === '' && z2.success && z2.output === ''
      && z3.success && z3.output === '', z1.output + '/' + z2.output + '/' + z3.output);

    const i1 = await exec('bash', 'head -n abc lines.txt', ws);
    check('HT13a non-integer count fails', !i1.success && i1.output.includes('invalid line count'), i1.output);
    const i2 = await exec('bash', 'head -c -5 lines.txt', ws);
    check('HT13b negative byte count fails', !i2.success && i2.output.includes('invalid byte count'), i2.output);
    const i3 = await exec('bash', 'head -999999999999999999999 lines.txt', ws);
    check('HT13c overflow count fails bounded', !i3.success && i3.output.includes('too large')
      && i3.output.length < 200, i3.output);
    const i4 = await exec('bash', 'tail -n 999999999999999999999 lines.txt', ws);
    check('HT13d tail overflow count fails bounded', !i4.success && i4.output.includes('too large'), i4.output);

    const big = bigText(46000); // ~2.5 MiB
    check('HT-fix big fixture is ~2.5 MiB', big.length > 2.4 * 1024 * 1024 && big.length < 2.6 * 1024 * 1024,
      String(big.length));
    const wsBig = fixture({ 'big.txt': big });
    const b1 = await exec('bash', 'head -n 3 big.txt', wsBig);
    check('HT14 2.5MiB head -n3 succeeds', b1.success && b1.output.startsWith('FIRST-row-marker')
      && b1.output.split('\n').length === 3, b1.output.slice(0, 60));
    const b2 = await exec('bash', 'tail -n 3 big.txt', wsBig);
    check('HT15 2.5MiB tail -n3 succeeds', b2.success && b2.output.includes('LAST-row-marker')
      && b2.output.split('\n').length === 3, b2.output.slice(0, 60));
    const b3 = await exec('bash', 'head -c 2000 big.txt', wsBig);
    check('HT15b 2.5MiB head -c2000 succeeds', b3.success && b3.output.startsWith('FIRST-row-marker')
      && b3.output.length <= 2000, String(b3.output.length));
    const b4 = await exec('bash', 'tail -c 2000 big.txt', wsBig);
    check('HT15c 2.5MiB tail -c2000 succeeds', b4.success && b4.output.endsWith('LAST-row-marker\n'),
      JSON.stringify(b4.output.slice(-40)));

    const giant = 'G'.repeat(2 * 1024 * 1024) + '\nsecond\n';
    const wsGiant = fixture({ 'giant.txt': giant });
    const g1 = await exec('bash', 'head -n 1 giant.txt', wsGiant);
    check('HT16 giant first line → output-cap failure, not silent truncation', !g1.success
      && g1.output.includes('output exceeds') && g1.output.includes('terminal limit'), g1.output.slice(0, 120));
    const g2 = await exec('bash', 'head -c 2000 giant.txt', wsGiant);
    check('HT16b giant line head -c2000 succeeds', g2.success && g2.output === 'G'.repeat(2000), String(g2.output.length));
    const g3 = await exec('bash', 'tail -c 2000 giant.txt', wsGiant);
    check('HT16c giant line tail -c2000 succeeds', g3.success && g3.output.length === 2000
      && g3.output.endsWith('\nsecond\n') && g3.output.startsWith('G'), String(g3.output.length));

    const huge = 'H'.repeat(17 * 1024 * 1024) + '\n';
    const wsHuge = fixture({ 'huge.txt': huge });
    const hu1 = await exec('bash', 'head -n 1 huge.txt', wsHuge);
    check('HT17 input over 16MiB head/tail cap fails bounded', !hu1.success
      && hu1.output.includes('input limit') && hu1.output.includes('use python')
      && hu1.output.length < 300, hu1.output.slice(0, 160));
    const hu2 = await exec('bash', 'tail -c 10 huge.txt', wsHuge);
    check('HT17b input cap applies in byte mode too', !hu2.success && hu2.output.includes('input limit'), hu2.output.slice(0, 160));

    const u1 = await exec('bash', 'head -c 3 zh.txt', ws);
    check('HT18a head -c 3 of 你好 → 你 (real UTF-8 bytes)', u1.success && u1.output === '你', JSON.stringify(u1.output));
    const u2 = await exec('bash', 'tail -c 3 zh.txt', ws);
    check('HT18b tail -c 3 of 你好 → 好', u2.success && u2.output === '好', JSON.stringify(u2.output));
    const u3 = await exec('bash', 'head -c 4 zh.txt', ws);
    check('HT18c cut mid-character → replacement, never UTF-16 slicing', u3.success
      && u3.output === '你\uFFFD', JSON.stringify(u3.output));
    const u4 = await exec('bash', 'echo a👍b | head -c 5', ws);
    check('HT18d emoji byte mode', u4.success && u4.output === 'a👍', JSON.stringify(u4.output));
  }

  // ---------- GC. grep -c ----------
  {
    const ws = fixture();
    const g1 = await exec('bash', 'grep -c foo a.txt', ws);
    check('GC1 single file count (no path prefix)', g1.success && g1.output === '2', g1.output);
    const g2 = await exec('bash', 'cat a.txt b.txt | grep -c foo', ws);
    check('GC2 stdin count', g2.success && g2.output === '3', g2.output);
    const g3 = await exec('bash', 'grep -c FOO a.txt', ws);
    const g3i = await exec('bash', 'grep -ci foo a.txt', ws);
    check('GC3 -ci counts case-insensitively', g3.success && g3.output === '0'
      && g3i.success && g3i.output === '2', g3.output + ' vs ' + g3i.output);
    const g3n = await exec('bash', 'grep -cn foo a.txt', ws);
    check('GC3b -c suppresses -n line numbers, count unchanged', g3n.success && g3n.output === '2', g3n.output);

    const g4 = await exec('bash', 'grep -c foo a.txt b.txt', ws);
    check('GC4 multi-file counts are prefixed', g4.success && g4.output === 'a.txt:2\nb.txt:1', g4.output);
    const g4z = await exec('bash', 'grep -c zzz a.txt b.txt', ws);
    check('GC4b zero matches still print 0 per file', g4z.success && g4z.output === 'a.txt:0\nb.txt:0', g4z.output);

    const g5 = await exec('bash', 'grep -rc foo .', ws);
    check('GC5 recursive counts per file', g5.success
      && g5.output.includes('a.txt:2') && g5.output.includes('b.txt:1') && g5.output.includes('sub/c.txt:1'),
      g5.output);
    const g5s = await exec('bash', 'grep -Rc foo sub', ws);
    check('GC5b -R recursive count', g5s.success && g5s.output.trim() === 'sub/c.txt:1', g5s.output);

    const many = [];
    for (let i = 0; i < 1000; i++) many.push('foo line ' + i);
    const wsMany = fixture({ 'many.txt': many.join('\n') + '\n' });
    const g6 = await exec('bash', 'grep -c foo many.txt', wsMany);
    check('GC6 1000 matches → true count, not GREP_MAX_MATCHES', g6.success && g6.output === '1000', g6.output);
    const g6p = await exec('bash', 'grep foo many.txt | wc -l', wsMany);
    check('GC6b presentation mode still capped at 500', g6p.success && g6p.output === '501', g6p.output);

    const g7 = await exec('bash', 'grep -n foo a.txt', ws);
    check('GC7 normal grep unchanged', g7.success && g7.output === '1:foo\n3:foo again', g7.output);

    const binBytes = new Uint8Array([0x00, 0xff, 0xfe, 0x01]);
    const wsSkip = fixture({ 'skipdir/big.bin': binBytes, 'skipdir/f.txt': 'foo\n' });
    const g8 = await exec('bash', 'grep -rc foo skipdir', wsSkip);
    check('GC8 skipped binary still reported in count mode', g8.success && g8.output.includes('f.txt:1')
      && g8.output.includes('skipped 1 file(s)'), g8.output);
  }

  // ---------- DN. /dev/null redirection sink ----------
  {
    const ws = fixture();
    const d1 = await exec('bash', 'echo hi > /dev/null', ws);
    check('DN1 echo >/dev/null succeeds with no output', d1.success && d1.output === '', d1.output);
    const d1b = await exec('bash', 'echo hi >/dev/null', ws);
    check('DN1b glued >/dev/null', d1b.success && d1b.output === '', d1b.output);

    const d2 = await exec('bash', 'cat missing 2>/dev/null', ws);
    check('DN2 failure keeps stderr silent', !d2.success && d2.output === '', d2.output);

    const d3 = await exec('bash', 'cat missing 2>/dev/null || echo fallback', ws);
    check('DN3 null stderr still fails → || runs fallback', d3.success && d3.output === 'fallback', d3.output);

    const d4 = await exec('bash', 'cat missing >/dev/null 2>&1', ws);
    check('DN4 stdout-then-2>&1 discards BOTH streams', !d4.success && d4.output === '', d4.output);

    const d5 = await exec('bash', 'cat missing 2>&1 >/dev/null', ws);
    check('DN5 2>&1-then-stdout keeps stderr visible (order matters)', !d5.success
      && d5.output.includes('cat:') && d5.output.includes('missing'), d5.output);
    check('DN5b the two orders observably differ', d4.output !== d5.output, 'same output');

    const d6 = await exec('bash', 'echo hi >> /dev/null', ws);
    const d6b = await exec('bash', 'echo hi 2>> /dev/null', ws);
    check('DN6 append forms are the same sink', d6.success && d6.output === '' && d6b.success, d6.output + '/' + d6b.output);

    const d7a = await exec('bash', 'cat /dev/null', ws);
    const d7b = await exec('bash', 'ls /dev', ws);
    check('DN7 /dev/null is not a filesystem node', !d7a.success && d7a.output.includes('no such file')
      && !d7b.success, d7a.output + '/' + d7b.output);
    const d7c = await exec('bash', 'echo x > dev/null', ws);
    check('DN7b a path that merely ENDS in dev/null stays a real file', d7c.success
      && ('dev/null' in ws.files) && dec(ws.files['dev/null']) === 'x\n', d7c.output);

    const d8 = await exec('bash', 'cat missing 2>/dev/null; echo after', ws);
    check('DN8 sequence continues after silenced failure', d8.success && d8.output === 'after', d8.output);
  }

  // ---------- SO. sort ----------
  {
    const ws = fixture();
    const s1 = await exec('bash', 'cat names.txt | sort', ws);
    check('SO1 lexical stdin sort', s1.success && s1.output === '1\n10\n2\napple\nbanana\nbanana', s1.output);
    const s2 = await exec('bash', 'sort names.txt', ws);
    check('SO2 lexical file sort', s2.success && s2.output === '1\n10\n2\napple\nbanana\nbanana', s2.output);
    const s3 = await exec('bash', 'sort a.txt b.txt', ws);
    check('SO3 multiple files sort together', s3.success
      && s3.output === 'bar\nfoo\nfoo\nfoo again\nnothing here', s3.output);
    const s4 = await exec('bash', 'sort -n names.txt', ws);
    check('SO4 -n numeric: 1 2 10', s4.success && s4.output.startsWith('1\n2\n10'), s4.output);
    const s4b = await exec('bash', 'sort -n names.txt', ws);
    check('SO4b -n non-numeric fallback is deterministic (numeric first, then lexical)',
      s4b.success && s4b.output === '1\n2\n10\napple\nbanana\nbanana', s4b.output);
    const s5 = await exec('bash', 'sort -r names.txt', ws);
    check('SO5 -r reverses', s5.success && s5.output === 'banana\nbanana\napple\n2\n10\n1', s5.output);
    const s6 = await exec('bash', 'sort -u names.txt', ws);
    check('SO6 -u dedupes exact lines', s6.success && s6.output === '1\n10\n2\napple\nbanana', s6.output);
    const s7 = await exec('bash', 'sort -nr names.txt', ws);
    check('SO7 -nr combined', s7.success && s7.output === 'banana\nbanana\napple\n10\n2\n1', s7.output);
    const s8 = await exec('bash', 'sort -nru names.txt', ws);
    check('SO8 -nru combined', s8.success && s8.output === 'banana\napple\n10\n2\n1', s8.output);
    const s8b = await exec('bash', 'sort -ru -n names.txt', ws);
    check('SO8b split flags compose', s8b.success && s8b.output === s8.output, s8b.output);

    const s9 = await exec('bash', 'find . -type f | sort', ws);
    check('SO9 find | sort pipeline', s9.success
      && s9.output === ['./a.txt', './b.txt', './lines.txt', './names.txt', './sub/c.txt', './zh.txt'].join('\n'),
      s9.output);
    const s10 = await exec('bash', 'sort names.txt | head -2', ws);
    check('SO10 sort | head pipeline', s10.success && s10.output === '1\n10', s10.output);
    const s10b = await exec('bash', 'sort -u names.txt | wc -l', ws);
    check('SO10b sort -u | wc -l', s10b.success && s10b.output === '5', s10b.output);

    const s11 = await exec('bash', 'sort -x names.txt', ws);
    check('SO11 unsupported flag fails loudly', !s11.success && s11.output.includes('unsupported option: -x')
      && s11.output.includes('-n -r -u'), s11.output);

    const s12 = await exec('bash', 'sort sub', ws);
    check('SO12 directory operand fails', !s12.success && s12.output.includes('is a directory'), s12.output);

    const binBytes = new Uint8Array([0x00, 0xff, 0xfe, 0x00]);
    const wsBin = fixture({ 'bin.dat': binBytes });
    const s13 = await exec('bash', 'sort bin.dat', wsBin);
    check('SO13 non-UTF8 input fails explicitly (no silent replacement)', !s13.success
      && s13.output.includes('not UTF-8'), s13.output);

    const bigSort = [];
    for (let i = 0; i < 100000; i++) bigSort.push('line-' + i + '-' + 'x'.repeat(75)); // ~9 MiB
    const wsBig = fixture({ 'big.txt': bigSort.join('\n') + '\n' });
    const s14 = await exec('bash', 'sort big.txt', wsBig);
    check('SO14 input over the 8MiB sort cap fails bounded', !s14.success
      && s14.output.includes('sort limit') && s14.output.includes('use python')
      && s14.output.length < 200, s14.output.slice(0, 140));

    const ac = new AbortController();
    const wsCancel = fixture({ 'f1.txt': 'b\na\n', 'f2.txt': 'd\nc\n' });
    const origRead = wsCancel.readBytes.bind(wsCancel);
    let reads = 0;
    wsCancel.readBytes = async (p) => {
      const r = await origRead(p);
      if (++reads === 1) ac.abort();
      return r;
    };
    const s15 = await exec('bash', 'sort f1.txt f2.txt', wsCancel, { signal: ac.signal });
    check('SO15 cancellation between file reads', !s15.success && s15.output.includes('cancelled'), s15.output);
  }

  // ---------- WH. which ----------
  {
    const ws = fixture();
    const w1 = await exec('bash', 'which python', ws);
    check('W1 which python', w1.success && w1.output === '/usr/bin/python', w1.output);
    const w2 = await exec('bash', 'which python3', ws);
    check('W2 which python3 resolves the alias to python', w2.success && w2.output === '/usr/bin/python', w2.output);
    const w3 = await exec('bash', 'which sort', ws);
    check('W3 which sort', w3.success && w3.output === '/usr/bin/sort', w3.output);
    const w4 = await exec('bash', 'which which', ws);
    check('W4 which which', w4.success && w4.output === '/usr/bin/which', w4.output);
    const w5 = await exec('bash', 'which tar', ws);
    check('W5 missing command fails honestly', !w5.success && w5.output.includes('which: tar: command not found'),
      w5.output);
    const w6 = await exec('bash', 'which python sort tar', ws);
    check('W6 mixed found+missing keeps stdout AND fails', !w6.success
      && w6.output.includes('/usr/bin/python') && w6.output.includes('/usr/bin/sort')
      && w6.output.includes('which: tar: command not found'), w6.output);
    const w7 = await exec('bash', 'which', ws);
    check('W7 no args → usage failure', !w7.success && w7.output.includes('usage: which'), w7.output);
    const w8cmds = Object.keys(M.SHELL_COMMANDS).filter((n) => n !== 'which');
    const w8 = await exec('bash', 'which ' + w8cmds.join(' '), ws);
    check('W8 every registry command resolves, exact registry-wide answer', w8.success
      && w8.output.split('\n').length === w8cmds.length, w8.output);
    check('W8b SHELL_ALIASES has exactly python3→python', Object.keys(M.SHELL_ALIASES).length === 1
      && M.SHELL_ALIASES.python3 === 'python', JSON.stringify(M.SHELL_ALIASES));

    const v = bareVfs(ws);
    const w9 = await exec('bash', 'ls /usr/bin', v);
    check('W9 /usr/bin auto-includes sort and which', w9.success && w9.output.includes('sort')
      && w9.output.includes('which'), w9.output);
    const w10 = await exec('bash', 'ls /bin', v);
    check('W10 /bin mirrors the same registry', w10.success && w10.output === w9.output, w10.output);

    const r1 = await exec('bash', 'echo x > /usr/bin/sort', v);
    const r2 = await exec('bash', 'rm /usr/bin/sort', v);
    check('W11 system bins remain read-only', !r1.success && r1.output.includes('read-only')
      && !r2.success, r1.output + '/' + r2.output);
  }

  // ---------- DG. dogfood regressions (real model trajectories) ----------
  {
    const big = bigText(50400);
    const ws = fixture({ 'large.txt': big, 'data.txt': 'foo\nbar\nfoo\n' });

    const a = await exec('bash', 'head -50 large.txt', ws);
    check('DG-A head -50 large.txt (was unsupported option)', a.success
      && a.output.split('\n').length === 50 && a.output.startsWith('FIRST-row-marker'), a.output.slice(0, 40));
    const b = await exec('bash', 'head -c 2000 large.txt', ws);
    check('DG-B head -c 2000 large.txt (was unsupported option)', b.success && b.output.length > 0
      && b.output.startsWith('FIRST-row-marker'), b.output.slice(0, 40));
    const c = await exec('bash', 'grep -c foo data.txt', ws);
    check('DG-C grep -c (was unsupported option)', c.success && c.output === '2', c.output);
    const d = await exec('bash', 'cat no-such-file 2>/dev/null || echo fallback', ws);
    check('DG-D failing-cmd 2>/dev/null || echo fallback', d.success && d.output === 'fallback', d.output);
    const e = await exec('bash', 'find . -type f | sort', ws);
    check('DG-E find | sort (sort was unavailable)', e.success
      && e.output === ['./a.txt', './b.txt', './data.txt', './large.txt', './lines.txt', './names.txt',
        './sub/c.txt', './zh.txt'].join('\n'), e.output);
    const f = await exec('bash', 'which tar', ws);
    check('DG-F which tar honestly reports absence (was unavailable)', !f.success
      && f.output.includes('command not found'), f.output);
  }

  // ---------- HP. help / system prompt contract ----------
  {
    const h = await exec('bash', 'help', fixture());
    check('HP1 help lists the new usages', h.success && h.output.includes('head [-n N|-c N|-N] [file]')
      && h.output.includes('tail [-n N|-n +N|-c N|-N] [file]')
      && h.output.includes('grep [-c]') && h.output.includes('sort [-n] [-r] [-u] [file...]')
      && h.output.includes('which <command>...'), h.output.slice(0, 200));
    check('HP2 help documents the /dev/null sink', h.output.includes('> /dev/null')
      && h.output.includes('not a file'), '');

    const p = M.shellSystemPromptSection();
    const stdinConsumers = Object.keys(M.SHELL_COMMANDS)
      .filter((n) => M.SHELL_COMMANDS[n].stdin).join(' ');
    check('HP3 prompt stdin consumers are registry-derived', p.includes('stdin consumers: ' + stdinConsumers)
      && stdinConsumers.includes('sort') && !stdinConsumers.includes('python'), stdinConsumers);
    check('HP4 prompt warns unsupported control structures + heredoc chaining',
      p.includes('for / while / if / case') && p.includes('standalone bash invocation'), '');
    check('HP5 prompt still declares NOT full POSIX bash + Python fallback',
      p.includes('NOT full POSIX bash') && p.includes('use Python for complex logic'), '');
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.error('TEST RUNNER FAIL', e); process.exit(1); });
