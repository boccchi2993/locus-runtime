// M3a extraction helper: copies the Runtime source closure from the pinned
// source baseline and applies the ESM conversion. Run once from the target
// repo root; the transformations are anchored to exact source strings so a
// baseline drift fails loudly instead of silently converting something else.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

const SRC = process.argv[2];
if (!SRC) { console.error('usage: node tools/extract-sources.mjs <source-worktree>'); process.exit(1); }
const DST = process.argv[2 + 1] || process.cwd();
const anchor = (s) => {
  console.error('ANCHOR NOT FOUND:\n' + s);
  process.exit(1);
};

function copy(relSrc, relDst, transforms) {
  // Source checkout is CRLF (core.autocrlf=true); this repo enforces LF
  // via .gitattributes — normalize once at copy time, anchors are LF.
  let text = readFileSync(join(SRC, relSrc), 'utf8').replace(/\r\n/g, '\n');
  for (const [find, replace] of transforms || []) {
    if (!text.includes(find)) anchor(find);
    text = text.replace(find, replace);
  }
  const out = join(DST, relDst);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, text);
  console.log('wrote ' + relDst + ' (' + text.split('\n').length + ' lines)');
}

// ---------- 1. src/lib/utf8.js (extracted from telemetry.js) ----------
mkdirSync(join(DST, 'src/lib'), { recursive: true });
writeFileSync(join(DST, 'src/lib/utf8.js'), `// ============================================================
//  UTF-8 BYTE LENGTH
//  M3a extraction: this is the only piece of src/telemetry.js the
//  Runtime core actually consumes (shell/python io accounting).
//  The product Telemetry singleton, its record store and the
//  window.__telemetry console accessor are PRODUCT observability and
//  are deliberately NOT part of the Runtime package.
// ============================================================

// Real UTF-8 byte length of a string (NOT String.length, which counts
// UTF-16 code units — e.g. "你好" is 6 bytes, not 2).
export function utf8ByteLength(text) {
  return new TextEncoder().encode(String(text)).byteLength;
}
`);
console.log('wrote src/lib/utf8.js');

// ---------- 2. src/workspace.js ----------
copy('src/workspace.js', 'src/workspace.js', [
  [
    `// M2a review: explicit cross-file publish (see telemetry.js). vfs.js
// extends WorkspaceAdapter at LOAD time and calls normalizeWorkspacePath
// throughout — on the ESM self-assembly path both must be bare globals.
globalThis.WorkspaceAdapter = WorkspaceAdapter;
globalThis.normalizeWorkspacePath = normalizeWorkspacePath;`,
    `// ============================================================
//  M3a (repository extraction): ES module exports. The M2a classic
//  globalThis publishes are gone — cross-file wiring is explicit
//  imports now (vfs.js imports WorkspaceAdapter/normalizeWorkspacePath
//  from this module).
// ============================================================
export {
  normalizeWorkspacePath,
  WorkspaceAdapter,
  LocalDirectoryWorkspace,
  OPFSWorkspace,
  isNotFoundOrTypeMismatch,
  ensureWorkspacePermission,
};`,
  ],
]);

// ---------- 3. src/vfs.js ----------
copy('src/vfs.js', 'src/vfs.js', [
  [
    `//  Globals exported: normalizeVfsPath, vfsError, VirtualWorkspace,
//  MemoryWorkspace, UploadWorkspace, SystemBinWorkspace.
//  No imports; loaded after workspace.js (WorkspaceAdapter,
//  normalizeWorkspacePath). This file must NEVER reference
//  SHELL_COMMANDS directly — the command list is injected.`,
    `//  ES module exports: normalizeVfsPath, vfsError, VirtualWorkspace,
//  MemoryWorkspace, UploadWorkspace, SystemBinWorkspace.
//  Imports WorkspaceAdapter/normalizeWorkspacePath from ./workspace.js
//  (M3a extraction; the classic load order became explicit imports).
//  This file must NEVER reference SHELL_COMMANDS directly — the
//  command list is injected.`,
  ],
  [
    `// ============================================================
//  VFS (Linux-like virtual filesystem, v1)
//  VirtualWorkspace mount table + internal providers.
//  See docs/LINUX-LIKE-VFS.md for the architecture contract.
//
`,
    `// ============================================================
//  VFS (Linux-like virtual filesystem, v1)
//  VirtualWorkspace mount table + internal providers.
//  See docs/LINUX-LIKE-VFS.md for the architecture contract.
//
import { WorkspaceAdapter, normalizeWorkspacePath } from './workspace.js';

`,
  ],
  [
    `// M2a review: explicit cross-file publish (see telemetry.js). shell.js
// constructs VirtualWorkspace/MemoryWorkspace and calls
// normalizeVfsPath/vfsError; the entry exposes the workspace
// constructors to hosts. Bare globals keep both load modes working.
globalThis.normalizeVfsPath = normalizeVfsPath;
globalThis.vfsError = vfsError;
globalThis.MemoryWorkspace = MemoryWorkspace;
globalThis.VirtualWorkspace = VirtualWorkspace;`,
    `// ============================================================
//  M3a (repository extraction): ES module exports. The M2a classic
//  globalThis publishes are gone — shell.js and the public entry
//  import these names directly.
// ============================================================
export {
  normalizeVfsPath,
  vfsError,
  MemoryWorkspace,
  UploadWorkspace,
  SystemBinWorkspace,
  VirtualWorkspace,
};`,
  ],
]);

// ---------- 4. src/network.js ----------
copy('src/network.js', 'src/network.js', [
  [
    `// M2a review: explicit cross-file publish (see telemetry.js). shell.js
// dispatches curl through NetworkRuntime and renders URLs through
// safeNetworkUrlForDisplay.
globalThis.NetworkRuntime = NetworkRuntime;
globalThis.safeNetworkUrlForDisplay = safeNetworkUrlForDisplay;`,
    `// ============================================================
//  M3a (repository extraction): ES module exports. The M2a classic
//  globalThis publishes are gone — shell.js imports NetworkRuntime /
//  safeNetworkUrlForDisplay directly; the wider taxonomy helpers stay
//  module-internal (consumers use the documented error codes).
// ============================================================
export {
  NetworkRuntime,
  safeNetworkUrlForDisplay,
  isPrivateHostname,
  NETWORK_MAX_REQUEST_BYTES,
  NETWORK_MAX_RESPONSE_BYTES,
  RELAY_CLIENT_TIMEOUT_MS,
};`,
  ],
]);

// ---------- 5. src/shell.js ----------
copy('src/shell.js', 'src/shell.js', [
  [
    `// ============================================================
//  BROWSER SHELL COMPATIBILITY LAYER
//  Implements the local \`bash\` tool: pwd / ls / cat / echo / python.
//  Everything runs against the WorkspaceAdapter and the Pyodide
//  worker — no native shell, no server, no cloud execution.
// ============================================================`,
    `// ============================================================
//  BROWSER SHELL COMPATIBILITY LAYER
//  Implements the local \`bash\` tool: pwd / ls / cat / echo / python.
//  Everything runs against the WorkspaceAdapter and the Pyodide
//  worker — no native shell, no server, no cloud execution.
//
//  M3a (repository extraction): this file is an ES module. The
//  cross-file names it consumed as classic-script globals
//  (utf8ByteLength / VirtualWorkspace / normalizeVfsPath / vfsError /
//  NetworkRuntime / safeNetworkUrlForDisplay) arrive through explicit
//  imports below, and the declared __LOCUS_RUNTIME_CORE__ registry at
//  the end of the classic file is DELETED — the public entry
//  (src/index.js) imports this module directly.
// ============================================================
import { utf8ByteLength } from './lib/utf8.js';
import { normalizeVfsPath, vfsError, VirtualWorkspace } from './vfs.js';
import { NetworkRuntime, safeNetworkUrlForDisplay } from './network.js';`,
  ],
  [
    `// ============================================================
//  M2a (repository split): the DECLARED Runtime-internal registry.
//
//  The runtime core stays a classic script until M3 (repository
//  extraction); this frozen table is the one named seam the public ESM
//  entry (src/runtime/index.js) and standalone hosts resolve it through.
//  It is a table of the SAME functions — never a second state holder.
//  Consumers outside the Runtime (Harness/Product) must go through the
//  public entry, never through this registry; the boundary test enforces
//  that Runtime files reference nothing but their own registry among
//  globals. Deleted at M3 when shell.js becomes the runtime package.
// ============================================================
if (typeof globalThis !== 'undefined') {
  const __runtimeCoreTable = {
    contractVersion: 1,
    // payload contract data (this module is the Runtime's canonical copy)
    contract: Object.freeze({
      pluginIdPattern: RUNTIME_PLUGIN_ID_PATTERN,
      pyModulePattern: RUNTIME_PY_MODULE_PATTERN,
    }),
    // M2c: REAL bound constants for the host's public capabilities()
    // declaration (contract §5 — declared limits are this module's own
    // constants, never retyped numbers). A core without the entry makes
    // capabilities() OMIT the limits section — never a fabricated limit.
    limits: Object.freeze({
      shellPipeMaxBytes: SHELL_PIPE_MAX_BYTES,
      headTailMaxOutputBytes: HEAD_TAIL_MAX_OUTPUT_BYTES,
      pythonTimeoutMs: PYTHON_TIMEOUT_MS,
    }),
    // interpreter + execution (always defined in this module)
    createPythonRuntime,
    runShellCommand,
    runPythonCode,
  };
  // Filesystem primitives load as separate classic scripts; a host that
  // loaded only part of the core registers what exists — the entry's
  // resolution check refuses an INCOMPLETE core at createRuntime() time.
  if (typeof VirtualWorkspace === 'function') __runtimeCoreTable.VirtualWorkspace = VirtualWorkspace;
  if (typeof MemoryWorkspace === 'function') __runtimeCoreTable.MemoryWorkspace = MemoryWorkspace;
  if (typeof shellSystemPromptSection === 'function') __runtimeCoreTable.shellSystemPromptSection = shellSystemPromptSection;
  if (typeof SHELL_COMMANDS !== 'undefined') __runtimeCoreTable.SHELL_COMMANDS = SHELL_COMMANDS;
  globalThis.__LOCUS_RUNTIME_CORE__ = Object.freeze(__runtimeCoreTable);
}`,
    `// ============================================================
//  M3a (repository extraction): ES module exports.
//
//  The declared __LOCUS_RUNTIME_CORE__ registry is DELETED: the public
//  entry (src/index.js) imports this module directly, so there is no
//  page-global table, no classic-script load order, and no registry
//  delegation anymore. Exports split two ways:
//    - the surface the public entry and hosts consume
//      (interpreter/execution factories, command registry +
//      descriptions, contract data + real limit constants);
//    - internal seams the package's own unit suites drive (bootstrap
//      manifest + budget helpers, wheel validation, tokenizer/parser
//      internals, workspace collection). This file is NOT in the
//      package "exports" map — it stays package-internal.
// ============================================================
export {
  // interpreter + execution
  createPythonRuntime,
  runShellCommand,
  runPythonCode,
  // shell surface (registry + descriptions + grep)
  SHELL_COMMANDS,
  SHELL_ALIASES,
  shellHelpText,
  shellSystemPromptSection,
  GrepRegexRuntime,
  createGrepRegexSession,
  GREP_REGEX_TIMEOUT_MS,
  // contract data: payload identity + real bound constants
  RUNTIME_PLUGIN_ID_PATTERN,
  RUNTIME_PY_MODULE_PATTERN,
  SHELL_PIPE_MAX_BYTES,
  HEAD_TAIL_MAX_OUTPUT_BYTES,
  // python bootstrap contract (single source of truth, F04c)
  PYODIDE_BASE,
  PYTHON_BOOTSTRAP_MANIFEST,
  PYTHON_BOOTSTRAP_CORE_ASSETS,
  PYTHON_RUNTIME_PACKAGE_FILES,
  PYTHON_INSTALLER_SUPPORT_FILES,
  PYTHON_TIMEOUT_MS,
  PYTHON_ASSET_TIMEOUT_MS,
  PYTHON_ASSET_STALL_MS,
  PYTHON_BOOTSTRAP_TIMEOUT_MS,
  PYTHON_PLUGIN_WHEEL_MAX_BYTES,
  validateWheelArtifact,
  // internal seams (package tests only)
  pythonBootstrapBudgets,
  makeBudgetClock,
  readBodyBounded,
  shellTokenize,
  parseShellLine,
  runPipeline,
  collectWorkspaceFiles,
};`,
  ],
]);

// ---------- 6. src/worker-assets.js (verbatim) ----------
copy('src/runtime/worker-assets.js', 'src/worker-assets.js', []);

console.log('extraction copy complete');
