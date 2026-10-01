// Full browser e2e orchestrator for the locus-runtime package (npm run test:e2e).
//
// Each browser suite owns its Chrome process, temporary profile, and dynamic
// CDP port. The runtime-host suites share the vite preview server; the
// python/network suites are self-contained (own servers + own Chrome).
//
// M3a scope: Runtime-owned gates only. The product-page suites
// (presentation/approval/image/persistence/wire/capabilities/skill-instances/
// product-joint) and the full-app runtime battery (tests/e2e.html — it drove
// the Product tool adapter and the model stack) stay in the product
// repository; the extraction-coverage map records where each behavior is
// covered here (runtime-host browser gate + the python/grep/network suites).
const { spawnSync } = require('child_process');
const path = require('path');
const {
  allocateFreePort,
  closeChrome,
  closeManagedProcess,
  launchChrome,
  launchManagedProcess,
  waitForCdp,
  waitForHttp,
  waitForPageTarget,
} = require('./helpers/chrome.cjs');

const ROOT = path.join(__dirname, '..');
const CHROME = process.env.CHROME;
const VITE_CLI = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');

// ---------- 1. runtime-host e2e (packaged standalone host, vite preview) ----------
// The M2a gate B/C/F battery over dist/tests/runtime-host.html: self-assembly
// proofs, cold-load laziness, real grep worker, real Python, status events,
// two-session isolation and the live boundary-semantics L-gates.
async function runtimeHostE2e() {
  console.log('=== standalone runtime host e2e (tests/e2e-runtime-host.cjs) ===');
  const build = spawnSync(process.execPath, [VITE_CLI, 'build'], { stdio: 'inherit', cwd: ROOT });
  if (build.status !== 0) return false;
  const port = await allocateFreePort();
  const preview = launchManagedProcess(process.execPath, [
    VITE_CLI, 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort',
  ], { cwd: ROOT, port, label: 'runtime-host Vite preview', env: process.env });
  const appRoot = `http://127.0.0.1:${port}/`;
  try {
    await waitForHttp(`${appRoot}tests/runtime-host.html`, { process: preview, timeoutMs: 15000 });
    const env = { ...process.env, E2E_HOST_URL: `${appRoot}tests/runtime-host.html` };
    const r = spawnSync(process.execPath, [path.join(__dirname, 'e2e-runtime-host.cjs')], {
      stdio: 'inherit', env,
    });
    return r.status === 0;
  } catch (error) {
    console.error(error && error.stack || error);
    return false;
  } finally {
    const cleanup = await closeManagedProcess(preview);
    if (!cleanup.exited) console.error('runtime-host Vite preview did not exit after bounded cleanup');
  }
}

// ---------- 2. active-content isolation (relay fixture contract) ----------
function activeContentE2e() {
  console.log('=== /fetch active-content isolation (tests/verify-active-content.cjs) ===');
  const r = spawnSync(process.execPath, [path.join(__dirname, 'verify-active-content.cjs')], {
    stdio: 'inherit',
    env: process.env,
  });
  return r.status === 0;
}

// ---------- 3. self-contained suites (own servers + own Chrome) ----------
function selfContained(label, script) {
  console.log(`=== ${label} (tests/${script}) ===`);
  const r = spawnSync(process.execPath, [path.join(__dirname, script)], {
    stdio: 'inherit', env: process.env,
  });
  return r.status === 0;
}

void launchChrome;
void waitForCdp;
void waitForPageTarget;

async function main() {
  const results = [];
  results.push(['runtime-host', await runtimeHostE2e()]);
  results.push(['active-content', activeContentE2e()]);
  results.push(['grep', selfContained('grep worker e2e', 'e2e-grep.cjs')]);
  results.push(['network', selfContained('network e2e', 'e2e-network.cjs')]);
  results.push(['python-authority', selfContained('python authority e2e', 'e2e-python-authority.cjs')]);
  results.push(['python-browser-authority', selfContained('python browser authority e2e', 'e2e-python-browser-authority.cjs')]);
  results.push(['python-bootstrap-integrity', selfContained('python bootstrap integrity e2e', 'e2e-python-bootstrap.cjs')]);
  results.push(['trusted-plugin-runtime', selfContained('trusted plugin runtime e2e', 'e2e-python-plugin-runtime.cjs')]);
  console.log('===');
  let failed = 0;
  for (const [name, ok] of results) {
    console.log((ok ? 'PASS' : 'FAIL') + ' suite: ' + name);
    if (!ok) failed++;
  }
  process.exitCode = failed ? 1 : 0;
}

main().catch((error) => { console.error(error && error.stack || error); process.exitCode = 1; });
