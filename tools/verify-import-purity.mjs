// M3a gate helper: import the whole source graph in plain Node with a
// pristine global object — no window, no document, no globals. Import must
// not throw, must not define any globalThis symbol, and must not touch DOM.
const before = new Set(Object.getOwnPropertyNames(globalThis));
const mod = await import('../src/index.js');
const after = Object.getOwnPropertyNames(globalThis).filter((k) => !before.has(k));

const need = ['createRuntime', 'createWorkspace', 'createMemoryWorkspace', 'shellCommandNames'];
const missing = need.filter((k) => typeof mod[k] !== 'function');
if (missing.length) { console.error('MISSING exports: ' + missing.join(', ')); process.exit(1); }
if (after.length) { console.error('IMPORT-TIME GLOBAL LEAK: ' + after.join(', ')); process.exit(1); }
if (globalThis.__LOCUS_RUNTIME_CORE__ !== undefined) { console.error('__LOCUS_RUNTIME_CORE__ present'); process.exit(1); }
console.log('import purity OK — exports: ' + need.join(', ') + '; zero global leaks; shellCommandNames: ' + mod.shellCommandNames().length);
