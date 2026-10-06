// M3a: a scripted implementation of the Runtime execution-authorization
// port (the §3.5 consumer contract) for unit suites.
//
// The source repository tests this port against the REAL harness
// ApprovalController; that class belongs to the Harness and does NOT
// ship with the Runtime package. The fixture below reproduces exactly
// the consumer-contract semantics the migrated suite pins: at most one
// pending interactive request, resolve/cancel by id (stale ids are
// no-ops), exact-key session grants, deny ≠ cancel. NetworkRuntime must
// work identically with ANY port implementation honoring that contract —
// that is the port's point.
class FakeApprovalPort {
  constructor() {
    this.asks = [];            // every request(spec) the Runtime made
    this.pending = null;       // the single outstanding ask (or null)
    this.grants = new Map();   // policyKey -> true (session-scoped)
    this._waiters = new Map(); // id -> { resolve }
    this._seq = 0;
  }

  request(spec) {
    this.asks.push(spec);
    if (this.grants.get(spec.policyKey)) {
      return Promise.resolve({ outcome: 'allow', scope: 'session' });
    }
    if (this.pending) {
      return Promise.reject(new Error('approval port: a request is already pending'));
    }
    const id = 'ask-' + (++this._seq);
    this.pending = Object.assign({ id: id }, spec);
    return new Promise((resolve) => { this._waiters.set(id, { resolve }); });
  }

  // Test-side decision delivery (mirrors ApprovalController.resolve).
  resolve(id, decision) {
    const w = this._waiters.get(id);
    if (!w) return false; // stale id: no-op
    this._waiters.delete(id);
    this.pending = null;
    if (decision && decision.outcome === 'allow' && decision.scope === 'session') {
      const spec = this.asks[this.asks.length - 1];
      this.grants.set(spec.policyKey, true);
    }
    w.resolve(decision || { outcome: 'deny', scope: 'once' });
    return true;
  }

  // Test-side cancellation delivery (mirrors ApprovalController.cancel):
  // a cancelled ask resolves { outcome: 'cancelled' } — distinct from deny.
  cancel(id) {
    const w = this._waiters.get(id);
    if (!w) return false;
    this._waiters.delete(id);
    this.pending = null;
    w.resolve({ outcome: 'cancelled', scope: 'once' });
    return true;
  }

  hasSessionGrant(policyKey) {
    return this.grants.get(policyKey) === true;
  }
}

module.exports = { FakeApprovalPort };
