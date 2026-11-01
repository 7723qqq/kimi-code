# Requirements — 上游对齐推进工程

本 spec 定义 kimi-code fork 与上游 `MoonshotAI/kimi-code` 之间缺口推进的**唯一口径、唯一进度来源和唯一验收门槛**。

它存在的理由是：此前所有"落后多少"的说法都不成立。`git merge-base` 给出的共同祖先、diff 行数、"一天 5000 行"的估算，都是把两套不同基准的东西当同一把尺子。这份文档用实测数据重建尺子。

## 目标

在任意时刻，能用一条命令回答三个问题，且答案有可执行证据：

1. 上游还有哪些功能/修复没有在本 fork 落地？
2. 每一条的判定依据是什么（文件行号、测试名、或明确的"不适用 + 理由"）？
3. 下一批该做什么，做完的门槛是什么？

不允许再用 commit 数量、diff 行数、`merge-base` 距离作为进度指标。

## 受众

维护本 fork 的开发者。读这份文档是为了知道：为什么要这么推进、每一批的边界在哪、什么样的状态才算"这条做完了"。

## 背景事实（2026-10-30 实测，随 `--refresh` 滚动更新）

| # | 事实 | 证据 |
| --- | --- | --- |
| F1 | 本地与上游**同一根提交** `842e699a64`（2026-05-22 "Kimi For Coding"） | `git log --max-parents=0 --format='%H' main upstream/main` 输出相同 |
| F2 | 上游 `upstream/main` 在 2026-10-30 当天前进过两次：`4b58a0cda2`（#4540）→ `a2afdbc7d1`（#4558，2.4.1 已发） | `git log -1 upstream/main` |
| F3 | main 已包含上游提交的绝大部分（1697 / 1753，按第一次采样） | `git rev-list --count main` 与 `upstream/main ^main` |
| F4 | 上游未进入 main 的提交：**61** 条（第一次采样 56 条，当天新增 5 条） | `git rev-list --count --no-merges upstream/main ^main` |
| F5 | main 独有提交 = **2276** 条 | `git rev-list --count main ^upstream/main` |
| F6 | 真做 `git merge upstream/main` 产生 **827** 个冲突，排除 `dist-web`/`dist` 生成物后 **638** 个 | `git merge-tree --write-tree --name-only --no-messages main upstream/main` |
| F7 | 冲突集中在 `agent-core-v2` 293、`apps/kimi-code` 120、`kap-server` 54、`apps/kimi-inspect` 44、`pi-tui` 40 | 同上，按目录聚合 |
| F8 | 工具链已不可逆地分叉：本地 `packageManager: bun@1.4.4` + `bun.lock` + `bunfig.toml` + 根 `package.json` `workspaces`；上游是 `pnpm-workspace.yaml` + `pnpm-lock.yaml` + `.npmrc` | 根 `package.json`；本地无 `pnpm-*`、`.npmrc`、`.nvmrc` |
| F9 | 本地多 `apps/kimi-inspect`、`.github/workflows/codeql.yml`、`release-native.yml`；少 `canary-release.yml` | `ls apps`、`ls .github/workflows` 与 `git ls-tree upstream/main` 对比 |
| F10 | 上游 61 条中约 25 条是零新增文件的纯改动，8 条含删除 | `.upstream/ledger.tsv` 的 `files` 列 |

**F4 会变。** 上游每个工作日都在前进（F2 就是当天两次前进的证据）。任何写死数字的文档都会在几天内变错，所以真正的口径是 `.upstream/ledger.tsv` + `--report`，不是本文档里的数字。

**结论**：这是同源、内容被手工搬运、git 历史未接的两条线。`merge` 在工程上不可行（F6/F8），PR 号与 diff 行数都不能当口径（F3/F5）。唯一可行口径是逐条验证内容是否落地。

## 范围

### 纳入

上游未合入提交全部入账，一条不落。条目清单以 `.upstream/ledger.tsv` 为准，本文档不复制清单——复制就会过期。当前分类：

- 功能类：#4342、#4336、#4352、#4347、#4310、#4418、#4425、#4062、#4465、#4457、#4527、#4538
- 修复类：其余全部
- 发版/CI 类：#4425、#4490、#4504、#4512
- 生成物与文档同步：#4496、#4497、#4453、#4387、#4488、#4542、#4445、#4530、#4556、#4557
- 移除类：#4514（移除 `apps/kimi-inspect`，已确认跟上游删除）

### 翻译要求（不是排除）

上游的 pnpm / Node 能力**必须翻译成 Bun 原生等价物**，不允许以"架构不同"为由跳过任何功能：

| 上游形态 | 本地等价物 |
| --- | --- |
| `pnpm-workspace.yaml` 成员变更 | 根 `package.json` `workspaces.packages`，并由 `check:nix-workspace` 守护 `flake.nix` |
| `pnpm-lock.yaml` 依赖变更 | 根 `package.json` `catalog` + `bun install` 生成 `bun.lock` |
| `pnpm -r <script>` / `pnpm --filter` | `bun run --filter '<glob>' <script>` |
| `pnpm <bin>` 一次性执行 | `bunx <bin>` |
| `.npmrc` 配置（registry / hoist / node-linker） | `bunfig.toml` 的 `[install]` 段；无对应项时在 playbook 记录差异 |
| `.nvmrc` / `engines.node` | `packageManager: "bun@<ver>"` + `bun --version` 校验 |
| Node SEA 打包链 | `bun build --compile`（`apps/kimi-code/scripts/native/build-bun.mjs`） |
| vitest / jest 语法 | `bun:test`（`describe`/`test`/`expect`/`mock` 用法映射见 playbook） |
| GitHub Actions 中的 `setup-node` / `pnpm/action-setup` | `oven-sh/setup-bun` |

只翻译"检查什么、产出什么"，不搬 workflow 文件本体——本地 CI 结构（`codeql.yml`、`release-native.yml`）是 fork 自己的。

### 明确排除（每条在台账留 `not-applicable` + 理由 + 签字人）

- `AGENTS.md`（`.gitattributes` 里 `merge=ours`，本 fork 版本保持）
- `flake.nix` 的 Node 构建路径本体（仅同步 workspace 成员，由 `check:nix-workspace` 校验）

除此之外没有预设排除项。任何被视为"不适用"的条目，都必须由维护者签字。

## 需求

### R1 — 台账是唯一进度源

`.upstream/ledger.tsv` 是仓库内受版本控制的台账，每行一条上游提交：

```
pr  upstream_sha  title  cluster  verdict  probe  evidence  batch  approved_by  updated
```

`verdict` 取值：`pending` / `in_progress` / `ported` / `equivalent` / `partial` / `blocked` / `not-applicable`。

任何"还剩多少"的回答只能从台账聚合得出。

### R2 — 每条判定必须有可执行探针

`probe` 字段必须是下列之一，不能是自由文本：

- `test:<path>#<test name>` — 跑该测试，通过即 `ported`
- `grep:<pattern>@<path>` — 该模式存在即 `ported`
- `absent:<pattern>@<path>` — 该模式不存在即 `ported`（用于移除类）
- `manual:<理由>` — 仅允许 `not-applicable` / `blocked` 使用，且 `approved_by` 非空
- `-` — 恰好且仅在 `verdict` 为 `pending` / `in_progress` 时合法：条目尚未分类，还没有探针可写。

`--verify` 只对前三种探针生效。一行不可能在 `-` 的状态下被推进到 `ported`。

### R3 — 已验证才能改判定

`verdict` 从 `pending` 变为 `ported`/`equivalent` 的唯一途径是 `--verify` 成功执行对应探针。手工改台账必须同时补 `evidence`（commit sha 或 `path:line`）。

### R4 — 批次边界由语义簇决定

批次按一组共享上下文决定，不按上游提交时间。每个批次是一个可独立验证、可独立提交、可独立回滚的单元。

### R5 — 每批门槛固定

见 `design.md` 的 Gate 一节。门槛不通过不算完成，不允许以"既有遗留"为由放行。

### R6 — Bun 翻译必须记录

任何一处因工具链差异而采用了与上游不同的实现，必须在 `design.md` 的 playbook 表里留一行，说明上游形态、本地形态、差异原因。

### R7 — 不擅自划范围

用户明确要求：不要自己在推进中收缩范围或跳过批次。批次可以被 `blocked`，但不能被静默省略。

### R8 — git 动作边界

每批验证全绿后：只 `git add` 本批自己改动的文件（不用 `git add -A`，不带用户未完成的改动），commit 后立即 `git push origin main`。这是 `AGENTS.md` Working Principles 的要求。

## 验收

推进工程本身完成的条件：

1. `.upstream/ledger.tsv` 存在，`--refresh` 抓到的每条上游提交都有一行，每行有合法 `probe`（`-` 仅限未分类行）。
2. `bun scripts/upstream-ledger.mjs --report` 能输出按批次、按 verdict 的聚合。
3. `--verify` 能实际执行探针并更新台账。
4. `specs/upstream-sync-ledger/` 三件套齐全并被 `DEVELOP.md` 引用（防止下一代会话又从头猜）。
