// Shared mid-flight lifecycle contract judgments (M3a review round 2).
//
// ONE source of truth for the C4b (reset boundary), C4e (mid-flight
// caller abort) and C4f (mid-flight dispose) check bodies:
//   - consumer-gate.cjs runs the *Checks (the strengthened round-2
//     forms) inside the normal out-of-repo consumer gate;
//   - selfcheck-faults.cjs runs BOTH the *LegacyChecks (the round-1
//     forms — proven BLIND by controlled fault injection) and the
//     *Checks (proven to CATCH the same faults) against fault-wrapped
//     sessions — so the self-verification and the gate assert the very
//     same bodies and cannot drift apart.
//
// Observation shape (the page scenarios in index.html return this):
//   busyAtPark / settledAtPark          — at the provider park, before
//                                         the boundary
//   busyAfterBoundarySync               — SAME-STACK read right after
//                                         the boundary (the round-1
//                                         observation; kept ONLY for
//                                         the fault-proof contrast —
//                                         no *Check is load-bearing on
//                                         it anymore)
//   settledBeforeRelease / busyBeforeRelease /
//   parkedWriteCommittedBeforeRelease /
//   secondWriteDispatchedBeforeRelease  — read AFTER a scheduling-turn
//                                         barrier (a MessageChannel
//                                         macrotask: every promise
//                                         reaction and queueMicrotask
//                                         the boundary could have
//                                         scheduled has run) and
//                                         BEFORE release()
//   res / busyFinal / committedFirst / dispatchedSecond / after
//                                       — post-settlement finals
//   dispose scenario only: executeRejection / prepareRejection (fresh
//   calls after the FIRST dispose), secondDisposeError,
//   executeRejection2 / prepareRejection2 (FRESH calls AFTER the SECOND
//   dispose — never the cached first-round observations),
//   busyAfterSecondDispose, dispatchesAfterSecondDispose.

const FIRST_DISPOSE_REASON = 'consumer mid-flight dispose';
const SECOND_DISPOSE_REASON = 'second dispose call';
const RESET_REASON = 'consumer boundary';

function s(v) { return String(v === undefined || v === null ? '' : v); }

// ---------- mid-flight CALLER abort (C4e) ----------

// The round-1 forms: same-stack reads and finals only. PROVEN BLIND by
// selfcheck-faults.cjs (fault A1: every line here stays green while the
// public busy count lies one microtask after the abort).
function abortLegacyChecks(r) {
  return [
    { name: 'LEGACY(round-1) C4e-i unsettled/busy across the abort (same-stack reads, no scheduling turn)',
      cond: !!r && r.busyAtPark === 1 && r.settledAtPark === false && r.busyAfterBoundarySync === 1,
      detail: JSON.stringify({ busyAtPark: r && r.busyAtPark, settledAtPark: r && r.settledAtPark, busyAfterBoundarySync: r && r.busyAfterBoundarySync }) },
    { name: 'LEGACY(round-1) C4e-ii the dispatched write commits; the second never dispatches',
      cond: !!r && r.committedFirst === true && r.dispatchedSecond === false,
      detail: JSON.stringify({ committedFirst: r && r.committedFirst, dispatchedSecond: r && r.dispatchedSecond }) },
    { name: 'LEGACY(round-1) C4e-iii cancellation-shaped, not a session boundary',
      cond: !!r && r.res && r.res.ok === false && /cancelled/i.test(s(r.res.output)) && r.res.boundary === undefined,
      detail: JSON.stringify(r && r.res) },
    { name: 'LEGACY(round-1) C4e-iv busy drains to zero; the session still executes normally',
      cond: !!r && r.busyFinal === 0 && !!r.after && r.after.ok === true && r.after.output === 'still-usable',
      detail: JSON.stringify({ busyFinal: r && r.busyFinal, after: r && r.after }) },
  ];
}

// The round-2 forms (the normal gate runs THESE).
function abortChecks(r) {
  return [
    { name: 'C4e-i the run stays unsettled with busy=1 across the abort — observed across a scheduling turn BEFORE release (the abort settles and releases nothing early)',
      cond: !!r && r.busyAtPark === 1 && r.settledAtPark === false
        && r.settledBeforeRelease === false && r.busyBeforeRelease === 1,
      detail: JSON.stringify({ busyAtPark: r && r.busyAtPark, settledAtPark: r && r.settledAtPark,
        settledBeforeRelease: r && r.settledBeforeRelease, busyBeforeRelease: r && r.busyBeforeRelease }) },
    { name: 'C4e-ii nothing commits or dispatches after the abort before release; after release the committed write is kept and the second write never dispatches',
      cond: !!r && r.parkedWriteCommittedBeforeRelease === false && r.secondWriteDispatchedBeforeRelease === false
        && r.committedFirst === true && r.dispatchedSecond === false,
      detail: JSON.stringify({ parkedCommittedBeforeRelease: r && r.parkedWriteCommittedBeforeRelease,
        secondDispatchedBeforeRelease: r && r.secondWriteDispatchedBeforeRelease,
        committedFirst: r && r.committedFirst, dispatchedSecond: r && r.dispatchedSecond }) },
    { name: 'C4e-iii the result fails cancellation-shaped and is NOT reported as a session boundary',
      cond: !!r && r.res && r.res.ok === false && /cancelled/i.test(s(r.res.output)) && r.res.boundary === undefined,
      detail: JSON.stringify(r && r.res) },
    { name: 'C4e-iv busy drains to zero; the same session still executes normally',
      cond: !!r && r.busyFinal === 0 && !!r.after && r.after.ok === true && r.after.output === 'still-usable',
      detail: JSON.stringify({ busyFinal: r && r.busyFinal, after: r && r.after }) },
  ];
}

// ---------- reset boundary (C4b) ----------

function resetLegacyChecks(r) {
  return [
    { name: 'LEGACY(round-1) C4b-i unsettled/busy at the boundary (same-stack reads)',
      cond: !!r && r.busyAtPark === 1 && r.settledAtPark === false && r.busyAfterBoundarySync === 1,
      detail: JSON.stringify({ busyAtPark: r && r.busyAtPark, settledAtPark: r && r.settledAtPark, busyAfterBoundarySync: r && r.busyAfterBoundarySync }) },
    { name: 'LEGACY(round-1) C4b-ii the dispatched write commits and the crossed run reports the boundary',
      cond: !!r && r.committedFirst === true && r.dispatchedSecond === false
        && r.res && r.res.ok === false && new RegExp(RESET_REASON).test(s(r.res.boundary) + s(r.res.output)),
      detail: JSON.stringify({ res: r && r.res, committedFirst: r && r.committedFirst, dispatchedSecond: r && r.dispatchedSecond }) },
    { name: 'LEGACY(round-1) C4b-iii busy drains to zero; the session stays usable',
      cond: !!r && r.busyFinal === 0 && !!r.after && r.after.ok === true && r.after.output === 'still-usable',
      detail: JSON.stringify({ busyFinal: r && r.busyFinal, after: r && r.after }) },
  ];
}

function resetChecks(r) {
  return [
    { name: 'C4b-i the parked composite is unsettled with busy=1 before the boundary AND across it (observed across a scheduling turn, before release)',
      cond: !!r && r.busyAtPark === 1 && r.settledAtPark === false
        && r.settledBeforeRelease === false && r.busyBeforeRelease === 1,
      detail: JSON.stringify({ busyAtPark: r && r.busyAtPark, settledAtPark: r && r.settledAtPark,
        settledBeforeRelease: r && r.settledBeforeRelease, busyBeforeRelease: r && r.busyBeforeRelease }) },
    { name: 'C4b-ii nothing commits or dispatches after the boundary before release; the dispatched write then commits (no rollback) and the crossed run reports the boundary',
      cond: !!r && r.parkedWriteCommittedBeforeRelease === false && r.secondWriteDispatchedBeforeRelease === false
        && r.committedFirst === true && r.dispatchedSecond === false
        && r.res && r.res.ok === false && new RegExp(RESET_REASON).test(s(r.res.boundary) + s(r.res.output)),
      detail: JSON.stringify({ parkedCommittedBeforeRelease: r && r.parkedWriteCommittedBeforeRelease,
        secondDispatchedBeforeRelease: r && r.secondWriteDispatchedBeforeRelease,
        res: r && r.res, committedFirst: r && r.committedFirst, dispatchedSecond: r && r.dispatchedSecond }) },
    { name: 'C4b-iii busy drains to zero only after true settlement; the session stays usable',
      cond: !!r && r.busyFinal === 0 && !!r.after && r.after.ok === true && r.after.output === 'still-usable',
      detail: JSON.stringify({ busyFinal: r && r.busyFinal, after: r && r.after }) },
  ];
}

// ---------- mid-flight dispose (C4f) ----------

function disposeLegacyChecks(r) {
  return [
    { name: 'LEGACY(round-1) C4f-i busy stays true across dispose until true settlement (same-stack reads)',
      cond: !!r && r.busyAtPark === 1 && r.busyAfterBoundarySync === 1 && r.busyFinal === 0,
      detail: JSON.stringify({ busyAtPark: r && r.busyAtPark, busyAfterBoundarySync: r && r.busyAfterBoundarySync, busyFinal: r && r.busyFinal }) },
    { name: 'LEGACY(round-1) C4f-ii the settled write is kept; zero dispatches after the boundary',
      cond: !!r && r.committedFirst === true && r.dispatchedSecond === false,
      detail: JSON.stringify({ committedFirst: r && r.committedFirst, dispatchedSecond: r && r.dispatchedSecond }) },
    { name: 'LEGACY(round-1) C4f-iii the run fails with the disposal boundary named',
      cond: !!r && r.res && r.res.ok === false && r.res.isError === true
        && new RegExp(FIRST_DISPOSE_REASON).test(s(r.res.boundary) + s(r.res.output)),
      detail: JSON.stringify(r && r.res) },
    { name: 'LEGACY(round-1) C4f-iv execute AND prepare refuse; dispose idempotent (CACHED reasons captured BEFORE the second dispose — blind to anything the second dispose breaks)',
      cond: !!r && new RegExp(FIRST_DISPOSE_REASON).test(s(r.executeRejection))
        && new RegExp(FIRST_DISPOSE_REASON).test(s(r.prepareRejection))
        && r.secondDisposeError === null
        && !new RegExp(SECOND_DISPOSE_REASON).test(s(r.executeRejection) + s(r.prepareRejection)),
      detail: JSON.stringify({ executeRejection: r && r.executeRejection, prepareRejection: r && r.prepareRejection, secondDisposeError: r && r.secondDisposeError }) },
  ];
}

function disposeChecks(r) {
  return [
    { name: 'C4f-i busy stays TRUE across dispose until the parked op truly settles (observed across a scheduling turn, before release)',
      cond: !!r && r.busyAtPark === 1 && r.settledBeforeRelease === false
        && r.busyBeforeRelease === 1 && r.busyFinal === 0,
      detail: JSON.stringify({ busyAtPark: r && r.busyAtPark, settledBeforeRelease: r && r.settledBeforeRelease,
        busyBeforeRelease: r && r.busyBeforeRelease, busyFinal: r && r.busyFinal }) },
    { name: 'C4f-ii the parked write is not committed and nothing else dispatches before release; the settled write is then kept; zero dispatches after the boundary',
      cond: !!r && r.parkedWriteCommittedBeforeRelease === false && r.secondWriteDispatchedBeforeRelease === false
        && r.committedFirst === true && r.dispatchedSecond === false,
      detail: JSON.stringify({ parkedCommittedBeforeRelease: r && r.parkedWriteCommittedBeforeRelease,
        secondDispatchedBeforeRelease: r && r.secondWriteDispatchedBeforeRelease,
        committedFirst: r && r.committedFirst, dispatchedSecond: r && r.dispatchedSecond }) },
    { name: 'C4f-iii the run fails with the disposal boundary named',
      cond: !!r && r.res && r.res.ok === false && r.res.isError === true
        && new RegExp(FIRST_DISPOSE_REASON).test(s(r.res.boundary) + s(r.res.output)),
      detail: JSON.stringify(r && r.res) },
    { name: 'C4f-iv after the FIRST dispose, execute AND prepare refuse with the disposal reason',
      cond: !!r && new RegExp(FIRST_DISPOSE_REASON).test(s(r.executeRejection))
        && new RegExp(FIRST_DISPOSE_REASON).test(s(r.prepareRejection)),
      detail: JSON.stringify({ executeRejection: r && r.executeRejection, prepareRejection: r && r.prepareRejection }) },
    { name: 'C4f-v after a SECOND dispose, FRESH execute/prepare calls still refuse with the FIRST reason (never the second call\u2019s); the second dispose does not throw; busy stays 0; nothing new dispatches',
      cond: !!r && r.secondDisposeError === null
        && r.executeRejection2 !== null && r.executeRejection2 !== undefined
        && new RegExp(FIRST_DISPOSE_REASON).test(s(r.executeRejection2))
        && !new RegExp(SECOND_DISPOSE_REASON).test(s(r.executeRejection2))
        && r.prepareRejection2 !== null && r.prepareRejection2 !== undefined
        && new RegExp(FIRST_DISPOSE_REASON).test(s(r.prepareRejection2))
        && !new RegExp(SECOND_DISPOSE_REASON).test(s(r.prepareRejection2))
        && r.busyAfterSecondDispose === 0 && r.dispatchesAfterSecondDispose === 0,
      detail: JSON.stringify({ secondDisposeError: r && r.secondDisposeError,
        executeRejection2: r && r.executeRejection2, prepareRejection2: r && r.prepareRejection2,
        busyAfterSecondDispose: r && r.busyAfterSecondDispose,
        dispatchesAfterSecondDispose: r && r.dispatchesAfterSecondDispose }) },
  ];
}

module.exports = {
  abortLegacyChecks, abortChecks,
  resetLegacyChecks, resetChecks,
  disposeLegacyChecks, disposeChecks,
};
