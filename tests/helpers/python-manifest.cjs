// Single-source-of-truth loader for the pinned Python bootstrap manifest
// (F04c): every suite derives its asset list from src/shell.js instead of
// keeping a duplicate copy. Throws loudly if the manifest is missing or
// malformed, so a broken manifest fails every consumer immediately.
//
// M3a: shell.js is an ES module — the loader imports the manifest (and
// the partition tables) directly instead of regex-extracting them from
// the classic source text. require(esm) is synchronous on this Node.
const shell = require('../../src/shell.js');

function validatePartition(names, label) {
  if (!Array.isArray(names) || names.length === 0) {
    throw new Error(label + ' is missing or empty');
  }
}

function loadPythonManifest() {
  const base = shell.PYODIDE_BASE;
  if (typeof base !== 'string' || !/^https:\/\//.test(base)) {
    throw new Error('PYODIDE_BASE is missing or malformed');
  }
  const manifest = shell.PYTHON_BOOTSTRAP_MANIFEST;
  if (!Array.isArray(manifest) || manifest.length === 0) {
    throw new Error('PYTHON_BOOTSTRAP_MANIFEST is missing or empty');
  }
  const names = manifest.map((e) => e.name);
  if (new Set(names).size !== names.length) {
    throw new Error('PYTHON_BOOTSTRAP_MANIFEST holds duplicate asset names');
  }
  const coreAssets = shell.PYTHON_BOOTSTRAP_CORE_ASSETS;
  const runtimePackageFiles = shell.PYTHON_RUNTIME_PACKAGE_FILES;
  const installerSupportFiles = shell.PYTHON_INSTALLER_SUPPORT_FILES;
  validatePartition(coreAssets, 'PYTHON_BOOTSTRAP_CORE_ASSETS');
  validatePartition(runtimePackageFiles, 'PYTHON_RUNTIME_PACKAGE_FILES');
  validatePartition(installerSupportFiles, 'PYTHON_INSTALLER_SUPPORT_FILES');
  const known = new Set([...coreAssets, ...runtimePackageFiles, ...installerSupportFiles]);
  if (names.length !== known.size || names.some((n) => !known.has(n))) {
    throw new Error('PYTHON_BOOTSTRAP_MANIFEST does not partition into core + runtime packages + installer support');
  }
  for (const e of manifest) {
    if (!e.name || !/^[0-9a-f]{64}$/.test(e.sha256) || !(e.size > 0)) {
      throw new Error('malformed manifest entry: ' + JSON.stringify(e));
    }
  }
  return {
    base,
    manifest,
    coreAssets,
    runtimePackageFiles,
    installerSupportFiles,
  };
}

module.exports = { loadPythonManifest };
