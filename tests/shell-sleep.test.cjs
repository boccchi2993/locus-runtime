// C3 sleep command tests (node, no network).
// Run: node tests/shell-sleep.test.cjs
//
// sleep <seconds>: exactly one plain decimal argument, 0 < s ≤ 60, no
// stdout, immediate failure on bad usage, cancellation through the
// shell's uniform gate reported as CANCELLED (never a success).

const M = require('./helpers/core.cjs');

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + String(detail) : '')); }
}
async function bash(line, opts) {
  return await M.runShellCommand(line, null, opts || {});
}

async function run() {
  // ---------- SL1: success, silent, actually waits ----------
  {
    const t0 = Date.now();
    const r = await bash('sleep 0.05');
    const elapsed = Date.now() - t0;
    check('SL1 sleep 0.05 succeeds silently after >= 50ms',
      !r.isError && r.output === '' && elapsed >= 50,
      JSON.stringify({ isError: r.isError, output: r.output, elapsed }));
  }

  // ---------- SL2: bad usage fails immediately, without waiting ----------
  {
    const cases = ['sleep', 'sleep 0', 'sleep -1', 'sleep 61', 'sleep 1s', 'sleep abc', 'sleep 1 2'];
    let allFast = true, allUsage = true, allFailed = true;
    for (const line of cases) {
      const t0 = Date.now();
      const r = await bash(line);
      const elapsed = Date.now() - t0;
      if (r.isError === false) allFailed = false;
      if (!r.output.includes('usage: sleep <seconds>')) allUsage = false;
      if (elapsed >= 40) allFast = false;
    }
    check('SL2 bad usage fails', allFailed, cases.join(' / '));
    check('SL2b usage error text', allUsage);
    check('SL2c failures are immediate (no waiting)', allFast);
  }

  // ---------- SL3: 60 is the legal maximum (cancel trick proves the wait started) ----------
  {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 40);
    const t0 = Date.now();
    const r = await bash('sleep 60', { signal: ac.signal });
    const elapsed = Date.now() - t0;
    check('SL3 sleep 60 is accepted and cancellable (not a usage error)',
      r.isError && r.output === 'bash: cancelled' && elapsed < 5000,
      JSON.stringify({ isError: r.isError, output: r.output, elapsed }));
  }

  // ---------- SL4: cancellation during the wait is immediate and reported as cancelled ----------
  {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 30);
    const t0 = Date.now();
    const r = await bash('sleep 5', { signal: ac.signal });
    const elapsed = Date.now() - t0;
    check('SL4 cancelled wait ends immediately as cancelled',
      r.isError && r.output === 'bash: cancelled' && elapsed < 1000,
      JSON.stringify({ isError: r.isError, output: r.output, elapsed }));
  }
  {
    // pre-aborted signal: the gate fires before the wait starts
    const ac = new AbortController();
    ac.abort();
    const t0 = Date.now();
    const r = await bash('sleep 1', { signal: ac.signal });
    check('SL4b pre-aborted signal cancels immediately',
      r.isError && r.output === 'bash: cancelled' && Date.now() - t0 < 500,
      JSON.stringify({ isError: r.isError, output: r.output }));
  }

  // ---------- SL5: sleep is discoverable; curl help carries the new lines ----------
  {
    const help = await bash('help');
    check('SL5 help lists sleep', help.output.includes('sleep <seconds>'), help.output.slice(0, 200));
    const which = await bash('which sleep');
    check('SL5b which sleep resolves to /usr/bin/sleep',
      !which.isError && which.output === '/usr/bin/sleep', JSON.stringify(which.output));
    const prompt = M.shellSystemPromptSection();
    check('SL5c curl help carries the rate-limit line', prompt.includes(
      '  When calling the same API repeatedly, put "sleep 0.3" between calls; on HTTP 429 wait ("sleep 2") and retry at most 3 times.'));
    check('SL5d curl help carries the credentials line', prompt.includes(
      '  Credentials: write the variable, never the key: -H "Authorization: Bearer $NAME". It is resolved only for the address the credential is bound to.'));
    check('SL5e registry entry matches the contract',
      M.SHELL_COMMANDS.sleep
      && M.SHELL_COMMANDS.sleep.usage === 'sleep <seconds>'
      && M.SHELL_COMMANDS.sleep.summary === 'pause for a number of seconds (decimals allowed, max 60); use between repeated API calls to stay under rate limits'
      && M.SHELL_COMMANDS.sleep.stdin === false,
      JSON.stringify(M.SHELL_COMMANDS.sleep || null));
  }

  // sleep does not read stdin (registry-driven pipeline guard)
  {
    const r = await bash('echo hi | sleep 1');
    check('SL6 piping into sleep fails loudly',
      r.isError && r.output.includes('does not read stdin'), JSON.stringify(r.output));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.error('TEST RUNNER FAIL', e); process.exit(1); });
