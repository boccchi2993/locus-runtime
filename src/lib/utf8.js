// ============================================================
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
