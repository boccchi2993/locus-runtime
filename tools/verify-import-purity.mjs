// M3a gate helper: import the whole source graph in plain Node with a
// pristine global object — no window, no document, no globals. Import must
// not throw, must not define any globalThis symbol, and must not touch DOM.
const before = new Set(Object.getOwnPropertyNames(globalThis));
const mod = await import('../src/index.js');
const after = Object.getOwnPropertyNames(globalThis).filter((k) => !before.has(k));

const need = ['createRuntime', 'createWorkspace', 'createMemoryWorkspace', 'shellCommandNames'];
const missing = need.filter((k) => typeof mod[k] !== 'function');
if (missing.length) { console.error('MISSING exports: ' + missing.join(', ')); process.exit(1); }
// The provider subpath entry (M3a review F1) must import as purely as
// the root entry and expose the provider surface.
const wsApi = await import('../src/workspace-api.js');
const wsNeed = ['WorkspaceAdapter', 'LocalDirectoryWorkspace', 'OPFSWorkspace', 'normalizeWorkspacePath', 'ensureWorkspacePermission', 'vfsError'];
const wsMissing = wsNeed.filter((k) => typeof wsApi[k] !== 'function');
if (wsMissing.length) { console.error('MISSING workspace subpath exports: ' + wsMissing.join(', ')); process.exit(1); }
const afterSubpath = Object.getOwnPropertyNames(globalThis).filter((k) => !before.has(k));
if (afterSubpath.length) { console.error('SUBPATH IMPORT-TIME GLOBAL LEAK: ' + afterSubpath.join(', ')); process.exit(1); }
if (after.length) { console.error('IMPORT-TIME GLOBAL LEAK: ' + after.join(', ')); process.exit(1); }
if (globalThis.__LOCUS_RUNTIME_CORE__ !== undefined) { console.error('__LOCUS_RUNTIME_CORE__ present'); process.exit(1); }
console.log('import purity OK — exports: ' + need.join(', ') + '; workspace subpath: ' + wsNeed.join(', ') + '; zero global leaks; shellCommandNames: ' + mod.shellCommandNames().length);
