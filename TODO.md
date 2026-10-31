# Maintenance TODO

The repository split is complete. These are maintenance follow-ups, not unfinished extraction work.

## RT-CI-001: Investigate intermittent CDP readiness failures

- [ ] Open. Owner: Runtime browser-test infrastructure; coordinate with Harness/Product when evidence establishes a shared cause.
- Evidence: [Runtime run 36987973661](https://github.com/boccchi2993/locus-runtime/actions/runs/36987973661) failed on attempt 1 before browser assertions; the authorized attempt 2 passed. [Runtime main run 37461978810](https://github.com/boccchi2993/locus-runtime/actions/runs/37461978810) failed in the out-of-repository consumer at CDP readiness while its separate browser-gates job passed.
- Root cause remains unknown. A passing sibling run or rerun does not establish an environment cause or rule out a regression. Historical Python E3/B-PY1 errors are a separate observation, not a demonstrated common cause.
- Runner containment (2026-10-12): CI runners are pinned to ubuntu-24.04 while this item is open; upgrading the runner image must be a separate change and waits for a conclusion here.
- 进展 2026-10-30：product PR #52（CI-STAB，合并提交 a70c301）在 product 的 `tests/helpers/chrome.cjs` 中改为 `--remote-debugging-port=0` + 读取 DevToolsActivePort、就绪等待 60 秒、服务端口 EADDRINUSE 重试。harness TODO 中 2026-10-16 的证据显示 Chrome 在启动后约 10–15 秒才打印 DevTools 监听行，与 15 秒就绪超时吻合。runtime 自己的 `tests/helpers/chrome.cjs` 尚未移植。按本条验收标准，仅加超时不能关单；需要移植修复并补充诊断结论后再关。
- 进展 2026-10-31：runtime 侧移植（PR #14，分支 `test/ci-port-chrome-readiness`）。harness main push run [41185934066](https://github.com/boccchi2993/locus-harness/actions/runs/41185934066)（合并提交 `bdb10db`）的 job `out-of-checkout tarball consumer (headless Chrome)` 再次以同签名失败：`CONSUMER-E2E ERROR: Error: CDP browser endpoint unavailable: readiness timeout`、`phase=cdp elapsedMs=15001`、Chrome `alive=yes exitCode=null signal=none`、`0 passed, 1 failed`。所有者决定不重跑、移植修复。本次把 product a70c301 的三项修复移植进 runtime 的 `tests/helpers/chrome.cjs`：Chrome `--remote-debugging-port=0` + 从 profile 目录 DevToolsActivePort 文件读取实际端口（消除 allocateFreePort 的释放/重绑竞态）、CDP 就绪等待默认 60 秒（`DEFAULT_CDP_TIMEOUT_MS`，显式传 15000 的 waitForCdp 调用点改用默认值）、服务端口 EADDRINUSE 换端口重试（`startServiceWithRetry`/`listenWithRetry`，最多 3 次，在任何检查执行之前）——覆盖 `tests/e2e.cjs` 的 vite preview、全部自带服务端口的套件（grep / network / python-*）与 out-of-repo consumer（`tools/consumer-e2e/consumer-gate.cjs`、`selfcheck-faults.cjs`）；并补 `tests/chrome-helper.test.cjs`（DevToolsActivePort 正常/迟到/内容异常解析、EADDRINUSE 第二次成功/三次耗尽的完整报错），注册进 `tests/run-unit.cjs`。按本条验收标准（"Do not close this item solely by retrying, increasing timeouts or observing a green run"），仅加超时不能关单：本次是移植 port 0 / DevToolsActivePort 消除端口竞态并加超时兜底，待合并后观察一段时间再由所有者决定是否关单。

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

- 进展 2026-10-30：RT-D3（Proxy 与普通函数对比实验）结果尚未收到，状态待确认；上面的临时例外继续有效。

## pyfetch denial layer changes when plugins are installed (observation, 2026-10-23)
- [ ] Open. 本机实验（装有 lxml / Pillow 等 plugin 的 worker）中，`pyodide.http.pyfetch` 被拒绝时的文本为 `Locus Python bootstrap: no in-memory asset for <url>`，而不是 F04a 拦截层的 `Python network access is disabled in Locus`；探针 0 请求，安全性质成立。推测：plugin 安装会先加载 micropip，micropip 导入 `pyodide.http`，后者在导入时捕获了当时的 `self.fetch`（即启动期资产解析函数），之后的 F04a 替换对它无效。待确认；修复方向是让启动期解析函数在 READY 前被拦截层取代，或在 lockdown 时同时处理 pyodide.http 内部引用。

## 2026-10-30 新增条目

### RT-SYNC-INC（runtime）：Python 数据挂载点增量同步

- [ ] Open. Owner: Runtime（Pyodide 桥接层）。
- 现状：每次 python 调用对每个数据挂载点全量读取、base64、postMessage；worker 端整树删除重写；任务跑完后对每个文件读出比对。
- 设计方向：worker 保留镜像；主线程按 stat（大小 + 修改时间）发差异；worker 用写入钩子或修改时间法只上报改动；主线程快照改为哈希。
- 风险：漏同步。
- 下一步：等 SPIKE-SYNC 实验结果（进行中），再按上述设计方向实现。
- 验收：必须包含「全量同步 vs 增量同步」随机操作序列的等价性测试，以及性能对比（单次 `print(1)` 的耗时与内存峰值）。
- 备注：完成后可放宽 SYNC_MAX_FILES / SYNC_MAX_TOTAL_BYTES。

### RT-SYNC-LIMIT（runtime）：单文件同步上限 5 MiB → 16 MiB

- [ ] Open. Owner: Runtime。
- 现状：进行中（PR feat/python-mirror-16mib）。
- 下一步：完成并合并 feat/python-mirror-16mib。
- 验收：待确认。
