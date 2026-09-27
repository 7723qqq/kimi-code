---
name: normify-gen
description: |
  Normify 结构树生成与维护（normify）：把一个代码库描述成一棵"分形模块树"，并保持它与代码同步。Use this skill whenever the user asks to generate/维护/同步 module tree、结构图、架构树、normify-*.md 结构数据、tree.json、normify.html，或提到"模块树""结构数据""架构图与代码保持一致""normify"。它规定了 30 个 normify_* MCP 工具的调用顺序与字段约束（双语 name/description、parent = id 去掉末段、source 为仓库内相对路径、叶子才允许 apis），并给出从 project_init → change_open → module_batch → validate → build → render → change_close 的完整闭环。写任何结构数据或调 normify 工具之前先读本 skill，不要靠猜参数名。
metadata:
  version: "0.5.4"
---

# Normify 结构树生成（normify-gen）

一个项目 = 一棵（或多棵）分形模块树。**模型负责写结构数据，确定性引擎负责校验、编译、渲染**——
引擎零容忍：`normify_validate` 有任何 error 就不允许 build。

结构数据落在 `normify-<slug>/`（必须在 `rootDir` 内，目录名必须以 `normify-` 开头）：

```
normify-<slug>/
  modules/<tree>/index.md          # 结构数据源文件（frontmatter + Markdown 正文）
  renders/<id>.json                # 渲染数据（阅读顺序 / 分组 / 边提示）
  changes/<id>.json                # 变更记录
  policy.yml                       # 架构规则
  tree.json / outline.md / api-index.json / receipt.json   # build 产物（勿手改）
```

## 闭环（按顺序，不要跳步）

1. **建项目** — `normify_project_init { project: "<slug>", root?: { id, name{zh,en}, description{zh,en} } }`。
   幂等：重复调用不会破坏已有内容。跨根目录的结构数据需要 `NORMIFY_ALLOW_PROJECT_OUTSIDE_ROOT=1`。
2. **开变更** — `normify_change_open { project, title, intent, modules[], acceptance[] }`，
   让"这次改什么"可追溯。
3. **查规范** — `normify_help { topic }`（`fields` / `deps` / `api` / `renders` / `flow` / `tools` /
   `policy` / `errors` / `all` / `tool:<工具名>`）。**不要猜参数名。**
4. **写结构数据** — `normify_module_batch { items, mode: "upsert" }`（计划态建树首选，一轮写多个，
   整批 L1 + 结构预检通过才落盘，失败自动回滚）。单模块改动用 `normify_module_patch`。
   计划态（还没实现）：`state: "planned"` + `fingerprint: "pending"`。
5. **写渲染数据** — `normify_layout_upsert { id, order[], groups[], reading, mode }`，
   每个容器一层，让每层图都易读。数据从哪来用 `normify_brief { task | id | files }`。
6. **实现代码** → `normify_module_refresh { ids|all, activate: true }` 重算指纹、把 planned 转 active。
7. **收尾** — `normify_validate`（0 error）→ `normify_build`（冻结产物 + receipt.json）
   → `normify_render`（单文件交互式 HTML）→ `normify_change_close`。
   `normify_change_close` 会强制走完 3-6 步，任一步失败都不关闭。

改完已有结构前先 `normify_sync { repoRoot, diff }`（只读增量再生成计划器：脏子树、新增文件建议、
失效模块、破坏性 API 变更），再按清单局部重建；重命名/移动前先 `normify_deps_find { to }`
看谁依赖它。

## 字段硬约束（写错直接被 L1 拒）

| 字段 | 约束 |
|------|------|
| `id` | 小写段点分隔：`[a-z0-9][a-z0-9-]*`；**`parent` 必须等于 `id` 去掉最后一段**；根模块 `parent: null` |
| `name` / `description` | `{zh, en}` 双语对象，两边都非空；name ≤60 字符，description ≤500 字符 |
| `source[]` | 仓库内**相对** POSIX 路径（≤240 字符）；禁止 `..`、绝对路径、反斜杠；`line`/`end_line` 为正整数且 `end_line ≥ line` |
| `apis[]` | **只有叶子模块**可以声明；`http` 类必须有大写 `method`；`description` 同样要 `{zh, en}` |
| `deps[]` | 只存源端；`to` 是目标模块 id（可跨树）；不能自环 |
| `state` | `active`（默认）\| `planned` \| `deprecated`（`deprecated` 需 `replacement`） |

`id` / `uid` / `parent` 不能用 patch 改——重命名或换父级用 `normify_module_move { id, new_id | new_parent }`
（保 uid，级联 children parent，重写全项目 `deps.to`，迁移 `renders/*.json`）。

## 调用注意

- **布尔参数接受 `"true"` / `"false"` 字符串**（模型常这么发）；其它类型一律按 schema 拒
  （`args/invalid`）。缺必填是 `args/missing`。
- **体量上限**（超出即 `args/invalid`）：数组参数 ≤500 条、自由文本 ≤200000 字符、
  单个对象参数 ≤1MB、整个 arguments ≤4MB。一次要写上千个模块就分多批。
- **`dry_run: true` 先看计划**：批量写入、移动、策略覆盖都支持；确认无误再正式落盘。
- **`expect_updated_at` 防覆盖**：patch/upsert 可传，模块被别人改过就拒绝，先重新读取。
- `normify_render` 的 `out` 只接受结构数据目录下的相对文件名（如 `reports/arch.html`）；
  绝对路径与 `..` 会被 `render/out-escape` 拒。
- 需要 `fingerprint` 字段时调 `normify_fingerprint { repoRoot, source[] }`，
  算法与校验器完全一致（别自己 hash）。

## 架构规则

`normify_policy_get` 读 `policy.yml`（不存在时返回默认模板），`normify_policy_upsert` 整体覆盖。
规则类型：`forbid-dependency` / `dependency-direction` / `acyclic` / `max-depth` / `cross-tree` /
`naming`。`naming` 的 `pattern` 是正则，**不能含嵌套量词（如 `(a+)+`）、长度 ≤200**——
它会被逐个模块 id 段反复执行，写复杂了会把校验进程卡死。

改动前想确认不违规：`normify_check { modules[], deps[] }`（设计/编码前预检，只读）。

## 诊断怎么读

所有诊断形如 `[error] <code>: <message> @ <subject> → 修复: <supportedFixes>`。
先看 `code`（如 `structure/id-format`、`api/non-leaf`、`dep/target-missing`、`policy/rule-*`）
再按 `supportedFixes` 改；批量写入被拒时先看返回里的 `root_causes`，
`dep/target-dropped` / `structure/parent-dropped` 都是连带错误，别追着连带错误改。

常用主题速查：`normify_help { topic: "errors" }`。
