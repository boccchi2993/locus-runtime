// Shared fixture-wheel payload helper (wheel-only per DECISIONS.md D10 §6).
// The fixture wheel is the Capability Package Core's synthetic wheel; suites
// that only need a CONFIGURE-time-valid extension payload (no worker boot)
// build their modules from it so every suite exercises the same TPR v1A
// wheel shape.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const WHEEL_PATH = path.join(__dirname, '..', 'fixtures/capability-package/minimal',
  'plugins/locus-test-plugin/artifacts/locus_test_plugin-1.0.0-py3-none-any.whl');
const WHEEL_BYTES = new Uint8Array(fs.readFileSync(WHEEL_PATH));
const WHEEL_FILENAME = 'locus_test_plugin-1.0.0-py3-none-any.whl';
const WHEEL_SHA256 = crypto.createHash('sha256').update(WHEEL_BYTES).digest('hex');

// One extension module carrying exactly one verified wheel artifact.
function wheelModule(overrides) {
  return Object.assign({
    pluginId: 'locus-test-plugin',
    imports: ['locus_test_plugin'],
    wheels: [{
      filename: WHEEL_FILENAME,
      format: 'python-wheel',
      size: WHEEL_BYTES.byteLength,
      sha256: WHEEL_SHA256,
      bytes: WHEEL_BYTES.slice(),
    }],
  }, overrides || {});
}

// A whole extension payload ({ key, modules }) as configureExtensions and
// prepare() accept it.
function wheelPayload(key, moduleOverrides) {
  return { key, modules: [wheelModule(moduleOverrides)] };
}

module.exports = { WHEEL_PATH, WHEEL_BYTES, WHEEL_FILENAME, WHEEL_SHA256, wheelModule, wheelPayload };
