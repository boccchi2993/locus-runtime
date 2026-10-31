// Shell C5-gap tests (node): ls -R, `cmd < file` input redirection, generic
// heredocs, the sed subset, unknown-command alternatives and python
// traceback denoising. Same harness as the other shell-compat suites: the
// PUBLIC runtime entry with a hierarchical in-memory workspace; the python
// worker boundary is stubbed (traceback denoising is asserted through
// runPythonCode with a worker-shaped result).
// Run: node tests/shell-compat5.test.cjs

global.window = { location: { protocol: 'https:' } };
global.document = { getElementById: () => null };

const M = require('./helpers/core.cjs');

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
const { installGrepFakeWorker } = require('./helpers/grep-fake-worker.cjs');
installGrepFakeWorker(M);

function bareVfs() {
  return new M.VirtualWorkspace({ listCommands: () => Object.keys(M.SHELL_COMMANDS) });
}
function wrapVfs(adapter, mode) {
  const vfs = new M.VirtualWorkspace({ listCommands: () => Object.keys(M.SHELL_COMMANDS) });
  vfs.mount('/mnt/ro', adapter, mode || 'read-only');
  return vfs;
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

const dec = (b) => new TextDecoder().decode(b || new Uint8Array());

function sedFixture() {
  return new TreeWS({
    'nums.txt': 'one\n two\nthree\nfour\nfive\n',   // 5 lines + trailing newline
    'pairs.txt': 'a-1\nb-2\nc-3\n',
    'dup.txt': 'aa-1\nab-2\n',                      // two 'a' on the first line
    'notrail.txt': 'alpha\nbeta',                   // no trailing newline
    'empty.txt': '',
    'sub/inner.txt': 'deep\n',
  });
}

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + detail : '')); }
}

// M1b: python runs on an injected instance; the worker boundary is stubbed.
let pyrt = null;
function withPyrt(opts) { return Object.assign({ pythonRuntime: pyrt }, opts || {}); }
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
  __session = (await __hostPromise).createSession();
  pyrt = __session.pythonRuntime();

  // ---------- R. ls -R ----------
  {
    const ws = new TreeWS({
      'top.txt': 'x\n',
      'sub/a.txt': 'a\n',
      'sub/deep/b.txt': 'b\n',
      '.hiddendir/h.txt': 'h\n',
    });
    const r1 = await exec('bash', 'ls -R', ws);
    check('R1 ls -R GNU sections: root header, blank-line separated, nested dirs',
      r1.success
      && r1.output.startsWith('.:\n')
      && r1.output.includes('sub/')
      && r1.output.includes('./sub:\n')
      && r1.output.includes('./sub/deep:')
      && r1.output.split('\n\n').length === 3,
      JSON.stringify(r1.output));
    const r2 = await exec('bash', 'ls -R sub', ws);
    check('R2 ls -R <dir> headers use the operand path (sub:, sub/deep:)',
      r2.success && r2.output.startsWith('sub:\n') && r2.output.includes('sub/deep:\n'),
      JSON.stringify(r2.output));
    const r3 = await exec('bash', 'ls -Ra', ws);
    check('R3 ls -Ra recurses hidden dirs', r3.success && r3.output.includes('.hiddendir:'), r3.output);
    const r3b = await exec('bash', 'ls -R', ws);
    check('R3b ls -R without -a skips hidden entries entirely',
      r3b.success && !r3b.output.includes('.hiddendir'), r3b.output);
    const r4 = await exec('bash', 'ls -Rlh top.txt', ws);
    check('R4 ls -R on a plain file prints the long entry, no header',
      r4.success && r4.output.startsWith('-') && r4.output.includes('top.txt') && !r4.output.includes(':'),
      r4.output);
    const big = {};
    for (let i = 0; i < 2100; i++) big['f' + i + '.txt'] = 'x\n';
    const wsBig = new TreeWS(big);
    const r5 = await exec('bash', 'ls -R', wsBig);
    check('R5 ls -R truncates with a trailing notice over the line cap',
      r5.success && r5.output.includes('[ls: recursive listing truncated'), r5.output.slice(-160));
    const r6 = await exec('bash', 'ls top.txt', ws);
    check('R6 plain ls (no -R) unchanged: single operand, no header',
      r6.success && r6.output === 'top.txt', r6.output);
  }

  // ---------- I. cmd < file ----------
  {
    const ws = sedFixture();
    const i1 = await exec('bash', 'grep e < nums.txt', ws);
    check('I1 grep < file', i1.success && i1.output === 'one\nthree\nfive', JSON.stringify(i1.output));
    const i2 = await exec('bash', 'head -n 2 < nums.txt', ws);
    check('I2 head < file', i2.success && i2.output === 'one\n two', JSON.stringify(i2.output));
    const i3 = await exec('bash', 'wc -l < nums.txt', ws);
    check('I3 wc < file', i3.success && i3.output === '5', i3.output);
    const i4 = await exec('bash', 'sort < nums.txt | head -n 1', ws);
    check('I4 < file on the first pipeline stage', i4.success && i4.output === ' two', JSON.stringify(i4.output));
    const i5 = await exec('bash', 'grep e < missing.txt', ws);
    check('I5 < missing file fails clearly', !i5.success && i5.output.includes('no such file or directory'), i5.output);
    const i6 = await exec('bash', 'grep e < sub', ws);
    check('I6 < directory fails clearly', !i6.success && i6.output.includes('is a directory'), i6.output);
    const i7 = await exec('bash', 'python < nums.txt', ws, withPyrt());
    check('I7 python < file is refused with the actionable hint',
      !i7.success && i7.output.includes("python: '<' input redirection is not supported for python")
      && i7.output.includes("python <<'PY'"), i7.output);
    const i8 = await exec('bash', 'grep e < nums.txt > hits.txt', ws);
    check('I8 < file combines with > redirect', i8.success && dec(ws.files['hits.txt']) === 'one\nthree\nfive\n',
      JSON.stringify(i8.output));
    const i9 = await exec('bash', 'ls < nums.txt', ws);
    check('I9 < into a non-stdin command is POSIX: stdin attached, unread',
      i9.success && i9.output.includes('nums.txt'), i9.output);
  }

  // ---------- H. generic heredoc ----------
  {
    const ws = sedFixture();
    const h1 = await exec('bash', "cat <<'EOF'\nline one\nline two\nEOF", ws);
    check('H1 cat <<\'EOF\' prints the body verbatim', h1.success && h1.output === 'line one\nline two', JSON.stringify(h1.output));
    const h2 = await exec('bash', 'cat <<EOF\nbare $delim ; | > "quotes"\nEOF', ws);
    check('H2 bare delimiter, body kept verbatim (no expansion)',
      h2.success && h2.output === 'bare $delim ; | > "quotes"', JSON.stringify(h2.output));
    const h3 = await exec('bash', 'cat <<"EOF"\ndq body\nEOF', ws);
    check('H3 double-quoted delimiter behaves the same', h3.success && h3.output === 'dq body', h3.output);
    const h4 = await exec('bash', "cat > out1.txt <<'EOF'\nalpha\nbeta\nEOF", ws);
    check('H4 cat > f <<EOF writes the file (trailing newline)',
      h4.success && dec(ws.files['out1.txt']) === 'alpha\nbeta\n', JSON.stringify(h4.output));
    const h5 = await exec('bash', "cat <<'EOF' > out2.txt\nalpha2\nbeta2\nEOF", ws);
    check('H5 cat <<EOF > f (redirect first) writes the file too',
      h5.success && dec(ws.files['out2.txt']) === 'alpha2\nbeta2\n', JSON.stringify(h5.output));
    const h6 = await exec('bash', "echo base > app.txt; cat >> app.txt <<'EOF'\nmore\nEOF", ws);
    check('H6 >> appends heredoc body', h6.success && dec(ws.files['app.txt']) === 'base\nmore\n', h6.output);
    const h6b = await exec('bash', "cat app.txt <<'EOF' >>\nx\nEOF", ws);
    check('H6b heredoc with misplaced >> does not corrupt the file',
      !h6b.success || dec(ws.files['app.txt']) === 'base\nmore\n', JSON.stringify(h6b.output));
    const h7 = await exec('bash', "cat <<-EOF\n\ttabs\tstay\tinside\n\tEOF", ws);
    check('H7 <<- strips leading TABS only (interior tabs kept)',
      h7.success && h7.output === 'tabs\tstay\tinside', JSON.stringify(h7.output));
    const h8 = await exec('bash', "cat <<'EOF'\nEOFx not terminator\nEOF", ws);
    check('H8 only an exact delimiter line terminates (EOFx is body)',
      h8.success && h8.output === 'EOFx not terminator', JSON.stringify(h8.output));
    const h9 = await exec('bash', "cat <<'EOF'\nbody without terminator", ws);
    check('H9 missing terminator fails with the delimiter named',
      !h9.success && h9.output.includes("missing heredoc terminator 'EOF'"), h9.output);
    const h10 = await exec('bash', "cat <<'EOF' <<'EOF2'\nx\nEOF", ws);
    check('H10 second heredoc on one line is refused',
      !h10.success && h10.output.includes('at most one heredoc'), h10.output);
    const h11 = await exec('bash', "cat <<'EOF' | grep b\napple\nbanana\nEOF", ws);
    check('H11 heredoc into a pipeline', h11.success && h11.output === 'banana', h11.output);
    const h12 = await exec('bash', "ls <<'EOF'\nignored\nEOF", ws);
    check('H12 heredoc into a non-stdin command is POSIX: body unread',
      h12.success && h12.output.includes('nums.txt'), h12.output);
    const h13 = await exec('bash', "cat <<'EOF'\nbody\nEOF\nls", ws);
    check('H13 text after the terminator is refused (one command line per call)',
      !h13.success && h13.output.includes('unexpected text after the heredoc terminator'), h13.output);
    const h14 = await exec('bash', 'cat 2<<EOF\nx\nEOF', ws);
    check('H14 n<< stderr heredoc refused', !h14.success && h14.output.includes('2<<'), h14.output);
    const h15 = await exec('bash', 'cat <<< x', ws);
    check('H15 <<< herestring refused with a clear delimiter error',
      !h15.success && h15.output.includes('delimiter'), h15.output);

    // python heredoc combos — the actionable message.
    const h16 = await exec('bash', "cd sub && python <<'PY'\nprint(1)\nPY", ws, withPyrt());
    check('H16 `cd x && python <<PY` refused with the standalone-python-heredoc message',
      !h16.success && h16.output.includes('must be the ONLY command of its bash invocation')
      && h16.output.includes('os.chdir'), h16.output);
    const h17 = await exec('bash', "python <<'PY'\nprint(1)\nPY; ls", ws, withPyrt());
    check('H17 `python <<PY … PY; ls` refused with the same message',
      !h17.success && h17.output.includes('must be the ONLY command of its bash invocation'), h17.output);
    // The standalone python heredoc path is UNCHANGED (mock worker verdict).
    mockWorkerResult({
      stdout: 'heredoc-ok', stderr: '', error: null,
      files: [], deleted: [], createdDirs: [], deletedDirs: [], uncollectedFiles: [],
      stdoutTruncated: false, stderrTruncated: false, inputBytes: 0, outputBytes: 0,
    });
    const h18 = await exec('bash', "python <<'PY'\nprint('heredoc-ok')\nPY", ws, withPyrt());
    check('H18 standalone python heredoc still runs through the special path',
      h18.success && h18.output === 'heredoc-ok', JSON.stringify(h18.output));
  }

  // ---------- S. sed subset ----------
  {
    const ws = sedFixture();
    const s1 = await exec('bash', "sed -n '2,3p' nums.txt", ws);
    check('S1 -n + address range p', s1.success && s1.output === ' two\nthree\n', JSON.stringify(s1.output));
    const s2 = await exec('bash', "sed '2d' nums.txt", ws);
    check('S2 delete line 2', s2.success && s2.output === 'one\nthree\nfour\nfive\n', JSON.stringify(s2.output));
    const s2b = await exec('bash', "sed '$d' nums.txt", ws);
    check('S2b $ deletes the last line', s2b.success && s2b.output === 'one\n two\nthree\nfour\n', JSON.stringify(s2b.output));
    const s2c = await exec('bash', "sed '2,3d' nums.txt", ws);
    check('S2c range delete', s2c.success && s2c.output === 'one\nfour\nfive\n', JSON.stringify(s2c.output));
    const s3 = await exec('bash', "sed 's/o/0/g' nums.txt", ws);
    check('S3 global substitution', s3.success && s3.output === '0ne\n tw0\nthree\nf0ur\nfive\n', JSON.stringify(s3.output));
    const s4 = await exec('bash', "sed 's/\\([a-z]\\)-\\([0-9]\\)/\\2:\\1/' pairs.txt", ws);
    check('S4 BRE group backreference \\2:\\1', s4.success && s4.output === '1:a\n2:b\n3:c\n', JSON.stringify(s4.output));
    const s5 = await exec('bash', "sed -E 's/([a-z])-([0-9])/\\2=\\1/' pairs.txt", ws);
    check('S5 ERE with -E', s5.success && s5.output === '1=a\n2=b\n3=c\n', JSON.stringify(s5.output));
    const s5b = await exec('bash', "sed -r 's/([a-z])-([0-9])/\\2=\\1/' pairs.txt", ws);
    check('S5b -r is an alias of -E', s5b.success && s5b.output === '1=a\n2=b\n3=c\n', s5b.output);
    const s6 = await exec('bash', "sed 's/e/[&]/' nums.txt", ws);
    check('S6 & refers to the whole match (first occurrence per line)',
      s6.success && s6.output === 'on[e]\n two\nthr[e]e\nfour\nfiv[e]\n', JSON.stringify(s6.output));
    const s7 = await exec('bash', "sed 's,a/b,X,' pairs.txt", ws);
    check('S7 arbitrary delimiter , (no match keeps lines unchanged)',
      s7.success && s7.output === 'a-1\nb-2\nc-3\n', s7.output);
    const s7b = await exec('bash', "sed 's|a-1|OK|' pairs.txt", ws);
    check('S7b arbitrary delimiter |', s7b.success && s7b.output === 'OK\nb-2\nc-3\n', s7b.output);
    const s10 = await exec('bash', "sed -e 's/e/E/' -e '2d' nums.txt", ws);
    check('S10 multiple -e applied in order', s10.success && s10.output === 'onE\nthrEe\nfour\nfivE\n', JSON.stringify(s10.output));
    const s11 = await exec('bash', "sed 'y/ab/ba/' pairs.txt", ws);
    check('S11 y command refused with the supported subset listed',
      !s11.success && s11.output.includes("unsupported sed command 'y'") && s11.output.includes('s/RE/REPL'), s11.output);
    const s11b = await exec('bash', "sed '/^a/d' pairs.txt", ws);
    check('S11b regex address refused', !s11b.success && s11b.output.includes('regex addresses'), s11b.output);
    const s11c = await exec('bash', "sed '2!d' pairs.txt", ws);
    check('S11c ! negation refused', !s11c.success && s11c.output.includes("'!'"), s11c.output);
    const s12 = await exec('bash', "sed 's/alpha/ALPHA/' notrail.txt", ws);
    check('S12 no trailing newline: output keeps it off', s12.success && s12.output === 'ALPHA\nbeta', JSON.stringify(s12.output));
    const s12b = await exec('bash', "sed -n '2p' notrail.txt", ws);
    check('S12b -n last line without trailing newline stays bare', s12b.success && s12b.output === 'beta', JSON.stringify(s12b.output));
    const s13 = await exec('bash', "sed 's/x/y/' empty.txt", ws);
    check('S13 empty file → empty output', s13.success && s13.output === '', JSON.stringify(s13.output));
    const s14 = await exec('bash', "sed 's/i/I/g' nums.txt pairs.txt", ws);
    check('S14 multiple files concatenate into one stream (line numbers span)',
      s14.success && s14.output === 'one\n two\nthree\nfour\nfIve\na-1\nb-2\nc-3\n', JSON.stringify(s14.output));
    const s15 = await exec('bash', "sed 's/a/X/2' dup.txt", ws);
    check('S15 Nth-occurrence flag (2nd occurrence only)', s15.success && s15.output === 'aX-1\nab-2\n', JSON.stringify(s15.output));
    const s15b = await exec('bash', "sed 's/a/X/' dup.txt", ws);
    check('S15b without g only the first occurrence per line changes',
      s15b.success && s15b.output === 'Xa-1\nXb-2\n', JSON.stringify(s15b.output));
    const s16 = await exec('bash', "sed 's/ONE/one/I' nums.txt", ws);
    check('S16 I flag (case-insensitive)', s16.success && s16.output === 'one\n two\nthree\nfour\nfive\n', JSON.stringify(s16.output));
    const s17 = await exec('bash', "sed 's/[[:digit:]]/#/' pairs.txt", ws);
    check('S17 POSIX class [[:digit:]]', s17.success && s17.output === 'a-#\nb-#\nc-#\n', JSON.stringify(s17.output));
    const s18 = await exec('bash', "cat nums.txt | sed 's/o/0/'", ws);
    check('S18 sed reads pipeline stdin', s18.success && s18.output.startsWith('0ne'), s18.output);
    const s19 = await exec('bash', "sed -i 's/x/y/'", ws);
    check('S19 -i without a file operand fails', !s19.success && s19.output.includes('-i requires a file operand'), s19.output);
    const s20 = await exec('bash', 'sed', ws);
    check('S20 no script fails with usage', !s20.success && s20.output.includes('usage: sed'), s20.output);
    const s21 = await exec('bash', "sed 's/(x)/(y)/' pairs.txt", ws);
    check('S21 unescaped ( in a BRE is a literal ( (no match, lines unchanged)',
      s21.success && s21.output === 'a-1\nb-2\nc-3\n', s21.output);
    const s22 = await exec('bash', "sed 's/[[:alpha:]]/A/g' pairs.txt", ws);
    check('S22 [[:alpha:]] global', s22.success && s22.output === 'A-1\nA-2\nA-3\n', JSON.stringify(s22.output));

    // -i in-place editing (own fixture: the mutation must not leak into the
    // stream tests above).
    const wsI = sedFixture();
    const s8 = await exec('bash', "sed -i 's/one/ONE/' nums.txt", wsI);
    check('S8 -i writes in place', s8.success && dec(wsI.files['nums.txt']) === 'ONE\n two\nthree\nfour\nfive\n', s8.output);
    const s8b = await exec('bash', "sed -i 's/nothing/else/' nums.txt", wsI);
    check('S8b -i with no change leaves the file byte-identical',
      s8b.success && dec(wsI.files['nums.txt']) === 'ONE\n two\nthree\nfour\nfive\n', s8b.output);
    const ro = sedFixture();
    const roVfs = wrapVfs(ro);
    const s9 = await exec('bash', "sed -i 's/one/ONE/' /mnt/ro/nums.txt", roVfs);
    check('S9 -i on a read-only mount is refused before any write',
      !s9.success && s9.output.includes('cannot write in place') && dec(ro.files['nums.txt']).startsWith('one'),
      s9.output);
  }

  // ---------- A. unknown-command alternatives ----------
  {
    const ws = sedFixture();
    const a1 = await exec('bash', "awk '{print $1}' nums.txt", ws);
    check('A1 awk → python alternative', !a1.success && a1.output.includes('awk') && a1.output.includes('use python') && a1.output.includes('help'), a1.output);
    const a2 = await exec('bash', 'pip install requests', ws);
    check('A2 pip → capability-plugin-wheels alternative', !a2.success && a2.output.includes('capability-plugin wheels'), a2.output);
    const a3 = await exec('bash', 'unzip x.zip', ws);
    check('A3 unzip → python zipfile alternative', !a3.success && a3.output.includes('zipfile'), a3.output);
    const a4 = await exec('bash', 'fakexe --flag', ws);
    check('A4 unknown command without a hint keeps the plain message',
      !a4.success && a4.output.includes('fakexe: command not available in local browser runtime') && a4.output.includes('help'), a4.output);
  }

  // ---------- TB. python traceback denoising (unit level) ----------
  {
    const raw = [
      'Traceback (most recent call last):',
      '  File "/lib/python312.zip/_pyodide/_base.py", line 573, in eval_code_async',
      '    await CodeRunner(',
      '  File "/lib/python312.zip/_pyodide/_base.py", line 355, in run_async',
      '    coroutine = eval_code(code, globals, locals)',
      '  File "<exec>", line 2, in <module>',
      'ZeroDivisionError: division by zero',
    ].join('\n');
    const d1 = M.denoisePyodideTraceback(raw);
    check('TB1 internal frames collapse into the marker; user frame + exception kept',
      d1 === [
        '[Locus: 2 internal Pyodide frames hidden]',
        '  File "<exec>", line 2, in <module>',
        'ZeroDivisionError: division by zero',
      ].join('\n'), JSON.stringify(d1));
    const d2 = M.denoisePyodideTraceback('Traceback (most recent call last):\n  File "<exec>", line 1, in <module>\nValueError: x');
    check('TB2 no internal frames → byte-identical (header kept)',
      d2 === 'Traceback (most recent call last):\n  File "<exec>", line 1, in <module>\nValueError: x', JSON.stringify(d2));
    const d3 = M.denoisePyodideTraceback([
      'Traceback (most recent call last):',
      '  File "/lib/python312.zip/_pyodide/_base.py", line 10, in eval_code_async',
      '    await CodeRunner(',
      'RuntimeError: boom',
    ].join('\n'));
    check('TB3 all-internal traceback → marker + exception line only',
      d3 === '[Locus: 1 internal Pyodide frames hidden]\nRuntimeError: boom', JSON.stringify(d3));
    const d4 = M.denoisePyodideTraceback([
      'Traceback (most recent call last):',
      '  File "/lib/python312.zip/_pyodide/_base.py", line 10, in eval_code_async',
      '    await CodeRunner(',
      '  File "<exec>", line 1',
      '    x =',
      '       ^',
      'SyntaxError: invalid syntax',
    ].join('\n'));
    check('TB4 SyntaxError caret lines survive with the user frame',
      d4.startsWith('[Locus: 1 internal Pyodide frames hidden]\n')
      && d4.includes('  File "<exec>", line 1\n    x =\n       ^\nSyntaxError: invalid syntax'), JSON.stringify(d4));
    const d5 = M.denoisePyodideTraceback('plain error text, no traceback');
    check('TB5 non-traceback text passes through untouched', d5 === 'plain error text, no traceback', d5);
    // End-to-end through runPythonCode with a worker-shaped result.
    mockWorkerResult({
      stdout: '', stderr: '', error: raw,
      files: [], deleted: [], createdDirs: [], deletedDirs: [], uncollectedFiles: [],
      stdoutTruncated: false, stderrTruncated: false, inputBytes: 0, outputBytes: 0,
    });
    const tb6 = await exec('bash', "python -c 'x = 1/0'", new TreeWS({}), withPyrt());
    check('TB6 runPythonCode output starts with the marker and hides _pyodide frames',
      !tb6.success && tb6.output.startsWith('[Locus: 2 internal Pyodide frames hidden]')
      && tb6.output.includes('ZeroDivisionError') && !tb6.output.includes('_pyodide'), JSON.stringify(tb6.output));
  }

  console.log('---');
  console.log(passed + ' passed, ' + failed + ' failed');
  if (failed) process.exitCode = 1;
}

run().catch((e) => { console.error(e && e.stack || e); process.exitCode = 1; });
