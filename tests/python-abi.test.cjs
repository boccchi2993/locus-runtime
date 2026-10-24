// Python runtime identity export tests (docs D13). The identity constants
// (PYODIDE_VERSION / PYTHON_ABI / PYTHON_RUNTIME_PACKAGES) and the wheel
// compatibility helpers must be DERIVED from the pinned bootstrap — never
// retyped — so these gates read the shell.js SOURCE text as well as the
// module exports:
//
//   AB1   values: the three constants equal the preloaded identity, are
//         frozen, and the public entry re-exports the SAME bindings
//   AB2   single source of truth: the version literal appears in exactly
//         one code line (the PYODIDE_BASE definition) and PYODIDE_VERSION
//         parses out of it; the ABI tags exist only in manifest wheel
//         names and the normalized package names are nowhere hardcoded
//   AB3   wheelPlatformCompatible: PEP 427 tags against the preloaded ABI
//         (native / pure / incompatible with the required ABI in the
//         reason / invalid filenames)
//   AB4   normalizeDistName: PEP 503 normalization
//
// Run: node tests/python-abi.test.cjs

const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + String(detail).slice(0, 300) : '')); }
}

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'shell.js'), 'utf8');
const shell = require('../src/shell.js');
const entry = require('../src/index.js');

// ================= AB1: values + frozen + re-exported =================

check('AB1 PYODIDE_VERSION is the pinned Pyodide version string',
  shell.PYODIDE_VERSION === '0.26.4' && Object.isFrozen(shell.PYODIDE_VERSION),
  String(shell.PYODIDE_VERSION));

check('AB1 PYTHON_ABI is exactly the preloaded interpreter identity, frozen',
  JSON.stringify(shell.PYTHON_ABI) === JSON.stringify({ python: 'cp312', platform: 'pyodide_2024_0_wasm32' })
  && Object.isFrozen(shell.PYTHON_ABI)
  && Object.keys(shell.PYTHON_ABI).length === 2,
  JSON.stringify(shell.PYTHON_ABI));

check('AB1 PYTHON_RUNTIME_PACKAGES is the frozen, sorted, normalized preloaded set',
  JSON.stringify(shell.PYTHON_RUNTIME_PACKAGES)
    === JSON.stringify(['micropip', 'numpy', 'packaging', 'pandas', 'python-dateutil', 'pytz', 'six'])
  && Object.isFrozen(shell.PYTHON_RUNTIME_PACKAGES),
  JSON.stringify(shell.PYTHON_RUNTIME_PACKAGES));

check('AB1 the public entry re-exports the SAME identity bindings (not copies)',
  entry.PYODIDE_VERSION === shell.PYODIDE_VERSION
  && entry.PYTHON_ABI === shell.PYTHON_ABI
  && entry.PYTHON_RUNTIME_PACKAGES === shell.PYTHON_RUNTIME_PACKAGES
  && entry.wheelPlatformCompatible === shell.wheelPlatformCompatible
  && entry.normalizeDistName === shell.normalizeDistName,
  '');

// The identity constants are DERIVED from the manifest, so their values
// must not exist as standalone literals in the source: every line carrying
// a native ABI tag must be a manifest wheel-name line, and no normalized
// package name may appear as a quoted literal.
check('AB1 derivation proof: cp312/pyodide_2024_0_wasm32 exist only in manifest wheel names',
  SRC.split('\n').every((l) => !/cp312|pyodide_2024_0_wasm32/.test(l) || l.includes('.whl')),
  JSON.stringify(SRC.split('\n').filter((l) => /cp312|pyodide_2024_0_wasm32/.test(l) && !l.includes('.whl'))));
check('AB1 derivation proof: no normalized package name is hardcoded as a literal',
  ['micropip', 'numpy', 'packaging', 'pandas', 'python-dateutil', 'pytz', 'six']
    .every((n) => !SRC.includes("'" + n + "'")),
  '');

// ================= AB2: single source of truth =================

const versionCodeLines = SRC.split('\n').filter((l) => l.includes('0.26.4') && !/^\s*\/\//.test(l));
check('AB2 the version literal appears in exactly ONE code line — the PYODIDE_BASE definition',
  versionCodeLines.length === 1 && /const PYODIDE_BASE = /.test(versionCodeLines[0]),
  JSON.stringify(versionCodeLines));

check('AB2 PYODIDE_BASE is exactly the base composed around PYODIDE_VERSION',
  shell.PYODIDE_BASE === 'https://cdn.jsdelivr.net/pyodide/v' + shell.PYODIDE_VERSION + '/full/'
  && shell.PYODIDE_BASE === 'https://cdn.jsdelivr.net/pyodide/v0.26.4/full/',
  shell.PYODIDE_BASE);

check('AB2 PYODIDE_VERSION parses out of PYODIDE_BASE (change one, the other follows)',
  /const PYODIDE_VERSION = \(function[\s\S]{0,400}?exec\(PYODIDE_BASE\)/.test(SRC)
  && /PYODIDE_BASE does not carry a \/pyodide\/v<version>\/ segment/.test(SRC),
  '');

// ================= AB3: wheelPlatformCompatible =================

const wpc = shell.wheelPlatformCompatible;

check('AB3 native wheel on the preloaded ABI -> compatible (native)',
  (() => { const r = wpc('lxml-5.2.1-cp312-cp312-pyodide_2024_0_wasm32.whl');
    return r.ok === true && r.kind === 'native' && r.reason === ''; })(), JSON.stringify(wpc('lxml-5.2.1-cp312-cp312-pyodide_2024_0_wasm32.whl')));

check('AB3 pure wheel (py3-none-any) -> compatible (pure)',
  (() => { const r = wpc('python_docx-1.2.0-py3-none-any.whl');
    return r.ok === true && r.kind === 'pure' && r.reason === ''; })(), JSON.stringify(wpc('python_docx-1.2.0-py3-none-any.whl')));

check('AB3 compound python tag with abi none/platform any -> compatible (pure)',
  (() => { const r = wpc('six-1.16.0-py2.py3-none-any.whl');
    return r.ok === true && r.kind === 'pure'; })(), JSON.stringify(wpc('six-1.16.0-py2.py3-none-any.whl')));

check('AB3 build-tag wheel filename still parses -> compatible (pure)',
  (() => { const r = wpc('foo-1.0-2-py3-none-any.whl');
    return r.ok === true && r.kind === 'pure'; })(), JSON.stringify(wpc('foo-1.0-2-py3-none-any.whl')));

{
  const r = wpc('lxml-5.2.1-cp311-cp311-pyodide_2023_0_wasm32.whl');
  check('AB3 wrong python tag + wrong platform -> incompatible, reason names the required ABI',
    r.ok === false && r.kind === null
    && r.reason.includes('cp312') && r.reason.includes('pyodide_2024_0_wasm32'),
    JSON.stringify(r));
}

{
  const r = wpc('numpy-1.26.4-cp312-cp312-manylinux_2_17_x86_64.whl');
  check('AB3 matching tags on a foreign platform -> incompatible',
    r.ok === false && r.kind === null
    && r.reason.includes('cp312') && r.reason.includes('pyodide_2024_0_wasm32'),
    JSON.stringify(r));
}

check('AB3 invalid filenames are never compatible',
  wpc('bad.whl').ok === false && wpc('bad.whl').kind === null
  && wpc('x.tar.gz').ok === false && wpc('x.tar.gz').kind === null
  && wpc('a-b-c-d-e-f-g-h.whl').ok === false
  && wpc('').ok === false && wpc(null).ok === false && wpc(undefined).ok === false,
  JSON.stringify([wpc('bad.whl').reason, wpc('x.tar.gz').reason]));

// ================= AB4: normalizeDistName =================

check('AB4 PEP 503 normalization (separators collapse, lowercase)',
  shell.normalizeDistName('Python_Dateutil') === 'python-dateutil'
  && shell.normalizeDistName('typing.extensions') === 'typing-extensions',
  JSON.stringify([shell.normalizeDistName('Python_Dateutil'), shell.normalizeDistName('typing.extensions')]));

check('AB4 non-string names are refused (fail closed, no silent coercion)',
  (() => { try { shell.normalizeDistName(42); return false; } catch (e) { return e instanceof TypeError; } })()
  && (() => { try { shell.normalizeDistName(null); return false; } catch (e) { return true; } })(),
  '');

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
