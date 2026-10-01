// Runtime IMPORT-PURITY gates (M3a — successor of the M2a
// runtime-self-assembly suite).
//
// The M2a entry had TWO assembly modes (classic __LOCUS_RUNTIME_CORE__
// registry delegation vs dynamic-import self-assembly over classic
// sources). M3a deleted both: the implementation modules are real ES
// modules and the entry imports them directly. The self-assembly proof
// therefore becomes an IMPORT-PURITY proof:
//
//  SA1  a cold import in a pristine process (no window, no document, no
//       page files, no classic globals) works and exposes the public API;
//  SA2  importing performs ZERO side effects: no globalThis symbol
//       appears, no DOM query fires (the document stub throws), no
//       __LOCUS_RUNTIME_CORE__ exists even after full assembly;
//  SA3  the VFS helpers make a host self-sufficient immediately — no
//       createRuntime()-first resolution order anymore (the M2a entry
//       required the core resolved through it; a direct-import package
//       has nothing to resolve);
//  SA4  a host builds a filesystem through the entry exports and runs
//       shell work through a session with zero classic scripts.
// Run: node tests/runtime-import-purity.test.mjs

let passed = 0, failed = 0;
function check(name, cond, detail) {
  const line = (cond ? 'PASS ' : 'FAIL ') + name + (detail !== undefined ? ' | ' + String(detail).slice(0, 300) : '');
  console.log(line);
  if (cond) passed++; else failed++;
}
const errText = (e) => String(e && e.message ? e.message : e);
process.on('unhandledRejection', (e) => { console.error('UNHANDLED:', e && e.stack || e); process.exit(3); });

// ---------- SA1: cold import — no core, no window, no document, no page ----------
// Nothing in this process defines window/document or any classic global:
// a hidden page dependency would throw right here. A document stub that
// THROWS turns "no DOM access" into an observable property.
let domTouched = 0;
globalThis.document = { get getElementById() { domTouched++; throw new Error('import-time DOM access'); } };
if (typeof globalThis.window !== 'undefined') { console.error('SA1 precondition violated: window exists'); process.exit(3); }

const beforeGlobals = new Set(Object.getOwnPropertyNames(globalThis));
let entry = null;
try { entry = await import('../src/index.js'); } catch (e) { console.error('cold import threw:', e); }
check('SA1 the entry cold-imports with no page, no classic globals, no DOM',
  !!entry && typeof entry.createRuntime === 'function'
  && typeof entry.createWorkspace === 'function'
  && typeof entry.createMemoryWorkspace === 'function'
  && typeof entry.shellCommandNames === 'function',
  errText(entry ? '' : 'entry missing'));

let assets = null;
try { assets = await import('../src/worker-assets.js'); } catch (e) { console.error(e); }
check('SA1b the worker-asset module cold-imports',
  !!assets && typeof assets.PY_WORKER_SOURCE === 'string' && assets.PY_WORKER_SOURCE.length > 1000
  && typeof assets.GREP_WORKER_SOURCE === 'string' && assets.GREP_WORKER_SOURCE.length > 100,
  'assets present: ' + !!assets);

// ---------- SA2: zero import-time side effects ----------
const newGlobals = Object.getOwnPropertyNames(globalThis).filter((k) => !beforeGlobals.has(k) && k !== 'document');
check('SA2 the import defined ZERO globalThis symbols (no global injection)',
  newGlobals.length === 0, JSON.stringify(newGlobals));
check('SA2b the import performed ZERO DOM queries',
  domTouched === 0, String(domTouched));

// ---------- SA3: self-sufficient host exports ----------
check('SA3 shellCommandNames exposes the registry immediately (no createRuntime-first order)',
  entry.shellCommandNames().length > 0 && entry.shellCommandNames().includes('echo'),
  JSON.stringify(entry.shellCommandNames().length));
check('SA3b createMemoryWorkspace builds immediately',
  (() => {
    try {
      const mem = entry.createMemoryWorkspace({ name: 'purity' });
      return mem && typeof mem.write === 'function';
    } catch (e) { return false; }
  })(), '');

// ---------- SA4: a host assembles a session and runs shell work ----------
{
  const host = await entry.createRuntime({
    workerAssets: { pyWorkerSource: assets.PY_WORKER_SOURCE, grepWorkerSource: assets.GREP_WORKER_SOURCE },
  });
  check('SA4 a host assembles from the cold-imported entry', typeof host.createSession === 'function', '');
  check('SA4b no __LOCUS_RUNTIME_CORE__ exists after full assembly',
    globalThis.__LOCUS_RUNTIME_CORE__ === undefined, '');
  const session = host.createSession();
  const vfs = entry.createWorkspace(); // the entry's own VFS export, default command surface
  vfs.mount('/mnt/workspace', entry.createMemoryWorkspace({ name: 'workspace' }), 'read-write');
  const res = await session.execute({ kind: 'shell', input: 'echo pure > /mnt/workspace/x.txt && cat /mnt/workspace/x.txt', context: { filesystem: vfs } });
  check('SA4c the self-assembled host executes VFS shell work',
    res.ok === true && res.output === 'pure\n', JSON.stringify({ ok: res.ok, output: res.output }));
  check('SA4d still zero DOM queries after execution (python never started)',
    domTouched === 0 && session.status().interpreter === 'cold',
    JSON.stringify({ dom: domTouched, status: session.status() }));
}

// ---------- SA5: the workspace provider subpath export ----------
// The "locus-runtime/workspace" subpath is the PUBLIC provider surface
// (M3a review F1): provider classes, the shared path normalization, the
// permission helper and the error factory. It must re-export the ONE
// implementation (identity, not a copy) and import as purely as the root.
{
  const wsImpl = await import('../src/workspace.js');
  const vfsImpl = await import('../src/vfs.js');
  let wsApi = null;
  try { wsApi = await import('../src/workspace-api.js'); } catch (e) { console.error('subpath import threw:', e); }
  check('SA5 the workspace subpath exposes the provider surface',
    !!wsApi
    && typeof wsApi.WorkspaceAdapter === 'function'
    && typeof wsApi.LocalDirectoryWorkspace === 'function'
    && typeof wsApi.OPFSWorkspace === 'function'
    && typeof wsApi.normalizeWorkspacePath === 'function'
    && typeof wsApi.ensureWorkspacePermission === 'function'
    && typeof wsApi.vfsError === 'function',
    errText(wsApi ? '' : 'subpath import threw'));
  check('SA5b the subpath re-exports the SAME implementation objects (no copy)',
    !!wsApi
    && wsApi.WorkspaceAdapter === wsImpl.WorkspaceAdapter
    && wsApi.LocalDirectoryWorkspace === wsImpl.LocalDirectoryWorkspace
    && wsApi.OPFSWorkspace === wsImpl.OPFSWorkspace
    && wsApi.normalizeWorkspacePath === wsImpl.normalizeWorkspacePath
    && wsApi.ensureWorkspacePermission === wsImpl.ensureWorkspacePermission
    && wsApi.vfsError === vfsImpl.vfsError,
    'identity mismatch against src/workspace.js / src/vfs.js');
  const globalsAfterSubpath = Object.getOwnPropertyNames(globalThis)
    .filter((k) => !beforeGlobals.has(k) && k !== 'document');
  check('SA5c the subpath import stays pure (zero globals, zero DOM)',
    globalsAfterSubpath.length === 0 && domTouched === 0,
    JSON.stringify({ globals: globalsAfterSubpath, dom: domTouched }));
  check('SA5d the subpath surfaces the shared escape rules immediately',
    !!wsApi
    && (() => {
      try { wsApi.normalizeWorkspacePath('../escape'); return false; } catch (e) { return /path escapes workspace/.test(e.message); }
    })()
    && (() => {
      try { wsApi.normalizeWorkspacePath('C:/win'); return false; } catch (e) { return /invalid path/.test(e.message); }
    })(), '');
}

delete globalThis.document;
console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
