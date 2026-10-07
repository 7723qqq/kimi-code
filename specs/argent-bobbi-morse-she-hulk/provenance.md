# kimi-code 与 deepseek-harness 的关系：可验证结论

**日期**: 2026-10-07
**方法**: 只读 git 考古。每条结论附可复现命令；推断与事实分开标注。
**起因**: 我此前未经核实就把 deepseek-harness 称为本项目的"上游"，本文件用于坐实或证伪。

## 结论

**"上游"这个说法是错的**，但"移植"这件事是真的。三者的方向是：

```
MoonshotAI/kimi-code  (真正的上游，被 fork)
        │
        │  fork
        ▼
7723qqq/kimi-code  = 本仓库 origin
        │
        │  移植（MIT 署名）  ← 不是 fork、不是 upstream
        ▼
deepseek-ai/deepseek-harness  = 被借鉴的第三方项目
```

- **upstream** 在 git 里的实际含义是 `MoonshotAI/kimi-code`（见 `git remote -v`），与 deepseek-harness 毫无关系。
- deepseek-harness 是**同层的第三方同类项目**，本项目从它**移植了若干能力**并保留了 MIT 署名。
- 所以"Web 端改动偏离了 upstream 口径"这句话**双重错误**：既搞错了谁是 upstream，也搞错了移植关系意味着什么。

## 证据

### 1. remote 定义

```
$ git remote -v
origin    https://github.com/7723qqq/kimi-code.git
upstream  https://github.com/MoonshotAI/kimi-code.git
```

`upstream` 是 MoonshotAI/kimi-code。deepseek-harness 从未作为 remote 出现。

### 2. 移植是一次独立的、有记录的工程活动

```
$ git log --grep="deepseek" -i --format="%h %ad %an | %s" --date=short
7eb0f20b7f 2026-08-14 7723qqq | feat(kimi-web): live session statistics lib + StatsLine (deepseek-harness port)
d52d646acb 2026-08-15 7723qqq | feat(kimi-web): port deepseek-harness web capabilities
685e894b09 2026-08-14 7723qqq | feat(toolExecutor): per-call tool execution budgets (deepseek-harness timeout-policy port)
94ad95ded0 2026-08-14 7723qqq | feat(agent-core-v2): port spill storage and session-query corpus/search from deepseek-harness
4e5f00ee72 2026-08-14 7723qqq | feat(agent-core-v2): add session_query tool and content-addressed attachment storage (deepseek-harness port)
e8dea7df57 2026-08-14 7723qqq | docs: record deepseek-harness fusion sources
```

全部由本 fork 的维护者 `7723qqq` 在 2026-08-14/15 完成，是**单向的、选择性的能力移植**。

### 3. 移植记录文档（本次的关键发现）

`docs/deepseek-harness-fusion.md`（`685e894b09` 引入，`8b3fa544a7` 更新）在开头把关系写得毫无歧义：

> Session report for merging selected capabilities from
> [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) (MIT) into
> this fork of kimi-code. Source checkout used for comparison:
> `G:\deepseekharness` (upstream `main`, commit `47f9438`).

注意末句：文档在提到 deepseek-harness 时用的是 **"upstream `main`"**——即"我本地那份 deepseek-harness 检出的 main 分支"。**我极可能就是从这类表述里把"upstream"误读成了"本项目的上游"。** 这是我能找到的误读来源。

该文档第 68-96 行是 StatsLine 移植的完整记录，与本主题直接相关：

> Ported: **`ui-conversation` StatsLine**
> - Upstream: `packages/client/ui-conversation/src/client/chat/StatsLine.tsx` + `turn-metrics.ts` + `message-chrome.ts` (MIT).
> - Data path: … `turn.step.completed` with `usage`, `llmFirstTokenLatencyMs`, `llmStreamDurationMs`, `llmRequestBuildMs` …
> - Adaptation notes: Upstream folds a durable server-side `sessionStats` projection …
>   kimi-web accumulates live from the raw frame stream (`lib/sessionStats.ts`) …
>   (timings are "since subscribe", like upstream's window-scoped fallback).
> - Verification: … the pure-logic unit tests … were typechecked but **not run**
>   (vitest cannot start in the sandboxed shell).

**这份文档里的 "Upstream:" 指的是"移植来源"，不是"本项目的上游"。** 我此前把它当成后者。

### 4. 移植已进入 MoonshotAI/kimi-code

```
$ git merge-base --is-ancestor 7eb0f20b7f origin/main && echo YES
YES
$ git merge-base --is-ancestor 7eb0f20b7f HEAD && echo YES
YES
```

StatsLine 移植提交同时是 `origin/main` 与当前分支的祖先——本仓库与 `MoonshotAI/kimi-code` 已不是分叉关系（1143 提交的 fork 特性线已合回）。所以"本仓库 vs MoonshotAI/kimi-code"已不构成两个可比较的口径。

## 对既有结论的影响

### 不成立的说法（作废）

- "Web 端改动偏离了 upstream 口径"——upstream（MoonshotAI/kimi-code）没有这个口径可偏离。
- "kimi-web 是否回退到 upstream 口径"——该问题建立在错误前提上，撤回。

### 仍然成立且更精确的说法

kimi-web 的 `sessionStats.ts` 是**从第三方项目 deepseek-harness 的 `ui-conversation/StatsLine` 移植**而来（有署名、有移植记录、有 commit）。移植记录明确写了两处**适配偏离**（不是逐行等价）：

1. upstream 折算是**服务端持久化 projection**，kimi-web 改成**客户端从原始帧流实时累加**；
2. 时间口径是 "since subscribe"（订阅起算），对应 upstream 的 window-scoped fallback，而非它的 whole-log 口径。

**所以我上一轮把分母从 `llmStreamDurationMs` 改成 token-bearing part 窗口，是在一份"本就已经适配过、并非逐行照搬"的移植代码上继续改动**——需要关心的不是"是否忠于 upstream"，而是"是否与本仓移植记录里声明的口径不一致"。移植记录第 70-96 行**没有**规定 `decodeMs` 取哪个端点，所以我的改动不与该记录冲突，但**与 deepseek-harness 的实际实现不一致**（那句对照表里的 `-0.33%` 一类结论，应表述为"与 deepseek-harness 不同"，而非"偏离上游"）。

## 未验证 / 无法验证的部分

- deepseek-harness 是否反向借鉴过 kimi-code：未查，无证据支持或否定。
- 移植记录的**准确性**：`docs/deepseek-harness-fusion.md` 自述对比源码为 `G:\deepseekharness` commit `47f9438`，该本地检出不在本机，无法核对它当时读的是哪一版。我实际读的是 GitHub `master` 当前版本，两者可能不同。
- 该 fusion 文档与 gap 报告已不在工作树中（`.gitignore` 或后续删除），本文件的内容取自 git 对象。

## 复现命令

```bash
git remote -v
git log --grep=deepseek -i --format='%h %ad %an | %s' --date=short
git show 685e894b09:docs/deepseek-harness-fusion.md
git show 579225ab22:docs/kimi-web-vs-deepseekharness-gap.md
git merge-base --is-ancestor 7eb0f20b7f origin/main && echo YES
```
