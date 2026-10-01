// VFS unit tests (node): path normalization, mount routing, structural
// skeleton, MemoryWorkspace / UploadWorkspace / SystemBinWorkspace
// providers, authorities, quotas, protected roots.
// Run: node tests/vfs.test.cjs

global.window = { location: { protocol: 'https:' } };

const M = require('./helpers/core.cjs');

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + detail : '')); }
}

async function throwsWith(name, fn, errName, msgPart) {
  try {
    await fn();
    check(name, false, 'expected throw');
  } catch (e) {
    const ok = (!errName || e.name === errName) && (!msgPart || String(e.message).includes(msgPart));
    check(name, ok, e.name + ': ' + e.message);
  }
}

const names = (entries) => entries.map((e) => e.name).join(' ');

async function run() {
  // ---------- V1-V4. root topology / structural skeleton ----------
  const vfs = new M.VirtualWorkspace();
  check('V1 vfs flagged as Locus VFS', vfs.isLocusVFS === true);

  const root = await vfs.list('/');
  check('V2 / lists bin home mnt tmp usr', names(root) === 'bin home mnt tmp usr', names(root));
  check('V2b / entries are all directories', root.every((e) => e.kind === 'directory'));

  const usr = await vfs.list('/usr');
  check('V3 /usr lists bin lib local', names(usr) === 'bin lib local', names(usr));

  const mnt = await vfs.list('/mnt');
  check('V4 /mnt without workspace lists download plugins upload', names(mnt) === 'download plugins upload', names(mnt));

  await throwsWith('V5 /mnt/workspace list → NotMountedError', () => vfs.list('/mnt/workspace'), 'NotMountedError', '/mnt/workspace: not mounted');
  await throwsWith('V6 /mnt/workspace stat → NotMountedError', () => vfs.stat('/mnt/workspace'), 'NotMountedError');
  await throwsWith('V7 /mnt/workspace read → NotMountedError', () => vfs.read('/mnt/workspace/a.txt'), 'NotMountedError');
  check('V8 exists under unmounted /mnt/workspace → false', (await vfs.exists('/mnt/workspace/a.txt')) === false);
  check('V8b exists under unmounted /mnt/workspace root → false', (await vfs.exists('/mnt/workspace')) === false);

  // ---------- V9-V12. structural stat / write rejection ----------
  const rootStat = await vfs.stat('/');
  check('V9 stat(/) is directory size 0', rootStat.kind === 'directory' && rootStat.size === 0 && rootStat.modified === null);
  const mntStat = await vfs.stat('/mnt');
  check('V10 stat(/mnt) is directory size 0', mntStat.kind === 'directory' && mntStat.size === 0 && mntStat.modified === null);

  await throwsWith('V11 write /foo.txt rejected read-only', () => vfs.write('/foo.txt', 'x'), 'ReadOnlyError', 'read-only filesystem: /foo.txt');
  await throwsWith('V12 write /etc/x rejected read-only', () => vfs.write('/etc/x', 'x'), 'ReadOnlyError', 'read-only filesystem');
  await throwsWith('V12b mkdir /usr/lib/locus/x rejected (structural)', () => vfs.mkdir('/usr/lib/locus/x'), 'ReadOnlyError');
  await throwsWith('V12c read / is TypeMismatchError', () => vfs.read('/'), 'TypeMismatchError');

  // ---------- V13-V16. mount resolution: longest prefix, segment boundary ----------
  const r1 = vfs.resolveMount('/mnt/upload/a.csv');
  check('V13 /mnt/upload/a.csv → upload mount, rel a.csv',
    r1 && r1.path === '/mnt/upload' && r1.rel === 'a.csv' && r1.authority === 'read-only', JSON.stringify(r1 && { path: r1.path, rel: r1.rel }));
  const r2 = vfs.resolveMount('/mnt/upload');
  check('V14 mount root itself → rel ""', r2 && r2.path === '/mnt/upload' && r2.rel === '');
  const r3 = vfs.resolveMount('/mnt/uploaded/x');
  check('V15 /mnt/uploaded is NOT under /mnt/upload (segment boundary)', r3 === null, JSON.stringify(r3));
  const r4 = vfs.resolveMount('/usr/bin/ls');
  check('V16 longest prefix: /usr/bin/ls → /usr/bin mount rel ls', r4 && r4.path === '/usr/bin' && r4.rel === 'ls'
    && r4.authority === 'system-read-only');
  check('V16b structural path resolves to null', vfs.resolveMount('/usr/lib') === null
    && vfs.resolveMount('/mnt/workspace/x') === null);

  // ---------- V17-V20. normalization ----------
  check('V17 /mnt/workspace/a/../b normalizes', M.normalizeVfsPath('/mnt/workspace/a/../b') === '/mnt/workspace/b');
  await throwsWith('V18 /../../foo escapes root', () => M.normalizeVfsPath('/../../foo'), 'Error', 'path escapes filesystem root');
  await throwsWith('V19 backslash/drive path rejected', () => M.normalizeVfsPath('C:\\x'), 'Error', 'invalid path');
  await throwsWith('V19b bare drive letter rejected', () => M.normalizeVfsPath('C:/x'), 'Error', 'invalid path');
  check('V20 relative path resolves against cwd', M.normalizeVfsPath('a/b', '/home/locus') === '/home/locus/a/b'
    && M.normalizeVfsPath('./a//b/', '/tmp/') === '/tmp/a/b'
    && M.normalizeVfsPath('', '/home/locus') === '/home/locus'
    && M.normalizeVfsPath('..', '/home/locus') === '/home');

  // ---------- V21-V27. MemoryWorkspace CRUD + quota ----------
  const mem = new M.MemoryWorkspace({ name: 'mem' });
  await mem.mkdir('a/b/c');
  await mem.write('a/b/c/hello.txt', 'héllo'); // multibyte: byte-exact check
  const memBytes = await mem.readBytes('a/b/c/hello.txt');
  check('V21 nested mkdir + write + byte-exact read',
    new TextDecoder().decode(memBytes) === 'héllo'
    && memBytes.byteLength === new TextEncoder().encode('héllo').byteLength);
  check('V22 read returns utf-8 string', (await mem.read('a/b/c/hello.txt')) === 'héllo');
  const memStat = await mem.stat('a/b/c/hello.txt');
  check('V23 stat file vs dir', memStat.kind === 'file' && memStat.size === memBytes.byteLength
    && (await mem.stat('a/b')).kind === 'directory' && (await mem.stat('')).kind === 'directory');
  check('V24 list nested', names(await mem.list('a/b')) === 'c' && names(await mem.list('a')) === 'b');
  await throwsWith('V25 remove non-empty dir fails', () => mem.remove('a'), 'Error', 'directory not empty: a');
  await mem.remove('a/b/c/hello.txt');
  check('V26 remove file then empty dirs', !(await mem.exists('a/b/c/hello.txt')) && (await mem.exists('a/b/c')));
  await mem.remove('a/b/c');
  await mem.remove('a/b');
  await mem.remove('a');
  check('V26b empty dirs removable, root list empty', (await mem.list('')).length === 0);
  await throwsWith('V27 stat missing → NotFoundError', () => mem.stat('nope.txt'), 'NotFoundError', 'no such file or directory');

  const memQ = new M.MemoryWorkspace({ maxFileBytes: 4, maxBytes: 10 });
  await throwsWith('V27b maxFileBytes fails loudly', () => memQ.write('big.bin', '12345'), 'QuotaExceededError', 'maxFileBytes');
  await memQ.write('a', '1234');
  await memQ.write('b', '1234'); // total 8 of 10: allowed
  await throwsWith('V27c maxBytes fails loudly, no truncation', () => memQ.write('c', '123'), 'QuotaExceededError', 'maxBytes');
  check('V27d failed writes leave no trace', !(await memQ.exists('big.bin')) && !(await memQ.exists('c')));

  // ---------- V28-V31. UploadWorkspace ----------
  const up = new M.UploadWorkspace();
  const f1 = new File(['col1,col2'], 'report.csv', { type: 'text/csv', lastModified: 0 });
  const n1 = up.addFile(f1);
  const n2 = up.addFile(new File(['x'], 'report.csv'));
  const n3 = up.addFile(new File(['y'], 'report.csv'));
  check('V28 deterministic collision naming', n1 === 'report.csv' && n2 === 'report (2).csv' && n3 === 'report (3).csv',
    [n1, n2, n3].join(', '));
  check('V29 lazy read of real File bytes', (await up.read('report.csv')) === 'col1,col2'
    && new TextDecoder().decode(await up.readBytes('report (2).csv')) === 'x');
  const upStat = await up.stat('report.csv');
  check('V30 stat file', upStat.kind === 'file' && upStat.size === 9 && upStat.modified === null
    && names(await up.list('')) === 'report (2).csv report (3).csv report.csv');
  await throwsWith('V31 write is ReadOnlyError', () => up.write('report.csv', 'z'), 'ReadOnlyError', 'read-only filesystem');
  await throwsWith('V31b remove is ReadOnlyError', () => up.remove('report.csv'), 'ReadOnlyError');
  await throwsWith('V31c mkdir is ReadOnlyError', () => up.mkdir('sub'), 'ReadOnlyError');
  check('V31d read-only failures changed nothing', names(await up.list('')) === 'report (2).csv report (3).csv report.csv');
  up.removeFile('report (2).csv');
  check('V31e explicit user removeFile works', !(await up.exists('report (2).csv')) && (await up.exists('report.csv')));
  await throwsWith('V31f removeFile missing → NotFoundError', () => up.removeFile('ghost'), 'NotFoundError');

  const upQ = new M.UploadWorkspace({ maxFileBytes: 3, maxTotalBytes: 5 });
  await throwsWith('V31g upload maxFileBytes quota', () => upQ.addFile(new File(['1234'], 'a.txt')), 'QuotaExceededError', 'maxFileBytes');
  upQ.addFile(new File(['123'], 'b.txt'));
  await throwsWith('V31h upload maxTotalBytes quota', () => upQ.addFile(new File(['123'], 'c.txt')), 'QuotaExceededError', 'maxTotalBytes');
  check('V31i quota-skipped files absent', !(await upQ.exists('a.txt')) && !(await upQ.exists('c.txt')) && (await upQ.exists('b.txt')));

  // ---------- V32-V34. SystemBinWorkspace reflects injected list ----------
  let cmds = ['ls', 'cat'];
  const bin = new M.SystemBinWorkspace(() => cmds);
  check('V32 list reflects injected command list (sorted)', names(await bin.list('')) === 'cat ls');
  const binStat = await bin.stat('ls');
  check('V33 stat command → virtual file', binStat.kind === 'file' && binStat.size === 0 && binStat.modified === null
    && (await bin.read('ls')) === '' && (await bin.readBytes('ls')).byteLength === 0);
  await throwsWith('V33b stat unknown command → NotFoundError', () => bin.stat('nope'), 'NotFoundError');
  await throwsWith('V33c mutation → ReadOnlyError', () => bin.write('x', 'y'), 'ReadOnlyError');
  cmds.push('grep');
  check('V34 added command appears (no hardcoded list)', (await bin.exists('grep')) && names(await bin.list('')) === 'cat grep ls');
  const bareBin = new M.SystemBinWorkspace();
  check('V34b omitted listCommands tolerated (empty view)', (await bareBin.list('')).length === 0);

  // ---------- V35-V38. VirtualWorkspace integration ----------
  let shellCmds = ['ls', 'grep'];
  // M2a: the home skeleton is an explicit constructor argument — this
  // suite pins the PRODUCT-shaped skeleton the same way the product passes
  // LOCUS_HOME_SKELETON; V36c pins the neutral generic default.
  const vfs2 = new M.VirtualWorkspace({ listCommands: () => shellCmds, homeSkeleton: ['.skills', '.config/locus/mcp', '.cache/locus'] });
  check('V35 /usr/bin reflects injected commands', names(await vfs2.list('/usr/bin')) === 'grep ls');
  shellCmds.push('wc');
  check('V35b /bin aliases the same provider', names(await vfs2.list('/bin')) === 'grep ls wc');
  await throwsWith('V35c write to /usr/bin/ls → ReadOnlyError', () => vfs2.write('/usr/bin/ls', 'x'), 'ReadOnlyError', 'read-only filesystem: /usr/bin/ls');

  check('V36 home pre-initialized skeleton', names(await vfs2.list('/home/locus')) === '.cache .config .skills',
    names(await vfs2.list('/home/locus')));
  check('V36b deep skeleton dirs exist', (await vfs2.exists('/home/locus/.config/locus/mcp'))
    && (await vfs2.exists('/home/locus/.cache/locus')) && (await vfs2.exists('/usr/local/share/locus/skills')));

  // ---------- C02. replacing the current home provider ----------
  const homeBeforeClear = vfs2.resolveMount('/home/locus').provider;
  const tmpBeforeClear = vfs2.resolveMount('/tmp').provider;
  await vfs2.write('/home/locus/clear-survivor.txt', 'old');
  vfs2.resetHome();
  check('C02-1 memory home Clear removes files', await vfs2.exists('/home/locus/clear-survivor.txt') === false);
  check('C02-2 memory home Clear rebuilds skeleton',
    await vfs2.exists('/home/locus/.skills')
    && await vfs2.exists('/home/locus/.config/locus/mcp')
    && await vfs2.exists('/home/locus/.cache/locus'));
  await vfs2.write('/home/locus/reset-survivor.txt', 'old');
  vfs2.resetHome();
  check('C02-3 memory home Reset removes files', await vfs2.exists('/home/locus/reset-survivor.txt') === false);
  check('C02-4 memory home Reset rebuilds skeleton',
    await vfs2.exists('/home/locus/.skills')
    && await vfs2.exists('/home/locus/.config/locus/mcp')
    && await vfs2.exists('/home/locus/.cache/locus'));
  check('C02-5 resetHome replaces only the home provider',
    vfs2.resolveMount('/home/locus').provider !== homeBeforeClear
    && vfs2.resolveMount('/tmp').provider === tmpBeforeClear);

  // protected roots: exact set
  const prot = ['/', '/usr', '/home', '/home/locus', '/mnt', '/mnt/workspace', '/mnt/upload', '/mnt/download', '/mnt/plugins'];
  check('V37 protected roots exact set', prot.every((p) => vfs2.isProtectedRoot(p))
    && !vfs2.isProtectedRoot('/bin') && !vfs2.isProtectedRoot('/usr/bin') && !vfs2.isProtectedRoot('/tmp')
    && !vfs2.isProtectedRoot('/etc') && !vfs2.isProtectedRoot('/mnt/workspace/x') && !vfs2.isProtectedRoot('/mnt/upload/a'));

  // cross-mount copy via vfs read/write
  const ext = new M.MemoryWorkspace({ name: 'proj' });
  await ext.write('src/a.js', 'export {}\n');
  vfs2.mount('/mnt/workspace', ext, 'external-read-write');
  const upProvider = vfs2.resolveMount('/mnt/upload').provider;
  upProvider.addFile(new File(['input-data'], 'input.csv'));
  await vfs2.write('/mnt/download/result.csv', await vfs2.read('/mnt/upload/input.csv'));
  await vfs2.write('/tmp/copy.js', await vfs2.readBytes('/mnt/workspace/src/a.js'));
  check('V38 cross-mount copy upload→download, workspace→tmp',
    (await vfs2.read('/mnt/download/result.csv')) === 'input-data'
    && (await vfs2.read('/tmp/copy.js')) === 'export {}\n');
  check('V38b mounted workspace lists through vfs', names(await vfs2.list('/mnt/workspace')) === 'src');
  check('V38c /mnt now includes workspace', names(await vfs2.list('/mnt')) === 'download plugins upload workspace');

  // authorityOf / assertWritable
  check('V39 authorityOf routing', vfs2.authorityOf('/mnt/upload/f') === 'read-only'
    && vfs2.authorityOf('/tmp/x') === 'read-write'
    && vfs2.authorityOf('/mnt/workspace/x') === 'external-read-write'
    && vfs2.authorityOf('/usr/bin/ls') === 'system-read-only'
    && vfs2.authorityOf('/usr/lib') === 'none');
  check('V39b authorityOf unmounted workspace → not-mounted', vfs.authorityOf('/mnt/workspace/x') === 'not-mounted');
  vfs2.assertWritable('/tmp/ok.txt'); // must not throw
  vfs2.assertWritable('/mnt/workspace/src/a.js');
  await throwsWith('V40 assertWritable upload → ReadOnlyError', () => vfs2.assertWritable('/mnt/upload/input.csv'), 'ReadOnlyError');
  await throwsWith('V40b assertWritable structural → structural error', () => vfs2.assertWritable('/foo.txt'), 'Error', 'structural path');
  await throwsWith('V40c assertWritable unmounted workspace → NotMountedError', () => vfs.assertWritable('/mnt/workspace/a'), 'NotMountedError');

  // defaultCwd / workspaceName / getEnv / dataMounts
  check('V41 defaultCwd both states', vfs.defaultCwd() === '/home/locus' && vfs2.defaultCwd() === '/mnt/workspace');
  vfs2.unmount('/mnt/workspace');
  check('V41b defaultCwd back to home after unmount', vfs2.defaultCwd() === '/home/locus' && vfs2.workspaceName === null);
  vfs2.mount('/mnt/workspace', ext, 'external-read-write');
  check('V42 workspaceName from provider', vfs2.workspaceName === 'proj');
  const env = vfs2.getEnv();
  check('V43 getEnv', env.HOME === '/home/locus' && env.PATH === '/usr/local/bin:/usr/bin:/bin' && env.TMPDIR === '/tmp');
  const dmBare = vfs.dataMounts().map((d) => d.root).join(' ');
  const dmMounted = vfs2.dataMounts().map((d) => d.root).join(' ');
  check('V44 dataMounts set (workspace only when mounted)',
    dmBare === '/mnt/upload /mnt/download /home/locus /tmp'
    && dmMounted === '/mnt/workspace /mnt/upload /mnt/download /home/locus /tmp', dmBare + ' | ' + dmMounted);

  await throwsWith('V45 unmount of absent path → NotMountedError', () => vfs.unmount('/mnt/workspace'), 'NotMountedError', 'not mounted');
  await throwsWith('V45b invalid authority rejected', () => vfs.mount('/mnt/x', ext, 'bogus'), 'Error', 'invalid mount authority');
  check('V45c invalid mount left no trace', vfs.resolveMount('/mnt/x') === null);

  console.log('---');
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.error('HARNESS ERROR', e); process.exit(1); });
