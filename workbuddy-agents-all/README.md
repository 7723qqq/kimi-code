# WorkBuddy 全量 Agent 包

由 `scripts/workbuddy-experts/import-all.mjs` 生成。

- 清单专家：448
- 已生成 Agent 的专家：252
- 生成的 Agent 文件：439
- 受限（无公开提示词）：199
- 部分（成员缺失）：1
- 本地额外专家：3

默认入口：`/skill:workbuddy-expert 代码 SeniorDeveloper`（两级路由，不需要启用全部）。

启用全部：在 `config.toml` 顶层加入

```toml
extra_agent_dirs = ["workbuddy-agents-all/agents"]
```

也可以只复制 `agents/<name>.md` 到 `.agents/agents/workbuddy/`。完整目录与状态见 `INDEX.md`，机器可读目录见 `catalog.json`。
