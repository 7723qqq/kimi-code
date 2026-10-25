# hello-world 开发流程模式

hello-world 模式是一次带阶段门禁的开发 run（开发流程工作流）。开启模式即开启一次 run：run 沿 7 个阶段推进——`requirements` → `design` → `implement` → `test` → `review` → `docs` → `deliver`——每个阶段有自己的目标、注入给模型的剧本和退出证据。

与 swarm、Tower 这类并行执行模式不同，hello-world 关注的是**单次开发任务的完整生命周期**：从需求确认一路走到交付收尾。run 的产物落在 `specs/<id>/` 目录下的四件套文件中。run 跨轮次存活——某一轮对话结束后模式和阶段状态仍然保留，直到你用 `/hello-world off` 退出。

开启后，footer 会显示 `hello-world:<stage>` 徽章，模型每轮都会收到当前阶段的剧本指引；`/status` 显示当前阶段，`/hello-world status` 可以查看 run 的完整进度。

## 适用场景

是否使用 hello-world，主要看任务是否需要走完整的开发生命周期，而不只是「把代码改完」。

一些合适的场景：

- 任务从需求到交付有明确链条：先定验收标准，再设计、实现、测试、评审、补文档、落 changeset
- 希望每个阶段都有可核对的证据，而不是凭感觉往下走
- 任务会跨多轮对话，需要中途查看进度、手动推进或跳过个别检查项

## 七个阶段

每个阶段有明确的产出要求；满足退出证据后自动进入下一阶段，也可以手动推进。

| 阶段 | 做什么 | 核心产物 |
| --- | --- | --- |
| `requirements` | 明确需求与验收标准 | `specs/<id>/requirements.md` |
| `design` | 做设计并拆解任务 | `specs/<id>/design.md`、`specs/<id>/tasks.md` |
| `implement` | 实现并保持小步提交 | 代码、聚焦的 commit |
| `test` | 运行测试与本地门禁 | 测试执行证据 |
| `review` | 代码评审并处置发现 | 评审发现记录 |
| `docs` | 更新用户文档 | `docs/`、`README*` 更新 |
| `deliver` | 跑交付门禁并落 changeset | changeset、commit、push |

维护（maintain）不是 run 内的阶段，而是收尾闭环：退出 run 时把遗留项按四类维护归档，回流为下一轮 run 的需求种子。

## 子命令

`/hello-world` 的所有形式都只在空闲（idle）状态下可用。

| 命令 | 作用 | 可用性 |
| --- | --- | --- |
| `/hello-world` | 翻转模式（开 ↔ 关） | 仅空闲时 |
| `/hello-world on\|off` | 显式开启或关闭模式，不发送提示词；`off` 时若还有未完成的 checklist 项会先列出警告（仍会执行关闭） | 仅空闲时 |
| `/hello-world <task>` | 开启模式并把 `<task>` 作为普通提示词发送，同时记录为本次 run 的 task；若当前是「始终询问」权限模式，启动前会提示是否切换到「必要时询问」或「完全自动」 | 仅空闲时 |
| `/hello-world status` | 显示 run 面板：阶段、task、checklist 项与证据、豁免记录 | 仅空闲时 |
| `/hello-world next` | 手动推进到下一阶段；已在最后阶段（`deliver`）时无操作 | 仅空闲时 |
| `/hello-world phase <stage>` | 直接切到指定阶段；阶段只进不退 | 仅空闲时 |
| `/hello-world skip <item>` | 豁免一项 checklist 并留痕（该项记为 `waived`） | 仅空闲时 |

## run 产物约定

run 的产物落在 `specs/<id>/` 目录（`<id>` 是本次 run 的标识）下的四件套：

- **`requirements.md`**：需求与验收标准
- **`design.md`**：设计决策与取舍
- **`tasks.md`**：任务拆解与执行步骤
- **`progress.md`**：进展、遗留项与收尾摘要

hello-world 与 [Spec 模式](../reference/tools.md#spec-模式)共用 `specs/` 目录，但每个 `<id>` 是独立目录，互不覆盖。证据识别按 `specs/*/文件名` 通配匹配，不限定具体 `<id>`。

## 证据自动推进

run 会观察工具调用，按下面的证据表自动推进阶段（写入 = `Write`/`Edit` 工具）：

| 信号 | 前置阶段 | 推进到 | 顺带打勾 |
| --- | --- | --- | --- |
| 写入 `specs/*/requirements.md` | `requirements` | `design` | `requirements-approved` |
| 写入 `specs/*/design.md` 或 `specs/*/tasks.md` | `design` | `implement` | `design-written`、`tasks-complete` |
| 写入代码路径（非 `specs/`、非 `docs/`、非 `.changeset/`） | `requirements`、`design` | `implement` | — |
| 成功执行 `bun test` / `bun run lint` / `bun run typecheck` / `check:*` 等门禁命令 | `implement` | `test` | — |
| 同上命令在 `test` 阶段成功执行 | `test` | `review` | `tests-green` |
| 写入 `docs/**` 或 `README*` | `review` | `docs` | `review-done` |
| 写入 `.changeset/*.md` | `docs` | `deliver` | `docs-updated`、`changeset-ready` |

推进规则：阶段只进不退；重复信号幂等（不会重复推进）；手动推进（`next` / `phase`）与自动推进同权重。自动判定是保守的——误判不会阻塞你，也不构成硬门禁，用 `next` / `phase` 兜底即可。

## checklist 与收尾摘要

每次 run 自带 7 项 checklist，对应各阶段的退出证据：

- `requirements-approved` — 需求已确认
- `design-written` — 设计已写入
- `tasks-complete` — 任务拆解完成
- `tests-green` — 测试全绿
- `review-done` — 评审完成
- `docs-updated` — 文档已更新
- `changeset-ready` — changeset 就绪

证据命中会自动打勾；无法自动判定的项用 `/hello-world skip <item>` 豁免，记为 `waived` 并留下豁免记录。`/hello-world status` 随时可以看到每项的状态、证据和豁免情况。

退出 run（`/hello-world off`）时会注入收尾摘要指引：列出未完成项（open items）、把进展写入 `specs/<id>/progress.md`、把遗留项按四类维护归档（纠正性 corrective、适应性 adaptive、完善性 perfective、预防性 preventive），并提炼出下一轮 run 的需求种子。

## 模式互斥

hello-world 与 Spec、Swarm、Tower 互斥：开启 hello-world 会退出这三种模式中当时开启的那个，反过来进入它们也会退出 hello-world。Plan 与 hello-world 可以同时开启。`Shift-Tab` 只在 Plan 与 Spec 之间循环，不涉及 hello-world；hello-world 请使用 `/hello-world` 开关。

模式互斥的完整说明见[斜杠命令](../reference/slash-commands.md#模式与运行控制)。

## 下一步

- [斜杠命令](../reference/slash-commands.md#模式与运行控制) — `/hello-world` 的各种用法
- [内置工具](../reference/tools.md#spec-模式) — Spec 模式与 `specs/` 产物的另一套约定
- [Tower 多 Agent 协作](./tower.md) — 需要多 Agent 并行执行时的实验模式
