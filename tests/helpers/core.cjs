// M3a: shared loader for the migrated unit suites.
//
// The classic eval loading model is GONE: the implementation modules are
// real ES modules and this helper imports them (require(esm) is
// synchronous on this Node) and merges their namespaces into one object
// ONLY as a migration compatibility surface, so migrated suite bodies
// keep reading `M.<Symbol>` exactly as before. The modules themselves
// wire each other through explicit ESM imports — this object holds no
// state and no second copy of anything.
const workspace = require('../../src/workspace.js');
const vfs = require('../../src/vfs.js');
const network = require('../../src/network.js');
const shell = require('../../src/shell.js');

module.exports = Object.assign({}, workspace, vfs, network, shell);
