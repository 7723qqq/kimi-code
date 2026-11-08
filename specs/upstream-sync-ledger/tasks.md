# Tasks — 上游对齐推进工程

前置：`requirements.md`（口径）与 `design.md`（方案）。本文件只列可执行步骤与完成判据。

条目总数与批次分配以 `.upstream/ledger.tsv` 为准，本文档不复制清单。

## 阶段 A — 建基座

### A1 台账播种 — 已完成

- [x] `.upstream/ledger.tsv` 由 `bun scripts/upstream-ledger.mjs --refresh` 生成。
- [x] 61 行，11 列，`cluster` 按 `design.md` 批次表填，`verdict` 全部 `pending`。
- **实测**：`refresh: 61 open upstream commits, 61 new rows`；`unassigned` 为 0；`--report` 输出 12 个批次行，`STATUS: open`。

### A2 台账工具 — 已完成

- [x] `scripts/upstream-ledger.mjs` 实现 `--refresh` / `--verify` / `--report` / `--set` / `--probe` / `--cluster` / `--batch-done`。
- [x] 只用 Bun 内置（`Bun.spawnSync`、`node:fs`）；探针串行；任一探针失败退出码非 0。
- **实测**：`--report` 聚合正确；`--refresh` 在真实上游前进时自动补入 5 条新提交。

### A3 Bun playbook — 已完成

- [x] `.upstream/PLAYBOOK.md` 覆盖工具链、测试、运行时、构建四类形态映射，以及"已知差异"表。
- [x] 记录 `upstream-drift` 检查与台账的分工：前者管整文件删除，后者管文件内内容缺口。

### A4 文档挂接 — 已完成

- [x] `DEVELOP.md` 新增 "Upstream Gap Tracking" 一节，指向 `specs/upstream-sync-ledger/` 与 `.upstream/PLAYBOOK.md`。
- [x] 未改动 `AGENTS.md`（它每轮注入，保持短）。

## 阶段 B — 门槛修复

### B0 修复根级 `typecheck`

- [x] 定位：失败点不在 node-sdk，而在 `packages/klient` 的 `typecheck:examples`（`tsconfig.examples.json`）。
- [x] 根因不是未跟踪文件（`packages/runtime-shared/src/cache-breakpoints.ts` 现已跟踪）：该 tsconfig 把 `../agent-core-v2/src` 拉进程序，却不映射 `#/`，于是 human kernel 里的 `#/agent/contextMemory/*` 按 `src/human/package.json` 的 imports 规则解析成 human 内部的同名文件，而它不存在。
- [x] 修法：给该程序加上与 `agent-core-v2/tsconfig.json` 相同的 `#/*` 映射（`../agent-core-v2/src/*.ts`、`../agent-core-v2/src/human/*.ts`）。
- **判据**：`bun run typecheck` 退出码 0 —— 2026-11-08 复跑 exit 0。

## 阶段 C — 按批次推进（61 条）

每批统一流程与门槛见 `design.md`「批次内执行流程」「Gate」。下表只记批次与退出条件。

| 批次 | 条数 | 退出条件 |
| --- | --- | --- |
| B1 安全与凭据 | 7 | 全部定档；OAuth 与 CSP 测试绿；`check:no-comments` 绿 |
| B2 请求/压缩/缓存/工具披露 | 13 | 全部定档；`agent-core-v2` 测试与 build 绿；`state-manifest.d.ts` 若变动已重生成；**#4558 的预算标定必须复核，不沿用旧结论** |
| B3 子代理与协作 | 4 | 全部定档；子代理测试绿 |
| B4 workspace/文件系统/git status | 10 | 全部定档；`check:nix-workspace` 绿；config-manifest 已重生成 |
| B5 kap-server 传输与会话 | 4 | 全部定档；kap-server 测试绿；wire-manifest 若变动已重生成 |
| B6 TUI | 4 | 全部定档；TUI 测试绿；i18n 三项检查绿 |
| B7 会话导入 | 1 | 定档；导入测试绿 |
| B8 llm core 重构 | 1 | 定档；`agent-core-v2` 全量测试绿；深导入与边界检查绿 |
| B9 远程执行环境 | 1 | 定档；新增包已登记 workspace 与 `flake.nix`；exec 测试绿 |
| B10 发版流水线与 CI | 5 | 定档；CI 不引入 Node；`check:nix-workspace` 绿 |
| B11 生成物与文档同步 | 10 | 定档；不产生 changeset |
| B12 移除 kimi-inspect | 1 | 目录删除；workspace 与 `flake.nix` 同步；根 `build`/`typecheck` 不再引用；changeset 写清替代路径 |

## 阶段 D — 收口

### D1 全量台账复核

- [x] `--verify` 全跑，剩余量为 0（`--report` 输出 `STATUS: clear`、`remaining=0`，2026-11-08 复跑）。
- **判据**：`--report` 输出 `STATUS: clear`。

### D2 门槛总跑

- [x] 五包 `tsc`（根 `bun run typecheck`）、`agent-core-v2` build、`check:no-comments`、`check:nix-workspace`、i18n 三项 —— 2026-11-08 复跑全部 exit 0。
- **判据**：全部退出码 0。

### D3 漂移策略决策

- [ ] 清零后就「路线 C：本地独有功能外移以消除长期漂移」单独出结论，交维护者决定。
- **判据**：有书面结论，不做则写明理由。

## 每批的执行顺序（不可交换）

1. `git show <sha>` 读上游改动
2. 在 `.upstream/PLAYBOOK.md` 找到对应形态
3. 读本地现状判断有无等价实现
4. 改代码 + 补测试
5. 跑 Gate
6. `--probe` 记探针，`--verify` 推进判定
7. `git add <本批路径>` → commit → `git push origin main`
8. `--batch-done <批次>` 并随提交

## 风险

| 风险 | 应对 |
| --- | --- |
| B8 #4352 与 B9 #4062 体量过大（102+278 / 95+337 文件） | 按 `design.md` B13+ 规则再切子批，每子批独立提交 |
| B2 有 13 条，跨压缩与工具披露两个主题 | 切子批：压缩/缓存一组，工具披露与请求形态一组 |
| Bun 翻译漏项导致"看起来搬了但跑不起来" | 每条必过 Gate，`bun install` + `check:nix-workspace` 必跑 |
| 上游每天前进，基线漂移 | 每批开始前跑 `--refresh`；数字只从 `--report` 取 |
| 台账被手工改坏 | 写入统一走脚本，写入前校验列数 |
| 与用户未提交改动冲突 | 提交只用显式路径，禁止 `git add -A` |
