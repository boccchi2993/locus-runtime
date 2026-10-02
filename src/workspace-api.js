// ============================================================
//  PUBLIC WORKSPACE PROVIDER API — the "locus-runtime/workspace"
//  subpath export (M3a review round F1).
//
//  The root entry ('locus-runtime') exposes the execution contract
//  (createRuntime → Host → Session) and the VFS factories
//  (createWorkspace / createMemoryWorkspace). THIS subpath exposes the
//  provider LAYER beneath them — the surface a host product mounts its
//  own storage through:
//
//    WorkspaceAdapter            the provider base class. Extend it to
//                                bring any backend the host owns (IDB
//                                views, static trees, task-scoped
//                                permission-guarded views) — every
//                                mount routes through this shape.
//    LocalDirectoryWorkspace     a user-picked directory (File System
//                                Access API directory handle).
//    OPFSWorkspace               an Origin-Private File System
//                                directory handle (e.g. from
//                                navigator.storage.getDirectory()).
//    normalizeWorkspacePath      the ONE path-normalization algorithm
//                                every provider shares. Rejects
//                                traversal ('..' past the root), control
//                                characters, drive letters and ':'
//                                segments; a host provider reusing it
//                                inherits the same escape rules as the
//                                built-ins.
//    ensureWorkspacePermission   request 'readwrite' for a picked
//                                handle (query → request; resolves
//                                false when the user denies — it never
//                                throws for a denial).
//    vfsError                    the runtime's name-tagged Error
//                                factory. Host providers throw these
//                                so the VFS/shell keep classifying
//                                their faults (NotFoundError →
//                                exists() === false, ReadOnlyError,
//                                TypeMismatchError, …).
//
//  OWNERSHIP (M3a review F1 audit — docs/EXTRACTION-PLAN.md §1b): the
//  runtime provides the generic providers and filesystem mechanisms;
//  the HOST picks directories, obtains OPFS handles, decides mount
//  points/authorities and owns persistence, schema and product policy.
//  Nothing here is Product code (no IDB, no session history, no
//  persistence service).
//
//  IMPORT PURITY: importing this module is pure — it requests no
//  permission, touches no OPFS/DOM/storage, starts no worker and
//  downloads no Python. Effects happen only when a constructed provider
//  is used.
//
//  SINGLE IMPLEMENTATION: one-way re-exports of the exact symbols the
//  internal graph uses (src/workspace.js / src/vfs.js). No wrapper, no
//  copy, no global table.
// ============================================================

export {
  WorkspaceAdapter,
  LocalDirectoryWorkspace,
  OPFSWorkspace,
  normalizeWorkspacePath,
  ensureWorkspacePermission,
} from './workspace.js';
export { vfsError } from './vfs.js';
