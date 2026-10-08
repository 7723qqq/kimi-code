# 发现 — packages/{transcript,migration-legacy,kap-server,acp-server} 下的 .md

范围：`packages/transcript`、`packages/migration-legacy`、`packages/kap-server`、`packages/acp-server` 下全部 `.md`（共 5 个文件，逐个通读并与实现比对）。

## 发现

- `packages/kap-server/CHANGELOG.md:91` — 类别 3 · 严重度 中 — 说明：CHANGELOG 声称本地服务器入口是 `kimi server run` / `kimi web`，代码实际把 `kimi server` 注册成废弃 shim：`run` 等一切子命令都被 `allowUnknownOption(true)` / `allowExcessArguments(true)` 吞掉，只打印弃用提示并 `process.exit(1)`，不会启动服务器（依据：`apps/kimi-code/src/cli/sub/web/deprecated-server.ts:29`、`:33-34`、`:37`；`kimi web` 仍有效，见 `apps/kimi-code/src/cli/sub/web/index.ts:22`）。

- `packages/kap-server/CHANGELOG.md:87` — 类别 3 · 严重度 低 — 说明：CHANGELOG 声称 v2 print 模式支持 `--skillsDir`，代码实际定义的 CLI 选项是 `--skills-dir`；commander 选项名大小写敏感且 `allowUnknownOption(false)`，传 `--skillsDir` 会直接报 unknown option（依据：`apps/kimi-code/src/cli/commands.ts:70`、`:36`）。

- `packages/kap-server/CHANGELOG.md:15` — 类别 3 · 严重度 低 — 说明：CHANGELOG 把「flag off」列为 `title/generate` 返回 40923 的原因之一，代码实际已无该 flag 门禁：`auto_session_title` 实验 flag 随 #3749 毕业被删除（`sessionTitle/flag.ts` 已不存在），`generateTitleOnce` 内不再有 flag 判断，路由自身的错误文案也只列三种原因（依据：`packages/agent-core-v2/src/session/sessionTitle/sessionTitleService.ts:73-88`、`packages/kap-server/src/routes/sessions.ts:587`）。

## 已读文件（覆盖声明）

- `packages/transcript/CHANGELOG.md`（13 行，全文）
- `packages/migration-legacy/CHANGELOG.md`（114 行，全文）
- `packages/migration-legacy/test/fixtures/golden/.kimi/skills/golden-skill/SKILL.md`（6 行，全文）
- `packages/kap-server/CHANGELOG.md`（99 行，全文）
- `packages/acp-server/CHANGELOG.md`（9 行，全文）

## 已核对为真、不作为发现的断言（择要）

- transcript:7 — `isDisplayablePromptOrigin` 接受 `system_trigger/subagent`（`packages/agent-core-v2/src/agent/loop/turnEvents.ts:95`）；冷重建只对 `name === 'subagent'` 折叠开场输入，`goal_continuation` / `stop_hook` / `loadable-tools` 确实保持无 prompt（`packages/transcript/src/history/groupTurns.ts:345-353`；`loadable-tools` 是合法 system_trigger 名，见 `packages/agent-core-v2/src/agent/toolSelect/dynamicTools.ts:14`）。
- transcript:13 / kap-server:71 — 粒度枚举 `off / turn / block / delta`（`packages/transcript/src/granularity/grade.ts:1`）；transcript wire 类型确由 transcript 包拥有（`packages/transcript/src/contract/events.ts:6-16`）。
- kap-server:15 — `source` 枚举与 40401/40923 错误码（`packages/kap-server/src/routes/sessions.ts:559`、`packages/kap-server/src/protocol/error-codes.ts:15`、`:58`）。
- kap-server:25 / :27 / :42 / :62 — `event.config.warning`（`packages/kap-server/src/transport/ws/v1/events.ts:107`）、`experimental_flags`（`packages/kap-server/src/routes/meta.ts:54`）、`hostIdentity` 必填与 `serverVersion` 改名（`packages/kap-server/src/start.ts:114`、`:117`）、tools 的 `active` 字段（`packages/kap-server/src/routes/tools.ts:202`）。
- kap-server:33 — 三个 `KIMI_SNAPSHOT_*` 环境变量在全仓库已无引用。
- kap-server:81 — 答案按问题文本为键、选项 label 为值（`packages/kap-server/src/routes/questions.ts:285-306`）；重复问题/选项被拒（`packages/agent-core-v2/src/agent/tools/ask-user-question/ask-user-question.ts:58`、`:64`）；question wire 无 `expires_at`。
- migration-legacy:30 / :95 / :111 — 废弃 flag 过滤（`packages/migration-legacy/src/steps/config.ts:37-42`、`:445-451`）、`default_yolo` → `default_permission_mode`（同文件 `:410-413`）、skills 迁移路径与「保留已存在目标」（`packages/migration-legacy/src/steps/skills.ts:30-31`、`:55-58`；`packages/migration-legacy/src/paths.ts:7`、`:19`）。
- acp-server:7-9 — 依赖 `@moonshot-ai/agent-core-v2@0.4.0`、`@moonshot-ai/klient@0.1.2` 与 `packages/acp-server/package.json` 一致，且 `agent-core-v2@0.4.0` 真实存在（`packages/agent-core-v2/CHANGELOG.md:21`）。

## 已考虑但未报告

- `packages/transcript/CHANGELOG.md:13` 与 `packages/kap-server/CHANGELOG.md:71` 把端点写作 `GET /sessions/{id}/transcript`，实际挂载在 `/api/v1` 前缀下（`packages/kap-server/src/routes/registerApiV1Routes.ts:213`）。判为路由内部路径的简写而非错误断言，不报。
- `packages/migration-legacy/CHANGELOG.md:10` 的 `@moonshot-ai/agent-core@0.15.5`、`packages/kap-server/CHANGELOG.md:99` 的 `@moonshot-ai/protocol@0.4.0` 指向已删除的包（`431b584a44`、`9188d03c99`），但属发布时的历史记录，不报。
