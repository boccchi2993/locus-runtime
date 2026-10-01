// Pre-alpha runtime visibility boundary (R-NF04C) — RUNTIME SIDE.
//
// Invariant: UNPARSEABLE USER INPUT IS NOT SAFE DIAGNOSTIC TEXT — a
// malformed URL produces the bounded `invalid URL` error (code
// network_invalid_url, zero network attempts) and the raw input never
// reaches tool output.
//
// M3a (repository extraction) split: the source suite also pinned the
// provider-history/telemetry half (execution-location metadata never
// enters provider-visible results — its V5–V9) and the tool-adapter
// telemetry record (V4c/V4d/V10). Those live with the Harness/Product
// (AgentSession, nativeResultContent, executeTool's telemetry sink) and
// remain covered by the source repository's runtime-visibility suite;
// the Runtime has no execution telemetry at all (pinned by
// runtime-boundary). This migrated half covers everything the Runtime
// itself produces: the network error surface (V1–V3) and the bash tool
// output (V4/V4b) through the public session.
// Run: node tests/runtime-visibility.test.cjs

const M = require('./helpers/core.cjs');

// Browser-stub parity with the source suite: a hosted page (relay
// available). network.js reads window.location at request time only.
global.window = { location: { protocol: 'https:' } };

// The public entry assembles the session the bash checks drive.
const { createRuntime } = require('../src/index.js');
const __hostPromise = createRuntime({
  workerAssets: { pyWorkerSource: '/* not booted in this suite */', grepWorkerSource: '/* not booted in this suite */' },
});
let __host = null;
let __session = null;

let passed = 0, failed = 0;

function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + detail : '')); }
}

async function errOf(promise) {
  try { await promise; return null; } catch (e) { return e; }
}

function newVfs() {
  return new M.VirtualWorkspace({ listCommands: () => Object.keys(M.SHELL_COMMANDS) });
}

// The Runtime-shaped bash execution (the Product executeTool adapter maps
// this into the model-visible result; output text is Runtime-produced).
const exec = (input, workspace, opts) => __session.execute({
  kind: 'shell',
  input,
  context: Object.assign({ filesystem: workspace }, opts || {}),
}).then((res) => ({ output: res.output, success: !!res.ok, isError: !!res.isError }));

async function run() {
  __host = await __hostPromise;
  __session = __host.createSession();
  // ================= R-NF04C: malformed URL is never echoed raw =================

  // --- V1. the runtime error itself is the bounded constant ---
  {
    const MALFORMED = 'ht tp://example.com/?token=SECRET_INVALID_URL_123';
    const e = await errOf(M.NetworkRuntime.request({ url: MALFORMED }));
    check('V1 malformed URL → network_invalid_url',
      e && e.networkCode === 'network_invalid_url', e && (e.message || String(e)));
    check('V1b error message is the bounded constant', e && e.message === 'invalid URL',
      JSON.stringify(e && e.message));
    check('V1c raw input never echoed', e && e.message.indexOf('SECRET_INVALID_URL_123') === -1
      && e.message.indexOf('ht tp') === -1, JSON.stringify(e && e.message));

    // Parse failure happens BEFORE any attempt or approval: with a
    // side-effecting method and no authorization port wired, the invalid
    // URL diagnosis still wins (an attempt would demand approval first).
    // (M3a: the old suite passed a dead `policyContext` field here — the
    // pre-M2a shape — which was inert; the wired-less POST is the same
    // assertion without the leftover field.)
    const pe = await errOf(M.NetworkRuntime.request({
      method: 'POST',
      url: MALFORMED,
    }));
    check('V1d parse failure precedes approval and any attempt',
      pe && pe.networkCode === 'network_invalid_url', pe && pe.networkCode);
  }

  // --- V2. every malformed shape gets the same bounded deterministic error ---
  {
    const VARIANTS = [
      ['space-in-scheme', 'ht tp://example.com/?token=SECRET_VAR_SPACE'],
      ['space-in-host', 'https://exa mple.com/?x=SECRET_VAR_HOST'],
      ['missing-scheme', '://SECRET_VAR_NOSCHEME'],
      ['bad-ipv6', 'https://[invalid-ipv6]/?token=SECRET_VAR_IPV6'],
      ['control-char', 'ht\x01tp://example.com/?token=SECRET_VAR_CTRL'],
      ['del-in-host', 'https://exa\x7fmple.com/?token=SECRET_VAR_DEL'],
    ];
    for (const [label, raw] of VARIANTS) {
      const ve = await errOf(M.NetworkRuntime.request({ url: raw }));
      check('V2 ' + label + ' → bounded invalid URL',
        ve && ve.networkCode === 'network_invalid_url' && ve.message === 'invalid URL',
        JSON.stringify(ve && ve.message));
      check('V2b ' + label + ' sentinel never echoed',
        ve && ve.message.indexOf('SECRET_VAR_') === -1, JSON.stringify(ve && ve.message));
    }
    // An OVERLONG URL that WHATWG still accepts fails later, at dispatch —
    // that failure must ALSO be bounded: a classified code, a constant
    // length message, and never the raw input (R-NF04C §boundedness).
    const long = await errOf(M.NetworkRuntime.request({
      url: 'https://' + 'a'.repeat(1048576) + '/?token=SECRET_VAR_LONG',
    }));
    check('V2c overlong URL fails classified, never echoing the input',
      long && typeof long.networkCode === 'string'
      && long.message.length <= 120
      && long.message.indexOf('SECRET_VAR_LONG') === -1
      && long.message.indexOf('aaaa') === -1,
      JSON.stringify(long && long.message));
  }

  // --- V3. parseable URL display drops query secrets (regression) ---
  {
    check('V3 safe display keeps origin+path, drops the query',
      M.safeNetworkUrlForDisplay('https://example.com/path?token=SECRET_QUERY_123')
        === 'https://example.com/path');
  }

  // --- V4. the bash tool output never sees the sentinel ---
  {
    const res = await exec('curl "ht tp://example.com/?token=SECRET_INVALID_URL_123"', newVfs());
    check('V4 tool fails with bounded output mentioning invalid URL',
      res.success === false && res.output.includes('invalid URL'), JSON.stringify(res.output));
    check('V4b tool output never echoes the sentinel or the raw input',
      res.output.indexOf('SECRET_INVALID_URL_123') === -1 && res.output.indexOf('ht tp') === -1,
      JSON.stringify(res.output));
    // M3a: V4c/V4d (the tool-adapter telemetry record) are Product-side
    // coverage now; the Runtime result itself is the boundary above.
  }
}

run().then(() => {
  console.log('---');
  console.log(failed ? failed + ' check(s) FAILED' : passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}).catch((e) => {
  console.error(e && e.stack || e);
  process.exit(1);
});
