# WorkBuddy → Kimi Code 专家接入

## 默认入口：两级路由器

```sh
/skill:workbuddy-expert 代码 SeniorDeveloper
/skill:workbuddy-expert 代码
```

- Skill：`.agents/skills/workbuddy-expert/SKILL.md`
- 数据源：`workbuddy-agents-all/`
- 439 个 Agent 文件默认不加载；路由器按“分类 → 专家 ID”只读取选中的一个提示词。
- 分类与 ID 索引：`.agents/skills/workbuddy-expert/references/catalog.md`
- 机器可读目录：`workbuddy-agents-all/catalog.json`
- 完整目录：`workbuddy-agents-all/INDEX.md`

调用时先给分类，再给专家 ID；只给分类会列出该分类下的可用 ID。也支持直接给中文名，路由器会在目录里匹配。

```sh
/skill:workbuddy-expert 代码 CodeReviewExpert
/skill:workbuddy-expert 内容创作
/skill:workbuddy-expert 腾讯专区 CloudOpsTeam
```

主 Agent 也可以在需要时自动调用 `workbuddy-expert`，例如：

```text
用代码分类的 SeniorDeveloper 专家看这个改动。
```

## 权限

目标 Agent 的 `tools` 决定本次能力边界：

- 只读专家没有 `Write`/`Edit`，部分也没有 `Bash`。
- 文档/研究专家有 `Write`/`Edit`，没有 `Bash`。
- 执行专家有 `Write`/`Edit`/`Bash`。
- 团队主理人只有 `Agent`/`AgentSwarm` 等编排工具。

路由器运行在当前 Agent 上下文里；选中只读专家时按提示词保持只读。需要硬边界时，从 `plan`/`explore` 等只读 Agent 调用，或启用全量包后用 `kimi --agent <对应专家>`。

## 全量包

`workbuddy-agents-all/` 是数据源，默认不自动加载。

- 平铺加载全部：在 `config.toml` 顶层加 `extra_agent_dirs = ["workbuddy-agents-all/agents"]`。会引入 439 个 Agent，主 Agent 选择成本明显上升，不建议日常使用。
- 只想用某个专家的 `--agent` 快捷方式：把 `workbuddy-agents-all/agents/<name>.md` 复制到 `.agents/agents/workbuddy/`。
- 全量包包含原来的 13 个工程向 Agent；原来的平铺目录已移到 `.tmp/workbuddy-agents-starter-backup/`，需要时可恢复。

## 重新生成

```sh
node scripts/workbuddy-experts/import-all.mjs
```

生成全量包和两级路由 skill。源目录默认 `.tmp/workbuddy-all-experts`；小批量预设仍可用 `node scripts/workbuddy-experts/import.mjs`。

## 覆盖与限制

- 448 个清单专家 + 3 个本地额外专家，共 451 条目录。
- 252 个专家有 Agent，展开为 439 个 Agent 文件。
- 199 个受限专家只有元数据，没有公开提示词；路由器会标注，不会伪造。
- 1 个部分缺失：`AiContentCreatorTeam`，7 位成员中 6 位有提示词。
- WorkBuddy 内置 skills 未批量导入；需要时可把对应 `SKILL.md` 转成 Kimi Code skill。

## 移除

- 删除 `.agents/skills/workbuddy-expert/` 停止路由器。
- 删除 `workbuddy-agents-all/` 删除全量数据源。
- 恢复平铺 13 个：先建 `.agents/agents/`，再把 `.tmp/workbuddy-agents-starter-backup/` 移回 `.agents/agents/workbuddy/`。
