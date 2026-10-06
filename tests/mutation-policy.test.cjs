// MutationPolicy PORT tests (M3a extraction of tests/mutation-policy.test.cjs).
//
// The skill-identity rules are PRODUCT policy (src/mutation-policy.js in
// the product repository) consumed by the generic runtime shell through
// opts.mutationPolicy — the shell carries NO hardcoded policy-tree
// knowledge, and the product's /home/locus/.skills knowledge does NOT
// ship with the Runtime package. The byte-stable refusal matrix against
// the REAL LocusMutationPolicy (old MP1/MP6) stays Product-side coverage
// in the source repository.
//
// This migrated suite pins the RUNTIME side of the port with a GENERIC
// host policy fixture guarding a neutral tree (/home/locus/keep):
//
//  MP-G1  the shell executes the INJECTED policy: refusals compose as
//         'mv: <resolved source>: <reason>' / 'rm: <reason>' and the
//         guarded tree is enforced on source AND final destination;
//  MP-G2  no policy injected = the generic runtime's neutral behavior
//         (the same tree is a plain writable path);
//  MP-G3  path shapes: relative paths, .., redundant segments, trailing
//         slashes resolve BEFORE the policy sees them — no spelling
//         slips through;
//  MP-G4  the mv final destination (basename appended for
//         mv-into-directory) and multi-source moves are judged on the
//         real target;
//  MP-G5  non-guarded operations are not over-blocked;
//  MP-G6  the VFS's own protections (protected roots, read-only mounts,
//         into-itself geometry) still refuse WITH a policy present — the
//         policy never grants; the policy check sits BEFORE the
//         geometric rules (original check order preserved);
//  MP-G7  isPolicyRefusal: python commit-phase errors from the policy
//         family report as honest conflicts with the policy injected,
//         and as plain write failures without it;
//  MP-G8  a DIFFERENT policy (guarding another tree) is enforced
//         verbatim and the first fixture's tree is NOT special to it.
// Run: node tests/mutation-policy.test.cjs

const M = require('./helpers/core.cjs');
const { freshRuntime } = require('./helpers/runtime.cjs');

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + detail : '')); }
}

// A GENERIC host policy fixture (the same checkMove/checkRemove/
// isPolicyRefusal port shape the Product policy implements), guarding a
// neutral tree. reason texts are the fixture's own — the shell composes
// them verbatim.
const GUARD = '/home/locus/keep';
const KEEP_REASON = 'kept tree is immutable';
const policy = {
  checkMove(a) {
    if (a.source.indexOf(GUARD) === 0 || a.destination.indexOf(GUARD) === 0) {
      return { allowed: false, reason: KEEP_REASON };
    }
    return { allowed: true };
  },
  checkRemove(a) {
    if (a.target.indexOf(GUARD) === 0) {
      return { allowed: false, reason: KEEP_REASON };
    }
    return { allowed: true };
  },
  isPolicyRefusal(e) { return !!e && e.code === 'kept_refusal'; },
};

const bare = () => new M.VirtualWorkspace({ listCommands: () => Object.keys(M.SHELL_COMMANDS) });

async function freshTree(vfs) {
  await vfs.mkdir(GUARD + '/cap-a');
  await vfs.mkdir(GUARD + '/cap-a/sub');
  await vfs.write(GUARD + '/cap-a/keep-file.txt', 'guidance\n');
  await vfs.write('/home/locus/notes.txt', 'mine\n');
  await vfs.mkdir('/tmp/work');
  await vfs.write('/tmp/work/other.txt', 'other\n');
}

async function run() {
  // ================= MP-G1. the injected policy is enforced =================
  {
    const vfs = bare();
    await freshTree(vfs);
    const run = (cmd) => M.runShellCommand(cmd, vfs, { mutationPolicy: policy });

    const mv1 = await run('mv /home/locus/keep/cap-a/keep-file.txt /home/locus/renamed.txt');
    check('MP-G1 mv out of the guarded tree is refused with the composed reason',
      mv1.isError && mv1.output === 'mv: /home/locus/keep/cap-a/keep-file.txt: ' + KEEP_REASON,
      JSON.stringify(mv1.output));
    check('MP-G1b nothing was moved',
      await vfs.exists('/home/locus/keep/cap-a/keep-file.txt')
        && !(await vfs.exists('/home/locus/renamed.txt')));

    const mv2 = await run('mv /home/locus/notes.txt /home/locus/keep/cap-a/incoming.txt');
    check('MP-G1c mv INTO the guarded tree is refused (destination side)',
      mv2.isError && mv2.output === 'mv: /home/locus/notes.txt: ' + KEEP_REASON, JSON.stringify(mv2.output));
    check('MP-G1d the source survived and nothing landed inside',
      await vfs.exists('/home/locus/notes.txt') && !(await vfs.exists('/home/locus/keep/cap-a/incoming.txt')));

    const mv3 = await run('mv /home/locus/keep/cap-a /home/locus/moved-cap');
    check('MP-G1e mv of a guarded DIRECTORY is refused',
      mv3.isError && mv3.output === 'mv: /home/locus/keep/cap-a: ' + KEEP_REASON, JSON.stringify(mv3.output));

    const rm1 = await run('rm -r /home/locus/keep/cap-a');
    check('MP-G1f rm -r of a guarded directory is refused with the composed text',
      rm1.isError && rm1.output === 'rm: ' + KEEP_REASON, JSON.stringify(rm1.output));
    check('MP-G1g the directory survived with its files',
      await vfs.exists('/home/locus/keep/cap-a/keep-file.txt'));
  }

  // ============ MP-G2. no policy = neutral generic runtime ============
  {
    const vfs = bare();
    await freshTree(vfs);
    const r1 = await M.runShellCommand('mv /home/locus/keep/cap-a/keep-file.txt /tmp/work/file.txt', vfs, {});
    check('MP-G2 without a policy the guarded tree is a plain path (generic runtime)',
      !r1.isError && (await vfs.exists('/tmp/work/file.txt')), JSON.stringify(r1.output));
    const r2 = await M.runShellCommand('rm -r /home/locus/keep', vfs, {});
    check('MP-G2b rm -r of the fixture tree without a policy is VFS-rules-only',
      !r2.isError && !(await vfs.exists('/home/locus/keep')), JSON.stringify(r2.output));
  }

  // ============ MP-G3. path shapes resolve before the policy ============
  {
    const vfs = bare();
    await freshTree(vfs);
    const run = (cmd) => M.runShellCommand(cmd, vfs, { mutationPolicy: policy });

    const spellings = [
      'mv /home/locus/keep/../keep/cap-a/keep-file.txt /tmp/work/x.txt',
      'mv /home/locus//keep/cap-a/keep-file.txt /tmp/work/x.txt',
      'mv /home/locus/keep/./cap-a/keep-file.txt /tmp/work/x.txt',
      'mv /home/locus/keep/cap-a/keep-file.txt/ /tmp/work/x.txt',
    ];
    for (let i = 0; i < spellings.length; i++) {
      await freshTree(vfs); // restore the file each round
      const r = await run(spellings[i]);
      check('MP-G3.' + i + ' spelling is normalized before the policy: ' + spellings[i].slice(0, 46) + '…',
        r.isError && r.output === 'mv: ' + spellings[i].split(' ')[1] + ': ' + KEEP_REASON,
        JSON.stringify(r.output));
    }

    // Relative paths against an explicit cwd are resolved by the shell.
    const r5 = await M.runShellCommand('cd /home/locus && mv keep/cap-a/keep-file.txt /tmp/work/x.txt', vfs,
      { mutationPolicy: policy });
    check('MP-G3b a relative path into the guarded tree is refused after resolution',
      r5.isError && r5.output === 'mv: keep/cap-a/keep-file.txt: ' + KEEP_REASON,
      JSON.stringify(r5.output));
    const r6 = await M.runShellCommand('cd /home/locus/keep/cap-a/sub && rm -r ../../../keep', vfs,
      { mutationPolicy: policy });
    check('MP-G3c .. traversal out of a nested cwd still lands on the guarded root',
      r6.isError && r6.output === 'rm: ' + KEEP_REASON, JSON.stringify(r6.output));
  }

  // ============ MP-G4. final destination + multi-source ============
  {
    const vfs = bare();
    await freshTree(vfs);
    const run = (cmd) => M.runShellCommand(cmd, vfs, { mutationPolicy: policy });

    // mv INTO the guarded directory appends the basename — the FINAL
    // target is under the tree, so the refusal fires on the resolved
    // destination.
    const m1 = await run('mv /home/locus/notes.txt /home/locus/keep');
    check('MP-G4 mv-into-directory is judged on the basename-appended target',
      m1.isError && m1.output === 'mv: /home/locus/notes.txt: ' + KEEP_REASON, JSON.stringify(m1.output));

    // A guarded-tree source moved INTO an existing directory elsewhere:
    // the SOURCE side still refuses.
    const m2 = await run('mv /home/locus/keep/cap-a /tmp/work');
    check('MP-G4b moving a guarded directory OUT is refused',
      m2.isError && m2.output === 'mv: /home/locus/keep/cap-a: ' + KEEP_REASON, JSON.stringify(m2.output));

    // Multi-source mv into the guarded tree: refused, nothing moved.
    const m3 = await run('mv /home/locus/notes.txt /tmp/work/other.txt /home/locus/keep');
    check('MP-G4c multi-source mv into the guarded tree is refused',
      m3.isError && m3.output === 'mv: /home/locus/notes.txt: ' + KEEP_REASON, JSON.stringify(m3.output));
    check('MP-G4d no source moved',
      await vfs.exists('/home/locus/notes.txt') && (await vfs.exists('/tmp/work/other.txt')));

    // A move whose final target is OUTSIDE the tree passes: dest dir
    // /home/locus is not under the root, finalAbs = /home/locus/x.txt.
    await vfs.write('/tmp/work/incoming.txt', 'x\n');
    const m4 = await run('mv /tmp/work/incoming.txt /home/locus');
    check('MP-G4e a destination NEXT TO the guarded tree is allowed',
      !m4.isError && (await vfs.exists('/home/locus/incoming.txt')), JSON.stringify(m4.output));
  }

  // ============ MP-G5. non-guarded operations are not over-blocked ==========
  {
    const vfs = bare();
    await freshTree(vfs);
    const run = (cmd) => M.runShellCommand(cmd, vfs, { mutationPolicy: policy });
    const r1 = await run('mv /home/locus/notes.txt /tmp/work/notes.txt');
    check('MP-G5 ordinary mv is untouched', !r1.isError && (await vfs.exists('/tmp/work/notes.txt')), JSON.stringify(r1.output));
    const r2 = await run('rm -r /tmp/work');
    check('MP-G5b ordinary rm -r outside the guarded tree is untouched',
      !r2.isError && !(await vfs.exists('/tmp/work')), JSON.stringify(r2.output));
    const r3 = await run('echo created > /home/locus/created.txt');
    check('MP-G5c non-mv/rm file work is untouched by the policy port (the mount guard owns those)',
      !r3.isError && (await vfs.exists('/home/locus/created.txt')), JSON.stringify(r3.output));
  }

  // ============ MP-G6. VFS protections still hold WITH the policy =========
  {
    const vfs = bare();
    await freshTree(vfs);
    const run = (cmd) => M.runShellCommand(cmd, vfs, { mutationPolicy: policy });
    const r1 = await run('rm -r /home/locus');
    check('MP-G6 the protected-root refusal stays a RUNTIME check (never the policy)',
      r1.isError && r1.output.startsWith('rm: refusing to recursively remove protected path: /home/locus'),
      JSON.stringify(r1.output));
    // Order preservation: the policy check sits exactly where the old
    // hardcoded check sat — BEFORE the stat/into-itself rules — so a
    // guarded path gets the policy refusal, not the geometric one.
    const r2 = await run('mv /home/locus/keep /home/locus/keep/cap-a/sub');
    check('MP-G6b guarded paths get the policy refusal first (original check order preserved)',
      r2.isError && r2.output === 'mv: /home/locus/keep: ' + KEEP_REASON, JSON.stringify(r2.output));
    // The geometric rule itself stays runtime-owned for non-guarded trees.
    vfs.mount('/mnt/area', new M.MemoryWorkspace({ name: 'area' }), 'read-write');
    await vfs.write('/mnt/area/keep.txt', 'x\n');
    const r3 = await run('mv /mnt/area /mnt/area/inside');
    check('MP-G6c mount-root protection is still the runtime\'s refusal',
      r3.isError && r3.output.includes('cannot move a directory into itself'),
      JSON.stringify(r3.output));
  }

  // ============ MP-G7. isPolicyRefusal in the python commit phase =========
  {
    const rt = freshRuntime(M);
    rt._ensureWorker = async () => {};
    rt.worker = {
      postMessage(msg) {
        const p = rt._pending.get(msg.id);
        queueMicrotask(() => {
          clearTimeout(p.timer);
          rt._pending.delete(msg.id);
          p.resolve({
            stdout: '', stderr: '', error: null,
            files: [{ path: '/home/locus/out.txt', b64: Buffer.from('written by python', 'utf8').toString('base64') }],
            deleted: [],
          });
        });
      },
    };
    const refusingProvider = {
      name: 'refusing',
      async list() { return []; },
      async readBytes(p) { const e = new Error('no such file: ' + p); e.name = 'NotFoundError'; throw e; },
      async write(p) { const e = new Error('declined by the user'); e.code = 'kept_refusal'; throw e; },
      async exists() { return false; },
      async stat() { const e = new Error('no such file'); e.name = 'NotFoundError'; throw e; },
    };
    const vfs = bare();
    vfs.mount('/home/locus', refusingProvider, 'read-write');

    const withPolicy = await M.runShellCommand("python -c 'x'", vfs, { mutationPolicy: policy, pythonRuntime: rt });
    check('MP-G7 a policy-family error is reported as a REFUSED conflict (with policy)',
      withPolicy.isError && withPolicy.output.includes('conflict: /home/locus/out.txt')
        && withPolicy.output.includes('declined by the user'),
      JSON.stringify(withPolicy.output));

    const withoutPolicy = await M.runShellCommand("python -c 'x'", vfs, { pythonRuntime: rt });
    check('MP-G7b without the policy the same error is a plain write failure',
      withoutPolicy.isError && withoutPolicy.output.includes('write-back failed: /home/locus/out.txt')
        && !withoutPolicy.output.includes('conflict:'),
      JSON.stringify(withoutPolicy.output));
  }

  // ======== MP-G8. a DIFFERENT policy guards a different tree (verbatim) ========
  {
    const vfs = bare();
    await freshTree(vfs);
    const other = {
      checkMove(a) {
        if (a.source.indexOf('/mnt/protected') === 0 || a.destination.indexOf('/mnt/protected') === 0) {
          return { allowed: false, reason: 'custom tree is immutable' };
        }
        return { allowed: true };
      },
      checkRemove(a) {
        if (a.target.indexOf('/mnt/protected') === 0) {
          return { allowed: false, reason: 'custom tree is immutable' };
        }
        return { allowed: true };
      },
      isPolicyRefusal(e) { return !!e && e.code === 'custom_refusal'; },
    };
    vfs.mount('/mnt/protected', new M.MemoryWorkspace({ name: 'protected' }), 'read-write');
    await vfs.write('/mnt/protected/data.txt', 'locked\n');
    const run = (cmd) => M.runShellCommand(cmd, vfs, { mutationPolicy: other });

    const r1 = await run('mv /mnt/protected/data.txt /tmp/work/data.txt');
    check('MP-G8 the alternative policy is enforced verbatim',
      r1.isError && r1.output === 'mv: /mnt/protected/data.txt: custom tree is immutable',
      JSON.stringify(r1.output));
    const r2 = await run('mv /home/locus/keep/cap-a/keep-file.txt /tmp/work/skill.txt');
    check('MP-G8b the same shell ALLOWS the first fixture\'s tree under the alternative policy',
      !r2.isError && !(await vfs.exists('/home/locus/keep/cap-a/keep-file.txt'))
        && (await vfs.exists('/tmp/work/skill.txt')),
      JSON.stringify(r2.output));
    const r3 = await run('rm -r /mnt/protected');
    check('MP-G8c the alternative policy refuses its own tree on rm',
      r3.isError && r3.output === 'rm: custom tree is immutable', JSON.stringify(r3.output));
    // mv -f style flag refusals and VFS rules are runtime-owned and unchanged.
    const r4 = await run('mv -f /home/locus/notes.txt /tmp/work/x.txt');
    check('MP-G8d runtime-owned command rules are untouched by the policy port',
      r4.isError && r4.output.includes('mv: -f is not supported'), JSON.stringify(r4.output));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.error('TEST RUNNER FAIL', e); process.exit(1); });
