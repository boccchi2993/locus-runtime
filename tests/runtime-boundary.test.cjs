// Runtime DEPENDENCY-BOUNDARY gate (M2a gate G origin; M3a form).
//
// Structural checks over the Runtime package sources AND the built dist/
// bundle, paired with the real execution proof in
// tests/runtime-standalone.test.mjs (structure + behavior, not grep
// alone). Forbidden for Runtime files:
//   - imports of / references to Harness or Product modules
//     (agent, model, model-adapters, approval, tools-as-registry,
//      extensions, capability*, attachments, persistence, mutation-policy,
//      ui/, harness/, Vue)
//   - the product page DOM: worker-source elements (#py-worker-src /
//     #grep-worker-src), the status element (#sb-python),
//     document.getElementById DOM reads
//   - the product home-skeleton global (LOCUS_HOME_SKELETON) and the
//     Harness identity-pattern globals (EXTENSION_ID_PATTERN /
//     EXTENSION_PY_MODULE_PATTERN)
//
// M3a deletions this gate now ENFORCES (they were declared exceptions
// before extraction):
//   - the declared __LOCUS_RUNTIME_CORE__ registry: ZERO occurrences in
//     any source and none in the built bundle;
//   - cross-file globalThis/window symbol injection: ZERO global
//     assignments in host-side sources;
//   - eval/new Function host-side source assembly: ZERO occurrences.
// The worker sources (src/worker-assets.js) execute inside a Worker or
// the strict-CSP creator iframe — self/globalThis usage inside those
// SHIPPED WORKER STRINGS is the existing Python bootstrap mechanism and
// is explicitly out of scope for the host-side injection scan.
// Run: node tests/runtime-boundary.test.cjs

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + String(detail).slice(0, 400) : '')); }
}

// The Runtime file set (this repository's whole implementation surface).
const HOST_FILES = [
  'src/index.js',
  'src/lib/utf8.js',
  'src/workspace.js',
  'src/workspace-api.js',
  'src/vfs.js',
  'src/network.js',
  'src/shell.js',
];
// The public ENTRY files: everything a consumer can import directly.
// The entry rules (no window/DOM work, closure inside the runtime set)
// apply to every one of them.
const ENTRY_FILES = ['src/index.js', 'src/workspace-api.js'];
const RUNTIME_FILES = HOST_FILES.concat(['src/worker-assets.js']);

// Harness/Product module names that must NEVER appear as a dependency of
// a Runtime file (import specifiers or global-name references).
const FORBIDDEN_MODULES = [
  'agent', 'model-adapters', 'model.', 'approval', 'tools',
  'extensions', 'capability-package', 'capability',
  'attachments', 'persistence', 'mutation-policy', 'capabilities',
  'conversation-history-workspace',
  'task-runner', 'provider-session',
  'projector', 'markdown', 'store',
];

// Strip comments so explanatory mentions don't mask real code references;
// the scan is over CODE. CRLF is normalized first.
function stripComments(src) {
  return src
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n');
}

// ---------- G1: no Harness/Product module references ----------
for (const f of RUNTIME_FILES) {
  const src = stripComments(read(f));
  const esc = (m) => m.replace(/\./g, '\\.').replace(/-/, '\\-');
  const forbidden = FORBIDDEN_MODULES.filter((m) => new RegExp('(?:from\\s*|import\\s*\\(\\s*|require\\s*\\(\\s*)[\'"][^\'"]*\\b' + esc(m) + '(\\.js)?[\'"]').test(src));
  check('G1 ' + f + ' imports no Harness/Product module', forbidden.length === 0, JSON.stringify(forbidden));
}

// ---------- G2: no product globals or DOM ids ----------
{
  const domIdHits = [];
  const globalHits = [];
  for (const f of RUNTIME_FILES) {
    const lines = stripComments(read(f)).split('\n');
    lines.forEach((line, i) => {
      if (/getElementById\(|sb-python|py-worker-src|grep-worker-src/.test(line)) {
        domIdHits.push(f + ':' + (i + 1) + ' ' + line.trim().slice(0, 120));
      }
      if (/\bLOCUS_HOME_SKELETON\b|EXTENSION_ID_PATTERN|EXTENSION_PY_MODULE_PATTERN|PersistenceServiceInstance|SkillInstanceWorkspace|CapabilityManager|LocusMutationPolicy|AgentSession|ApprovalController|executeTool|AGENT_TOOL_DEFINITIONS/.test(line)) {
        globalHits.push(f + ':' + (i + 1) + ' ' + line.trim().slice(0, 120));
      }
    });
  }
  check('G2 no product DOM ids or page-element reads in Runtime', domIdHits.length === 0, JSON.stringify(domIdHits));
  check('G2b no Harness/Product globals in Runtime', globalHits.length === 0, JSON.stringify(globalHits));
}

// ---------- G3: the conversation identity never enters the Runtime ----------
{
  const hits = [];
  for (const f of RUNTIME_FILES) {
    const lines = stripComments(read(f)).split('\n');
    lines.forEach((line, i) => {
      if (/\bconversationId\b|\btaskGeneration\b/.test(line)) hits.push(f + ':' + (i + 1) + ' ' + line.trim().slice(0, 140));
    });
  }
  check('G3 no chat-identity field names in Runtime sources', hits.length === 0, JSON.stringify(hits));
}

// ---------- G4: the Runtime OWNS its contract data (canonical copy) ----------
{
  const shellSrc = read('src/shell.js');
  const runtimeId = shellSrc.match(/RUNTIME_PLUGIN_ID_PATTERN\s*=\s*(\/[^/]+\/)\s*;/);
  const runtimeMod = shellSrc.match(/RUNTIME_PY_MODULE_PATTERN\s*=\s*(\/[\s\S]*?\/)\s*;/);
  check('G4 the payload-identity patterns are declared in the module that enforces them',
    !!runtimeId && !!runtimeMod
    && runtimeId[1] === '/^[a-z0-9][a-z0-9._-]*$/'
    && runtimeMod[1] === '/^[A-Za-z_][A-Za-z0-9_]*(\\.[A-Za-z_][A-Za-z0-9_]*)*$/',
    JSON.stringify({ id: runtimeId && runtimeId[1], mod: runtimeMod && runtimeMod[1] }));
  // Byte-stable error texts embed the pattern — pinned through the real
  // configure gate with an invalid id.
  globalThis.window = { location: { protocol: 'https:' } };
  globalThis.document = { getElementById: () => null };
  (async () => {
    const { createPythonRuntime } = await import('../src/shell.js');
    const rt = createPythonRuntime({ pyWorkerSource: 'x' });
    let msg = null;
    try { rt.configureExtensions({ key: 'k', modules: [{ pluginId: 'BAD ID', imports: [] }] }); }
    catch (e) { msg = e.message; }
    check('G4c invalid payload ids fail with the SAME message text as before the split',
      !!msg && msg.includes('module pluginId must match /^[a-z0-9][a-z0-9._-]*$/'),
      msg);
    finish();
  })().catch((e) => { console.error(e); process.exit(1); });
  return;
}

function finish() {
  // ---------- G5: the built bundle obeys the same boundary ----------
  {
    const distDir = path.join(ROOT, 'dist');
    const bundleFiles = [];
    (function walk(dir) {
      if (!fs.existsSync(dir)) return;
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(js|mjs)$/.test(e.name)) bundleFiles.push(path.relative(ROOT, p).split(path.sep).join('/'));
      }
    })(distDir);
    check('G5 the build produced JS bundles to scan', bundleFiles.length > 0, JSON.stringify(bundleFiles));
    const hits = [];
    for (const f of bundleFiles) {
      let src = stripComments(read(f));
      // The host test page's own ABSENCE PROBE (`!!window.__LOCUS_RUNTIME_CORE__`
      // in runtime-host.html, asserting the registry never appears) is this
      // gate's runtime counterpart, not a seam — exempt exactly that probe
      // expression; any other occurrence (assignment, delegation, read) fails.
      src = src.replace(/!!window\.__LOCUS_RUNTIME_CORE__/g, '');
      if (/sb-python|py-worker-src|grep-worker-src|LOCUS_HOME_SKELETON|EXTENSION_ID_PATTERN|conversationId|taskGeneration|__LOCUS_RUNTIME_CORE__/.test(src)) {
        hits.push(f);
      }
    }
    check('G5b the built bundle stays inside the boundary (no registry, no product tokens)', hits.length === 0, JSON.stringify(hits));
  }

  // ---------- G6: NO global assembly seams remain (M3a deletions) ----------
  {
    const registryHits = [];
    for (const f of RUNTIME_FILES) {
      if (/__LOCUS_RUNTIME_CORE__/.test(stripComments(read(f)))) registryHits.push(f);
    }
    check('G6 zero __LOCUS_RUNTIME_CORE__ code references in any Runtime source', registryHits.length === 0, JSON.stringify(registryHits));

    const injectHits = [];
    for (const f of HOST_FILES) {
      const lines = stripComments(read(f)).split('\n');
      lines.forEach((line, i) => {
        if (/\b(?:globalThis|window)\.[A-Za-z_$][\w$]*\s*=(?!=)/.test(line)) {
          injectHits.push(f + ':' + (i + 1) + ' ' + line.trim().slice(0, 120));
        }
      });
    }
    check('G6b zero cross-file globalThis/window symbol injection in host-side sources', injectHits.length === 0, JSON.stringify(injectHits));

    const evalHits = [];
    for (const f of HOST_FILES) {
      const lines = stripComments(read(f)).split('\n');
      lines.forEach((line, i) => {
        if (/\beval\s*\(|new\s+Function\s*\(/.test(line)) {
          evalHits.push(f + ':' + (i + 1) + ' ' + line.trim().slice(0, 120));
        }
      });
    }
    check('G6c zero eval/new Function host-side source assembly', evalHits.length === 0, JSON.stringify(evalHits));

    const entrySrc = stripComments(read('src/index.js'));
    const wsApiSrc = stripComments(read('src/workspace-api.js'));
    check('G6d the entries perform no window or DOM work',
      !/\bwindow\b/.test(entrySrc) && !/document\./.test(entrySrc)
      && !/\bwindow\b/.test(wsApiSrc) && !/document\./.test(wsApiSrc),
      'window/document reference in an entry');
    // The provider subpath must stay a ONE-WAY re-export surface: any
    // local function/class body would be a second implementation.
    check('G6e the workspace subpath declares no implementation (pure re-exports)',
      !/\b(?:async\s+)?function\s|\bclass\s/.test(wsApiSrc),
      wsApiSrc.slice(0, 200));
  }

  // ---------- G7: the entry's TRANSITIVE ESM dependency closure ----------
  // The entry must never reach a Harness/Product file: walk the import
  // graph from src/index.js (static imports, re-exports and dynamic
  // import() calls) and require every reached file to be part of the
  // Runtime set — and the closure to actually COVER the core.
  {
    const resolveFrom = (fromFile, spec) => {
      if (!spec.startsWith('.')) return null; // bare specifiers are out of scope here
      const base = path.join(path.dirname(path.join(ROOT, fromFile)), spec.split('?')[0]);
      return path.relative(ROOT, base).split(path.sep).join('/');
    };
    const seen = new Set();
    const walk = (file) => {
      if (seen.has(file)) return;
      seen.add(file);
      // Fresh regex per file: a shared /g regex's lastIndex is corrupted by
      // the inline recursion below.
      const IMPORT_RE = /(?:from\s*|import\s+|import\()\s*['"]([^'"]+)['"]/g;
      const src = read(file);
      let m;
      while ((m = IMPORT_RE.exec(src)) !== null) {
        const rel = resolveFrom(file, m[1]);
        if (rel) walk(rel);
      }
    };
    walk('src/index.js');
    walk('src/workspace-api.js'); // the provider subpath is a second public entry
    const ALLOWED = new Set(RUNTIME_FILES);
    const outside = Array.from(seen).filter((f) => !ALLOWED.has(f));
    check('G7 the entry\u2019s transitive import closure stays inside the Runtime set',
      outside.length === 0, JSON.stringify(outside));
    // worker-assets.js is deliberately ABSENT from the closure: its sources
    // travel as host-injected strings (createRuntime workerAssets), never as
    // an import of the entry.
    const CORE_CLOSURE = [
      'src/lib/utf8.js',
      'src/workspace.js',
      'src/vfs.js',
      'src/network.js',
      'src/shell.js',
    ];
    const MISSING = CORE_CLOSURE.filter((f) => !seen.has(f));
    check('G7b the closure covers the whole core', MISSING.length === 0, JSON.stringify(MISSING));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}
