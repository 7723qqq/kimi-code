# 手填添加 / 编辑供应商（以官方 web 为蓝本）

- **日期**：2026-10-12
- **蓝本**：`apps/kimi-code/dist-web`（Kimi Code Web 2.0.2，code-app 同步的预编译产物，随原生二进制分发）里的 `AddProviderPage` / `ProviderForm` / `ProviderModelTable`
- **落点**：`apps/kimi-code` 的 TUI `/provider` 与 `kimi provider` CLI
- **配套分析**：`reports/audit-2026-10-12.md`（无关）、本次三份分析（web 源码 / dist-web / TUI 现状）见对话记录

## 1. 目标

1. **TUI 手填添加**：`/provider` → `[ 添加新平台 ]` 增加第三个入口「手动添加」，让用户直接填写 `id / type / api_key / base_url / models[]` 把供应商写进 `config.toml`，不再只能依赖 models.dev 目录或自建 api.json。
2. **TUI 编辑**：`/provider` 列表可对已有供应商进入编辑表单（对齐官方 `ProviderForm` 的 `edit` 模式），支持改名，并在改名时迁移 `models` 别名与 `default_model` / `default_provider` 引用。
3. **CLI 对齐**：新增 `kimi provider create` 与 `kimi provider update`，与 TUI 共用同一套校验与写盘构造。
4. **删除废弃实现**：移除 fork 自带、与当前服务端契约不匹配且 UI 不可达的 `apps/kimi-web`（334 个跟踪文件）及其全部引用。

## 2. 受众

- **TUI 用户**：想接入不在 models.dev 目录里的自建/第三方 OpenAI 兼容端点。
- **CLI / 脚本用户**：需要非交互式地在 CI、容器或远程机器上添加供应商。
- **维护者**：少一份与 kap-server 契约脱节的 web 实现，少一条 CI job 与若干门禁条目。

## 3. 范围

**做**

- TUI 手填添加表单（字段、校验、错误显示对齐官方）。
- TUI 编辑（含改名迁移）。
- CLI 两个新子命令（create / update），共享同一纯函数模块。
- i18n（en + zh 同步）。
- `apps/kimi-web` 的删除与引用清理。

**不做（明确排除）**

- 不实现模型自动发现：`model_source` 的 `'discover'` 在全仓是未被任何代码分支处理的死值，本次不实现、不删除（属独立议题）。
- 不写 `model_source` 字段：运行时**不用** `KimiConfigPatchSchema` 校验写盘，真正生效的闸门是引擎 section schema（`app/config/configService.ts:323` 的 `validate` → `app/kosongConfig/configSection.ts`），它**保留** `modelSource`；`packages/node-sdk/src/config/schema.ts:40-57` 的 `ProviderConfigSchema` 没有该字段，只影响 SDK 侧的类型与校验。反向的既有分歧一并记录、本次不动：引擎 section schema 会剥掉 SDK-only 字段（`stream`/`temperature`/`maxTokens`/`searchDisable`）。官方 web 同样不写它。
- 不改 `POST/PUT /providers` 的 kap-server 契约，也不让 TUI 走 daemon REST（TUI 为进程内 SDK 直连，无 HTTP 客户端）。
- 不改 models.dev 目录导入与 api.json 注册表导入两条既有路径（只在添加子菜单里并列第三项）。
- 不修 `apps/kimi-web`（按用户决定直接删除）。
- 不改 `plugins/official/kimi-webbridge/**`、`packages/node-sdk` 里 `kimi-webbridge` 相关的任何内容——那是另一个同名能力插件，与 `apps/kimi-web` 无关。
- 不改 `specs/`、`reports/` 下的历史文档。

## 4. 需求与验收（R）

| # | 需求 | 验收（可执行/可观察） |
|---|---|---|
| R1 | 表单字段与官方一致：`id`*、`type`*、`api_key`*、`base_url`*、`models[]`*（每行 `model`* / `max_context_size`* / `display_name` 可选）；**无** `default_model` 字段 | 快照/单测断言渲染出这 5 组字段标签，且不存在默认模型字段；类型下拉恰为 6 值：`kimi / openai / openai_responses / anthropic / google-genai / vertexai` |
| R2 | 校验规则与官方一致：id 非空且匹配 `^[\p{L}\p{N}][\p{L}\p{N}\-_ ]*$`；`api_key` 在新增模式必填、编辑模式可空（留空=不更换）；`base_url` 仅校验非空；`models` ≥1 行且每行 `model` 非空、`max_context_size` 为正整数；**不做 URL 格式校验** | 单测：逐条构造非法输入断言返回对应错误码；`max_context_size` 输入 `0`/`-1`/`1.5`/`abc` 均判错；`base_url = "not-a-url"` 通过校验 |
| R3 | 类型切换时 `anthropic` 会把 base_url 结尾的 `/v1` 去掉，其它类型不动 | 单测：`normalizeBaseUrlForType('https://x/v1','anthropic') === 'https://x'`；对 `openai` 返回原值 |
| R4 | 添加写盘只写 `[providers.<id>]` 与 `[models."<id>/<model>"]`，且不触碰其它供应商/别名/`thinking`/`default_model`（除用户显式设为默认） | 单测：给出含既有 provider 的 config，断言 patch 只含新键；集成断言 `thinking` 字段未被写入 |
| R5 | 新模型行默认 `capabilities: ['tool_use','thinking']`、`adaptive_thinking: true`（对齐官方）；编辑模式预填并保留既有别名上表单未编辑的字段（`max_output_size` / `support_efforts` / `protocol` / 等） | 单测：新增行断言两个默认值；编辑既有行断言未编辑字段原样保留 |
| R6 | 编辑支持改名：改名后 `[providers]` 旧键消失、`models` 别名从 `<old>/<m>` 变为 `<new>/<m>`、无残留旧别名；当 `default_model`/`default_provider` 原指向该供应商时随之迁移；若原默认模型在新别名集合中不存在则保持未设置（不指向悬空别名） | 单测三条：普通改名、默认模型跟随、默认模型被删行后不悬空；一条负向：去掉迁移逻辑后「默认模型跟随」用例必须失败 |
| R7 | 托管（OAuth）供应商在编辑表单中只读：字段禁用，且不向用户展示已存 `api_key` | 单测：`managed:kimi-code` + `type: kimi` 时字段 `disabled`、不预填 key |
| R8 | 提交中禁用保存、失败保留输入并把错误显示在表单内（非 toast） | 单测：错误码 → 文案键映射；断言失败后表单值不变、焦点仍在表单 |
| R9 | 添加成功后刷新：重载 config 并更新 `availableModels`/`availableProviders`；随后进入既有的模型选择步骤（与目录导入一致），成功的供应商出现在 `/provider` 列表 | 现有 `provider.test.ts` 扩展：断言 `setConfig` 被调用且 `refreshConfigAfterLogin` 被调用一次；列表含新 id |
| R10 | CLI：`kimi provider create --id --type --api-key [--base-url] [--model] [--max-context-size] [--display-name] [--default]`；`kimi provider update <id> [--new-id] ...` 语义与 TUI 相同；两者与 TUI **共用**同一校验与 patch 构造模块 | `apps/kimi-code/test/cli/provider.test.ts` 扩展；断言 CLI 与 TUI 走同一 `buildAddPatch`（同一模块导入） |
| R11 | CLI 输出与既有命令一致：成功打印添加/更新摘要；`--json` 输出脱敏（`api_key` 不出现明文），失败以非零退出码结束 | 单测：`--json` 输出中不含输入的 api_key 字面量；失败路径 `process.exitCode !== 0` |
| R12 | i18n：所有新增文案 en/zh 成对，且不引入硬编码散文 | `bun run check:locale-keys`、`check:locale-placeholders`、`check:t-coverage`、`check:no-hardcoded-prose` 全部通过，且基线文件不新增条目 |
| R13 | 删除 `apps/kimi-web`：目录与 334 个跟踪文件移除；根 `package.json`、CI、`DEVELOP.md`、`CONTRIBUTING*.md`、4 个 `scripts/check-*.mjs`、`tools/review` 的 Zig 检查与 3 个 baseline 中的 `apps/kimi-web` 条目全部清理 | 见 tasks.md T7 的逐条验收；收尾断言：`rg -n 'apps/kimi-web' --glob '!node_modules' --glob '!specs/**' --glob '!reports/**'` 仅剩 0 命中（`kimi-webbridge` 不算命中） |
| R14 | 删除后仓库仍绿：`typecheck`（含 6 个 app 的 5 个）、`lint`、9 个 `check:*`、`tools/review` 的 zig 测试、根 `vitest` 与受影响包测试全部通过 | tasks.md T7 验收里的命令清单逐条通过 |

## 5. 决策记录（本 spec 已定）

- **不写 `model_source`**：引擎 section schema 会保留它（运行时不用 SDK 的 `KimiConfigPatchSchema`），只是 SDK 的 `KimiConfig` 类型没有该字段；官方蓝本也不写（见「不做」）。
- **TUI 写盘走 `KimiHarness`**（`setConfig` / `removeProvider`），不走 daemon REST。
- **编辑采用「先 `removeProvider` 再 `setConfig`」**，与仓库既有 catalog 导入同一模式；备选（v2 单次原子 `replaceConfigSections`）见 design 的备选方案，可在 ExitSpecMode 选择。
- **CLI 用新子命令**（`create`/`update`），不改既有 `provider add <url>` 的位置参数语义。

## 6. 依赖与前置

- `packages/node-sdk` 的 `KimiConfigPatchSchema`/`ModelAliasSchema` 是写入契约，本次不改动它。
- 官方蓝本中「编辑预填 api_key」由 `GET /providers/{id}` 提供；TUI 进程内可直读 `harness.getConfig()`，无需求助 REST。
