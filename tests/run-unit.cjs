// Runs every Node unit suite sequentially. No internet required.
// Usage: node tests/run-unit.cjs   (npm test)
const { spawnSync } = require('child_process');
const path = require('path');

const SUITES = [
  'workspace.test.cjs',
  'opfs-workspace.test.cjs',
  'vfs.test.cjs',
  'shell.test.cjs',
  'shell-compat.test.cjs',
  'shell-compat2.test.cjs',
  'shell-compat3.test.cjs',
  'vfs-audit.test.cjs',
  'network.test.cjs',
  'network-runtime.test.cjs',
  'runtime-visibility.test.cjs',
  'mutation-policy.test.cjs',
  'grep-worker.test.cjs',
  'worker-init.test.cjs',
  'worker-output.test.cjs',
  'python-lifecycle.test.cjs',
  'python-authority.test.cjs',
  'python-bootstrap-integrity.test.cjs',
  'python-plugin-runtime.test.cjs',
  'runtime-standalone.test.mjs',
  'runtime-import-purity.test.mjs',
  'runtime-session-lifecycle.test.mjs',
  'runtime-boundary.test.cjs',
];

let failed = 0;
for (const s of SUITES) {
  const r = spawnSync(process.execPath, [path.join(__dirname, s)], { stdio: 'inherit' });
  if (r.status !== 0) {
    failed++;
    console.error('SUITE FAIL: ' + s);
  }
}
console.log('---');
console.log(failed ? failed + ' suite(s) FAILED' : 'all ' + SUITES.length + ' suites passed');
process.exit(failed ? 1 : 0);
