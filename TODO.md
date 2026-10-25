# Maintenance TODO

The repository split is complete. These are maintenance follow-ups, not unfinished extraction work.

## RT-CI-001: Investigate intermittent CDP readiness failures

- [ ] Open. Owner: Runtime browser-test infrastructure; coordinate with Harness/Product when evidence establishes a shared cause.
- Evidence: [Runtime run 36987973661](https://github.com/boccchi2993/locus-runtime/actions/runs/36987973661) failed on attempt 1 before browser assertions; the authorized attempt 2 passed. [Runtime main run 37461978810](https://github.com/boccchi2993/locus-runtime/actions/runs/37461978810) failed in the out-of-repository consumer at CDP readiness while its separate browser-gates job passed.
- Root cause remains unknown. A passing sibling run or rerun does not establish an environment cause or rule out a regression. Historical Python E3/B-PY1 errors are a separate observation, not a demonstrated common cause.
- Runner containment (2026-10-12): CI runners are pinned to ubuntu-24.04 while this item is open; upgrading the runner image must be a separate change and waits for a conclusion here.

Implementation path:

1. Preserve first-failure logs with exact commit, run ID, attempt and platform.
2. Record owned Chrome PID, launch arguments, stderr, exit status/signal, endpoint address and phase timings; avoid credentials and unrelated processes.
3. Reproduce under controlled startup conditions and distinguish launch, endpoint discovery, navigation and behavioral failures.
4. Fix the demonstrated cause and add a regression test that fails on the old behavior. Preserve bounded startup and cleanup.

Acceptance: reproducible diagnosis, fixing commit and test evidence linked here; startup failure remains nonzero. Do not close this item solely by retrying, increasing timeouts or observing a green run.

Related: [Product maintenance index](https://github.com/boccchi2993/locus-product/blob/main/TODO.md); [Harness test-result classification](https://github.com/boccchi2993/locus-harness/blob/main/TODO.md).

## E3: Pyodide SystemError on denied js.fetch

- [ ] Open. Owner: Runtime (Pyodide bridge layer); root cause under investigation (RT-D3).

> **临时例外（所有者 2026-10-23 批准，修复合并后失效）**：browser gate 中 B-PY1（product）/ E3（runtime）检查失败时，如果同时满足以下三条，允许重跑**一次**：
> 1. 失败输出中的异常正好是 `SystemError: error return without exception set`（product 看 `DIAG B-PY1 FULL` 行）；
> 2. 同一次运行中零请求的检查（B-PY1b / E3b）通过，即探针请求数为 0；
> 3. 该次运行中没有任何其他检查失败。
> 重跑前，必须先在这里追加一行：失败 run 的链接、head SHA、日期、DIAG 原文的最后一行。重跑后再追加结果。重跑仍失败，或任一条件不满足，照常停下来报告，不得再次重跑。
> 背景：2026-10-23 本机实验，PR #32 前后各 10 次，各失败 1 次，异常均为上述 SystemError，探针 0 请求；根因在 runtime 的 Pyodide 桥接层，调查中（RT-D3）。

## pyfetch denial layer changes when plugins are installed (observation, 2026-10-23)
- [ ] Open. 本机实验（装有 lxml / Pillow 等 plugin 的 worker）中，`pyodide.http.pyfetch` 被拒绝时的文本为 `Locus Python bootstrap: no in-memory asset for <url>`，而不是 F04a 拦截层的 `Python network access is disabled in Locus`；探针 0 请求，安全性质成立。推测：plugin 安装会先加载 micropip，micropip 导入 `pyodide.http`，后者在导入时捕获了当时的 `self.fetch`（即启动期资产解析函数），之后的 F04a 替换对它无效。待确认；修复方向是让启动期解析函数在 READY 前被拦截层取代，或在 lockdown 时同时处理 pyodide.http 内部引用。
