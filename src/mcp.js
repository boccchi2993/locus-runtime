// ============================================================
//  MCP CLIENT — Streamable HTTP (C3 second phase, spec draft v1)
//
//  Implements the runtime side of docs/C3-MCP-STREAMABLE-HTTP.md:
//  a per-task MCP client behind the shell command `mcp`
//  (servers / tools / describe / call, D4), speaking the candidate
//  protocol revisions 2025-06-18 / 2025-11-25: initialize handshake,
//  negotiated protocol-version header, task-scoped sessions, POST
//  responses as JSON or incremental SSE, server-initiated form
//  elicitation on the tools/call stream, prompt cancellation and
//  task-end cleanup.
//
//  BOUNDARY RULES (D1–D4, C3 §5.6):
//    - the bearer token exists only in host memory. It is resolved
//      through the C3 credential port (context.credentials.value)
//      once per request, at send time, and only after the runtime
//      re-checked the endpoint against the confirmed URL and the
//      credential's binding (origin + pathPrefix). It never enters
//      VFS, tool output, errors, or telemetry, and it is redacted
//      from every response before the result leaves this module —
//      at the event boundary for SSE, so a value split across
//      network chunks is still caught before any parse.
//    - the session id lives in memory for one task only; it is sent
//      only to the endpoint that issued it.
//    - tools/call is sent EXACTLY ONCE. Every post-dispatch failure
//      is reported as an unknown outcome — never retried, never
//      re-routed (C3 §6.8).
//    - the approval hook (§7.1) sits after argument validation and
//      before the send; without a port the default is allow.
//
//  TRANSPORT: this revision implements the browser-direct backend
//  only (incremental JSON and SSE), per the transport measurement in
//  tools/mcp-transport-verify — direct × SSE streams before the
//  upstream closes; through the buffered NetworkRuntime.request()
//  path it would not (D-S3/C-S4). Direct cross-origin requests need
//  the server's CORS preflight to allow the MCP request headers and
//  Access-Control-Expose-Headers to include Mcp-Session-Id, otherwise
//  the session id is unreadable (D-J2 in the measurement). The relay
//  route is left to the product integration step.
// ============================================================

import {
  NetworkRuntime,
  NETWORK_MAX_RESPONSE_BYTES,
  DirectTransportFailure,
  openDirectIncremental,
  fetchWithDeadline,
  filterRequestHeaders,
} from './network.js';
import { resolveShellPath } from './shell.js';

// Supported protocol revisions (C3 §6.3): the newest one is sent with
// `initialize`; the server's pick is adopted when it is in this set.
export const MCP_PROTOCOL_VERSIONS = Object.freeze(['2025-06-18', '2025-11-25']);
// Client identity sent with initialize (C3 §6.3: independent of the
// product version).
export const MCP_CLIENT_INFO = Object.freeze({ name: 'locus', version: '1' });

// Engineering defaults (C3 §10.1 table — owner review requested).
// requestTimeoutMs / relayRequestTimeoutMs / maxResponseBytes reuse the
// NetworkRuntime constants; maxArgsFileBytes must equal shell.js
// SHELL_PIPE_MAX_BYTES — a local literal keeps the module cycle-safe
// (src/shell.js imports this module), and tests/mcp-client.test.cjs
// pins the equality.
export const MCP_LIMITS = Object.freeze({
  requestTimeoutMs: NetworkRuntime.directTimeoutMs,
  relayRequestTimeoutMs: NetworkRuntime.relayClientTimeoutMs,
  maxResponseBytes: NETWORK_MAX_RESPONSE_BYTES,
  maxSseEventBytes: 4 * 1024 * 1024,
  maxArgsFileBytes: 1024 * 1024,
  toolsListMaxPages: 10,
  maxElicitationsPerCall: 5,
  inputSchemaMaxBytes: 64 * 1024,
  inputSchemaMaxNodes: 20000,
  inputSchemaMaxDepth: 64,
  elicitationMessageMaxChars: 4096,
  elicitationSchemaMaxBytes: 64 * 1024,
  elicitationSchemaMaxProperties: 32,
  cancelNotifyTimeoutMs: 2000,
});

const CREDENTIAL_REDACTED = '[credential redacted]';
const RPC_METHOD_NOT_FOUND = -32601;
const RPC_INVALID_PARAMS = -32602;

// ------------------------------------------------------------
//  Errors. `message` is the final model-facing wording (C3 §4.7);
//  `mcpCode` is a stable token for tests and the shell mapping;
//  `lostReason` marks a POST-DISPATCH loss of a tools/call — the call
//  was sent and no usable result came back, so the outcome is unknown
//  and the request is never re-sent (C3 §6.8).
// ------------------------------------------------------------
class McpError extends Error {
  constructor(code, message, lostReason) {
    super(message);
    this.name = 'McpError';
    this.mcpCode = code;
    if (lostReason) this.lostReason = lostReason;
  }
}

function errOf(code, message, lostReason) {
  return new McpError(code, message, lostReason);
}

// Shell-uniform cancellation error (same shape as shell.js
// makeCancelledError — recognized by isCancelledError) with the C3 §4.7
// wording riding on `detail`, like rm/mv's committed-work reports.
function makeMcpCancelled(detail) {
  const e = new Error('mcp cancelled');
  e.name = 'AbortError';
  e.cancelled = true;
  if (detail) e.detail = detail;
  return e;
}

function isCancelledShape(e) {
  return !!e && (e.cancelled === true || e.name === 'AbortError');
}

function throwIfCancelledLocal(signal) {
  if (signal && signal.aborted) throw makeMcpCancelled(null);
}

function unreachableMsg(serverId, reason) {
  return 'mcp: server ' + serverId + ' is unreachable (' + reason
    + '); the connection is kept and the next call retries';
}

// ------------------------------------------------------------
//  SSE decoder (C3 §6.4): WHATWG event-stream rules, incremental.
//  push(bytes) → JSON-RPC messages dispatched by completed events;
//  end() → the trailing event without a final blank line. UTF-8 is
//  decoded with a streaming decoder so a multibyte character split
//  across network chunks survives; a single event is capped. An
//  optional redactor runs on each event's data BEFORE JSON.parse —
//  the credential shield needs the complete event, not a chunk.
// ------------------------------------------------------------
export function createSseDecoder(opts) {
  const maxEventBytes = opts && Number.isFinite(opts.maxEventBytes)
    ? opts.maxEventBytes : MCP_LIMITS.maxSseEventBytes;
  const redactor = opts && typeof opts.redactor === 'function' ? opts.redactor : null;
  const decoder = new TextDecoder('utf-8');
  let lineBuf = '';
  let pendingBytes = 0;
  let dataLines = null; // data fields of the event being accumulated
  let finished = false;

  function dispatch() {
    const lines = dataLines;
    dataLines = null;
    pendingBytes = 0;
    if (!lines || !lines.length) return [];
    let data = lines.join('\n');
    if (data === '') return []; // an event with empty data is ignored
    if (redactor) {
      try {
        data = redactor(data);
      } catch (e) { /* a redactor failure must not corrupt dispatch */ }
    }
    let msg;
    try {
      msg = JSON.parse(data);
    } catch (e) {
      throw errOf('malformed', 'event data is not valid JSON');
    }
    return [msg];
  }

  function handleLine(line, out) {
    if (line === '') {
      for (const m of dispatch()) out.push(m);
      return;
    }
    if (line.charAt(0) === ':') return; // comment line
    let field = line;
    let value = '';
    const colon = line.indexOf(':');
    if (colon !== -1) {
      field = line.slice(0, colon);
      value = line.slice(colon + 1);
      if (value.charAt(0) === ' ') value = value.slice(1);
    }
    if (field === 'data') {
      if (!dataLines) dataLines = [];
      dataLines.push(value);
    }
    // event:, id:, retry: and unknown fields do not take part in
    // dispatch (no resumability in this revision — C3 §6.4).
  }

  function feedText(text, isFinal, out) {
    let line = lineBuf;
    let i = 0;
    while (i < text.length) {
      const ch = text.charAt(i);
      if (ch === '\r' || ch === '\n') {
        let j = i + 1;
        if (ch === '\r') {
          if (j < text.length && text.charAt(j) === '\n') j++;
          else if (j >= text.length && !isFinal) {
            // A CR at the very end of this chunk may pair with the LF
            // of the next chunk — hold it until more text arrives.
            break;
          }
        }
        handleLine(line, out);
        line = '';
        i = j;
      } else {
        line += ch;
        i++;
      }
    }
    lineBuf = line;
  }

  return {
    // Feed one network chunk; returns the JSON-RPC messages of every
    // event completed by it.
    push(bytes) {
      if (finished) throw errOf('malformed', 'the stream already ended');
      const chunk = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || 0);
      pendingBytes += chunk.byteLength;
      if (pendingBytes > maxEventBytes) {
        throw errOf('too-large', 'a single SSE event exceeds the '
          + maxEventBytes + '-byte limit', 'response too large');
      }
      const text = decoder.decode(chunk, { stream: true });
      const out = [];
      feedText(text, false, out);
      return out;
    },
    // Flush the stream end: the trailing line without a terminator and
    // the trailing event without a blank line still dispatch.
    end() {
      if (finished) return [];
      finished = true;
      const tail = decoder.decode(); // flush a split multibyte character
      const out = [];
      if (lineBuf !== '') {
        const held = lineBuf;
        lineBuf = '';
        handleLine(held, out);
      }
      feedText(tail, true, out);
      for (const m of dispatch()) out.push(m);
      return out;
    },
  };
}

// ------------------------------------------------------------
//  Argument validation against a tool's inputSchema (C3 §4.6).
//  Bounded and always-terminating: the schema comes from an untrusted
//  server, so `pattern` / `format` are deliberately NOT evaluated
//  locally (a server-supplied regex on the main thread is a DoS), and
//  the schema itself has size / node / depth budgets. `$ref` is
//  accepted only as an internal JSON Pointer into the same schema.
//
//  → null (passes) | { pointer, reason } (mismatch)
//                  | { unsupported: reason } (schema cannot be checked)
// ------------------------------------------------------------
export function validateToolArguments(schema, value) {
  // Boolean schemas: true accepts everything, false rejects everything.
  if (schema === true) return null;
  if (schema === false) {
    return { pointer: '', reason: 'the schema rejects every value' };
  }
  if (schema == null) return null; // no inputSchema: nothing to enforce locally
  if (typeof schema !== 'object' || Array.isArray(schema)) {
    return { unsupported: 'the inputSchema is not a JSON object' };
  }

  let serialized;
  try {
    serialized = JSON.stringify(schema);
  } catch (e) {
    return { unsupported: 'the inputSchema cannot be serialized' };
  }
  if (serialized && serialized.length > MCP_LIMITS.inputSchemaMaxBytes) {
    return { unsupported: 'the schema exceeds ' + MCP_LIMITS.inputSchemaMaxBytes + ' bytes' };
  }

  let nodes = 0;
  const root = schema;

  // Structural pre-scan of the WHOLE schema, independent of the value:
  // the size/node/depth budgets are properties of the schema (C3 §4.6),
  // so a hostile schema is refused before any value is examined. The
  // walk is bounded by the same budgets, so it always terminates — a
  // $ref cycle burns the node budget instead of looping forever.
  function scan(node, depth) {
    if (++nodes > MCP_LIMITS.inputSchemaMaxNodes) {
      return { unsupported: 'the schema exceeds ' + MCP_LIMITS.inputSchemaMaxNodes + ' nodes' };
    }
    if (depth > MCP_LIMITS.inputSchemaMaxDepth) {
      return {
        unsupported: 'the schema is deeper than ' + MCP_LIMITS.inputSchemaMaxDepth + ' levels',
      };
    }
    if (node === true || node === false || node == null || typeof node !== 'object') {
      return null;
    }
    if (Array.isArray(node)) {
      for (const sub of node) {
        const r = scan(sub, depth + 1);
        if (r) return r;
      }
      return null;
    }
    for (const key of Object.keys(node)) {
      if (key === '$ref') {
        const ref = node.$ref;
        if (typeof ref !== 'string' || ref.charAt(0) !== '#') {
          return { unsupported: '$ref points outside the schema' };
        }
        const r = resolveRef(node);
        if (r.unsupported) return { unsupported: r.unsupported };
        const rr = scan(r.target, depth + 1);
        if (rr) return rr;
        continue;
      }
      const r = scan(node[key], depth + 1);
      if (r) return r;
    }
    return null;
  }
  const scanned = scan(root, 1);
  if (scanned) return scanned;

  function resolveRef(node) {
    const ref = node.$ref;
    if (typeof ref !== 'string' || ref.charAt(0) !== '#') {
      return { unsupported: '$ref points outside the schema' };
    }
    let target = root;
    const pointer = ref.slice(1);
    if (pointer !== '') {
      for (const rawSeg of pointer.split('/').slice(1)) {
        if (target == null || typeof target !== 'object') {
          return { unsupported: 'unresolvable $ref: ' + ref };
        }
        target = target[rawSeg.replace(/~1/g, '/').replace(/~0/g, '~')];
        if (target === undefined) {
          return { unsupported: 'unresolvable $ref: ' + ref };
        }
      }
    }
    return { target: target };
  }

  function deepEq(a, b) {
    if (a === b) return true;
    if (typeof a !== typeof b || a === null || b === null) return false;
    if (Array.isArray(a) || Array.isArray(b)) {
      if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
      return a.every((v, i) => deepEq(v, b[i]));
    }
    if (typeof a === 'object') {
      const ka = Object.keys(a);
      const kb = Object.keys(b);
      if (ka.length !== kb.length) return false;
      return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEq(a[k], b[k]));
    }
    return false;
  }

  function typeOf(v) {
    if (v === null) return 'null';
    if (Array.isArray(v)) return 'array';
    return typeof v;
  }

  function matchesType(v, t) {
    if (t === 'integer') return typeof v === 'number' && Number.isInteger(v);
    if (t === 'object') return typeOf(v) === 'object';
    if (t === 'number') return typeof v === 'number' && Number.isFinite(v);
    return typeOf(v) === t;
  }

  // The fixed keyword order gives the deterministic "first failure"
  // the spec requires (C3 §4.6). pattern / format and every keyword
  // not listed as enforced are ignored — the server judges them.
  function check(node, v, pointer, depth) {
    if (++nodes > MCP_LIMITS.inputSchemaMaxNodes) {
      return { unsupported: 'the schema exceeds ' + MCP_LIMITS.inputSchemaMaxNodes + ' nodes' };
    }
    if (depth > MCP_LIMITS.inputSchemaMaxDepth) {
      return {
        unsupported: 'the schema is deeper than ' + MCP_LIMITS.inputSchemaMaxDepth + ' levels',
      };
    }
    if (node === true) return null;
    if (node === false) {
      return { pointer: pointer, reason: 'the schema rejects this value' };
    }
    if (!node || typeof node !== 'object' || Array.isArray(node)) return null;

    if (Object.prototype.hasOwnProperty.call(node, '$ref')) {
      const r = resolveRef(node);
      if (r.unsupported) return { unsupported: r.unsupported };
      return check(r.target, v, pointer, depth + 1);
    }

    const isObject = typeOf(v) === 'object';
    const isArray = Array.isArray(v);
    const isString = typeof v === 'string';
    const isNumber = typeof v === 'number' && Number.isFinite(v);

    if (node.type !== undefined) {
      const types = Array.isArray(node.type) ? node.type : [node.type];
      if (!types.some((t) => typeof t === 'string' && matchesType(v, t))) {
        return { pointer: pointer, reason: 'expected ' + types.join(' or ') };
      }
    }
    if (node.enum !== undefined) {
      if (!Array.isArray(node.enum)) return { unsupported: 'enum is not an array' };
      if (!node.enum.some((candidate) => deepEq(candidate, v))) {
        return { pointer: pointer, reason: 'value is not one of the enumerated values' };
      }
    }
    if (node.const !== undefined && !deepEq(node.const, v)) {
      return { pointer: pointer, reason: 'value does not equal the const value' };
    }
    if (Array.isArray(node.allOf)) {
      for (const sub of node.allOf) {
        const r = check(sub, v, pointer, depth + 1);
        if (r) return r;
      }
    }
    if (Array.isArray(node.anyOf)) {
      const anyOk = node.anyOf.some((sub) => check(sub, v, pointer, depth + 1) === null);
      if (!anyOk) {
        return { pointer: pointer, reason: 'value does not match any anyOf schema' };
      }
    }
    if (Array.isArray(node.oneOf)) {
      const hits = node.oneOf.filter((sub) => check(sub, v, pointer, depth + 1) === null).length;
      if (hits !== 1) {
        return {
          pointer: pointer,
          reason: hits === 0
            ? 'value does not match any oneOf schema'
            : 'value matches more than one oneOf schema',
        };
      }
    }
    if (node.not !== undefined) {
      if (check(node.not, v, pointer, depth + 1) === null) {
        return { pointer: pointer, reason: 'value matches the forbidden not schema' };
      }
    }

    if (isObject) {
      if (Array.isArray(node.required)) {
        for (const key of node.required) {
          if (typeof key !== 'string') continue;
          if (!Object.prototype.hasOwnProperty.call(v, key)) {
            return { pointer: pointer, reason: 'missing required property "' + key + '"' };
          }
        }
      }
      if (node.properties && typeof node.properties === 'object'
        && !Array.isArray(node.properties)) {
        for (const key of Object.keys(node.properties)) {
          if (!Object.prototype.hasOwnProperty.call(v, key)) continue;
          const r = check(node.properties[key], v[key],
            pointer + '/' + escapeJsonPointerToken(key), depth + 1);
          if (r) return r;
        }
      }
      if (node.additionalProperties === false && node.properties
        && typeof node.properties === 'object' && !Array.isArray(node.properties)) {
        for (const key of Object.keys(v)) {
          if (Object.prototype.hasOwnProperty.call(node.properties, key)) continue;
          return {
            pointer: pointer + '/' + escapeJsonPointerToken(key),
            reason: 'unexpected property "' + key + '"',
          };
        }
      }
    }

    if (isArray) {
      if (Number.isFinite(node.minItems) && v.length < node.minItems) {
        return { pointer: pointer, reason: 'array has fewer than ' + node.minItems + ' items' };
      }
      if (Number.isFinite(node.maxItems) && v.length > node.maxItems) {
        return { pointer: pointer, reason: 'array has more than ' + node.maxItems + ' items' };
      }
      if (node.items && typeof node.items === 'object' && !Array.isArray(node.items)) {
        for (let i = 0; i < v.length; i++) {
          const r = check(node.items, v[i], pointer + '/' + i, depth + 1);
          if (r) return r;
        }
      }
    }

    if (isString) {
      const len = Array.from(v).length; // Unicode code points
      if (Number.isFinite(node.minLength) && len < node.minLength) {
        return { pointer: pointer, reason: 'string is shorter than ' + node.minLength };
      }
      if (Number.isFinite(node.maxLength) && len > node.maxLength) {
        return { pointer: pointer, reason: 'string is longer than ' + node.maxLength };
      }
    }

    if (isNumber) {
      if (Number.isFinite(node.minimum)) {
        const exclusive = node.exclusiveMinimum === true; // draft-04 boolean form
        if (exclusive ? v <= node.minimum : v < node.minimum) {
          return {
            pointer: pointer,
            reason: 'number is below the minimum' + (exclusive ? ' (exclusive)' : ''),
          };
        }
      }
      if (Number.isFinite(node.exclusiveMinimum) && node.exclusiveMinimum !== true
        && v <= node.exclusiveMinimum) {
        return { pointer: pointer, reason: 'number is below the exclusive minimum' };
      }
      if (Number.isFinite(node.maximum)) {
        const exclusive = node.exclusiveMaximum === true;
        if (exclusive ? v >= node.maximum : v > node.maximum) {
          return {
            pointer: pointer,
            reason: 'number is above the maximum' + (exclusive ? ' (exclusive)' : ''),
          };
        }
      }
      if (Number.isFinite(node.exclusiveMaximum) && node.exclusiveMaximum !== true
        && v >= node.exclusiveMaximum) {
        return { pointer: pointer, reason: 'number is above the exclusive maximum' };
      }
    }

    return null;
  }

  nodes = 0; // the value walk gets its own node budget
  return check(root, value, '', 1);
}

function escapeJsonPointerToken(token) {
  return String(token).replace(/~/g, '~0').replace(/\//g, '~1');
}

// ------------------------------------------------------------
//  JSON-RPC classification (C3 §6.4 message table).
// ------------------------------------------------------------
function classifyMessage(msg) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)
    || msg.jsonrpc !== '2.0') {
    return 'malformed';
  }
  if (typeof msg.method === 'string') {
    return (msg.id === undefined || msg.id === null) ? 'notification' : 'request';
  }
  if (Object.prototype.hasOwnProperty.call(msg, 'id')
    && (Object.prototype.hasOwnProperty.call(msg, 'result')
      || Object.prototype.hasOwnProperty.call(msg, 'error'))) {
    return 'response';
  }
  return 'malformed';
}

// Byte-substring replace-all — the runtime's buffered-response sweep
// (network.js replaceBytesAll) applied to the MCP paths that do not go
// through request(). Shared shape so both stay byte-faithful.
function redactBytes(bytes, value) {
  const needle = new TextEncoder().encode(value);
  const replacement = new TextEncoder().encode(CREDENTIAL_REDACTED);
  const hay = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || 0);
  if (!needle.byteLength || hay.byteLength < needle.byteLength) return hay;
  const hits = [];
  const last = hay.byteLength - needle.byteLength;
  for (let i = 0; i <= last; i++) {
    if (hay[i] !== needle[0]) continue;
    let ok = true;
    for (let j = 1; j < needle.byteLength; j++) {
      if (hay[i + j] !== needle[j]) { ok = false; break; }
    }
    if (ok) {
      hits.push(i);
      i += needle.byteLength - 1;
    }
  }
  if (!hits.length) return hay;
  const out = new Uint8Array(
    hay.byteLength - hits.length * (needle.byteLength - replacement.byteLength));
  let src = 0;
  let dst = 0;
  for (const h of hits) {
    while (src < h) out[dst++] = hay[src++];
    for (let j = 0; j < replacement.byteLength; j++) out[dst++] = replacement[j];
    src += needle.byteLength;
  }
  while (src < hay.byteLength) out[dst++] = hay[src++];
  return out;
}

// ------------------------------------------------------------
//  Task client (C3 §10.1): one per task. `port` is the product-owned
//  MCP port (servers / setState / elicit / beforeToolCall?); `deps`
//  carries the C3 credential port — the token never lives on the MCP
//  port itself (D2/D3).
// ------------------------------------------------------------
export function createMcpTaskClient(port, deps) {
  if (!port || typeof port.servers !== 'function') {
    throw new Error('createMcpTaskClient: an MCP port with servers() is required');
  }
  const credentials = deps && typeof deps.credentials === 'object' ? deps.credentials : null;
  const sessions = new Map(); // serverId → session (task lifetime)

  function newSession(rec) {
    return {
      serverId: rec.id,
      url: rec.url,
      displayName: rec.displayName || rec.id,
      credential: rec.credential || null,
      protocolVersion: null,
      sessionId: null,
      nextId: 1,
      tools: null, // Map name → tool once listed
    };
  }

  function resetSession(session) {
    session.protocolVersion = null;
    session.sessionId = null;
    session.nextId = 1;
    session.tools = null;
  }

  function setStateQuiet(serverId, state, reason) {
    try {
      if (typeof port.setState === 'function') port.setState(serverId, state, reason);
    } catch (e) { /* the port validates; a refusal never breaks the client */ }
  }

  // ---- record + state checks (C3 §4.3; no network) ----
  async function serverRecord(serverId) {
    const list = await port.servers();
    if (!Array.isArray(list)) {
      throw errOf('port-invalid', 'mcp: MCP is not available in this task');
    }
    const rec = list.find((s) => s && s.id === serverId);
    if (!rec) {
      throw errOf('unknown-server', 'mcp: unknown server: ' + serverId
        + '. Run mcp servers to list the servers of this task.');
    }
    return rec;
  }

  function checkUsable(rec) {
    if (rec.state === 'needs-connection') {
      throw errOf('needs-connection', 'mcp: server ' + rec.id
        + ' is not connected — the user can connect it in Settings → Capabilities.'
        + ' You cannot connect it.');
    }
    if (rec.state === 'unavailable') {
      throw errOf('unavailable', 'mcp: server ' + rec.id
        + ' cannot be used: ' + (rec.reason || 'unavailable'));
    }
  }

  // ---- credential injection (C3 §5.6) ----
  // At send time the runtime re-checks BOTH conditions: the request
  // address equals the confirmed url (by construction — a session only
  // ever sends to its server record's url) and the address is inside
  // the credential's binding (origin + pathPrefix). Any miss stops the
  // send and drops the server to needs-connection. The value is
  // resolved exactly once per request, immediately before it goes out.
  async function resolveBearer(session) {
    if (!session.credential) return null;
    if (!credentials || typeof credentials.value !== 'function'
      || typeof credentials.bindings !== 'function') {
      return bindingMismatch(session.serverId);
    }
    let bindings = null;
    try {
      bindings = await credentials.bindings();
    } catch (e) { bindings = null; }
    const binding = Array.isArray(bindings)
      ? bindings.find((b) => b && b.name === session.credential) : null;
    let endpointOk = false;
    try {
      const u = new URL(session.url);
      endpointOk = !!binding
        && typeof binding.origin === 'string' && binding.origin !== ''
        && typeof binding.pathPrefix === 'string'
        && u.origin === binding.origin
        && u.pathname.startsWith(binding.pathPrefix);
    } catch (e) { endpointOk = false; }
    if (!endpointOk || binding.state !== 'connected') {
      return bindingMismatch(session.serverId);
    }
    let value = null;
    try {
      value = await credentials.value(session.credential);
    } catch (e) { value = null; }
    if (typeof value !== 'string' || !value.length || /[\u0000-\u001f\u007f]/.test(value)) {
      return bindingMismatch(session.serverId);
    }
    return value;
  }

  function bindingMismatch(serverId) {
    setStateQuiet(serverId, 'needs-connection');
    return Promise.reject(errOf('binding-mismatch', 'mcp: server ' + serverId
      + ' no longer matches the confirmed endpoint; nothing was sent.'
      + ' Ask the user to reconnect it in Settings → Capabilities.'));
  }

  function baseHeaders(session, bearer) {
    const headers = {
      'accept': 'application/json, text/event-stream',
      'content-type': 'application/json',
    };
    if (bearer != null) headers['authorization'] = 'Bearer ' + bearer;
    return headers;
  }

  function sessionHeaders(session, bearer) {
    // Post-handshake headers (C3 §6.2): the negotiated protocol version
    // and — only when the server issued one — the session id. The
    // initialize request itself carries neither; every other request of
    // the session does, INCLUDING notifications/initialized and the
    // replies to server requests (owner's correction of the C3 appendix
    // B wire example: the session already exists at that point, so the
    // version and session headers apply from the notification on).
    const headers = baseHeaders(session, bearer);
    if (session.protocolVersion) headers['mcp-protocol-version'] = session.protocolVersion;
    if (session.sessionId) headers['mcp-session-id'] = session.sessionId;
    return headers;
  }

  // Fire-and-forget POST (notifications, server-request replies,
  // task-end DELETE): its own short deadline, never the task signal —
  // a cancelled task still gets its best-effort cancellation traffic
  // (C3 §6.6.2, §6.6.4). Returns the Response or null; throws nothing.
  async function shortPost(url, headers, body, method) {
    try {
      return await fetchWithDeadline(url, {
        method: method || 'POST',
        headers: filterRequestHeaders(headers),
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'manual',
        credentials: 'omit',
      }, MCP_LIMITS.cancelNotifyTimeoutMs, null, async (res) => {
        if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
          throw errOf('redirect-refused', 'redirect');
        }
        if (res.status < 200 || res.status > 299) {
          throw errOf('short-post-status', 'http-' + res.status);
        }
        return true; // accepted — the response body is never read
      });
    } catch (e) {
      return null; // every failure contained (C3 §6.6.2, §6.7)
    }
  }

  // ---- the wire: one POST + full response consumption ----
  // `opts.readonly` enables the single resend of C3 §6.4/§6.8;
  // `opts.onServerRequest` handles server-initiated requests on the
  // stream (elicitation, ping, …); `opts.notes` collects stderr lines.
  // Returns { message, headers }; message may carry a JSON-RPC `error`.
  async function postRequest(session, body, opts) {
    const o = opts || {};
    const signal = o.signal || null;
    const telemetry = o.telemetry || null;
    const notes = Array.isArray(o.notes) ? o.notes : [];
    const readonly = !!o.readonly;
    const onServerRequest = typeof o.onServerRequest === 'function' ? o.onServerRequest : null;
    let attempt = 0;
    for (;;) {
      try {
        return await postOnce(session, body);
      } catch (e) {
        if (isCancelledShape(e)) throw e;
        if (e && e.mcpCode === 'session-lost') {
          // The server ended the session (404 with a session id):
          // re-handshake once; a READ-ONLY request is then re-sent with
          // a fresh id — tools/call never is (C3 §6.5, §6.8).
          resetSession(session);
          await handshake(session, { signal: signal, telemetry: telemetry });
          if (readonly && attempt === 0) { attempt++; continue; }
          throw e;
        }
        if (readonly && attempt === 0 && e instanceof McpError
          && (e.lostReason === 'network' || e.lostReason === 'stream closed early')) {
          // A pre-dispatch transport failure or a stream that ended
          // without a final response may be retried exactly once
          // (C3 §6.4, §6.8). Timeout and parse failures are not.
          attempt++;
          continue;
        }
        throw e;
      }
    }

    async function postOnce(sessionRef) {
      throwIfCancelledLocal(signal);
      const bearer = await resolveBearer(sessionRef);
      throwIfCancelledLocal(signal);
      const initialize = body._initialize === true;
      const headers = initialize
        ? baseHeaders(sessionRef, bearer)
        : sessionHeaders(sessionRef, bearer);
      const wire = { jsonrpc: '2.0' };
      if (body.id !== undefined) wire.id = body.id;
      if (body.method !== undefined) wire.method = body.method;
      if (body.params !== undefined) wire.params = body.params;
      const payload = JSON.stringify(wire);

      if (telemetry) telemetry.backend = 'browser-direct';
      let handle;
      try {
        handle = await openDirectIncremental({
          method: 'POST',
          url: sessionRef.url,
          headers: headers,
          body: payload,
          signal: signal,
          timeoutMs: MCP_LIMITS.requestTimeoutMs,
        });
      } catch (e) {
        if (isCancelledShape(e)) throw e;
        if (e && (e.networkCode === 'network_redirect_refused'
          || e.networkCode === 'network_redirect_blocked'
          || e.networkCode === 'network_credential_redirect_refused')) {
          // Definitive: the server answered 3xx and the client refused
          // to follow (C3 §4.7).
          throw errOf('redirect-refused', 'mcp: server ' + sessionRef.serverId
            + ' answered with a redirect; redirects are not followed');
        }
        if (e && e.networkCode === 'network_timeout') {
          throw errOf('unreachable', unreachableMsg(sessionRef.serverId, 'timeout'),
            'timeout');
        }
        if (e instanceof DirectTransportFailure) {
          throw errOf('unreachable', unreachableMsg(sessionRef.serverId, 'network'),
            'network');
        }
        throw errOf('unreachable', unreachableMsg(sessionRef.serverId, 'network'),
          'network');
      }

      try {
        return await consumeResponse(handle, bearer, { initialize: initialize });
      } finally {
        handle.close();
      }
    }

    // ---- response consumption (C3 §6.2, §6.4) ----
    async function consumeResponse(handle, bearer, ctxOpts) {
      const hasId = body.id !== undefined;
      const status = handle.status;

      if (status === 401) {
        setStateQuiet(session.serverId, 'needs-connection');
        throw errOf('credential-refused', 'mcp: server ' + session.serverId
          + ' rejected the credential (http-401). Ask the user to reconnect it'
          + ' in Settings → Capabilities.');
      }
      if (status === 404 && session.sessionId && !ctxOpts.initialize) {
        throw errOf('session-lost', 'the session ended (http-404)');
      }
      if (ctxOpts.initialize && (status === 400 || status === 403
        || status === 404 || status === 405)) {
        setStateQuiet(session.serverId, 'unavailable', 'http-' + status);
        throw errOf('unavailable', 'mcp: server ' + session.serverId
          + ' cannot be used: http-' + status
          + (status === 404 || status === 405
            ? ' (this address does not provide Streamable HTTP)' : ''));
      }
      if (status === 429 || status >= 500) {
        // Definitive transient: the server answered without processing
        // (C3 §6.8 "暂时性故障，请求确定没被处理").
        throw errOf('unreachable', unreachableMsg(session.serverId, 'http-' + status));
      }
      if (status === 202) {
        if (hasId) {
          throw errOf('no-response', 'mcp: server ' + session.serverId
            + ' sent a malformed response (accepted without a result)',
            'no result (http-202)');
        }
        return { message: null, headers: handle.headers }; // notification accepted
      }
      if (status !== 200) {
        throw errOf('http-status', 'mcp: server ' + session.serverId
          + ' answered http-' + status + ' instead of a protocol response');
      }

      const contentType = String(handle.headers['content-type'] || '')
        .split(';')[0].trim().toLowerCase();
      if (contentType === 'application/json') {
        const bytes = await readAllCapped(handle, session.serverId);
        const redacted = bearer != null ? redactBytes(bytes, bearer) : bytes;
        let msg;
        try {
          msg = JSON.parse(new TextDecoder('utf-8').decode(redacted));
        } catch (e) {
          throw errOf('malformed', malformedMsg(session.serverId, 'body is not JSON'),
            'malformed response');
        }
        const kind = classifyMessage(msg);
        if (kind === 'request') {
          // A JSON body must be the final response (C3 §6.4): a server
          // request without a stream is a protocol violation.
          throw errOf('malformed',
            malformedMsg(session.serverId, 'the body was a request, not a result'),
            'the response was a request, not a result');
        }
        if (kind !== 'response') {
          throw errOf('malformed',
            malformedMsg(session.serverId, 'not a JSON-RPC response'),
            'malformed response');
        }
        if (hasId && msg.id !== body.id) {
          throw errOf('malformed',
            malformedMsg(session.serverId, 'the response id does not match the request'),
            'response id mismatch');
        }
        return { message: msg, headers: handle.headers };
      }
      if (contentType === 'text/event-stream') {
        return await consumeSse(handle, bearer);
      }
      throw errOf('malformed',
        malformedMsg(session.serverId, 'content-type ' + (contentType || 'missing')),
        'malformed response');
    }

    function malformedMsg(serverId, why) {
      return 'mcp: server ' + serverId + ' sent a malformed response (' + why + ')';
    }

    async function readAllCapped(handle, serverId) {
      const chunks = [];
      let total = 0;
      for (;;) {
        throwIfCancelledLocal(signal);
        let chunk;
        try {
          chunk = await handle.read();
        } catch (e) {
          if (isCancelledShape(e)) throw e;
          if (e && e.networkCode === 'network_timeout') {
            throw errOf('unreachable', unreachableMsg(serverId, 'timeout'), 'timeout');
          }
          throw errOf('unreachable', unreachableMsg(serverId, 'network'), 'network');
        }
        if (chunk.done) break;
        total += chunk.value.byteLength;
        if (total > MCP_LIMITS.maxResponseBytes) {
          throw errOf('too-large', 'the response exceeds the '
            + MCP_LIMITS.maxResponseBytes + '-byte limit', 'response too large');
        }
        chunks.push(chunk.value);
      }
      const merged = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) {
        merged.set(c, off);
        off += c.byteLength;
      }
      return merged;
    }

    // SSE path (C3 §6.4): incremental parse; the final response for
    // this request id ends it; server-initiated requests are answered
    // on the side; a stream that ends without a final response is a
    // post-dispatch loss.
    async function consumeSse(handle, bearer) {
      const hasId = body.id !== undefined;
      // Controls the form wait: aborted by the task signal (the form
      // settles cancelled with the task, C3 §6.6.4) and by stream death
      // (the form closes immediately, C3 §8.5).
      const formAlive = new AbortController();
      const onTaskAbort = () => formAlive.abort();
      if (signal) {
        if (signal.aborted) formAlive.abort();
        else signal.addEventListener('abort', onTaskAbort, { once: true });
      }

      const decoder = createSseDecoder({
        maxEventBytes: MCP_LIMITS.maxSseEventBytes,
        // Credential shielding at the EVENT boundary: an event's data is
        // complete here, so a value split across network chunks is still
        // replaced before any parse (C3 §5.6.5).
        redactor: bearer != null
          ? (data) => data.split(bearer).join(CREDENTIAL_REDACTED)
          : null,
      });
      let total = 0;
      const notes0 = notes;
      // Stream-death detection for a pending form wait (C3 §8.5): the
      // reader's closed promise settles WITHOUT consuming data, so the
      // form can be ended the moment the stream closes or errors. The
      // eager no-op catch keeps the rejection contained on paths that
      // never race it.
      const deathP = handle.readerClosed;
      deathP.catch(() => {});
      const deathDuringForm = deathP.then(() => {
        const e = new Error('the stream ended while a form was pending');
        e.streamClosed = true;
        throw e;
      }, () => {
        const e = new Error('the stream failed while a form was pending');
        e.streamClosed = true;
        throw e;
      });
      deathDuringForm.catch(() => {}); // contained unless a form wait races it

      async function handleStreamMessage(msg) {
        const kind = classifyMessage(msg);
        if (kind === 'response') {
          if (!hasId || msg.id !== body.id) return; // mismatched: ignore
          throw { mcpFinal: msg }; // control-flow carrier, not an Error
        }
        if (kind === 'request') {
          await answerServerRequest(msg);
        }
        // notifications are ignored (C3 §6.4)
      }

      async function answerServerRequest(req) {
        const reply = await buildServerReply(req);
        if (reply) await deliverReply(req, reply);
      }

      async function buildServerReply(req) {
        if (req.id === undefined || req.id === null) return null;
        if (!onServerRequest) {
          return { jsonrpc: '2.0', id: req.id, error: {
            code: RPC_METHOD_NOT_FOUND, message: 'method not found' } };
        }
        try {
          return await onServerRequest(req, {
            suspendDeadline: () => handle.suspendDeadline(),
            resumeDeadline: () => handle.resumeDeadline(),
            formSignal: formAlive.signal,
            deathDuringForm: deathDuringForm,
          });
        } catch (e) {
          if (e && (e.mcpFinal || e.rpc)) throw e;
          if (e && e.streamClosed) {
            // The stream died while the form was pending (C3 §8.5):
            // close the form as cancelled — no stderr note, the call
            // itself reports the unknown outcome below.
            formAlive.abort();
            return { jsonrpc: '2.0', id: req.id, result: { action: 'cancel' } };
          }
          if (isCancelledShape(e) || (signal && signal.aborted)) {
            // The form died with the task or the port failed: the
            // server still gets a best-effort cancel (C3 §6.6.4, §8.4).
            return { jsonrpc: '2.0', id: req.id, result: { action: 'cancel' } };
          }
          notes0.push('mcp: could not show a form requested by server '
            + session.serverId + '; the server was told the request was cancelled');
          return { jsonrpc: '2.0', id: req.id, result: { action: 'cancel' } };
        }
      }

      async function deliverReply(req, reply) {
        if (telemetry) telemetry.backend = 'browser-direct';
        // The reply IS form content: it goes out only when the credential
        // check passes. A failed check sends NOTHING (C3 §5.6.3 — the
        // binding check already dropped the server to needs-connection)
        // — never a bare copy of the form answer.
        let bearer2;
        try {
          bearer2 = await resolveBearer(session);
        } catch (e) {
          // The check failed AFTER the tools/call was dispatched and the
          // server is waiting for this answer: the call can have no
          // result — a post-dispatch loss, outcome unknown (C3 §6.8,
          // §8.1.6), never re-sent.
          throw errOf('reply-blocked',
            'mcp: the form reply to ' + session.serverId
            + ' was not sent — the credential check failed',
            'the credential check failed before the form reply');
        }
        const headers = sessionHeaders(session, bearer2);
        const res = await shortPost(session.url, headers, reply);
        if (!res) {
          // shortPost contained the failure: the reply was not accepted
          // (non-2xx) or the transport failed. The server is left waiting
          // for an answer that will not arrive, so this tools/call has no
          // result (C3 §8.1.6). Outcome unknown — no retry of the reply
          // and no re-send of the original call (C3 §6.8).
          throw errOf('reply-undelivered',
            'mcp: the form reply could not be delivered to ' + session.serverId,
            'the form reply was not delivered');
        }
      }

      try {
        for (;;) {
          throwIfCancelledLocal(signal);
          let chunk;
          try {
            chunk = await handle.read();
          } catch (e) {
            if (isCancelledShape(e)) throw e;
            if (e && e.networkCode === 'network_timeout') {
              throw errOf('unreachable', unreachableMsg(session.serverId, 'timeout'),
                'timeout');
            }
            throw errOf('stream-early-end',
              unreachableMsg(session.serverId, 'stream closed early'),
              'stream closed early');
          }
          if (chunk.done) break;
          total += chunk.value.byteLength;
          if (total > MCP_LIMITS.maxResponseBytes) {
            throw errOf('too-large', 'the response exceeds the '
              + MCP_LIMITS.maxResponseBytes + '-byte limit', 'response too large');
          }
          const msgs = decoder.push(chunk.value);
          for (const msg of msgs) {
            await handleStreamMessage(msg);
          }
        }
        for (const msg of decoder.end()) {
          await handleStreamMessage(msg);
        }
      } catch (e) {
        formAlive.abort();
        if (signal) signal.removeEventListener('abort', onTaskAbort);
        if (e && e.mcpFinal) {
          // The final response for this request id (C3 §6.4).
          return { message: e.mcpFinal, headers: handle.headers };
        }
        if (e instanceof McpError && !e.lostReason
          && (e.mcpCode === 'malformed' || e.mcpCode === 'too-large')) {
          e.lostReason = e.mcpCode === 'malformed'
            ? 'malformed response' : 'response too large';
        }
        throw e;
      }
      formAlive.abort();
      if (signal) signal.removeEventListener('abort', onTaskAbort);
      // The stream ended without a final response (C3 §6.4).
      throw errOf('stream-early-end',
        unreachableMsg(session.serverId, 'stream closed early'),
        'stream closed early');
    }
  }

  // ---- initialize handshake (C3 §6.3) ----
  async function handshake(session, opts) {
    resetSession(session);
    const o = opts || {};
    const resp = await postRequest(session, {
      _initialize: true,
      id: session.nextId++,
      method: 'initialize',
      params: {
        protocolVersion: MCP_PROTOCOL_VERSIONS[MCP_PROTOCOL_VERSIONS.length - 1],
        capabilities: { elicitation: {} },
        clientInfo: MCP_CLIENT_INFO,
      },
    }, { readonly: true, signal: o.signal, telemetry: o.telemetry });
    if (resp.message && resp.message.error) {
      throw errOf('rpc-error', 'mcp: server ' + session.serverId
        + ' returned an error for initialize: ' + describeRpcError(resp.message.error));
    }
    const version = resp.message && resp.message.result
      ? resp.message.result.protocolVersion : undefined;
    if (MCP_PROTOCOL_VERSIONS.indexOf(version) === -1) {
      setStateQuiet(session.serverId, 'unavailable', 'unsupported-protocol');
      throw errOf('unsupported-protocol', 'mcp: server ' + session.serverId
        + ' speaks protocol version ' + (version === undefined ? '(none)' : String(version))
        + '; this client supports ' + MCP_PROTOCOL_VERSIONS.join(', ')
        + '. Nothing else was sent.');
    }
    session.protocolVersion = version;
    const sid = resp.headers ? resp.headers['mcp-session-id'] : null;
    session.sessionId = typeof sid === 'string' && sid ? sid : null;
    // notifications/initialized — the session exists from here on, so the
    // notification carries the negotiated protocol-version header and,
    // when the server issued one, the session id (owner's correction of
    // the appendix B wire example; the MCP transport spec requires the
    // version header on every request after initialize).
    let bearer;
    try {
      bearer = await resolveBearer(session);
    } catch (e) {
      // A binding failure here leaves a half-open session (initialize
      // answered, the notification missing) — reset it so the next
      // command re-handshakes from scratch instead of reusing it.
      resetSession(session);
      throw e;
    }
    const accepted = await shortPost(session.url, sessionHeaders(session, bearer), {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });
    if (!accepted) {
      resetSession(session);
      throw errOf('unreachable', unreachableMsg(session.serverId, 'initialization'
        + ' was not accepted; the next call re-handshakes'));
    }
    return session;
  }

  function describeRpcError(rpcError) {
    const code = rpcError && rpcError.code !== undefined ? rpcError.code : '(no code)';
    const message = rpcError && rpcError.message ? rpcError.message : '';
    return code + ' ' + message;
  }

  // ---- session acquisition ----
  async function acquireSession(serverId, opts) {
    const rec = await serverRecord(serverId);
    checkUsable(rec);
    if (rec.url == null) {
      // An old-style descriptor without an endpoint can never connect.
      setStateQuiet(serverId, 'unavailable', 'no-endpoint');
      throw errOf('unavailable', 'mcp: server ' + serverId
        + ' cannot be used: no-endpoint (the package does not declare a server address)');
    }
    let session = sessions.get(serverId);
    if (!session || session.url !== rec.url
      || session.credential !== (rec.credential || null)) {
      session = newSession(rec);
      sessions.set(serverId, session);
    }
    if (!session.protocolVersion) {
      await handshake(session, opts);
    }
    return session;
  }

  // ---- tools index (C3 §4.3): tools/list with pagination, ≤10 pages ----
  async function ensureTools(session, opts) {
    if (session.tools) return session;
    const o = opts || {};
    const collected = [];
    let cursor = null;
    let pages = 0;
    for (;;) {
      const resp = await postRequest(session, {
        id: session.nextId++,
        method: 'tools/list',
        params: cursor ? { cursor: cursor } : {},
      }, { readonly: true, signal: o.signal, telemetry: o.telemetry });
      if (resp.message && resp.message.error) {
        if (resp.message.error.code === RPC_METHOD_NOT_FOUND) {
          // A server without a tools capability: the connection stays
          // good, the tool set is just empty (C3 §6.3).
          session.tools = new Map();
          return session;
        }
        throw errOf('rpc-error', 'mcp: server ' + session.serverId
          + ' returned an error for tools/list: ' + describeRpcError(resp.message.error));
      }
      const result = resp.message ? resp.message.result : null;
      const list = result && Array.isArray(result.tools) ? result.tools : null;
      if (!list) {
        throw errOf('malformed', 'mcp: server ' + session.serverId
          + ' sent a malformed response (tools/list without a tool list)');
      }
      for (const t of list) {
        if (t && typeof t === 'object' && typeof t.name === 'string') collected.push(t);
      }
      pages++;
      cursor = result && typeof result.nextCursor === 'string' && result.nextCursor
        ? result.nextCursor : null;
      if (!cursor || pages >= MCP_LIMITS.toolsListMaxPages) break;
    }
    const map = new Map();
    for (const t of collected) map.set(t.name, t); // later pages override
    session.tools = map;
    return session;
  }

  // ---- the approval checkpoint (C3 §7.1) ----
  // The one call site: after validation, before the send. The hook sees
  // metadata only — never the token, never the session id.
  async function beforeToolCall(rec, tool, args, signal) {
    const req = {
      kind: 'mcp-call',
      server: {
        id: rec.id,
        displayName: rec.displayName || rec.id,
        url: rec.url,
      },
      tool: {
        name: tool.name,
        annotations: tool.annotations || null, // readOnlyHint et al, advisory
      },
      arguments: args,
    };
    const hook = typeof port.beforeToolCall === 'function' ? port.beforeToolCall : null;
    if (!hook) return { outcome: 'allow' }; // the default continues (C3 §7.1)
    let decision;
    try {
      decision = await raceHook(hook(req, { signal: signal }), signal);
    } catch (e) {
      if (isCancelledShape(e)) throw e;
      // A failing approval check NEVER allows the send (C3 §7.1).
      throw errOf('approval-failed', 'mcp: approval check failed; nothing was sent');
    }
    if (!decision || typeof decision !== 'object'
      || (decision.outcome !== 'allow' && decision.outcome !== 'deny'
        && decision.outcome !== 'cancel')) {
      throw errOf('approval-failed', 'mcp: approval check failed; nothing was sent');
    }
    if (decision.outcome === 'deny') {
      throw errOf('denied', 'mcp: call denied by user; nothing was sent');
    }
    if (decision.outcome === 'cancel') {
      throw errOf('cancelled-before-send', 'mcp: cancelled before the call was sent');
    }
    return decision;
  }

  // A hook that never settles still ends with the task signal: the
  // abort resolves as a cancel decision (C3 §11).
  function raceHook(promise, signal) {
    const p = Promise.resolve(promise);
    if (!signal) return p;
    if (signal.aborted) return Promise.resolve({ outcome: 'cancel' });
    return new Promise((resolve, reject) => {
      const onAbort = () => resolve({ outcome: 'cancel' });
      signal.addEventListener('abort', onAbort, { once: true });
      p.then(
        (v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
        (e) => { signal.removeEventListener('abort', onAbort); reject(e); },
      );
    });
  }

  // ---- elicitation request checks (C3 §8.2) ----
  function checkElicitation(params) {
    const fail = (why) => 'invalid elicitation request: ' + why;
    if (!params || typeof params !== 'object') return fail('missing params');
    const mode = params.mode === undefined ? 'form' : params.mode;
    if (mode !== 'form') return fail('mode must be "form"');
    if (typeof params.message !== 'string' || params.message.length === 0
      || params.message.length > MCP_LIMITS.elicitationMessageMaxChars) {
      return fail('message must be a string of at most '
        + MCP_LIMITS.elicitationMessageMaxChars + ' characters');
    }
    const schema = params.requestedSchema;
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
      return fail('requestedSchema must be an object');
    }
    let size = 0;
    try {
      size = JSON.stringify(schema).length;
    } catch (e) {
      return fail('requestedSchema cannot be serialized');
    }
    if (size > MCP_LIMITS.elicitationSchemaMaxBytes) {
      return fail('requestedSchema exceeds '
        + MCP_LIMITS.elicitationSchemaMaxBytes + ' bytes');
    }
    if (schema.type !== 'object') return fail('requestedSchema.type must be "object"');
    const props = schema.properties;
    if (!props || typeof props !== 'object' || Array.isArray(props)) {
      return fail('requestedSchema.properties must be an object');
    }
    const keys = Object.keys(props);
    if (keys.length > MCP_LIMITS.elicitationSchemaMaxProperties) {
      return fail('requestedSchema declares more than '
        + MCP_LIMITS.elicitationSchemaMaxProperties + ' properties');
    }
    for (const key of keys) {
      if (!elicitationPropertySupported(props[key])) {
        return fail('property "' + key + '" is not a supported primitive form');
      }
    }
    return null;
  }

  function elicitationPropertySupported(p) {
    if (!p || typeof p !== 'object' || Array.isArray(p)) return false;
    if (Array.isArray(p.oneOf)) {
      // single-select enum via oneOf const + title (2025-11-25 form)
      return p.oneOf.every((entry) => entry && typeof entry === 'object'
        && !Array.isArray(entry)
        && Object.prototype.hasOwnProperty.call(entry, 'const'));
    }
    if (Array.isArray(p.enum)) return true; // enum, with or without type
    if (p.type === 'string' || p.type === 'number' || p.type === 'integer'
      || p.type === 'boolean') return true;
    if (p.type === 'array') {
      // multi-select enum: array + items (2025-11-25 form)
      return !!(p.items && typeof p.items === 'object' && !Array.isArray(p.items));
    }
    return false; // nested objects etc. are refused, not guessed at
  }

  // ---- tools/call result shaping (C3 §4.5) ----
  function shapeToolResult(result) {
    const out = { content: [] };
    const content = result && Array.isArray(result.content) ? result.content : [];
    out.content = content.map(shapeContentPart);
    if (result && Object.prototype.hasOwnProperty.call(result, 'structuredContent')
      && result.structuredContent !== undefined) {
      out.structuredContent = result.structuredContent;
    }
    out.isError = !!(result && result.isError);
    return out;
  }

  function shapeContentPart(part) {
    if (!part || typeof part !== 'object' || Array.isArray(part)) return part;
    if (part.type === 'image' || part.type === 'audio') {
      const shaped = { type: part.type };
      if (typeof part.mimeType === 'string') shaped.mimeType = part.mimeType;
      shaped.dataOmitted = true; // binary data never reaches the model
      return shaped;
    }
    if (part.type === 'resource' && part.resource && typeof part.resource === 'object'
      && part.resource.blob != null && part.resource.text == null) {
      const shaped = { type: 'resource', resource: {} };
      if (part.resource.uri !== undefined) shaped.resource.uri = part.resource.uri;
      if (typeof part.resource.mimeType === 'string') {
        shaped.resource.mimeType = part.resource.mimeType;
      }
      shaped.resource.dataOmitted = true;
      return shaped;
    }
    // text parts and text resources pass through; only _meta is dropped.
    const out = {};
    for (const key of Object.keys(part)) {
      if (key === '_meta') continue;
      if (key === 'resource' && part.resource && typeof part.resource === 'object'
        && !Array.isArray(part.resource)) {
        const r = {};
        for (const rk of Object.keys(part.resource)) {
          if (rk === '_meta') continue;
          r[rk] = part.resource[rk];
        }
        out.resource = r;
        continue;
      }
      out[key] = part[key];
    }
    return out;
  }

  function outcomeUnknown(serverId, reason) {
    return errOf('outcome-unknown', 'mcp: outcome unknown — tools/call was sent to '
      + serverId + ' but no result was received (' + reason
      + '). It was NOT re-sent; run it again only if the tool is safe to repeat.');
  }

  // ---- the task client surface ----
  const client = {
    // The task's servers, live states. Never touches the network.
    async servers() {
      const list = await port.servers();
      return Array.isArray(list) ? list : [];
    },

    async listTools(serverId, opts) {
      const o = opts || {};
      const session = await acquireSession(serverId, o);
      await ensureTools(session, o);
      return Array.from(session.tools.values());
    },

    async describeTool(serverId, name, opts) {
      const o = opts || {};
      const session = await acquireSession(serverId, o);
      await ensureTools(session, o);
      const tool = session.tools.get(name);
      if (!tool) {
        throw errOf('tool-not-found', 'mcp: server ' + serverId
          + ' has no tool named ' + name + '; run mcp tools ' + serverId);
      }
      return tool;
    },

    // tools/call (C3 §4.5 steps 3–6, §7.1, §8). ONE send; every
    // post-dispatch failure is an unknown outcome (§6.8).
    async callTool(serverId, name, args, opts) {
      const o = opts || {};
      const signal = o.signal || null;
      const telemetry = o.telemetry || null;
      const notes = [];
      const rec = await serverRecord(serverId);
      checkUsable(rec);
      if (rec.url == null) {
        setStateQuiet(serverId, 'unavailable', 'no-endpoint');
        throw errOf('unavailable', 'mcp: server ' + serverId
          + ' cannot be used: no-endpoint (the package does not declare a server address)');
      }
      const session = await acquireSession(serverId, o);
      await ensureTools(session, o);
      const tool = session.tools.get(name);
      if (!tool) {
        throw errOf('tool-not-found', 'mcp: server ' + serverId
          + ' has no tool named ' + name + '; run mcp tools ' + serverId);
      }

      // Step 4: validate the arguments against the tool's inputSchema.
      const verdict = validateToolArguments(
        Object.prototype.hasOwnProperty.call(tool, 'inputSchema') ? tool.inputSchema : {},
        args);
      if (verdict) {
        if (verdict.unsupported) {
          throw errOf('schema-unsupported', 'mcp: the inputSchema of ' + name
            + ' cannot be validated locally (' + verdict.unsupported + '); nothing was sent');
        }
        throw errOf('schema-mismatch', 'mcp: arguments do not match the tool\'s'
          + ' inputSchema: ' + verdict.pointer + ': ' + verdict.reason);
      }

      // Step 5: the single approval checkpoint (C3 §7.1).
      await beforeToolCall(rec, tool, args, signal);

      // Step 6: final liveness check, then ONE send.
      throwIfCancelledLocal(signal);
      const requestId = session.nextId++;
      let elicitCount = 0;

      const onServerRequest = async (req, streamCtx) => {
        if (req.method === 'ping') {
          return { jsonrpc: '2.0', id: req.id, result: {} };
        }
        if (req.method === 'sampling/createMessage') {
          // sampling is never declared → always refused (C3 §6.9).
          return { jsonrpc: '2.0', id: req.id, error: {
            code: RPC_METHOD_NOT_FOUND, message: 'method not found' } };
        }
        if (req.method === 'elicitation/create') {
          if (elicitCount >= MCP_LIMITS.maxElicitationsPerCall) {
            // The 6th and later forms are answered with cancel (C3 §8.2).
            return { jsonrpc: '2.0', id: req.id, result: { action: 'cancel' } };
          }
          const invalid = checkElicitation(req.params);
          if (invalid) {
            return { jsonrpc: '2.0', id: req.id, error: {
              code: RPC_INVALID_PARAMS, message: invalid } };
          }
          elicitCount++;
          // The form wait must not consume the request deadline
          // (C3 §8.4): suspend while the user fills the form in. The
          // wait is raced against the stream's death so a stream that
          // ends under the form still closes it (C3 §8.5).
          if (streamCtx.suspendDeadline) streamCtx.suspendDeadline();
          let answer = null;
          try {
            answer = await Promise.race([
              Promise.resolve(port.elicit({
                server: { id: rec.id, displayName: rec.displayName || rec.id, url: rec.url },
                message: req.params.message,
                requestedSchema: req.params.requestedSchema,
              }, { signal: streamCtx.formSignal })),
              streamCtx.deathDuringForm,
            ]);
          } finally {
            if (streamCtx.resumeDeadline) streamCtx.resumeDeadline();
          }
          const action = answer && typeof answer.action === 'string'
            ? answer.action : 'cancel';
          if (action === 'accept') {
            const content = answer && answer.content !== undefined
              ? answer.content : {};
            return { jsonrpc: '2.0', id: req.id,
              result: { action: 'accept', content: content } };
          }
          return { jsonrpc: '2.0', id: req.id,
            result: { action: action === 'decline' ? 'decline' : 'cancel' } };
        }
        return { jsonrpc: '2.0', id: req.id, error: {
          code: RPC_METHOD_NOT_FOUND, message: 'method not found' } };
      };

      let resp;
      try {
        resp = await postRequest(session, {
          id: requestId,
          method: 'tools/call',
          params: { name: name, arguments: args },
        }, { signal: signal, telemetry: telemetry, onServerRequest: onServerRequest,
          notes: notes });
      } catch (e) {
        if (isCancelledShape(e)) {
          // Best-effort notifications/cancelled on its own short
          // deadline, not the already-cancelled task signal (C3 §6.6.2);
          // the report says the server may still have processed it.
          const bearer = await safeBearerFor(session);
          const headers = bearer === undefined
            ? baseHeaders(session, null) : sessionHeaders(session, bearer);
          await shortPost(session.url, headers, {
            jsonrpc: '2.0',
            method: 'notifications/cancelled',
            params: { requestId: requestId, reason: 'task cancelled' },
          });
          throw makeMcpCancelled('mcp: cancelled — tools/call was sent to ' + serverId
            + '; the server may still have processed it (not rolled back)');
        }
        if (e instanceof McpError && e.mcpCode === 'session-lost') {
          throw outcomeUnknown(serverId, 'the session ended (http-404)');
        }
        if (e instanceof McpError && e.lostReason) {
          throw outcomeUnknown(serverId, e.lostReason);
        }
        throw e;
      }
      if (resp.message && resp.message.error) {
        throw errOf('rpc-error', 'mcp: server ' + serverId
          + ' returned an error for tools/call: ' + describeRpcError(resp.message.error));
      }
      return { result: shapeToolResult(resp.message ? resp.message.result : null),
        notes: notes };
    },

    // Task-end cleanup (C3 §6.7): state is dropped synchronously; the
    // DELETEs are fired best-effort. The returned promise exists so
    // tests can join — the host does not await it.
    dispose() {
      const pending = [];
      const list = Array.from(sessions.values());
      sessions.clear();
      for (const session of list) {
        if (!session.sessionId || !session.protocolVersion) continue;
        pending.push((async () => {
          try {
            const bearer = await resolveBearer(session);
            const headers = baseHeaders(session, bearer);
            headers['mcp-protocol-version'] = session.protocolVersion;
            headers['mcp-session-id'] = session.sessionId;
            headers['accept'] = 'application/json, text/event-stream';
            await shortPost(session.url, headers, undefined, 'DELETE');
          } catch (e) { /* 405 and every other failure: ignored (C3 §6.7) */ }
        })());
      }
      return Promise.all(pending).then(() => undefined, () => undefined);
    },
  };

  async function safeBearerFor(session) {
    try {
      return await resolveBearer(session);
    } catch (e) {
      return undefined; // best effort: the notification goes out bare
    }
  }

  return client;
}

// One client per task, anchored on the task-scoped port: the first mcp
// command of a task creates it, later commands of the same task reuse
// its sessions. The entry dies with the port — product drops the port
// in onTaskEnd and calls dispose() on it (C3 §6.7).
const taskClients = new WeakMap();

function taskClientFor(port, opts) {
  let client = taskClients.get(port);
  if (!client) {
    client = createMcpTaskClient(port, { credentials: opts && opts.credentials });
    taskClients.set(port, client);
  }
  return client;
}

// The public task-end cleanup entry (C3 §6.7): takes the SAME port object
// the task's commands received as context.mcp, removes the cached client
// and disposes it — one best-effort DELETE per session the server issued
// a session id for, every open stream closed, form state dropped. Safe to
// call repeatedly and when the task never created a client: the second
// call finds no entry and is a no-op, and client.dispose() itself is
// idempotent. Returns the dispose promise (never rejects) so a host MAY
// join it; onTaskEnd is not required to.
export function disposeMcpTaskClient(port) {
  const client = port && typeof port === 'object' ? taskClients.get(port) : undefined;
  if (!client) return Promise.resolve();
  taskClients.delete(port);
  return client.dispose();
}

// ------------------------------------------------------------
//  The `mcp` shell command (C3 §4). args is the tokenized argv of the
//  invocation; ctx is the shell context (vfs, cwd); opts carries
//  signal / credentials / mcp (the port) like every other injection.
// ------------------------------------------------------------
export async function runMcp(args, ctx, opts) {
  const argv = Array.isArray(args) ? args.map((t) => String(t)) : [];
  const port = opts && typeof opts.mcp === 'object' ? opts.mcp : null;
  const signal = opts && opts.signal;
  const telemetry = { backend: null };

  const networkMeta = () => (telemetry.backend ? { backend: telemetry.backend } : null);
  const fail = (stderr) => ({ success: false, stdout: '', stderr: stderr, network: null });
  const ok = (stdout, stderr) => ({
    success: true, stdout: stdout, stderr: stderr || '', network: networkMeta(),
  });

  if (!port || typeof port.servers !== 'function') {
    return fail('mcp: MCP is not available in this task');
  }

  const usage = 'usage: mcp servers | mcp tools <server> | mcp describe <server> <tool>'
    + " | mcp call <server> <tool> '<json>' | mcp call <server> <tool> @args.json";
  const sub = argv[0];

  try {
    if (!sub) return fail(usage);

    // ---- mcp servers (C3 §4.2): a local read, never networked ----
    if (sub === 'servers') {
      if (argv.length !== 1) return fail(usage);
      const list = await port.servers();
      if (!Array.isArray(list)) return fail('mcp: MCP is not available in this task');
      if (!list.length) return ok('No MCP servers are connected in this task.');
      const sorted = list.slice().sort((a, b) => {
        const x = a && a.id != null ? String(a.id) : '';
        const y = b && b.id != null ? String(b.id) : '';
        return x < y ? -1 : x > y ? 1 : 0;
      });
      const lines = [];
      const stderrLines = [];
      let needsConnection = false;
      for (const s of sorted) {
        if (!s || !s.id) continue;
        const state = s.state || 'needs-connection';
        const label = state === 'unavailable'
          ? 'unavailable (' + (s.reason || 'unavailable') + ')'
          : state;
        lines.push(s.id + '  ' + label + '  ' + (s.displayName || s.id));
        if (state === 'needs-connection') needsConnection = true;
      }
      if (needsConnection) {
        stderrLines.push('Servers marked needs-connection must be connected by the user'
          + ' in Settings → Capabilities.');
      }
      return ok(lines.join('\n'), stderrLines.join('\n'));
    }

    const client = taskClientFor(port, opts);

    // ---- mcp tools <server> (C3 §4.3) ----
    if (sub === 'tools') {
      if (argv.length !== 2) return fail(usage);
      const tools = await client.listTools(argv[1], { signal: signal, telemetry: telemetry });
      if (!tools.length) return ok('Server ' + argv[1] + ' offers no tools.');
      const lines = tools.map((t) => {
        const desc = t && typeof t.description === 'string' && t.description.trim()
          ? t.description.split('\n')[0].trim()
          : (t && typeof t.title === 'string' && t.title.trim() ? t.title.trim() : '');
        return desc ? t.name + '  ' + desc : t.name;
      });
      return ok(lines.join('\n'));
    }

    // ---- mcp describe <server> <tool> (C3 §4.4) ----
    if (sub === 'describe') {
      if (argv.length !== 3) return fail(usage);
      const tool = await client.describeTool(argv[1], argv[2],
        { signal: signal, telemetry: telemetry });
      return ok(JSON.stringify(describeShape(tool), null, 2));
    }

    // ---- mcp call <server> <tool> ['<json>'|@file] (C3 §4.5) ----
    if (sub === 'call') {
      if (argv.length < 3 || argv.length > 4) return fail(usage);
      const serverId = argv[1];
      const toolName = argv[2];
      let args = {};
      if (argv.length === 4) {
        const spec = argv[3];
        if (spec.charAt(0) === '@') {
          args = await readArgsFile(ctx, spec.slice(1), spec);
        } else {
          try {
            args = JSON.parse(spec);
          } catch (e) {
            return fail('mcp: arguments must be a JSON object');
          }
        }
        if (!args || typeof args !== 'object' || Array.isArray(args)) {
          return fail('mcp: arguments must be a JSON object');
        }
      }
      const call = await client.callTool(serverId, toolName, args,
        { signal: signal, telemetry: telemetry });
      const shaped = { content: call.result.content };
      if (Object.prototype.hasOwnProperty.call(call.result, 'structuredContent')) {
        shaped.structuredContent = call.result.structuredContent;
      }
      shaped.isError = call.result.isError;
      const stdout = JSON.stringify(shaped);
      const stderrLines = (call.notes || []).slice();
      if (call.result.isError) {
        stderrLines.push('mcp: tool ' + toolName + ' reported an error');
        return {
          success: false, stdout: stdout, stderr: stderrLines.join('\n'),
          network: networkMeta(),
        };
      }
      return ok(stdout, stderrLines.join('\n'));
    }

    return fail(usage);
  } catch (e) {
    if (isCancelledShape(e)) throw e; // the shell appends its uniform cancel line
    if (e instanceof McpError) {
      if (e.mcpCode === 'cancelled-before-send') {
        // Hook-cancelled before anything was sent (C3 §4.7, §7.1).
        throw makeMcpCancelled('mcp: cancelled before the call was sent');
      }
      return fail(e.message);
    }
    return fail('mcp: ' + (e && e.message ? e.message : String(e)));
  }
}

// §4.5: the @args.json form — local read only, bounded, never networked
// on a failure (C3 §4.5 table).
async function readArgsFile(ctx, path, display) {
  const vfs = ctx && ctx.vfs;
  if (!vfs) {
    throw errOf('args-file', 'mcp: cannot read ' + display + ': no filesystem');
  }
  let abs;
  try {
    abs = resolveShellPath(ctx, path);
  } catch (e) {
    throw errOf('args-file', 'mcp: cannot read ' + display + ': ' + e.message);
  }
  try {
    const st = await vfs.stat(abs);
    if (st && Number.isFinite(st.size) && st.size > MCP_LIMITS.maxArgsFileBytes) {
      throw errOf('args-file', 'mcp: cannot read ' + display + ': file exceeds the '
        + MCP_LIMITS.maxArgsFileBytes + '-byte argument limit');
    }
  } catch (e) {
    if (e && e.name === 'NotFoundError') {
      throw errOf('args-file', 'mcp: cannot read ' + display
        + ': no such file or directory');
    }
    if (e instanceof McpError) throw e;
    throw errOf('args-file', 'mcp: cannot read ' + display + ': '
      + (e && e.message ? e.message : String(e)));
  }
  let bytes;
  try {
    bytes = await vfs.readBytes(abs);
  } catch (e) {
    throw errOf('args-file', 'mcp: cannot read ' + display + ': '
      + (e && e.message ? e.message : String(e)));
  }
  if (bytes.byteLength > MCP_LIMITS.maxArgsFileBytes) {
    throw errOf('args-file', 'mcp: cannot read ' + display + ': file exceeds the '
      + MCP_LIMITS.maxArgsFileBytes + '-byte argument limit');
  }
  try {
    return JSON.parse(new TextDecoder('utf-8').decode(bytes));
  } catch (e) {
    throw errOf('args-file', 'mcp: cannot read ' + display
      + ': the file is not valid JSON');
  }
}

// §4.4 describe output: fixed key order, _meta dropped.
function describeShape(tool) {
  const out = { name: tool.name };
  if (typeof tool.title === 'string') out.title = tool.title;
  if (typeof tool.description === 'string') out.description = tool.description;
  if (tool.inputSchema !== undefined) out.inputSchema = tool.inputSchema;
  if (tool.outputSchema !== undefined) out.outputSchema = tool.outputSchema;
  if (tool.annotations !== undefined) out.annotations = tool.annotations;
  return out;
}
