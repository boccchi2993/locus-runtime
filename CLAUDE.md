> AGENTS.md 与 CLAUDE.md 是同一份规则的两个副本，内容必须完全一致。
> 修改其中任何一份时，必须在同一个提交里对另一份做相同的修改。CI 会比对两份文件，不一致即失败。

## 仓库职责

本仓库是 Locus 三仓结构中的 runtime：浏览器本地的 Unix-like 执行基底（Linux-like VFS、shell、Python/worker、有界网络），不依赖 harness 或 product 独立构建与测试。
另两个仓库：[locus-product](https://github.com/boccchi2993/locus-product)、[locus-harness](https://github.com/boccchi2993/locus-harness)。
官方参考能力包在 [locus-example-capabilities](https://github.com/boccchi2993/locus-example-capabilities)（见 locus-product docs/DECISIONS.md D11）。

## 架构决定

涉及架构的改动之前，必须先阅读 [locus-product/docs/DECISIONS.md](https://github.com/boccchi2993/locus-product/blob/main/docs/DECISIONS.md)。
与其中某条决定冲突的改动，必须先由所有者批准，不能自行决定。

## 工作规则

- 在分支上工作，通过 PR 提交；不直接推送 main，不自行合并。
- PR 合并前 CI 必须全部通过。
- 不放宽断言、不跳过测试、不靠重跑让红灯变绿。
- 保留第一次失败的记录，证据必须与实际一致。
- 开放的维护项见本仓库的 [TODO.md](TODO.md)。

## 常用命令

以 [package.json](package.json) 的 scripts 为准：

- `npm ci` — 按 lockfile 干净安装依赖
- `npm run build` — 构建打包产物
- `npm test` — 单元与结构门（Node）
- `npm run test:e2e` — 浏览器端到端门
- `npm run preview` — 在 4173 端口预览打包产物
