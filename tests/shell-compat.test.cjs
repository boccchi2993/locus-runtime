// Shell compatibility baseline tests (node): command sequencing (; &&),
// pipelines (|), invocation-local cd / virtual cwd, ls flags, find, grep,
// head, tail, wc, help, quoted-operator safety, bounds and cancellation.
// Uses a hierarchical in-memory workspace (the flat MemWS in shell.test.cjs
// cannot represent directories). Run: node tests/shell-compat.test.cjs

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

// A bare VFS (no /mnt/workspace) or one wrapping a legacy adapter.
function bareVfs() {
  return new M.VirtualWorkspace({ listCommands: () => Object.keys(M.SHELL_COMMANDS) });
}

// --- hierarchical in-memory workspace (byte-exact, deterministic order) ---
class TreeWS extends M.WorkspaceAdapter {
  constructor(files) {
    super();
    this.name = 'tree';
    this.files = {};
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
  async remove(p) { p = M.normalizeWorkspacePath(p); delete this.files[p]; }
  async mkdir(p) { p = M.normalizeWorkspacePath(p); if (p && p in this.files) { const e = new Error('type mismatch'); e.name = 'TypeMismatchError'; throw e; } }
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

function b64(s) { return Buffer.from(s, 'utf8').toString('base64'); }

// M1b: python runs on an injected instance (what the product wiring does).
const { freshRuntime } = require('./helpers/runtime.cjs');
let pyrt = null; // the session drives THIS instance — resolved at run() start
function withPyrt(opts) { return Object.assign({ pythonRuntime: pyrt }, opts || {}); }
function mockWorkerResult(result) {
  pyrt._ensureWorker = () => {};
  pyrt.worker = {
    postMessage(msg) {
      const p = pyrt._pending.get(msg.id);
      queueMicrotask(() => {
        clearTimeout(p.timer);
        M.PythonRuntime._pending.delete(msg.id);
        p.resolve(result);
      });
    },
  };
}

const dec = (b) => new TextDecoder().decode(b || new Uint8Array());

function fixture() {
  return new TreeWS({
    'README.md': '# hello\nfoo line\nbar\n',
    'a.txt': 'foo\nbar\nfoo again\n',          // 18 bytes, 3 lines, 4 words
    'lines.txt': Array.from({ length: 20 }, (_, i) => 'L' + (i + 1)).join('\n') + '\n',
    'u.txt': '你好\n',                            // 7 UTF-8 bytes
    'k.bin': 'x'.repeat(1024),                   // exactly 1 KiB
    'sub/b.js': 'console.log(1)\n',
    'sub/deep/c.md': '# deep\n',
    'sub/.dotfile': 'x\n',
    '.hidden': 'secret\n',
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
  pyrt = __session.pythonRuntime();
  // ---------- Q. quoted operators are DATA, never syntax ----------
  {
    const ws = fixture();
    const q1 = await exec('bash', 'echo "a;b"', ws);
    check('Q1 quoted semicolon is text', q1.success && q1.output === 'a;b', q1.output);
    const q2 = await exec('bash', "echo 'x|y'", ws);
    check('Q2 quoted pipe is text', q2.success && q2.output === 'x|y', q2.output);
    const q3 = await exec('bash', 'echo "x && y"', ws);
    check('Q3 quoted && is text', q3.success && q3.output === 'x && y', q3.output);
    const q4 = await exec('bash', 'echo "a && b"', ws);
    check('Q4 quoted && (2) is text', q4.success && q4.output === 'a && b', q4.output);
    const q5 = await exec('bash', 'echo ">" victim.txt', ws);
    check('Q5 quoted > writes nothing', q5.success && q5.output === '> victim.txt' && !('victim.txt' in ws.files));
  }

  // ---------- S. sequencing ----------
  {
    const ws = fixture();
    const s1 = await exec('bash', 'echo A; ls', ws);
    check('S1 ; sequence runs both', s1.success && s1.output.startsWith('A\n') && s1.output.includes('a.txt'), s1.output);
    const s2 = await exec('bash', 'echo one > s1.txt; echo two > s2.txt', ws);
    check('S2 both side effects commit', s2.success && dec(ws.files['s1.txt']) === 'one\n' && dec(ws.files['s2.txt']) === 'two\n');
    const s3 = await exec('bash', 'badcmd; echo after', ws);
    check('S3 ; continues after failure (status = last command)', s3.success
      && s3.output.includes('badcmd') && s3.output.includes('after'), s3.output);

    const a1 = await exec('bash', 'ls && cat a.txt', ws);
    check('A1 && runs second on success', a1.success && a1.output.includes('foo again'), a1.output);
    const a2 = await exec('bash', 'bad-command && echo should-not-run', ws);
    check('A2 && stops on failure', !a2.success && a2.output.includes('bad-command')
      && !a2.output.includes('should-not-run'), a2.output);
    const a3 = await exec('bash', 'cat missing.txt && echo nope > nope.txt', ws);
    check('A3 && blocks later side effect', !a3.success && !('nope.txt' in ws.files), a3.output);
  }

  // ---------- P. pipelines ----------
  {
    const ws = fixture();
    const p1 = await exec('bash', 'find . -type f | head -n 3', ws);
    check('P1 find | head works', p1.success && p1.output.split('\n').length === 3, p1.output);
    const p2 = await exec('bash', 'grep foo a.txt | wc -l', ws);
    check('P2 grep | wc -l', p2.success && p2.output === '2', p2.output);
    const p3 = await exec('bash', 'cat a.txt | grep bar', ws);
    check('P3 cat | grep', p3.success && p3.output === 'bar', p3.output);
    const p4 = await exec('bash', 'echo hi | cat', ws);
    check('P4 echo | cat', p4.success && p4.output === 'hi', p4.output);
    const p5 = await exec('bash', 'echo hi | ls', ws);
    check('P5 pipe into non-stdin command fails loudly', !p5.success && p5.output.includes('does not read stdin'), p5.output);
    const p6 = await exec('bash', 'find . -type f | grep "\\.md" | head -n 20', ws);
    check('P6 three-stage pipeline', p6.success && p6.output.includes('./README.md')
      && p6.output.includes('./sub/deep/c.md') && !p6.output.includes('a.txt'), p6.output);

    // intermediate stage output over SHELL_PIPE_MAX_BYTES fails loudly
    const wsBig = new TreeWS({ 'big.txt': 'x'.repeat(M.SHELL_PIPE_MAX_BYTES + 100) + '\n' }); // one huge matching line
    const p7 = await exec('bash', 'grep x big.txt | wc -l', wsBig);
    check('P7 oversized pipeline stage fails loudly', !p7.success && p7.output.includes('pipeline stage output exceeds'),
      p7.output.slice(0, 120));
  }

  // ---------- L. ls flags ----------
  {
    const ws = fixture();
    const l1 = await exec('bash', 'ls', ws);
    check('L1 ls hides dotfiles by default', l1.success && !l1.output.includes('.hidden')
      && l1.output.includes('a.txt') && l1.output.includes('sub/'), l1.output);
    const l2 = await exec('bash', 'ls -a', ws);
    check('L2 ls -a shows dotfiles', l2.success && l2.output.includes('.hidden'), l2.output);
    const l3 = await exec('bash', 'ls -l', ws);
    check('L3 ls -l long format', l3.success && /^- 18 a\.txt$/m.test(l3.output) && /^d 0 sub\/$/m.test(l3.output), l3.output);
    const l4 = await exec('bash', 'ls -lh', ws);
    check('L4 ls -lh human sizes', l4.success && l4.output.includes('18 B') && l4.output.includes('1.0 KiB'), l4.output);
    const l5 = await exec('bash', 'ls -l', ws);
    check('L5 raw bytes without -h', l5.success && l5.output.includes('1024') && !l5.output.includes('KiB'), l5.output);
    const l6 = await exec('bash', 'ls -la sub', ws);
    check('L6 ls -la path', l6.success && l6.output.includes('.dotfile') && l6.output.includes('deep/'), l6.output);
    const l7 = await exec('bash', 'ls -lah', ws);
    check('L7 combined -lah', l7.success && l7.output.includes('.hidden') && l7.output.includes('KiB'), l7.output);
    const l8 = await exec('bash', 'ls -al sub', ws);
    check('L8 combined -al path', l8.success && l8.output.includes('.dotfile'), l8.output);
    const l9 = await exec('bash', 'ls -R', ws);
    check('L9 unknown option error lists supported', !l9.success && l9.output.includes('ls: unsupported option: -R')
      && l9.output.includes('-a -l -h'), l9.output);
    const l10 = await exec('bash', 'ls missing', ws);
    check('L10 missing path error', !l10.success && l10.output.includes('no such file or directory'), l10.output);
    const l11 = await exec('bash', 'ls "dir with space"', ws);
    check('L11 quoted path with spaces', l11.success && l11.output === 'note.txt', l11.output);
    const l12 = await exec('bash', 'ls README.md a.txt', ws);
    check('L12 multiple file operands', l12.success && l12.output.includes('README.md') && l12.output.includes('a.txt'), l12.output);
  }

  // ---------- C. cd / virtual cwd ----------
  {
    const ws = fixture();
    const c1 = await exec('bash', 'pwd', ws);
    check('C1 pwd starts at the mounted workspace', c1.success && c1.output === '/mnt/workspace', c1.output);
    const c2 = await exec('bash', 'cd sub && pwd', ws);
    check('C2 cd && pwd (absolute)', c2.success && c2.output === '/mnt/workspace/sub', c2.output);
    const c3 = await exec('bash', 'cd sub && cat b.js', ws);
    check('C3 relative file resolves against cwd', c3.success && c3.output.includes('console.log(1)'), c3.output);
    const c4 = await exec('bash', 'cd sub; ls', ws);
    check('C4 cd ; ls', c4.success && c4.output.includes('b.js') && !c4.output.includes('a.txt'), c4.output);
    const c5 = await exec('bash', 'pwd', ws);
    check('C5 next invocation starts at the default cwd again', c5.success && c5.output === '/mnt/workspace', c5.output);
    const c6 = await exec('bash', 'cd ../../../..', ws);
    check('C6 cd above the filesystem root rejected', !c6.success && c6.output.includes('escapes filesystem root'), c6.output);
    const c7 = await exec('bash', 'cd sub && cd ../../../.. && pwd', ws);
    check('C7 nested escape rejected', !c7.success && c7.output.includes('escapes filesystem root'), c7.output);
    const c8 = await exec('bash', 'cd sub && cd .. && pwd', ws);
    check('C8 cd .. back to the mount root', c8.success && c8.output === '/mnt/workspace', c8.output);
    const c9 = await exec('bash', 'cd "dir with space" && pwd', ws);
    check('C9 quoted dir with spaces', c9.success && c9.output === '/mnt/workspace/dir with space', c9.output);
    const c10 = await exec('bash', 'cd missing', ws);
    check('C10 cd missing', !c10.success && c10.output.includes('no such directory'), c10.output);
    const c11 = await exec('bash', 'cd a.txt', ws);
    check('C11 cd onto file', !c11.success && c11.output.includes('not a directory'), c11.output);
    const c12 = await exec('bash', 'cd sub && echo hi > n.txt', ws);
    check('C12 redirect writes under cwd', c12.success && dec(ws.files['sub/n.txt']) === 'hi\n', JSON.stringify(Object.keys(ws.files)));
    const c13 = await exec('bash', 'cd sub && cat /mnt/workspace/a.txt', ws);
    check('C13 absolute path is filesystem-root absolute', c13.success && c13.output.includes('foo again'), c13.output);
    // bare cd returns to the VFS default cwd
    const c16 = await exec('bash', 'cd sub && cd && pwd', ws);
    check('C16 bare cd returns to the default cwd', c16.success && c16.output === '/mnt/workspace', c16.output);
    const c17 = await exec('bash', 'cd && pwd', null);
    check('C17 bare cd without workspace lands in /home/locus', c17.success && c17.output === '/home/locus', c17.output);

    // python script path resolves against the shell cwd; the shell cwd is
    // passed through to the worker as Python's cwd (protocol v2)
    const wsP = new TreeWS({ 'sub/script.py': 'print(1)\n' });
    let lastMsg = null;
    pyrt._ensureWorker = () => {};
    pyrt.worker = {
      postMessage(msg) {
        lastMsg = msg;
        const p = pyrt._pending.get(msg.id);
        queueMicrotask(() => {
          clearTimeout(p.timer);
          pyrt._pending.delete(msg.id);
          p.resolve({ stdout: 'ok', stderr: '', error: null, files: [], deleted: [] });
        });
      },
    };
    const c14 = await exec('bash', 'cd sub && python script.py', wsP, withPyrt());
    check('C14 cd && python script.py resolves script under cwd', c14.success && c14.output.includes('ok'), c14.output);
    check('C14b worker receives the shell cwd (ABS) and a mounts array',
      !!lastMsg && lastMsg.cwd === '/mnt/workspace/sub'
      && Array.isArray(lastMsg.mounts)
      && lastMsg.mounts.some((m) => m.root === '/mnt/workspace'
        && m.files.some((f) => f.path === '/mnt/workspace/sub/script.py')),
      JSON.stringify(lastMsg && { cwd: lastMsg.cwd, roots: lastMsg.mounts && lastMsg.mounts.map((m) => m.root) }));
    const c15 = await exec('bash', 'cd sub && python missing.py', wsP, withPyrt());
    check('C15 missing script error', !c15.success && c15.output.includes("can't open file"), c15.output);
  }

  // ---------- F. find ----------
  {
    const ws = fixture();
    const f1 = await exec('bash', 'find . -type f', ws);
    const f1again = await exec('bash', 'find . -type f', ws);
    check('F1 find lists files', f1.success && f1.output.includes('./a.txt') && f1.output.includes('./sub/deep/c.md')
      && f1.output.includes('./.hidden') && !f1.output.includes('./sub\n'), f1.output);
    check('F1b find is deterministic', f1.output === f1again.output);
    const f2 = await exec('bash', 'find . -name "*.js"', ws);
    check('F2 find -name glob', f2.success && f2.output === './sub/b.js', f2.output);
    const f3 = await exec('bash', 'find . -type d', ws);
    check('F3 find -type d', f3.success && f3.output.includes('./sub') && f3.output.includes('./sub/deep')
      && !f3.output.includes('a.txt'), f3.output);
    const f4 = await exec('bash', 'find . -maxdepth 1', ws);
    check('F4 find -maxdepth 1', f4.success && f4.output.includes('./sub') && f4.output.includes('./a.txt')
      && !f4.output.includes('deep'), f4.output);
    const f5 = await exec('bash', 'find . -maxdepth 0', ws);
    check('F5 find -maxdepth 0 prints start only', f5.success && f5.output === '.', f5.output);
    const f6 = await exec('bash', 'find sub -name "?.js"', ws);
    check('F6 find -name ? glob', f6.success && f6.output === 'sub/b.js', f6.output);
    const f7 = await exec('bash', 'find missing', ws);
    check('F7 find missing path', !f7.success && f7.output.includes('no such file or directory'), f7.output);
    const f8 = await exec('bash', 'find . -exec rm', ws);
    check('F8 unsupported predicate fails with guidance', !f8.success && f8.output.includes('find: unsupported predicate: -exec'), f8.output);
    const f9 = await exec('bash', 'find src -name "*.java" -type f', ws);
    check('F9 combined predicates on missing dir fail cleanly', !f9.success && f9.output.includes('no such'), f9.output);
    const f10 = await exec('bash', 'find sub -maxdepth 1 -type f', ws);
    check('F10 combined -maxdepth -type', f10.success && f10.output === 'sub/.dotfile\nsub/b.js', f10.output);

    // cancellation stops traversal
    const wsC = fixture();
    const ac = new AbortController();
    let lists = 0;
    const origList = wsC.list.bind(wsC);
    wsC.list = async (p) => { lists++; if (lists >= 2) ac.abort(); return origList(p); };
    const f11 = await M.runShellCommand('find .', wsC, { signal: ac.signal });
    check('F11 find honours cancellation mid-traversal', f11.isError && f11.output.includes('cancelled'), f11.output);
  }

  // ---------- G. grep ----------
  {
    const ws = fixture();
    const g1 = await exec('bash', 'grep foo a.txt', ws);
    check('G1 grep file', g1.success && g1.output === 'foo\nfoo again', g1.output);
    const g2 = await exec('bash', 'grep -n foo a.txt', ws);
    check('G2 grep -n', g2.success && g2.output === '1:foo\n3:foo again', g2.output);
    const g3 = await exec('bash', 'grep -i FOO a.txt', ws);
    check('G3 grep -i', g3.success && g3.output === 'foo\nfoo again', g3.output);
    const g4 = await exec('bash', 'grep -r foo .', ws);
    check('G4 grep -r prefixes paths', g4.success && g4.output.includes('./a.txt:foo') && g4.output.includes('./README.md:foo line'), g4.output);
    const g5 = await exec('bash', 'grep -Rn foo .', ws);
    check('G5 combined -Rn', g5.success && g5.output.includes('./README.md:2:foo line'), g5.output);
    const g6 = await exec('bash', 'grep [ a.txt', ws);
    check('G6 invalid regex fails clearly', !g6.success && g6.output.includes('grep: invalid pattern'), g6.output);
    const g7 = await exec('bash', 'grep foo sub', ws);
    check('G7 directory without -r', !g7.success && g7.output.includes('is a directory'), g7.output);
    const g8 = await exec('bash', 'echo "hello world" | grep "o.w"', ws);
    check('G8 regex semantics on stdin', g8.success && g8.output === 'hello world', g8.output);
    const g9 = await exec('bash', 'grep zzz a.txt', ws);
    check('G9 no match = successful empty answer', g9.success && g9.output === '', JSON.stringify(g9));
    const g10 = await exec('bash', 'grep foo', ws);
    check('G10 no file and no stdin fails', !g10.success && g10.output.includes('missing file operand'), g10.output);
    const g11 = await exec('bash', 'grep -P foo a.txt', ws);
    check('G11 unsupported option lists supported', !g11.success && g11.output.includes('grep: unsupported option: -P'), g11.output);

    // binary / non-UTF-8 files are skipped safely, with a note
    const wsB = fixture();
    wsB.files['bin.dat'] = new Uint8Array([0xff, 0xfe, 0x41, 0x00]);
    const g12 = await exec('bash', 'grep -r foo .', wsB);
    check('G12 non-UTF-8 file skipped with note', g12.success && g12.output.includes('skipped') && g12.output.includes('bin.dat'), g12.output.slice(-200));

    // match cap truncates with an explicit note
    const wsM = new TreeWS({ 'm.txt': Array(600).fill('hit').join('\n') + '\n' });
    const g13 = await exec('bash', 'grep hit m.txt', wsM);
    check('G13 match cap truncates with note', g13.success && g13.output.split('\n').length === 501
      && g13.output.includes('truncated'), 'lines=' + g13.output.split('\n').length);

    // cancellation stops recursive grep
    const wsC = fixture();
    const ac = new AbortController();
    let lists = 0;
    const origList = wsC.list.bind(wsC);
    wsC.list = async (p) => { lists++; if (lists >= 2) ac.abort(); return origList(p); };
    const g14 = await M.runShellCommand('grep -r foo .', wsC, { signal: ac.signal });
    check('G14 recursive grep honours cancellation', g14.isError && g14.output.includes('cancelled'), g14.output);
  }

  // ---------- H/T. head / tail ----------
  {
    const ws = fixture();
    const h1 = await exec('bash', 'head lines.txt', ws);
    check('H1 head default 10', h1.success && h1.output.split('\n').length === 10 && h1.output.startsWith('L1\n'), h1.output);
    const h2 = await exec('bash', 'head -n 3 lines.txt', ws);
    check('H2 head -n 3', h2.success && h2.output === 'L1\nL2\nL3', h2.output);
    const h3 = await exec('bash', 'cat lines.txt | head -n 2', ws);
    check('H3 head from stdin', h3.success && h3.output === 'L1\nL2', h3.output);
    const h4 = await exec('bash', 'head -x lines.txt', ws);
    check('H4 head unsupported option', !h4.success && h4.output.includes('head: unsupported option'), h4.output);
    const t1 = await exec('bash', 'tail -n 2 lines.txt', ws);
    check('HT1 tail -n 2', t1.success && t1.output === 'L19\nL20', t1.output);
    const t2 = await exec('bash', 'tail -n +19 lines.txt', ws);
    check('HT2 tail -n +N', t2.success && t2.output === 'L19\nL20', t2.output);
    const t3 = await exec('bash', 'tail -n 30 lines.txt', ws);
    check('HT3 tail larger than file', t3.success && t3.output.split('\n').length === 20, t3.output);
    const t4 = await exec('bash', 'cat lines.txt | tail -n 1', ws);
    check('HT4 tail from stdin', t4.success && t4.output === 'L20', t4.output);
    const t5 = await exec('bash', 'tail -n -3 lines.txt', ws);
    check('HT5 tail rejects invalid count', !t5.success && t5.output.includes('invalid line count'), t5.output);
  }

  // ---------- W. wc ----------
  {
    const ws = fixture();
    const w1 = await exec('bash', 'wc a.txt', ws);
    check('W1 wc default l/w/c', w1.success && w1.output === '3 4 18 a.txt', w1.output);
    const w2 = await exec('bash', 'wc -l a.txt', ws);
    check('W2 wc -l', w2.success && w2.output === '3 a.txt', w2.output);
    const w3 = await exec('bash', 'wc -w a.txt', ws);
    check('W3 wc -w', w3.success && w3.output === '4 a.txt', w3.output);
    const w4 = await exec('bash', 'wc -c u.txt', ws);
    check('W4 wc -c counts UTF-8 bytes', w4.success && w4.output === '7 u.txt', w4.output);
    const w5 = await exec('bash', 'echo 你好 | wc -c', ws);
    check('W5 wc -c stdin UTF-8 bytes', w5.success && w5.output === '6', w5.output);
    const w6 = await exec('bash', 'cat a.txt | wc -l', ws);
    check('W6 wc -l stdin', w6.success && w6.output === '3', w6.output);
    const w7 = await exec('bash', 'wc -l a.txt u.txt', ws);
    check('W7 wc multiple files + total', w7.success && w7.output.includes('3 a.txt') && w7.output.includes('1 u.txt')
      && w7.output.includes('4 total'), w7.output);
    const w8 = await exec('bash', 'wc -x a.txt', ws);
    check('W8 wc unsupported option', !w8.success && w8.output.includes('wc: unsupported option: -x'), w8.output);
  }

  // ---------- X. unsupported syntax / operator errors ----------
  {
    const ws = fixture();
    const x1 = await exec('bash', 'ls || pwd', ws);
    check('X1 || supported: rhs skipped on success', x1.success && x1.output.includes('a.txt')
      && !x1.output.split('\n').includes('/'), x1.output);
    const x2 = await exec('bash', 'ls & pwd', ws);
    check('X2 background & unsupported', !x2.success && x2.output.includes("unsupported operator: '&'"), x2.output);
    const x3 = await exec('bash', 'cat < a.txt', ws);
    check('X3 input redirect unsupported', !x3.success && x3.output.includes("unsupported operator: '<'"), x3.output);
    const x4 = await exec('bash', 'echo hi 2> err.txt', ws);
    check('X4 2> supported: empty stderr creates empty file', x4.success && x4.output === 'hi'
      && ('err.txt' in ws.files) && dec(ws.files['err.txt']) === '', x4.output);
    const x5 = await exec('bash', 'ls |', ws);
    check('X5 trailing pipe syntax error', !x5.success && x5.output.includes("empty command after '|'"), x5.output);
    const x6 = await exec('bash', 'ls &&', ws);
    check('X6 trailing && syntax error', !x6.success && x6.output.includes("empty command after '&&'"), x6.output);
    const x7 = await exec('bash', 'sudo rm x', ws);
    check('X7 unknown command suggests help', !x7.success && x7.output.includes('sudo') && x7.output.includes('help'), x7.output);
    const x8 = await exec('bash', 'echo $(pwd)', ws);
    check('X8 $() is literal text, not executed', x8.success && x8.output === '$(pwd)', x8.output);
  }

  // ---------- HELP. help + registry/prompt co-source ----------
  {
    const ws = fixture();
    const h = await exec('bash', 'help', ws);
    check('HELP1 help succeeds and lists commands', h.success && h.output.includes('Unix-like compatibility shell'), h.output.slice(0, 120));
    const names = Object.keys(M.SHELL_COMMANDS);
    check('HELP2 help text contains every command', names.every((n) => h.output.includes(n)), names.join(','));
    const prompt = M.shellSystemPromptSection();
    check('HELP3 prompt section contains every command usage',
      names.every((n) => prompt.includes(M.SHELL_COMMANDS[n].usage)), names.join(','));
    check('HELP4 prompt states the contract', prompt.includes('NOT full POSIX bash')
      && prompt.includes('Paths containing spaces must be quoted')
      && prompt.includes('Every bash invocation starts at the default cwd')
      && prompt.includes('/mnt/workspace') && prompt.includes('/home/locus'));
    check('HELP5 help and prompt come from one registry',
      h.output === M.shellHelpText() && h.output.includes(';') && h.output.includes('&&') && h.output.includes('|'));
  }

  // ---------- K. cancellation between sequence commands ----------
  {
    const ws = fixture();
    const ac = new AbortController();
    const origWrite = ws.write.bind(ws);
    let writes = 0;
    ws.write = async (p, d) => { writes++; await origWrite(p, d); ac.abort(); };
    const k1 = await exec('bash', 'echo A > ka.txt; echo B > kb.txt', ws, { signal: ac.signal });
    check('K1 cancel between commands stops side effects', !k1.success && ('ka.txt' in ws.files) && !('kb.txt' in ws.files),
      JSON.stringify(Object.keys(ws.files).filter((f) => f.startsWith('k'))) + ' | ' + k1.output);
    check('K1b output reports cancellation', k1.output.includes('cancelled'), k1.output);
  }

  // ---------- N. network metadata through compound commands ----------
  {
    const ws = fixture();
    const origFetch = global.fetch;
    global.fetch = async () => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
    try {
      const n1 = await exec('bash', 'echo start; curl https://example.test/x', ws);
      check('N1 single network op keeps real backend', n1.success && n1.backend === 'browser-direct'
        && n1.operation === 'network', n1.backend + '/' + n1.operation);
      // M3a: the Telemetry record is the Product tool-adapter sink; the Runtime pins the same attribution on the execution result.
      check('N1b telemetry carries network operation (result attribution)', n1.operation === 'network' && n1.backend === 'browser-direct'
        && n1.success === true, JSON.stringify(n1));
      const n2 = await exec('bash', 'curl https://example.test/a; curl https://example.test/b', ws);
      check('N2 multiple network ops marked compound', n2.success && n2.operation === 'compound' && n2.backend === 'browser',
        n2.backend + '/' + n2.operation);
      const n3 = await exec('bash', 'curl https://example.test/x | head -n 1', ws);
      check('N3 network op inside pipeline propagates', n3.success && n3.backend === 'browser-direct'
        && n3.operation === 'network' && n3.output === '{"ok":true}', n3.backend + '/' + n3.operation + ' | ' + n3.output);
    } finally {
      global.fetch = origFetch;
    }
  }

  // ---------- V. the machine always has a filesystem (VFS invariants) ----------
  {
    // pwd defaults
    const v1 = await exec('bash', 'pwd', null);
    check('V1 pwd without workspace is /home/locus', v1.success && v1.output === '/home/locus', v1.output);

    // filesystem root listing is the fixed userland view
    const vfs = bareVfs();
    const v2 = await exec('bash', 'ls /', vfs);
    check('V2 ls / shows the machine layout', v2.success
      && v2.output.split('\n').map((s) => s.replace(/\/$/, '')).join(' ') === 'bin home mnt tmp usr', v2.output);
    const v3 = await exec('bash', 'ls /mnt', vfs);
    check('V3 ls /mnt without workspace', v3.success
      && v3.output.split('\n').map((s) => s.replace(/\/$/, '')).join(' ') === 'download plugins upload', v3.output);

    // /usr/bin is the command registry (drift guard)
    const v4 = await exec('bash', 'ls /usr/bin', vfs);
    const expectedCmds = Object.keys(M.SHELL_COMMANDS).slice().sort();
    check('V4 /usr/bin lists exactly the shell registry', v4.success
      && v4.output === expectedCmds.join('\n'), v4.output.slice(0, 120));
    check('V4b /bin is the same view', (await exec('bash', 'ls /bin', vfs)).output === v4.output);

    // unmounted /mnt/workspace is a clear error, not an empty dir
    const v5 = await exec('bash', 'ls /mnt/workspace', vfs);
    check('V5 unmounted workspace errors clearly', !v5.success && v5.output.includes('not mounted'), v5.output);
    const v6 = await exec('bash', 'cd /mnt/workspace', vfs);
    check('V6 cd into unmounted workspace → not mounted', !v6.success && v6.output.includes('not mounted'), v6.output);

    // /tmp and /home/locus persist across invocations sharing one vfs
    await exec('bash', 'echo tmpdata > /tmp/keep.txt; echo homedata > /home/locus/keep.txt', vfs);
    const v7 = await exec('bash', 'cat /tmp/keep.txt /home/locus/keep.txt', vfs);
    check('V7 /tmp and /home/locus persist across bash calls', v7.success
      && v7.output.split('\n').includes('tmpdata') && v7.output.split('\n').includes('homedata'), v7.output);

    // structural paths reject writes
    const v8 = await exec('bash', 'echo x > /foo.txt', vfs);
    check('V8 structural write rejected', !v8.success && v8.output.includes('read-only filesystem'), v8.output);
    const v9 = await exec('bash', 'echo x > /usr/bin/evil', vfs);
    check('V9 /usr/bin is read-only', !v9.success && v9.output.includes('read-only'), v9.output);

    // protected roots can never be recursively removed
    for (const root of ['/', '/mnt', '/mnt/workspace', '/mnt/upload', '/home/locus', '/usr']) {
      const r = await exec('bash', 'rm -rf ' + root, vfs);
      check('V10 rm -rf ' + root + ' refused (protected root)', !r.success
        && r.output.includes('rm: refusing to recursively remove protected path: ' + root)
        && !r.output.includes('deleted'), r.output);
    }
    // other mount/system roots are still refused (provider-level message)
    for (const root of ['/home', '/tmp', '/mnt/download', '/mnt/plugins', '/usr/bin']) {
      const r = await exec('bash', 'rm -rf ' + root, vfs);
      check('V10b rm -rf ' + root + ' refused (not silently emptied)', !r.success, r.output);
    }

    // upload mount: user files readable, never writable/removable
    const up = vfs.resolveMount('/mnt/upload').provider;
    const upBytes = new TextEncoder().encode('uploaded input');
    up.addFile({ name: 'input.txt', size: upBytes.byteLength, arrayBuffer: async () => upBytes.slice().buffer });
    const v11 = await exec('bash', 'cat /mnt/upload/input.txt', vfs);
    check('V11 upload file readable via cat', v11.success && v11.output === 'uploaded input', v11.output);
    const v12 = await exec('bash', 'echo x > /mnt/upload/out.txt', vfs);
    check('V12 write into upload refused', !v12.success && v12.output.includes('read-only filesystem'), v12.output);
    const v13 = await exec('bash', 'rm /mnt/upload/input.txt', vfs);
    check('V13 rm from upload refused, file intact', !v13.success
      && v13.output.includes('rm: /mnt/upload/input.txt: read-only filesystem')
      && (await vfs.exists('/mnt/upload/input.txt')), v13.output);

    // cross-mount mv: read-only source fails BEFORE the destination exists
    const v14 = await exec('bash', 'mv /mnt/upload/input.txt /mnt/download/copied.txt', vfs);
    check('V14 mv from read-only source refused before any mutation', !v14.success
      && v14.output.includes('source is on a read-only filesystem')
      && !(await vfs.exists('/mnt/download/copied.txt'))
      && (await vfs.exists('/mnt/upload/input.txt')), v14.output);

    // ... and read-only destination is also refused before any mutation
    await exec('bash', 'echo data > /mnt/download/d.txt', vfs);
    const v15 = await exec('bash', 'mv /mnt/download/d.txt /mnt/upload/d.txt', vfs);
    check('V15 mv into read-only destination refused before any mutation', !v15.success
      && v15.output.includes('read-only filesystem')
      && (await vfs.exists('/mnt/download/d.txt'))
      && !(await vfs.exists('/mnt/upload/d.txt')), v15.output);

    // a REAL working mv across writable mounts still works (copy-verify-delete)
    const v16 = await exec('bash', 'mv /mnt/download/d.txt /tmp/moved.txt', vfs);
    check('V16 mv across writable mounts works', v16.success
      && !(await vfs.exists('/mnt/download/d.txt'))
      && (await vfs.read('/tmp/moved.txt')) === 'data\n', v16.output);

    // protected roots cannot be moved either
    const v17 = await exec('bash', 'mv /mnt/download /tmp/d2', vfs);
    check('V17 mv of a protected root refused', !v17.success
      && v17.output.includes('refusing to move protected path: /mnt/download'), v17.output);
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.error('TEST RUNNER FAIL', e); process.exit(1); });
