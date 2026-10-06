const { OPFSWorkspace } = require('../src/workspace.js');

class FakeFileHandle {
  constructor(name, node) { this.name = name; this.kind = 'file'; this.node = node; }
  async getFile() {
    const bytes = this.node.bytes.slice();
    return { size: bytes.byteLength, lastModified: 1, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
  }
  async createWritable() {
    const node = this.node;
    return {
      write: async (data) => { node.bytes = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data); },
      close: async () => {},
    };
  }
}

class FakeDirHandle {
  constructor(name) { this.name = name; this.kind = 'directory'; this.children = new Map(); }
  async getDirectoryHandle(name, opts) {
    const existing = this.children.get(name);
    if (existing && existing.kind === 'file') { const e = new Error('type'); e.name = 'TypeMismatchError'; throw e; }
    if (existing) return existing;
    if (!opts || !opts.create) { const e = new Error('missing'); e.name = 'NotFoundError'; throw e; }
    const dir = new FakeDirHandle(name); this.children.set(name, dir); return dir;
  }
  async getFileHandle(name, opts) {
    const existing = this.children.get(name);
    if (existing && existing.kind === 'directory') { const e = new Error('type'); e.name = 'TypeMismatchError'; throw e; }
    if (existing) return existing;
    if (!opts || !opts.create) { const e = new Error('missing'); e.name = 'NotFoundError'; throw e; }
    const file = new FakeFileHandle(name, { bytes: new Uint8Array() }); this.children.set(name, file); return file;
  }
  async *entries() { for (const entry of this.children.entries()) yield entry; }
  async removeEntry(name, opts) {
    const entry = this.children.get(name);
    if (!entry) { const e = new Error('missing'); e.name = 'NotFoundError'; throw e; }
    if (entry.kind === 'directory' && entry.children.size && !(opts && opts.recursive)) throw new Error('not empty');
    this.children.delete(name);
  }
}

(async () => {
  const root = new FakeDirHandle('root');
  const first = new OPFSWorkspace(root, { name: 'home' });
  await first.mkdir('nested');
  await first.write('nested/bytes.bin', new Uint8Array([0, 255, 1, 128]));
  const before = await first.readBytes('nested/bytes.bin');
  const second = new OPFSWorkspace(root, { name: 'home' });
  const after = await second.readBytes('nested/bytes.bin');
  let passed = 0; let failed = 0;
  function check(name, condition) { if (condition) { passed++; console.log('PASS ' + name); } else { failed++; console.log('FAIL ' + name); } }
  check('O1 OPFS workspace writes byte-exact data', Array.from(before).join(',') === '0,255,1,128');
  check('O2 OPFS workspace survives provider recreation', Array.from(after).join(',') === '0,255,1,128');
  check('O3 list exposes durable directories', (await second.list('')).some((e) => e.name === 'nested' && e.kind === 'directory'));
  check('O4 stat exposes durable file size', (await second.stat('nested/bytes.bin')).size === 4);
  console.log('---');
  console.log('opfs-workspace.test.cjs: ' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

