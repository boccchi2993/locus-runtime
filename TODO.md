# Maintenance TODO

The repository split is complete. These are maintenance follow-ups, not unfinished extraction work.

## RT-CI-001: Investigate intermittent CDP readiness failures

- [ ] Open. Owner: Runtime browser-test infrastructure; coordinate with Harness/Product when evidence establishes a shared cause.
- Evidence: [Runtime run 36987973661](https://github.com/boccchi2993/locus-runtime/actions/runs/36987973661) failed on attempt 1 before browser assertions; the authorized attempt 2 passed. [Runtime main run 37461978810](https://github.com/boccchi2993/locus-runtime/actions/runs/37461978810) failed in the out-of-repository consumer at CDP readiness while its separate browser-gates job passed.
- Root cause remains unknown. A passing sibling run or rerun does not establish an environment cause or rule out a regression. Historical Python E3/B-PY1 errors are a separate observation, not a demonstrated common cause.

Implementation path:

1. Preserve first-failure logs with exact commit, run ID, attempt and platform.
2. Record owned Chrome PID, launch arguments, stderr, exit status/signal, endpoint address and phase timings; avoid credentials and unrelated processes.
3. Reproduce under controlled startup conditions and distinguish launch, endpoint discovery, navigation and behavioral failures.
4. Fix the demonstrated cause and add a regression test that fails on the old behavior. Preserve bounded startup and cleanup.

Acceptance: reproducible diagnosis, fixing commit and test evidence linked here; startup failure remains nonzero. Do not close this item solely by retrying, increasing timeouts or observing a green run.

Related: [Product maintenance index](https://github.com/boccchi2993/locus-product/blob/main/TODO.md); [Harness test-result classification](https://github.com/boccchi2993/locus-harness/blob/main/TODO.md).
