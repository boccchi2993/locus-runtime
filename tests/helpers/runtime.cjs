// M3a: the worker sources are RUNTIME assets — suites import them from
// src/worker-assets.js and build interpreter instances the way hosts do
// (explicit source, never a page DOM element). require(esm) is
// synchronous on this Node, so suites can use this at module scope.
const assets = require('../../src/worker-assets.js');

// A fresh interpreter instance wired exactly like a host builds one.
// `M` is the helpers/core.cjs namespace (carries createPythonRuntime).
function freshRuntime(M, opts) {
  return M.createPythonRuntime(Object.assign({ pyWorkerSource: assets.PY_WORKER_SOURCE }, opts));
}

module.exports = { PY_WORKER_SOURCE: assets.PY_WORKER_SOURCE, GREP_WORKER_SOURCE: assets.GREP_WORKER_SOURCE, freshRuntime };
