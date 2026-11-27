// `mcp` shell command tests (node, mocked fetch — no network).
// Run: node tests/shell-mcp.test.cjs
// Covers the command layer (C3 §4, §11): the no-port refusal, usage
// errors, `mcp servers` listing, `tools`/`describe` output shapes, `call`
// with inline JSON and @args.json, the result JSON shaping, the §4.1
// registration contract (help / which / system prompt) and the
// stdin:false rule — all driven through the real shell executor.

const M = require('./helpers/core.cjs');

const unhandled = [];
process.on('unhandledRejection', (e) => { unhandled.push(e); });

// --- fetch mock (the same shape as tests/mcp-client.test.cjs) ---
const calls = [];
const routes = [];
function on(match, respond) { routes.push({ match, respond }); }
function resetServer() { calls.length = 0; routes.length = 0; }
global.fetch = async (url, opts) => {
  const rawBody = opts && opts.body;
  const call = {
    url: String(url),
    method: (opts && opts.method) || 'GET',
    headers: (opts && opts.headers) || {},
    body: rawBody == null ? null
      : typeof rawBody === 'string' ? JSON.parse(rawBody)
        : JSON.parse(new TextDecoder('utf-8').decode(rawBody instanceof Uint8Array
          ? rawBody : new Uint8Array(rawBody))),
  };
  calls.push(call);
  for (const r of routes) {
    if (r.match(call)) return r.respond(call);
  }
  throw new TypeError('no mock route for ' + url);
};
const enc = new TextEncoder();
const byMethod = (m) => (c) => !!(c.body && c.body.method === m);
const countBody = (m) => calls.filter((c) => c.body && c.body.method === m).length;
function jsonRpc(result, id) {
  const wire = { jsonrpc: '2.0' };
  if (id !== undefined) wire.id = id;
  wire.result = result;
  return new Response(JSON.stringify(wire),
    { status: 200, headers: { 'content-type': 'application/json' } });
}
function onHappyHandshake(tool) {
  on(byMethod('initialize'), (c) => jsonRpc({
    protocolVersion: '2025-06-18',
    capabilities: { tools: {} },
    serverInfo: { name: 't', version: '1' },
  }, c.body.id));
  on(byMethod('notifications/initialized'), () => new Response(null, { status: 202 }));
  on(byMethod('tools/list'), (c) => jsonRpc({ tools: tool ? [tool] : [], nextCursor: null }, c.body.id));
  on(byMethod('tools/call'), (c) => jsonRpc({
    content: [{ type: 'text', text: '{"hits":12,"top":"Q3 report"}' }],
    structuredContent: { hits: 12, top: 'Q3 report' },
    isError: false,
  }, c.body.id));
}

// --- fixtures ---
const URL_ = 'https://mcp.acme.test/mcp';
const TOOL = {
  name: 'search',
  title: 'Search documents',
  description: 'Search the Acme docs.\nLonger second line.',
  inputSchema: {
    type: 'object',
    properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1 } },
    required: ['query'],
  },
  annotations: { readOnlyHint: true },
  _meta: { internal: 'strip me' },
};
function fakePort(servers, opts) {
  const o = opts || {};
  return {
    servers: async () => servers,
    setState: o.setState || (() => {}),
    elicit: async () => ({ action: 'cancel' }),
    beforeToolCall: o.beforeToolCall,
  };
}
const rec = (extra) => Object.assign({
  id: 'acme', displayName: 'Acme Documents', url: URL_,
  auth: 'bearer', credential: null, state: 'connected',
}, extra);

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + String(detail) : '')); }
}
async function bash(line, opts, workspace) {
  return await M.runShellCommand(line, workspace === undefined ? null : workspace, opts || {});
}
// Separated stdout/stderr: runPipeline propagates the handler's
// { success, stdout, stderr, network } exactly (runShellCommand merges
// the streams into one output for presentation).
async function sh(line, opts, workspace) {
  const vfs = workspace || new M.VirtualWorkspace({ listCommands: () => Object.keys(M.SHELL_COMMANDS) });
  const ctx = { vfs: vfs, opts: opts || {}, cwd: vfs.defaultCwd() };
  const steps = M.parseShellLine(M.shellTokenize(line));
  return await M.runPipeline(steps[0].pipeline, ctx);
}

async function run() {
  // ---------- registration contract (§4.1) ----------
  check('R1 mcp is registered in SHELL_COMMANDS', 'mcp' in M.SHELL_COMMANDS);
  check('R2 mcp does not read pipeline stdin', M.SHELL_COMMANDS.mcp.stdin === false);
  check('R3 help lists mcp', M.shellHelpText().includes('mcp servers'));
  check('R4 which resolves mcp', (await bash('which mcp')).output === '/usr/bin/mcp');
  const prompt = M.shellSystemPromptSection();
  check('R5 system prompt carries the mcp block after curl',
    prompt.includes("mcp usage (tools on external servers that the user connected")
    && prompt.includes("mcp describe <server> <tool>  shows one tool's description and inputSchema.")
    && prompt.includes('Settings → Capabilities; you cannot connect it.')
    && prompt.indexOf('mcp usage') > prompt.indexOf('curl usage'),
    '');
  check('R6 the registry key set includes mcp', Object.keys(M.SHELL_COMMANDS).includes('mcp'));

  // ---------- no port (§4.1) ----------
  {
    for (const line of ['mcp servers', 'mcp tools acme', 'mcp describe acme search',
      "mcp call acme search '{}'", 'mcp', 'mcp bogus']) {
      const r = await bash(line, {});
      check('NP no port → not available: ' + line,
        r.isError && r.output === 'mcp: MCP is not available in this task', r.output);
    }
  }

  // ---------- usage errors (§4.7) ----------
  const port1 = fakePort([rec()]);
  const opts1 = { mcp: port1 };
  {
    const usage = 'usage: mcp servers | mcp tools <server> | mcp describe <server> <tool>'
      + " | mcp call <server> <tool> '<json>' | mcp call <server> <tool> @args.json";
    for (const line of ['mcp', 'mcp bogus', 'mcp servers extra', 'mcp tools',
      'mcp tools a b', 'mcp describe a', 'mcp describe a b c', 'mcp call a']) {
      const r = await bash(line, opts1);
      check('U usage error: ' + line, r.isError && r.output === usage, r.output);
    }
    resetServer();
    const r = await bash('mcp call a b', opts1);
    check('U call with omitted arguments is valid usage (server lookup fails)',
      r.isError && r.output === 'mcp: unknown server: a. Run mcp servers to list'
      + ' the servers of this task.', r.output);
    check('U usage errors never touch the network', calls.length === 0);
  }

  // ---------- mcp servers (§4.2) ----------
  {
    const r = await sh('mcp servers', { mcp: fakePort([]) });
    check('SV1 zero servers → the spec line, success',
      r.success && r.stdout === 'No MCP servers are connected in this task.', r.stdout);
  }
  {
    const port = fakePort([
      rec({ id: 'zeta', displayName: 'Zeta' }),
      rec({ id: 'alpha', displayName: 'Alpha' }),
      rec({ id: 'mid', displayName: 'Mid', state: 'needs-connection' }),
      rec({ id: 'old', displayName: 'Old', state: 'unavailable', reason: 'no-endpoint' }),
    ]);
    const r = await sh('mcp servers', { mcp: port });
    const lines = r.stdout.split('\n');
    check('SV2 sorted by id, one line per server, state column, reason in parens',
      r.success && lines[0] === 'alpha  connected  Alpha'
      && lines[1] === 'mid  needs-connection  Mid'
      && lines[2] === 'old  unavailable (no-endpoint)  Old'
      && lines[3] === 'zeta  connected  Zeta', r.stdout);
    check('SV3 needs-connection hint on stderr, command still succeeds',
      r.stderr === 'Servers marked needs-connection must be connected by the user'
      + ' in Settings → Capabilities.', r.stderr);
    check('SV4 servers is a local read — no network', calls.length === 0);
  }

  // ---------- mcp tools (§4.3) ----------
  {
    resetServer();
    onHappyHandshake(TOOL);
    const r = await sh('mcp tools acme', { mcp: fakePort([rec()]) });
    check('T1 tools lists name + first description line',
      r.success && r.stdout === 'search  Search the Acme docs.', r.stdout);
  }
  {
    resetServer();
    onHappyHandshake({ name: 'notitle', inputSchema: {} });
    const r = await sh('mcp tools acme', { mcp: fakePort([rec()]) });
    check('T2 no description → name only (no title on that tool)', r.stdout === 'notitle', r.stdout);
  }
  {
    resetServer();
    onHappyHandshake(null);
    const r = await sh('mcp tools acme', { mcp: fakePort([rec()]) });
    check('T3 tool-less server → the spec line, success',
      r.success && r.stdout === 'Server acme offers no tools.', r.stdout);
  }
  {
    resetServer();
    onHappyHandshake(null);
    const r = await bash('mcp tools ghost', { mcp: fakePort([rec()]) });
    check('T4 unknown server → spec message, failure, no network',
      r.isError && r.output === 'mcp: unknown server: ghost. Run mcp servers to list'
      + ' the servers of this task.' && calls.length === 0, r.output);
  }
  {
    const r = await bash('mcp tools acme', { mcp: fakePort([rec({ state: 'needs-connection' })]) });
    check('T5 needs-connection → spec message, no network',
      r.isError && r.output === 'mcp: server acme is not connected — the user can connect it'
      + ' in Settings → Capabilities. You cannot connect it.' && calls.length === 0, r.output);
  }
  {
    const r = await bash('mcp tools acme', { mcp: fakePort([rec({
      state: 'unavailable', reason: 'unsupported-protocol' })]) });
    check('T6 permanent unavailable → spec message with reason',
      r.isError && r.output === 'mcp: server acme cannot be used: unsupported-protocol', r.output);
  }

  // ---------- mcp describe (§4.4) ----------
  {
    resetServer();
    onHappyHandshake(TOOL);
    const r = await sh('mcp describe acme search', { mcp: fakePort([rec()]) });
    const parsed = JSON.parse(r.stdout);
    const keys = Object.keys(parsed);
    check('D1 describe outputs two-space JSON with fixed key order and no _meta',
      !r.isError && keys[0] === 'name' && keys[1] === 'title'
      && keys[2] === 'description' && keys[3] === 'inputSchema'
      && keys[4] === 'annotations' && !('title' in parsed && !('title' in TOOL))
      && !('_meta' in parsed) && r.stdout.includes('\n  "name": "search"'),
      r.stdout);
  }
  {
    resetServer();
    onHappyHandshake(TOOL);
    const r = await bash('mcp describe acme nope', { mcp: fakePort([rec()]) });
    check('D2 missing tool → spec message',
      r.isError && r.output === 'mcp: server acme has no tool named nope; run mcp tools acme',
      r.output);
  }

  // ---------- mcp call (§4.5) ----------
  {
    resetServer();
    onHappyHandshake(TOOL);
    const r = await sh("mcp call acme search '{\"query\":\"quarterly report\"}'",
      { mcp: fakePort([rec()]) });
    const parsed = JSON.parse(r.stdout);
    check('C1 inline JSON call → stdout is the shaped result object',
      r.success && JSON.stringify(parsed) === JSON.stringify({
        content: [{ type: 'text', text: '{"hits":12,"top":"Q3 report"}' }],
        structuredContent: { hits: 12, top: 'Q3 report' },
        isError: false,
      }), r.stdout);
    check('C2 the wire request carried the validated arguments',
      countBody('tools/call') === 1
      && calls.find((c) => c.body.method === 'tools/call').body.params.arguments.query === 'quarterly report');
    check('C3 telemetry reports the network backend', r.network
      && r.network.backend === 'browser-direct', JSON.stringify(r.network));
  }
  {
    resetServer();
    onHappyHandshake({ name: 'search', description: 'd', inputSchema: { type: 'object' } });
    const r = await sh('mcp call acme search', { mcp: fakePort([rec()]) });
    check('C4 omitted arguments → {} on the wire',
      r.success
      && JSON.stringify(calls.find((c) => c.body.method === 'tools/call').body.params.arguments) === '{}',
      r.stdout + ' | ' + JSON.stringify(calls[calls.length - 1] && calls[calls.length - 1].body));
  }
  {
    // argument validation refuses before the send
    resetServer();
    onHappyHandshake(TOOL);
    const r = await bash("mcp call acme search '{\"wrong\":1}'", { mcp: fakePort([rec()]) });
    check('C5 schema mismatch → failure, nothing sent (root pointer is the empty string)',
      r.isError
      && r.output === "mcp: arguments do not match the tool's inputSchema: "
        + ': missing required property "query"'
      && countBody('tools/call') === 0,
      r.output);
  }
  {
    resetServer();
    onHappyHandshake(TOOL);
    for (const bad of ["'[]'", "'\"str\"'", "'not json'"]) {
      const r = await bash('mcp call acme search ' + bad, { mcp: fakePort([rec()]) });
      check('C6 non-object arguments refused locally: ' + bad,
        r.isError && r.output === 'mcp: arguments must be a JSON object' && calls.length === 0,
        r.output);
    }
  }
  {
    // @args.json — written through the real VFS
    resetServer();
    onHappyHandshake(TOOL);
    const ws = new M.VirtualWorkspace({ listCommands: () => Object.keys(M.SHELL_COMMANDS) });
    await ws.write('/tmp/args.json', '{"query":"from file"}');
    const r = await sh('mcp call acme search @/tmp/args.json',
      { mcp: fakePort([rec()]) }, ws);
    check('C7 @args.json read from the VFS and sent',
      r.success && JSON.stringify(calls.find((c) => c.body.method === 'tools/call')
        .body.params.arguments) === '{"query":"from file"}', r.output);
    const callsBefore = countBody('tools/call');
    const r2 = await bash('mcp call acme search @/tmp/missing.json',
      { mcp: fakePort([rec()]) }, ws);
    check('C8 missing args file → failure, no network',
      r2.isError && r2.output === 'mcp: cannot read @/tmp/missing.json'
      + ': no such file or directory' && countBody('tools/call') === callsBefore, r2.output);
    await ws.write('/tmp/big.json', 'x'.repeat(1024 * 1024 + 1));
    const r3 = await bash('mcp call acme search @/tmp/big.json',
      { mcp: fakePort([rec()]) }, ws);
    check('C9 oversized args file refused before reading into the call',
      r3.isError && /cannot read @\/tmp\/big\.json: file exceeds the 1048576-byte/
        .test(r3.output) && countBody('tools/call') === callsBefore, r3.output);
    await ws.write('/tmp/bad.json', 'nope');
    const r4 = await bash('mcp call acme search @/tmp/bad.json',
      { mcp: fakePort([rec()]) }, ws);
    check('C10 non-JSON args file → cannot read',
      r4.isError && /the file is not valid JSON/.test(r4.output), r4.output);
  }
  {
    // isError:true → JSON on stdout, stderr line, failure
    resetServer();
    on(byMethod('initialize'), (c) => jsonRpc({
      protocolVersion: '2025-06-18', capabilities: { tools: {} },
      serverInfo: { name: 't', version: '1' } }, c.body.id));
    on(byMethod('notifications/initialized'), () => new Response(null, { status: 202 }));
    on(byMethod('tools/list'), (c) => jsonRpc({ tools: [TOOL], nextCursor: null }, c.body.id));
    on(byMethod('tools/call'), (c) => jsonRpc({
      content: [{ type: 'text', text: 'tool broke' }], isError: true }, c.body.id));
    const r = await sh("mcp call acme search '{\"query\":\"x\"}'", { mcp: fakePort([rec()]) });
    const parsed = JSON.parse(r.stdout);
    check('C11 isError result: JSON on stdout, stderr note, command fails',
      !r.success && parsed.isError === true && parsed.content[0].text === 'tool broke'
      && r.stderr === 'mcp: tool search reported an error', r.stderr);
  }
  {
    // content shaping: image/audio/blob-resource described, not inlined
    resetServer();
    on(byMethod('initialize'), (c) => jsonRpc({
      protocolVersion: '2025-06-18', capabilities: { tools: {} },
      serverInfo: { name: 't', version: '1' } }, c.body.id));
    on(byMethod('notifications/initialized'), () => new Response(null, { status: 202 }));
    on(byMethod('tools/list'), (c) => jsonRpc({ tools: [TOOL], nextCursor: null }, c.body.id));
    on(byMethod('tools/call'), (c) => jsonRpc({
      content: [
        { type: 'text', text: 'report' },
        { type: 'image', mimeType: 'image/png', data: 'AAAA' },
        { type: 'audio', mimeType: 'audio/wav', data: 'BBBB' },
        { type: 'resource', resource: { uri: 'file:///x.bin', mimeType: 'application/octet-stream', blob: 'CCCC' } },
        { type: 'resource', resource: { uri: 'file:///y.txt', mimeType: 'text/plain', text: 'kept' } },
      ],
      isError: false, _meta: { strip: true },
    }, c.body.id));
    const r = await sh("mcp call acme search '{\"query\":\"x\"}'", { mcp: fakePort([rec()]) });
    const parsed = JSON.parse(r.stdout);
    check('C12 binary parts become descriptions; text resource kept; _meta dropped',
      JSON.stringify(parsed.content) === JSON.stringify([
        { type: 'text', text: 'report' },
        { type: 'image', mimeType: 'image/png', dataOmitted: true },
        { type: 'audio', mimeType: 'audio/wav', dataOmitted: true },
        { type: 'resource', resource: { uri: 'file:///x.bin', mimeType: 'application/octet-stream', dataOmitted: true } },
        { type: 'resource', resource: { uri: 'file:///y.txt', mimeType: 'text/plain', text: 'kept' } },
      ]) && !('_meta' in parsed), r.stdout);
  }

  // ---------- approval hook through the shell (§7.1) ----------
  {
    resetServer();
    onHappyHandshake(TOOL);
    const r = await bash("mcp call acme search '{\"query\":\"x\"}'", {
      mcp: fakePort([rec()], { beforeToolCall: () => ({ outcome: 'deny' }) }),
    });
    check('A1 denied by the hook → spec message, nothing sent',
      r.isError && r.output === 'mcp: call denied by user; nothing was sent'
      && countBody('tools/call') === 0, r.output);
  }
  {
    resetServer();
    onHappyHandshake(TOOL);
    const r = await bash("mcp call acme search '{\"query\":\"x\"}'", {
      mcp: fakePort([rec()], { beforeToolCall: () => { throw new Error('x'); } }),
    });
    check('A2 failing hook → approval failed, nothing sent',
      r.isError && r.output === 'mcp: approval check failed; nothing was sent'
      && countBody('tools/call') === 0, r.output);
  }

  // ---------- cancellation through the shell (§6.6) ----------
  {
    resetServer();
    on(byMethod('initialize'), (c) => jsonRpc({
      protocolVersion: '2025-06-18', capabilities: { tools: {} },
      serverInfo: { name: 't', version: '1' } }, c.body.id));
    on(byMethod('notifications/initialized'), () => new Response(null, { status: 202 }));
    on(byMethod('tools/list'), (c) => jsonRpc({ tools: [TOOL], nextCursor: null }, c.body.id));
    on(byMethod('tools/call'), () => new Response(
      new ReadableStream({ start() { return new Promise(() => {}); } }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    const ac = new AbortController();
    const port = fakePort([rec()]);
    const p = bash("mcp call acme search '{\"query\":\"x\"}'", { mcp: port, signal: ac.signal });
    await new Promise((r2) => setTimeout(r2, 60));
    ac.abort(new Error('stop'));
    const r = await p;
    check('X1 cancelled after send → the may-have-processed wording rides the detail'
      + ' + bash: cancelled',
      r.isError && r.output.includes('mcp: cancelled — tools/call was sent to acme')
      && r.output.includes('not rolled back') && r.output.includes('bash: cancelled'),
      r.output);
    check('X1 notifications/cancelled went out',
      countBody('notifications/cancelled') === 1);
  }

  // ---------- session reuse within one task (§6.5) ----------
  {
    resetServer();
    onHappyHandshake(TOOL);
    const port = fakePort([rec()]);
    const o = { mcp: port };
    await bash('mcp tools acme', o);
    await bash("mcp call acme search '{\"query\":\"x\"}'", o);
    check('S1 one handshake per task, shared across commands',
      countBody('initialize') === 1 && countBody('tools/list') === 1
      && countBody('tools/call') === 1,
      'init=' + countBody('initialize') + ' list=' + countBody('tools/list')
      + ' call=' + countBody('tools/call'));
  }

  // ---------- unhandled rejections ----------
  await new Promise((r2) => setTimeout(r2, 30));
  check('X0 no unhandled rejections', unhandled.length === 0,
    unhandled.map((e) => e && e.message).join('; '));

  console.log('---');
  console.log(failed ? failed + ' check(s) FAILED' : 'all ' + passed + ' checks passed');
  process.exit(failed ? 1 : 0);
}

run().catch((e) => {
  console.error('SUITE ERROR:', e);
  process.exit(2);
});
