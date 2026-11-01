# Design — 上游对齐推进工程

## 总览

```
upstream/main (56 commits)
        │
        │ scripts/upstream-ledger.mjs --refresh
        ▼
.upstream/ledger.tsv  ◄── 唯一进度源
        │
        │ --verify（跑 test: / grep: / absent: 探针）
        ▼
   verdict 变化 ──► --report（按批次聚合）
        │
        ▼
   批次执行（B0…B12）──► Gate 全绿 ──► add 本批文件 ──► commit ──► push
```

三个组件：

1. **台账**（`.upstream/ledger.tsv`）——数据，受版本控制，人可读可 diff。
2. **工具**（`scripts/upstream-ledger.mjs`）——唯一写台账的程序，负责抓取、验证、聚合。
3. **playbook**（`.upstream/PLAYBOOK.md`）——Bun 翻译规则，每条带上游形态/本地形态/验证方式。

## 组件一：台账格式

`.upstream/ledger.tsv`，TAB 分隔，首行表头：

| 列 | 含义 | 约束 |
| --- | --- | --- |
| `pr` | 上游 PR 号 | 数字或 `-` |
| `sha` | 上游提交完整 SHA | 40 位 |
| `title` | 上游标题（去 PR 后缀，≤80 字） | 文本 |
| `cluster` | 所属批次 | `B0`…`B12` |
| `verdict` | 判定 | 枚举，见下 |
| `probe` | 可执行探针 | `test:` / `grep:` / `absent:` / `manual:` |
| `evidence` | 证据 | `path:line` / commit sha / 测试输出摘要 |
| `batch_done` | 该批次是否已验收 | `yes` / `no` |
| `approved_by` | `not-applicable`/`blocked` 的签字人 | 文本或空 |
| `updated` | 最后更新日期 | ISO 日期 |

`verdict` 枚举与语义：

- `pending` — 未开始验证
- `in_progress` — 正在做
- `ported` — 上游行为已在本 fork 落地，探针通过
- `equivalent` — 行为等价但实现形态不同（如 #4428 的事件模型），探针通过且 evidence 说明差异
- `partial` — 部分落地，evidence 必须写出缺哪一部分
- `blocked` — 做不了，evidence 必须写卡点与缺什么，`approved_by` 非空
- `not-applicable` — 不适用，`approved_by` 非空

## 组件二：`scripts/upstream-ledger.mjs`

沿用 `scripts/*.mjs` 惯例（`check-*.mjs` 是只读校验，这个带写入，命名用无前缀动词）。

子命令：

| 命令 | 行为 | 写盘 |
| --- | --- | --- |
| `--refresh` | `git fetch upstream`，取 `upstream/main ^main`，新增条目以 `pending` 入账，已存在的保留原 verdict | 是 |
| `--verify [--batch Bx]` | 对选中行执行探针；`test:` 跑 `bun test --isolate <path>` 并匹配用例名，`grep:`/`absent:` 用 ripgrep；通过则推进 verdict 并填 evidence | 是 |
| `--report` | 输出按 cluster × verdict 的聚合表、总数、剩余量 | 否 |
| `--set <sha> <verdict> --evidence <text> [--approved-by <who>]` | 唯一的手工通道；`not-applicable`/`blocked`/`partial` 必须带 evidence | 是 |

实现约束：

- 只用 Bun 内置（`Bun.spawnSync`、`node:fs`），不引新依赖。
- TAB 分隔，写入前校验列数，避免破坏台账。
- `--verify` 串行执行探针；遵守 `AGENTS.md`「never run two test suites at once」。
- 退出码：任一探针失败 → 非 0。

## 组件三：Bun 翻译 playbook

`.upstream/PLAYBOOK.md` 每条一张三列表。核心规则：

| 上游 | 本地 | 验证 |
| --- | --- | --- |
| `pnpm-workspace.yaml` 成员 | 根 `package.json` `workspaces.packages` | `bun install --frozen-lockfile` |
| 同上，且影响 Nix | `flake.nix` workspace 列表同步 | `bun run check:nix-workspace` |
| `pnpm-lock.yaml` | `bun.lock`（`bun install` 生成） | 差异仅限目标依赖 |
| `pnpm --filter <glob> <script>` | `bun run --filter '<glob>' <script>` | 根 `package.json` scripts 同步 |
| `pnpm <bin>` | `bunx <bin>` | — |
| `.npmrc` registry/hoist | `bunfig.toml` `[install]` | `bun install` 成功 |
| `.nvmrc` / `engines.node` | `packageManager: "bun@<ver>"` | `bun --version` |
| Node SEA | `bun build --compile` | `bun run build` |
| vitest `vi.fn()` | `bun:test` `mock()` | 测试通过 |
| vitest `test.each` | `for (const c of cases) test(...)` | 测试通过 |
| `setup-node` + `pnpm/action-setup` | `oven-sh/setup-bun` | CI 不装 Node |
| `process.env.NODE_ENV` 分支 | 保留；Bun 兼容 | — |
| `node:` 内置模块 | 保留；Bun 全兼容 | — |

**禁止**：搬 `pnpm-*`、`.npmrc`、`.nvmrc` 文件本体；在本地引入 Node 作为运行时依赖（Nix 路径除外）。

## 批次划分（56 条全覆盖）

按语义簇切，每批一个可独立验证/提交/回滚的单元。

| 批次 | 主题 | 条目 | 条数 |
| --- | --- | --- | --- |
| **B0** | 门槛修复（本地，非上游） | 根 `typecheck` 被未跟踪文件阻断 | — |
| **B1** | 安全与凭据 | #4431 #4434 #4435 #4283 #4523 #3733 #4532 | 7 |
| **B2** | 请求、压缩、缓存、工具披露 | #4365 #4410 #4421 #4413 #4450 #4451 #4456 #4485 #4486 #4524 #4526 #4538 #4558 | 13 |
| **B3** | 子代理与协作 | #4430 #4418 #4460 #4465 | 4 |
| **B4** | workspace、文件系统、git status | #4336 #4422 #4457 #4511 #4513 #4515 #4516 #4517 #4520 #4527 | 10 |
| **B5** | kap-server 传输与会话 | #4428 #4470 #4540 #4541 | 4 |
| **B6** | TUI | #4310 #4346 #4347 #4507 | 4 |
| **B7** | 会话导入 | #4342 | 1 |
| **B8** | llm core 重构 | #4352 | 1 |
| **B9** | 远程执行环境 | #4062 | 1 |
| **B10** | 发版流水线与 CI | #4425 #4469 #4490 #4504 #4512 | 5 |
| **B11** | 生成物与文档同步 | #4387 #4445 #4453 #4488 #4496 #4497 #4530 #4542 #4556 #4557 | 10 |
| **B12** | 移除 kimi-inspect | #4514 | 1 |

合计 61。

批次规模上限：单批不超过 13 条。原始划分里 B2 与 B4 已到 13 / 10 条，执行时按子主题再切子批（见下方 B13+ 规则）。

批次顺序理由：B0 是门槛（`build:packages` 不通则后续无法验）。B1–B3 是"低风险高频"正确性修复，先清理能立刻降低后续批次的噪音。B4 是 workspace 基座，B5 依赖它。B6 独立。B7–B9 是三条大线，各自独占批次，避免与其它改动混在一个提交里。B10 依赖 B11（canary 需要 changelog 已同步）。B12 是破坏性移除，放最后单独提交。

**注意 #4558**：上游刚调整了压缩预算标定（`test: adjust compaction budgets for slimmer prompts`），与本 fork 之前判定为"标定失效"的那条 `FullCompaction pre-shrink` 红测试直接相关。B2 执行时必须先读这条上游改动，再决定本地测试的标定值——不要沿用上一轮的 42k 结论而不复核。

**B13+ 顺延规则**：执行中若某批超过 15 条或跨超过 3 个包，必须在批次内再切子批，子批同样独立提交，不许一个提交塞进多个主题。

## 批次内执行流程

每条统一走五步，顺序不可交换：

1. **读上游 diff**：`git show <sha> -- <paths>`，确认改了什么、为什么改。
2. **读本地现状**：确认有无等价实现、有无冲突的本地改造。
3. **判形态**：能原样搬 / 需 Bun 翻译 / 本地已等价 / 不适用（不适用须签字）。
4. **落地 + 探针**：改代码，同时写/改覆盖该行为的测试。
5. **登记**：`--set` 填 verdict 与 evidence。

## Gate — 每批门槛

按改动内容触发，全部为必过项：

| 触发条件 | 命令 |
| --- | --- |
| 任何代码改动 | `bun test --isolate <改动文件对应测试>` |
| 任何代码改动 | `packages/agent-core-v2`：`bunx tsc --noEmit` |
| 同上，涉及 CLI | `apps/kimi-code`：`bunx tsc --noEmit` |
| 同上，涉及服务端 | `packages/kap-server`、`packages/node-sdk`：`bunx tsc --noEmit` |
| 任何 `agent-core-v2` 改动 | `cd packages/agent-core-v2 && bun run build` |
| 任何代码改动 | `bun run check:no-comments`（独立 gate，`lint` 绿不代表它绿） |
| 改 `package.json` / 新增包 | `bun run check:nix-workspace` + `bun install` |
| 改用户可见文案 | `check:locale-keys`、`check:locale-placeholders`、`check:no-hardcoded-prose` |
| 改 `src/**/*.md` 提示词 | 视为行为变更，需在 changeset 说明 |

红即不算完成。无法修的条目转 `blocked` 并在 evidence 写明卡点，不许标注为"既有遗留"放行。

## 提交与推送

1. `git status` 确认改动面只含本批文件。
2. 显式 `git add <本批路径>`，**禁止 `git add -A`**。
3. commit message 按 `type(scope): 祈使句`，不带 co-author，不提 agent。
4. **立即 `git push origin main`**（`AGENTS.md` Working Principles）。
5. 更新台账 `batch_done=yes` 后随该批提交。

## changeset 规则

- 改默认值 / 新增配置 / 移除功能：必须写清**用户失去什么**和**逃生口**。
- 纯内部修复：一句话。
- B11（生成物与 CHANGELOG 同步）不产生 changeset。
- B12（移除 kimi-inspect）必须是 `major` 语气，写清替代路径。

## 持续机制

- 上游每次发版后跑 `--refresh`，新增条目自动入 `pending`。
- `--report` 中 `pending + in_progress + partial` 大于 0 时不开新功能线。
- 每批完成后把该批的形态判定补进 `PLAYBOOK.md`，下一批不再重新决策。

## 明确不做

- **不做 `git merge upstream/main`**（638 个源码冲突，且工具链分叉不可逆）。- **不用 commit 数 / diff 行数报告进度**。
- **不重构本地独有功能**（路线 C：把本地功能外移成独立包以消除漂移，等 56 条清零后单独决策）。
