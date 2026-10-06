// ============================================================
//  VFS (Linux-like virtual filesystem, v1)
//  VirtualWorkspace mount table + internal providers.
//  See docs/LINUX-LIKE-VFS.md for the architecture contract.
//
import { WorkspaceAdapter, normalizeWorkspacePath } from './workspace.js';

//  ES module exports: normalizeVfsPath, vfsError, VirtualWorkspace,
//  MemoryWorkspace, UploadWorkspace, SystemBinWorkspace.
//  Imports WorkspaceAdapter/normalizeWorkspacePath from ./workspace.js
//  (M3a extraction; the classic load order became explicit imports).
//  This file must NEVER reference SHELL_COMMANDS directly — the
//  command list is injected.
// ============================================================

// Normalize a user/agent-supplied path to an absolute VFS path.
// Relative paths resolve against `cwd` (absolute VFS path, default '/').
// Backslashes, drive letters and control chars are rejected; `..` pops
// one segment and escaping the root is an error.
function normalizeVfsPath(path, cwd) {
  const original = path;
  let p = path === null || path === undefined ? '' : String(path);
  if (p.includes('\\') || /[\x00-\x1F]/.test(p)) {
    throw new Error('invalid path: ' + original);
  }
  if (!p.startsWith('/')) {
    if (/^[A-Za-z]:/.test(p)) throw new Error('invalid path: ' + original);
    const base = cwd === null || cwd === undefined || cwd === '' ? '/' : String(cwd);
    if (!base.startsWith('/')) throw new Error('invalid cwd: ' + base);
    p = base.replace(/\/+$/, '') + '/' + p;
  }
  const parts = [];
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (!parts.length) throw new Error('path escapes filesystem root: ' + original);
      parts.pop();
      continue;
    }
    parts.push(seg);
  }
  return '/' + parts.join('/');
}

// Error taxonomy: upper layers pattern-match on Error.name exactly like
// the browser File System Access errors (e.name === 'NotFoundError').
function vfsError(name, message) {
  const e = new Error(message);
  e.name = name;
  return e;
}

function vfsNotFound(path) {
  return vfsError('NotFoundError', 'no such file or directory: ' + path);
}

function vfsReadOnly(path) {
  return vfsError('ReadOnlyError', 'read-only filesystem: ' + path);
}

const VFS_AUTHORITIES = ['read-only', 'read-write', 'external-read-write', 'system-read-only'];

function vfsIsReadOnlyAuthority(authority) {
  return authority === 'read-only' || authority === 'system-read-only';
}

// ------------------------------------------------------------
//  MemoryWorkspace — byte-exact in-memory provider (page lifetime).
//  Explicit directory set; recursive mkdir; quota bounds are
//  constructor-overridable for tests.
// ------------------------------------------------------------
class MemoryWorkspace extends WorkspaceAdapter {
  constructor(opts) {
    super();
    opts = opts || {};
    this.name = opts.name || 'memory';
    this.maxBytes = opts.maxBytes !== undefined && opts.maxBytes !== null ? opts.maxBytes : 32 * 1024 * 1024;
    this.maxFileBytes = opts.maxFileBytes !== undefined && opts.maxFileBytes !== null ? opts.maxFileBytes : 16 * 1024 * 1024;
    this.files = new Map(); // rel -> Uint8Array
    this.dirs = new Set();  // rel of explicit dirs; '' (root) always exists implicitly
    this._bytes = 0;
    for (const d of opts.dirs || []) this._mkdir(normalizeWorkspacePath(d));
  }

  _rel(path) { return normalizeWorkspacePath(path); }

  _isDir(rel) { return rel === '' || this.dirs.has(rel); }

  _mkdir(rel) {
    if (!rel) return; // root always exists
    let cur = '';
    for (const part of rel.split('/')) {
      cur = cur ? cur + '/' + part : part;
      if (this.files.has(cur)) throw vfsError('TypeMismatchError', 'not a directory: ' + cur);
      this.dirs.add(cur);
    }
  }

  _children(rel, collection) {
    const prefix = rel ? rel + '/' : '';
    const out = [];
    for (const entry of collection) {
      if (!entry.startsWith(prefix)) continue;
      const rest = entry.slice(prefix.length);
      if (rest && !rest.includes('/')) out.push(rest);
    }
    return out;
  }

  async list(path) {
    const rel = this._rel(path);
    if (this.files.has(rel)) throw vfsError('TypeMismatchError', 'not a directory: ' + rel);
    if (!this._isDir(rel)) throw vfsNotFound(rel);
    const out = this._children(rel, this.dirs).map((name) => ({ name, kind: 'directory' }))
      .concat(this._children(rel, this.files.keys()).map((name) => ({ name, kind: 'file' })));
    out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return out;
  }

  async read(path) {
    return new TextDecoder('utf-8').decode(await this.readBytes(path));
  }

  async readBytes(path) {
    const rel = this._rel(path);
    const data = this.files.get(rel);
    if (data) return data.slice(); // copy — byte-exact, no aliasing
    if (this._isDir(rel)) throw vfsError('TypeMismatchError', 'is a directory: ' + rel);
    throw vfsNotFound(rel);
  }

  async write(path, data) {
    const rel = this._rel(path);
    if (!rel || this._isDir(rel)) throw vfsError('TypeMismatchError', 'is a directory: ' + (rel || '/'));
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
    if (bytes.byteLength > this.maxFileBytes) {
      throw vfsError('QuotaExceededError',
        'file size ' + bytes.byteLength + ' exceeds maxFileBytes limit ' + this.maxFileBytes + ': ' + rel);
    }
    const old = this.files.get(rel);
    const next = this._bytes - (old ? old.byteLength : 0) + bytes.byteLength;
    if (next > this.maxBytes) {
      throw vfsError('QuotaExceededError',
        'total size ' + next + ' exceeds maxBytes limit ' + this.maxBytes + ': ' + rel);
    }
    const slash = rel.lastIndexOf('/');
    if (slash !== -1) this._mkdir(rel.slice(0, slash)); // parent dirs created implicitly
    this.files.set(rel, bytes);
    this._bytes = next;
  }

  async remove(path) {
    const rel = this._rel(path);
    const data = this.files.get(rel);
    if (data) {
      this._bytes -= data.byteLength;
      this.files.delete(rel);
      return;
    }
    if (!rel) throw new Error('cannot remove mount root');
    if (this.dirs.has(rel)) {
      const prefix = rel + '/';
      for (const d of this.dirs) if (d.startsWith(prefix)) throw new Error('directory not empty: ' + rel);
      for (const f of this.files.keys()) if (f.startsWith(prefix)) throw new Error('directory not empty: ' + rel);
      this.dirs.delete(rel);
      return;
    }
    throw vfsNotFound(rel);
  }

  async mkdir(path) { this._mkdir(this._rel(path)); }

  async exists(path) {
    const rel = this._rel(path);
    return rel === '' || this.dirs.has(rel) || this.files.has(rel);
  }

  async stat(path) {
    const rel = this._rel(path);
    const data = this.files.get(rel);
    if (data) return { kind: 'file', size: data.byteLength, modified: null };
    if (this._isDir(rel)) return { kind: 'directory', size: 0, modified: null };
    throw vfsNotFound(rel);
  }
}

// ------------------------------------------------------------
//  UploadWorkspace — read-only provider holding real browser File
//  objects. Files are read lazily (arrayBuffer() only on read).
//  Deterministic collision naming: report.csv -> report (2).csv.
// ------------------------------------------------------------
class UploadWorkspace extends WorkspaceAdapter {
  constructor(opts) {
    super();
    opts = opts || {};
    this.name = opts.name || 'upload';
    this.maxFileBytes = opts.maxFileBytes !== undefined && opts.maxFileBytes !== null ? opts.maxFileBytes : 32 * 1024 * 1024;
    this.maxTotalBytes = opts.maxTotalBytes !== undefined && opts.maxTotalBytes !== null ? opts.maxTotalBytes : 128 * 1024 * 1024;
    this.files = new Map(); // finalName -> File (flat in v1)
  }

  _rel(path) { return normalizeWorkspacePath(path); }

  _totalBytes() {
    let total = 0;
    for (const f of this.files.values()) total += f.size || 0;
    return total;
  }

  _collisionName(name) {
    if (!this.files.has(name)) return name;
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    let n = 2;
    while (this.files.has(stem + ' (' + n + ')' + ext)) n++;
    return stem + ' (' + n + ')' + ext;
  }

  // Explicit USER action path (upload picker). Returns the final name
  // after deterministic collision renaming. Quota overflow fails loudly.
  addFile(file) {
    const size = (file && file.size) || 0;
    const rawName = String((file && file.name) || 'file');
    if (size > this.maxFileBytes) {
      throw vfsError('QuotaExceededError',
        'file size ' + size + ' exceeds maxFileBytes limit ' + this.maxFileBytes + ': ' + rawName);
    }
    const total = this._totalBytes() + size;
    if (total > this.maxTotalBytes) {
      throw vfsError('QuotaExceededError',
        'total size ' + total + ' exceeds maxTotalBytes limit ' + this.maxTotalBytes + ': ' + rawName);
    }
    const finalName = this._collisionName(rawName);
    this.files.set(finalName, file);
    return finalName;
  }

  addFiles(fileList) {
    const out = [];
    for (const file of fileList || []) out.push({ name: this.addFile(file), file });
    return out;
  }

  // Explicit USER action path (attachment chip remove) — not agent-reachable.
  removeFile(name) {
    if (!this.files.delete(name)) throw vfsNotFound(name);
  }

  async list(path) {
    const rel = this._rel(path);
    if (rel) {
      if (this.files.has(rel)) throw vfsError('TypeMismatchError', 'not a directory: ' + rel);
      throw vfsNotFound(rel);
    }
    return [...this.files.keys()].sort().map((name) => ({ name, kind: 'file' }));
  }

  async read(path) {
    return new TextDecoder('utf-8').decode(await this.readBytes(path));
  }

  async readBytes(path) {
    const rel = this._rel(path);
    if (!rel) throw vfsError('TypeMismatchError', 'is a directory: /');
    const file = this.files.get(rel);
    if (!file) throw vfsNotFound(rel);
    return new Uint8Array(await file.arrayBuffer());
  }

  // Mutations are read-only: fail BEFORE doing anything.
  async write(path) { throw vfsReadOnly(this._rel(path)); }
  async remove(path) { throw vfsReadOnly(this._rel(path)); }
  async mkdir(path) { throw vfsReadOnly(this._rel(path)); }

  async exists(path) {
    const rel = this._rel(path);
    return rel === '' || this.files.has(rel);
  }

  async stat(path) {
    const rel = this._rel(path);
    if (!rel) return { kind: 'directory', size: 0, modified: null };
    const file = this.files.get(rel);
    if (!file) throw vfsNotFound(rel);
    return { kind: 'file', size: file.size, modified: file.lastModified || null };
  }
}

// ------------------------------------------------------------
//  SystemBinWorkspace — virtual userland view over the injected
//  shell command registry. Never references SHELL_COMMANDS directly.
// ------------------------------------------------------------
class SystemBinWorkspace extends WorkspaceAdapter {
  constructor(listCommands) {
    super();
    this.name = 'system-bin';
    this._listCommands = typeof listCommands === 'function' ? listCommands : () => [];
  }

  _commands() {
    return [...new Set(this._listCommands())].sort();
  }

  _rel(path) { return normalizeWorkspacePath(path); }

  async list(path) {
    const rel = this._rel(path);
    if (!rel) return this._commands().map((name) => ({ name, kind: 'file' }));
    if (this._commands().includes(rel)) throw vfsError('TypeMismatchError', 'not a directory: ' + rel);
    throw vfsNotFound(rel);
  }

  async read(path) {
    const rel = this._rel(path);
    if (!rel) throw vfsError('TypeMismatchError', 'is a directory: /');
    if (!this._commands().includes(rel)) throw vfsNotFound(rel);
    return ''; // virtual capability view, not real executables
  }

  async readBytes(path) {
    return new TextEncoder().encode(await this.read(path));
  }

  async write(path) { throw vfsReadOnly(this._rel(path)); }
  async remove(path) { throw vfsReadOnly(this._rel(path)); }
  async mkdir(path) { throw vfsReadOnly(this._rel(path)); }

  async exists(path) {
    const rel = this._rel(path);
    return rel === '' || this._commands().includes(rel);
  }

  async stat(path) {
    const rel = this._rel(path);
    if (!rel) return { kind: 'directory', size: 0, modified: null };
    if (!this._commands().includes(rel)) throw vfsNotFound(rel);
    return { kind: 'file', size: 0, modified: null };
  }
}

// ------------------------------------------------------------
//  VirtualWorkspace — the always-present VFS. Skeleton structural
//  dirs are owned by the VFS itself; mounts route by longest-prefix
//  on segment boundaries. All public fs methods take absolute paths.
// ------------------------------------------------------------

// Structural skeleton: dir -> direct child names NOT provided by mounts.
const VFS_SKELETON = {
  '/': ['usr', 'home', 'tmp', 'mnt'],
  '/usr': ['lib', 'local'],
  '/usr/lib': ['locus'],
  '/usr/lib/locus': [],
  '/usr/local': ['share'],
  '/usr/local/share': ['locus'],
  '/usr/local/share/locus': ['skills', 'capabilities'],
  '/usr/local/share/locus/skills': [],
  '/home': [],
  '/mnt': ['plugins'],
  '/mnt/plugins': [],
};

// M2a (repository split): the durable home layout is a CONSTRUCTOR
// ARGUMENT, not a product global. The Product passes its skeleton
// (LOCUS_HOME_SKELETON) explicitly; a generic host constructing the VFS
// without one gets this neutral, non-Locus default.
const VFS_DEFAULT_HOME_SKELETON = ['.config', '.cache'];

const VFS_PROTECTED_ROOTS = new Set([
  '/', '/usr', '/home', '/home/locus', '/mnt',
  '/mnt/workspace', '/mnt/upload', '/mnt/download', '/mnt/plugins',
]);

class VirtualWorkspace {
  constructor(opts) {
    opts = opts || {};
    this.isLocusVFS = true;
    this.mounts = []; // ordered [{ path, provider, authority }]

    // The caller's home skeleton (Product supplies LOCUS_HOME_SKELETON);
    // relative dir paths created inside the /home/locus memory provider.
    const homeSkeleton = Array.isArray(opts.homeSkeleton)
      ? opts.homeSkeleton.slice()
      : VFS_DEFAULT_HOME_SKELETON;
    // Remembered for resetHome()/resetEphemeral() rebuilds.
    this._homeSkeleton = homeSkeleton;
    const home = new MemoryWorkspace({
      name: 'home',
      dirs: homeSkeleton,
    });
    const sysbin = new SystemBinWorkspace(opts.listCommands);

    this.mount('/home/locus', home, 'read-write');
    this.mount('/tmp', new MemoryWorkspace({ name: 'tmp' }), 'read-write');
    this.mount('/mnt/upload', new UploadWorkspace({ name: 'upload' }), 'read-only');
    this.mount('/mnt/download', new MemoryWorkspace({ name: 'download', maxBytes: 64 * 1024 * 1024 }), 'read-write');
    this.mount('/usr/bin', sysbin, 'system-read-only');
    this.mount('/bin', sysbin, 'system-read-only'); // alias: same provider instance
    // /mnt/workspace is NOT mounted by default.
  }

  _abs(path) { return normalizeVfsPath(path, '/'); }

  _mountAt(absPath) {
    for (const m of this.mounts) if (m.path === absPath) return m;
    return null;
  }

  _isStructural(abs) {
    return Object.prototype.hasOwnProperty.call(VFS_SKELETON, abs);
  }

  _underUnmountedWorkspace(abs) {
    return (abs === '/mnt/workspace' || abs.startsWith('/mnt/workspace/'))
      && !this._mountAt('/mnt/workspace');
  }

  _throwNotMounted() {
    throw vfsError('NotMountedError', '/mnt/workspace: not mounted');
  }

  // Longest-prefix match on segment boundaries.
  resolveMount(path) {
    const abs = this._abs(path);
    let best = null;
    for (const m of this.mounts) {
      if (abs === m.path || abs.startsWith(m.path + '/')) {
        if (!best || m.path.length > best.path.length) best = m;
      }
    }
    if (!best) return null;
    return {
      path: best.path,
      provider: best.provider,
      authority: best.authority,
      rel: abs === best.path ? '' : abs.slice(best.path.length + 1),
    };
  }

  mount(path, provider, authority) {
    const abs = this._abs(path);
    if (abs === '/') throw new Error('cannot mount over filesystem root');
    if (!provider) throw new Error('mount requires a provider: ' + abs);
    const auth = authority === undefined || authority === null ? 'read-write' : String(authority);
    if (!VFS_AUTHORITIES.includes(auth)) throw new Error('invalid mount authority: ' + auth);
    const existing = this._mountAt(abs);
    if (existing) {
      existing.provider = provider;
      existing.authority = auth;
      return;
    }
    this.mounts.push({ path: abs, provider, authority: auth });
  }

  unmount(path) {
    const abs = this._abs(path);
    const i = this.mounts.findIndex((m) => m.path === abs);
    if (i === -1) throw vfsError('NotMountedError', abs + ': not mounted');
    this.mounts.splice(i, 1);
  }

  // A task-bound view of this VFS: SAME provider instances, INDEPENDENT
  // mount table. mount()/unmount() on the original (e.g. a workspace
  // switch replacing the /mnt/workspace provider) can never rebind an
  // in-flight task holding a fork — the fork's mount entries are private
  // copies that keep routing to the providers captured at fork time.
  fork() {
    const f = Object.create(VirtualWorkspace.prototype);
    f.isLocusVFS = true;
    f.mounts = this.mounts.map((m) => ({ path: m.path, provider: m.provider, authority: m.authority }));
    return f;
  }

  async list(path) {
    const abs = this._abs(path);
    const r = this.resolveMount(abs);
    if (r) {
      const entries = await r.provider.list(r.rel);
      // A nested virtual mount (for example /home/locus/history) is visible
      // from its parent even when the parent provider is OPFS-backed.
      if (abs === r.path) {
        const names = new Map(entries.map((e) => [e.name, e]));
        for (const m of this.mounts) {
          const slash = m.path.lastIndexOf('/');
          const parent = slash === 0 ? '/' : m.path.slice(0, slash);
          if (parent === abs) names.set(m.path.slice(slash + 1), { name: m.path.slice(slash + 1), kind: 'directory' });
        }
        return [...names.values()].sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'directory' ? -1 : 1));
      }
      return entries;
    }
    if (this._underUnmountedWorkspace(abs)) this._throwNotMounted();
    if (this._isStructural(abs)) {
      const names = new Set(VFS_SKELETON[abs]);
      for (const m of this.mounts) {
        const slash = m.path.lastIndexOf('/');
        const parent = slash === 0 ? '/' : m.path.slice(0, slash);
        if (parent === abs) names.add(m.path.slice(slash + 1));
      }
      return [...names].sort().map((name) => ({ name, kind: 'directory' }));
    }
    throw vfsNotFound(abs);
  }

  async stat(path) {
    const abs = this._abs(path);
    const r = this.resolveMount(abs);
    if (r) return r.provider.stat(r.rel);
    if (this._underUnmountedWorkspace(abs)) this._throwNotMounted();
    if (this._isStructural(abs)) return { kind: 'directory', size: 0, modified: null };
    throw vfsNotFound(abs);
  }

  async exists(path) {
    const abs = this._abs(path);
    const r = this.resolveMount(abs);
    if (r) return r.provider.exists(r.rel);
    if (this._underUnmountedWorkspace(abs)) return false;
    return this._isStructural(abs);
  }

  async read(path) {
    const abs = this._abs(path);
    const r = this.resolveMount(abs);
    if (r) return r.provider.read(r.rel);
    if (this._underUnmountedWorkspace(abs)) this._throwNotMounted();
    if (this._isStructural(abs)) throw vfsError('TypeMismatchError', 'is a directory: ' + abs);
    throw vfsNotFound(abs);
  }

  async readBytes(path) {
    const abs = this._abs(path);
    const r = this.resolveMount(abs);
    if (r) return r.provider.readBytes(r.rel);
    if (this._underUnmountedWorkspace(abs)) this._throwNotMounted();
    if (this._isStructural(abs)) throw vfsError('TypeMismatchError', 'is a directory: ' + abs);
    throw vfsNotFound(abs);
  }

  async write(path, data) {
    const abs = this._abs(path);
    const r = this.resolveMount(abs);
    if (r) {
      if (vfsIsReadOnlyAuthority(r.authority)) throw vfsReadOnly(abs);
      return r.provider.write(r.rel, data);
    }
    if (this._underUnmountedWorkspace(abs)) this._throwNotMounted();
    throw vfsReadOnly(abs); // structural or unknown path: there is no provider
  }

  async remove(path) {
    const abs = this._abs(path);
    const r = this.resolveMount(abs);
    if (r) {
      if (vfsIsReadOnlyAuthority(r.authority)) throw vfsReadOnly(abs);
      return r.provider.remove(r.rel);
    }
    if (this._underUnmountedWorkspace(abs)) this._throwNotMounted();
    throw vfsReadOnly(abs);
  }

  async mkdir(path) {
    const abs = this._abs(path);
    const r = this.resolveMount(abs);
    if (r) {
      if (vfsIsReadOnlyAuthority(r.authority)) throw vfsReadOnly(abs);
      return r.provider.mkdir(r.rel);
    }
    if (this._underUnmountedWorkspace(abs)) this._throwNotMounted();
    throw vfsReadOnly(abs);
  }

  authorityOf(path) {
    const abs = this._abs(path);
    const r = this.resolveMount(abs);
    if (r) return r.authority;
    if (this._underUnmountedWorkspace(abs)) return 'not-mounted';
    return 'none';
  }

  // Throws before any side effect when the path is not agent-writable.
  assertWritable(path) {
    const abs = this._abs(path);
    const r = this.resolveMount(abs);
    if (r) {
      if (vfsIsReadOnlyAuthority(r.authority)) throw vfsReadOnly(abs);
      return;
    }
    if (this._underUnmountedWorkspace(abs)) this._throwNotMounted();
    throw new Error('read-only filesystem: structural path ' + abs);
  }

  defaultCwd() {
    return this._mountAt('/mnt/workspace') ? '/mnt/workspace' : '/home/locus';
  }

  getEnv() {
    return { HOME: '/home/locus', PATH: '/usr/local/bin:/usr/bin:/bin', TMPDIR: '/tmp' };
  }

  get workspaceName() {
    const m = this._mountAt('/mnt/workspace');
    return m && m.provider ? m.provider.name || null : null;
  }

  // The set mirrored into Python (workspace only when mounted).
  dataMounts() {
    const out = [];
    for (const root of ['/mnt/workspace', '/mnt/upload', '/mnt/download', '/home/locus', '/tmp']) {
      const m = this._mountAt(root);
      if (m) out.push({ root, authority: m.authority, provider: m.provider });
    }
    return out;
  }

  isProtectedRoot(path) {
    return VFS_PROTECTED_ROOTS.has(this._abs(path));
  }

  // Replace the live home provider with a fresh memory-backed home. Durable
  // clearing belongs to PersistenceService; this primitive only resets the
  // currently mounted VFS provider after the storage mutation has quiesced.
  resetHome() {
    this.mount('/home/locus', new MemoryWorkspace({
      name: 'home',
      dirs: this._homeSkeleton,
    }), 'read-write');
  }

  // Browser-session mounts are intentionally recreated on a full reset.
  // Durable OPFS/IDB providers are left untouched here and are cleared by
  // PersistenceService's explicit reset operation.
  resetEphemeral() {
    const mounts = new Map(this.mounts.map((m) => [m.path, m]));
    this.mount('/tmp', new MemoryWorkspace({ name: 'tmp' }), 'read-write');
    this.mount('/mnt/download', new MemoryWorkspace({ name: 'download', maxBytes: 64 * 1024 * 1024 }), 'read-write');
    this.mount('/mnt/upload', new UploadWorkspace({ name: 'upload' }), 'read-only');
  }
}

// ============================================================
//  M3a (repository extraction): ES module exports. The M2a classic
//  globalThis publishes are gone — shell.js and the public entry
//  import these names directly.
// ============================================================
export {
  normalizeVfsPath,
  vfsError,
  MemoryWorkspace,
  UploadWorkspace,
  SystemBinWorkspace,
  VirtualWorkspace,
};
