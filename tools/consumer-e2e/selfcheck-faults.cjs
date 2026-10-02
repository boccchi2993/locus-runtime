// Fault-injection SELF-VERIFICATION (M3a review round 2) — proves the
// strengthened mid-flight assertions actually catch the review's two
// fault classes, and that the round-1 assertions did not. NOT part of
// the normal consumer gate: the gate (consumer-gate.cjs) always drives
// the real tarball implementation unwrapped, and never runs this file.
//
// What runs here (same consumer page, same tarball, same public
// entries as the gate; the ONLY extra piece is the page-side fault
// wrapper — see index.html, self-verification section):
//
//   CONTROL  no fault, abort + dispose scenarios
//            → the real implementation passes BOTH the legacy (round-1)
//              and the strengthened (round-2) judgment sets. This is the
//              "真实 Runtime 通过判定" half of the proof, run in the same
//              harness as the faults.
//   A1       early busy-release: one microtask after the caller's abort
//            the public status misreports busyExecutions=0 while the real
//            execution is still parked at the provider barrier
//            → EVERY legacy check stays green (the round-1 gate was
//              blind), the strengthened C4e-i FAILS (busyBeforeRelease=0).
//   A2       early settle: one microtask after the caller's abort the
//            caller-visible promise resolves (cancellation-shaped) while
//            the real provider write is still parked
//            → the legacy same-stack C4e-i stays green, the strengthened
//              C4e-i FAILS on settledBeforeRelease — the settled
//              assertion has its own teeth, not only the busy one.
//              (Later legacy entries are RECORDED but not required under
//              A2: the real run settles concurrently with the probe, so
//              the finals legitimately lag — the old gate at best saw a
//              late busy anomaly, never the boundary-window settlement.)
//   B        dispose reason override: after the SECOND dispose call,
//            fresh execute/prepare refusals are overridden with the
//            second reason
//            → EVERY legacy check stays green (they read the CACHED
//              pre-second-dispose rejections), the strengthened C4f-v
//              FAILS (the FRESH rejections carry the second reason).
//
// Run (in an assembled consumer directory — tarball installed, see
// tools/consumer-e2e and the CI consumer job): node selfcheck-faults.cjs
const fs = require('fs/promises');
const http = require('http');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  allocateFreePort, closeChrome, connectToTarget, launchChrome, waitForCdp,
  waitForPageTarget, waitForRuntimeCondition,
} = require('./chrome-driver.cjs');
const contract = require('./lifecycle-contract.cjs');

const ROOT = __dirname;

async function evaluate(cdp, expression, timeout) {
  const result = await cdp.send('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true, timeout: timeout || 60000,
  });
  if (result?.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails).slice(0, 600));
  return result?.result?.value;
}

// The proof matrix. `legacy` names what the LEGACY (round-1) judgment set
// must show under the fault: 'all-green' (the old gate would have passed
// the run) or 'same-stack-only' (the round-1 boundary-window entry stays
// green; later finals are recorded, see A2 above). `mustFail` names the
// strengthened check that must FAIL, and `faultVisible` is the raw
// observation proving the fault took effect for the new observation.
const PROOFS = [
  {
    id: 'A1 early busy-release (public busy misreported 0 one microtask after the caller abort)',
    fault: 'early-busy-release', scenario: 'abort',
    legacy: 'all-green', mustFail: 'C4e-i',
    faultVisible: (r) => r.busyBeforeRelease === 0,
    faultNote: 'busyBeforeRelease=0 while the real write is still parked',
  },
  {
    id: 'A2 early settle (caller-visible promise resolves while the write is still parked)',
    fault: 'early-settle', scenario: 'abort',
    legacy: 'same-stack-only', mustFail: 'C4e-i',
    faultVisible: (r) => r.settledBeforeRelease === true && r.busyBeforeRelease === 1,
    faultNote: 'settledBeforeRelease=true (busy observation stays honest at 1 — the settled assertion has its own teeth)',
  },
  {
    id: 'B dispose reason override (post-second-dispose rejections clobbered with the second reason)',
    fault: 'dispose-reason-override', scenario: 'dispose',
    legacy: 'all-green', mustFail: 'C4f-v',
    faultVisible: (r) => /second dispose call/.test(String(r.executeRejection2))
      && /second dispose call/.test(String(r.prepareRejection2)),
    faultNote: 'FRESH post-second-dispose rejections carry the second reason',
  },
];

async function main() {
  let passed = 0, failed = 0;
  const check = (name, cond, detail) => {
    if (cond) { passed++; console.log('PASS ' + name); }
    else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + String(detail).slice(0, 400) : '')); }
  };
  let chrome = null;
  let profileDir = null;
  let server = null;
  try {
    // 1. build the consumer page with its OWN toolchain (same as the gate)
    const build = spawnSync(process.execPath, [path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'build'], {
      stdio: 'inherit', cwd: ROOT,
    });
    if (build.status !== 0) throw new Error('consumer vite build failed for the self-check');

    // 2. serve dist (static only — no network scenario runs here)
    const distRoot = path.join(ROOT, 'dist');
    const port = await allocateFreePort();
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css' };
    server = http.createServer(async (req, res) => {
      try {
        const u = new URL(req.url, 'http://127.0.0.1');
        let rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
        if (!rel || rel.endsWith('/')) rel += 'index.html';
        const file = path.join(distRoot, rel);
        if (!file.startsWith(distRoot) || !(await fs.stat(file).catch(() => null))) {
          res.statusCode = 404; res.end('not found'); return;
        }
        res.setHeader('content-type', types[path.extname(file)] || 'application/octet-stream');
        res.end(await fs.readFile(file));
      } catch (e) {
        res.statusCode = 500; res.end('server error');
      }
    });
    await new Promise((r) => server.listen(port, '127.0.0.1', r));
    const url = 'http://127.0.0.1:' + port + '/';

    // 3. drive the page
    profileDir = await fs.mkdtemp(path.join(require('os').tmpdir(), 'locus-selfcheck-'));
    chrome = await launchChrome(url, {
      chromePath: process.env.CHROME,
      label: 'selfcheck Chrome',
      profileDir,
      extraArgs: ['--window-size=1280,800'],
    });
    await waitForCdp(chrome, { timeoutMs: 15000 });
    const target = await waitForPageTarget(chrome, url, { timeoutMs: 15000 });
    const cdp = await connectToTarget(target);
    await waitForRuntimeCondition(cdp, '!!(window.__consumer && window.__consumer.ready)',
      { process: chrome, phase: 'selfcheck-boot', timeoutMs: 20000 });

    const runScenario = (scenario, fault) => evaluate(cdp,
      'window.__consumer.selfcheck(' + (fault ? JSON.stringify(fault) : 'null') + ', ' + JSON.stringify(scenario) + ')', 30000);

    // ---------- CONTROL: the real implementation, no fault ----------
    for (const scenario of ['abort', 'dispose']) {
      const r = await runScenario(scenario, null);
      const legacy = contract[(scenario === 'abort' ? 'abortLegacyChecks' : 'disposeLegacyChecks')](r);
      const strong = contract[(scenario === 'abort' ? 'abortChecks' : 'disposeChecks')](r);
      check('CONTROL ' + scenario + ': the real implementation passes the LEGACY (round-1) judgment set',
        legacy.every((c) => c.cond), JSON.stringify(legacy.filter((c) => !c.cond).map((c) => c.name)));
      check('CONTROL ' + scenario + ': the real implementation passes the STRENGTHENED (round-2) judgment set',
        strong.every((c) => c.cond), JSON.stringify(strong.filter((c) => !c.cond).map((c) => c.name)));
    }

    // ---------- the faults ----------
    for (const proof of PROOFS) {
      const r = await runScenario(proof.scenario, proof.fault);
      const legacy = contract[(proof.scenario === 'abort' ? 'abortLegacyChecks' : 'disposeLegacyChecks')](r);
      const strong = contract[(proof.scenario === 'abort' ? 'abortChecks' : 'disposeChecks')](r);
      const legacyGreen = legacy.filter((c) => c.cond);
      const legacyRed = legacy.filter((c) => !c.cond);
      const strongRed = strong.filter((c) => !c.cond);
      const strongGreen = strong.filter((c) => c.cond);

      if (proof.legacy === 'all-green') {
        check(proof.id + ' :: the OLD (round-1) judgment set stays GREEN under the fault — the old gate could not see it',
          legacyRed.length === 0,
          'unexpected legacy failures: ' + JSON.stringify(legacyRed.map((c) => c.name)));
      } else {
        const sameStack = legacy[0];
        check(proof.id + ' :: the OLD (round-1) boundary-window entry stays GREEN under the fault (same-stack reads)',
          !!sameStack && sameStack.cond, JSON.stringify(sameStack && sameStack.detail));
        console.log('     [recorded, not required] legacy entries NOT green under ' + proof.fault + ': '
          + JSON.stringify(legacyRed.map((c) => c.name))
          + ' — the real run settles concurrently with the probe, so the old gate at best saw a LATE busy anomaly, never the boundary-window settlement');
      }
      check(proof.id + ' :: the fault took effect for the NEW observation (' + proof.faultNote + ')',
        proof.faultVisible(r), JSON.stringify({
          settledBeforeRelease: r.settledBeforeRelease, busyBeforeRelease: r.busyBeforeRelease,
          executeRejection2: r.executeRejection2, prepareRejection2: r.prepareRejection2,
        }));
      check(proof.id + ' :: the STRENGTHENED judgment set CATCHES it (' + proof.mustFail + ' fails)',
        strongRed.some((c) => c.name.indexOf(proof.mustFail) === 0),
        'strengthened failures: ' + JSON.stringify(strongRed.map((c) => c.name)));
      if (proof.legacy === 'all-green') {
        check(proof.id + ' :: the catch is SURGICAL (only ' + proof.mustFail + ' fails; every other strengthened check stays green)',
          strongRed.length === 1 && strongRed[0].name.indexOf(proof.mustFail) === 0,
          JSON.stringify(strongRed.map((c) => c.name)));
      }
    }

    // ---------- hygiene: the faults left nothing behind ----------
    const pageErrors = await evaluate(cdp, 'window.__consumer.errors');
    check('HYGIENE no unhandled page errors across control + fault runs',
      Array.isArray(pageErrors) && pageErrors.length === 0, JSON.stringify(pageErrors));
  } catch (e) {
    console.error('SELF-CHECK FAIL: ' + (e && e.stack || e));
    process.exitCode = 1;
  } finally {
    if (chrome) await closeChrome(chrome);
    if (profileDir) { try { await fs.rm(profileDir, { recursive: true, force: true }); } catch (e) {} }
    if (server) { try { await new Promise((r) => server.close(r)); } catch (e) {} }
  }
  console.log('---');
  console.log('fault-injection self-check: ' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exitCode = 1;
}

main();
