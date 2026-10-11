# 进度记录

- **spec**：`specs/emma-frost-spider-gwen-sif/`（requirements / design / tasks）
- **选定方案**：编辑写盘 = A（`removeProvider` + `setConfig`）
- **执行约定**：不 commit / 不 push / 不打 tag，工作树留给属主审阅

## 状态

| 任务 | 状态 | 备注 |
|---|---|---|
| T1 共享纯函数模块 | ✅ | `apps/kimi-code/src/utils/provider-form.ts`（240 行）+ `test/utils/provider-form.test.ts`（508 行 / 35 用例） |
| T2 i18n 键 | ✅ | `en.ts` / `zh.ts` 各 +28 键（design §6 全 26 + `footerFields`/`apiKeyRevealHint`；`error.*` 8 个）；4 个门禁 + locale-parity 全绿，基线 0 新增 |
| T3 表单组件 | ✅ | `src/tui/components/dialogs/provider-form-dialog.ts`（673 行）+ `test/tui/components/dialogs/provider-form-dialog.test.ts`（376 行 / 14 用例） |
| T4 TUI 添加接线 | ✅ | `commands/provider.ts`：添加子菜单第三项 `manual` + `handleManualProviderAdd`（含 id 判重）+ 共用 `mountProviderModelSelector`；`test/tui/commands/provider.test.ts` 19 用例；终审修复见文末 |
| T5 TUI 编辑 | ✅ | `provider-manager.ts` 行级 `E`/`onEdit` + 页脚提示；`provider.ts` 的 `handleProviderEdit`（预填 / 冲突拒绝 / `removeProvider` → `setConfig` → 刷新 → 重挂列表）；终审修复见文末 |
| T6 CLI create/update | ✅ | `cli/sub/provider.ts` +293 行、`test/cli/provider.test.ts` +20 用例（59 全绿）；`commands.ts` 无需改动；无新增 locale 键 |
| T7 删除 apps/kimi-web | ✅ | 334 文件已 `git rm`（84,671 行）；引用清理 22 个文件 |
| T8 文档 + changeset + 全套门禁 | ✅ | `docs/{zh,en}/configuration/providers.md` 各 +2 小节；`docs/{zh,en}/reference/kimi-command.md` 补 `create`/`update` 子节；changeset `.changeset/manual-provider-add-edit.md`（minor）；门禁见文末「T8 结果与门禁」 |

## T1 结果与偏差裁决

- 交付：`PROVIDER_WIRE_TYPES` / `ProviderFormValue` / `validateProviderForm`（8 错误码，含 `modelDuplicate`）/ `normalizeBaseUrlForType` / `defaultModelRow` / `buildAddPatch` / `planEditWrite(..., { clearApiKey })`。
- 补强已实现：改名时 `providers[newId]` 以旧对象为基底（`source`/`oauth`/`customHeaders`/`env`/`stream` 不丢）；`defaultModel`/`defaultProvider` 迁移（模型行被删则不带 `defaultModel`）；清空语义（`clearApiKey` 才写 `apiKey: ''`）；编辑保留别名上未被表单编辑的字段。
- **审查后补强（独立审查驱动）**：`validateProviderForm` 新增 `modelDuplicate`（逐行错误优先，按 `row.model.trim()` 去重，对齐 kap `refineProviderForm` 的 `duplicate model`）；`planEditWrite` 返回改为 `{ removeProviderId, patch, collisions, providerIdTaken }`——`collisions` 是本 patch 将写入、但当前属于其它 provider 的别名键，`providerIdTaken` 是 `newId` 已被他方占用，调用方见到非空 / true 应拒绝写盘。
- **tasks.md 描述有误（已按官方与引擎一致实现，tasks.md 已改准）**：`^[\p{L}\p{N}][\p{L}\p{N}\-_ ]*$` 首字符类含 `\p{N}`，**数字开头合法**；官方 dist-web 反混淆实现与 `modelsDevImport.ts:25`、kap `providerIdSchema` 同款。测试显式覆盖「数字开头合法、无长度上限」。
- **唯一比官方更严处**：官方先 `trim()` 再测 id，本实现按原值匹配（`' demo'` → `idInvalid`），以满足 R2 的「值需匹配正则」。
- **冻结组件的集成修复（偏离「不要动」一次，已最小化）**：`provider-form-dialog.ts` 的 `hintText`/`focusError` 是 switch 逐码映射；新增 `modelDuplicate` 后 `hintText` 触发 `TS2366`（typecheck 变红）并让两个 switch 各出 1 条 `switch-exhaustiveness-check` 告警。仅补两个 case：`hintText` 返回 `t('tui.dialogs.providerForm.error.modelDuplicate')`；`focusError` 打开含重复 model 的首行行编辑（并为 `contextSizeInvalid` 补上原本靠「末尾 case」隐式可达的 `return`）。既有分支、公共 API、其测试文件未动；临时用例验证「提交重复行 → 显示本地化文案 + 打开行编辑」，验证后已删除，组件测试仍 14/14。
- 负向验证：拆掉默认指针迁移 → 2 用例失败；拆掉正整数校验 → 1 用例失败；`collisions` 恒为空数组 → 冲突用例失败（1 失败 / 34 通过）；均已还原并复跑 **35/35**。

## T7 结果与遗留

- `git rm -r apps/kimi-web`（334 文件 / 84,671 行，已暂存）；本地 `node_modules`（596MB，未跟踪）已删。
- 引用清理（22 文件）覆盖 design §7 全表，并额外处理：`AGENTS.md:6`、`tsconfig.json:47`、`check-web-assets.mjs:3`、`session-stats.ts:130` 注释、`scripts/prompt-optimizer/knowledge-rs/standards.md`（把举例换成仍在 flake 闭包外的 app）、`scripts/no-hardcoded-prose-baseline.txt` 56 行。
- 验收：`rg 'apps/kimi-web'`（排除 node_modules/specs/reports）**0 命中**；`bun install --frozen-lockfile` ✅；`bun run typecheck` ✅；9 个 `check:*` ✅；`(cd tools/review && zig build test)` 96/96 ✅；`review` 全量运行中本任务涉及的 6 项检查 0 finding。
- **遗留（需属主/后续处理）**：
  1. CI 分支保护若把 `test-kimi-web` 列为必需 status check，删除 job 后需在仓库设置移除。
  2. `bun run lint` 在 HEAD 即红（12 error，位于 kaos/minidb/klient，非本改动引入）。
  3. `review` 的 orphan-exports 有 6 条：5 条指向未接线的 `provider-form.ts`（T4/T5/T6 接线后消失），1 条既有（`tui/utils/thinking-config.ts:4 isThinkingOn`）。
  4. 负向验证发现：`silent-catch-baseline.txt` 的过期条目只报 `info`、不使检查失败——spec 里「必须失败」的措辞与该门禁的实际严重级不符（如需硬门禁应另开任务）。

## T2 结果与偏差

- 交付：`tui.dialogs.providerForm.*` 26 键（含 `error.*` 7 个）、`tui.statusMessages.*` 5 个、`cli.commandDescriptions.providerCreate/providerUpdate`、`cli.optionDescriptions.providerCreate*` 8 个（含 `--new-id`，create/update 共用；design 把 `--new-id` 也列进该系列）。
- 超出 design §6 的 2 个键（组件需要，无法用硬编码文案替代）：`footerFields`（普通字段区页脚——design 的 `footerList/footerRow/footerSave` 覆盖不了 4 个焦点区）、`apiKeyRevealHint`（Ctrl-R 明文提示）。
- **并发写入者**：写入期间有第二个写入者合并了同一处键。对方先加过一份重复的同名块（esbuild 报 `Duplicate key "providerForm"`），随后删除重复块并把其页脚文案并入本块。最终每个 locale 只保留一个 `providerForm` 块。
- 验收：`check:locale-keys` / `check:locale-placeholders` / `check:t-coverage` / `check:no-hardcoded-prose` 全绿；`scripts/no-hardcoded-prose-baseline.txt` 相对 HEAD 仅 56 行删除、0 新增（删除来自 T7）；`locale-parity.test.ts` 2/2；43 个目标键在 en/zh 双侧均存在，且 zh 无一条等于 en（无未翻译占位）。
- **未做**：tasks.md T2 的负向验证（只加 zh 不加 en → `check:locale-keys` 必须失败）未执行，避免在并发写入者对同一文件操作期间制造假失败。

## T3 结果与偏差

- 交付：`ProviderFormDialogComponent`（`onDone({kind:'ok'|'cancel', value?})`）。字段序 `id → type → apiKey → baseUrl → models → Save`；Tab/Shift-Tab/↑↓ 移动，Enter 前进（models 区进入行编辑、Save 提交），Esc/Ctrl-C 取消；`type` 用 ←/→/空格在 `PROVIDER_WIRE_TYPES` 间循环，切换时对已填 baseUrl 调 `normalizeBaseUrlForType`；models 行摘要列表（↑↓ 选择、`A` 追加并进入行编辑、`D` 删除且**始终保留 ≥1 行**、`E`/Enter 进入行编辑子模式：Model ID → Context → Display name，末字段 Enter 写回列表、Esc 放弃本行）；apiKey 默认掩码 + `Ctrl-R` 明文；校验走 `validateProviderForm`，失败保留全部输入并把焦点移到出错字段（models 类错误定位到具体行与字段），错误码渲染为表单内 hint；`provider.oauth !== undefined` → 全部字段只读 + 页脚 `managedReadonly`。
- 验收：`test/tui/components/dialogs/provider-form-dialog.test.ts` 14/14 全绿；`cd apps/kimi-code && bun run typecheck` 退出码 0；scoped `oxlint --type-aware`（组件 / 测试 / 两个 locale）0 错误 0 告警；`oxfmt --check` 新增文件格式正确；`printable-key-guard` / `chalk-named-color-guard` / `locale-parity` 全过；dialogs+commands+i18n 局部 sweep 572 用例全绿。
- 负向验证：① 去掉 `oauth` 禁用分支 → `renders a managed provider read-only` 失败（13/14）；② 去掉「最后一行不可删」保护 → `appends rows with A and refuses to delete the last row` 失败（rowCount 0 ≠ 1）。均已还原并复跑 14/14。
- **与 tasks.md 的偏差**：tasks T3 验收写「所有 Input `disabled`」，但 pi-tui `Input` 没有 `disabled` 属性且本仓库不改上游包；实现为组件级 `readonly disabled` + 输入永不获焦 + 除 Esc/Ctrl-C 外按键全部无效，测试以 `dialog.disabled === true`、渲染前后逐字节一致、`onDone` 未被调用三处断言覆盖。
- **并发风险（需属主裁决）**：写入期间存在第二个写入者，且其也在改 `provider-form-dialog.ts`（有一次外部改写摘下/还原了「≥1 行」保护，疑似对方在跑同一份 tasks.md 的 T3 负向验证）。若确有两个 agent 并行做 T2+T3，二者会互相覆盖；本文记录的状态对应 05:47 的文件内容（组件 `md5 d7b03a136870c8c86efa655360e15715`、测试 `md5 03753a5f30c4d11bdef2f72b757723d5`），之后若被外部改写需重新核对。

## T6 结果与偏差

- 交付：`src/cli/sub/provider.ts` +293 行（`handleProviderCreate` / `handleProviderUpdate` + `reportProviderWrite` / `PROVIDER_FORM_ERROR_KEYS` / `resolveWireType` / `createFormInput` / `updateFormInput` / `providerModelRows`，并在 `registerProviderCommand` 内注册两个子命令）；`test/cli/provider.test.ts` +20 用例（该文件 59/59 全绿）。**`src/cli/commands.ts` 无改动**：注册链路是 `commands.ts:106` → `registerProviderCommand` → 子命令，T6 的两条命令挂在该函数里；仓库内只有这一处调用点（`grep registerProviderCommand` 已确认）。
- 共享模块复用：两个 handler 都只构造 `ProviderFormValue` 后调 `validateProviderForm` / `buildAddPatch` / `planEditWrite`；测试用真实模块的返回值做 `toEqual` 断言（`setConfigCalls` 与 `buildAddPatch(...)` / `planEditWrite(...).patch` 逐字段一致），update 额外断言 `removeCalls === ['demo']` 且先于 `setConfig`。**未新增任何 locale 键。**
- 验收证据：真实临时 home（`makeRegistryHarness`）断言磁盘 TOML 含 `[providers.demo]`、`[models."demo/gpt-4.1"]`；改名后 `"demo/gpt-4.1"` 消失、`"demo2/gpt-4.1"` 出现，`customHeaders`/`maxOutputSize`/`displayName`/其它 provider 全部保留，`defaultModel`、`defaultProvider` 迁移；`--json` 输出解析为 `{providers,models}` 且不含 `sk-x`。
- 负向验证：把 `resolveWireType` 改成 `return raw as ProviderWireType`（宽松透传）→ `exits 1 without writing when --type is not one of the six wire types` 与 commander 路由用例双双失败；还原后 59/59。已确认非法 type 路径不调用 `ensureConfigFile` 之后的任何写盘（校验先于 `getHarness()`）。
- 自检：`test/cli/provider.test.ts` 59/59；`bun --bun x vitest run test/cli` 36 文件 / 666 用例全绿；app 级 `tsc --noEmit` 退出码 0；根 `bun run lint` 中本改动两文件 13 条告警与 HEAD 基线逐条一致（0 新增、0 error）；4 个 `check:*` 全绿。
- **与 design §5 的偏差（共享校验的必然结果，需属主确认）**：
  1. `create` 的 `--base-url` 实际**必填**——design 写成可选，但 `validateProviderForm` 对空 baseUrl 返回 `baseUrlRequired`，CLI 复用同一校验即拒绝；缺 `--base-url` 时退出码 1 且不写盘。
  2. `update` 未给 `--base-url` 时用存储值补齐；若存储值本身为空（引擎允许）且未显式给 `--base-url`，则 `baseUrlRequired`。同理，无模型别名的 provider（如 `managed:kimi-code`）做纯改名会被 `modelRequired` 拦下，除非给 `--model`。
  3. `--model` 在 update 里是**upsert**（同名行沿用未给字段、新行需 `--max-context-size`），design 未定义；`--display-name` 仅在同时给 `--model` 时生效。
- **locale 缺口（按指令不自行加键，改为复用最接近的现有键，建议后续补键）**：
  1. 非法/缺失 `--type` 无专用错误键 → 复用 `cli.optionDescriptions.providerCreateType`（列出合法 6 值）。
  2. `providerIdTaken` → 复用 `tui.dialogs.providerForm.error.idInvalid`；`collisions` → 复用 `...error.modelDuplicate`。两者语义都偏「格式/重复」而非「已被占用」，建议加 `error.idTaken` / `error.modelTaken`。**→ 已由「终审修复」#3 解决：新增 `error.idTaken` / `error.aliasConflict`，TUI/CLI 共用。**
  3. `--id` 选项描述复用 `tui.dialogs.providerForm.idLabel`；`--json` 复用 `cli.optionDescriptions.providerListJson`。
- 其它：`update` 不支持清空 api_key（无 `--clear-api-key`，走 `planEditWrite` 默认「空即保留」）**→ 已由「终审修复」#2 解决：`--api-key ''` 即清空凭据**；`type` 为引擎独有的 `astron` 时未给 `--type` 会原样保留。
- 格式化：`test/cli/provider.test.ts` 在 HEAD 即有 3 处 oxfmt 偏差（如多余的 `(await current())` 括号），本次按仓库配置一并格式化（5 行 diff）。

## T8 结果与门禁

- **文档（两个小节 × 两种语言）**：`docs/zh/configuration/providers.md` 与 `docs/en/configuration/providers.md` 各新增
  1. 「用 `/provider` 手动添加 / 编辑供应商」——字段表（供应商 ID / API 协议 / API 密钥 / 基础 URL / 模型行）、`models` 行三个字段与 `max_context_size`、6 种协议取值（锚点指向上文类型表）、键位（`Tab`/`↑↓`、`←→` 或空格循环协议、`A`/`D`/`E` 行操作、`Ctrl-R` 明文、`Esc` 取消）、校验错误、保存语义（单次写入 + `capabilities`/`adaptive_thinking` 默认值 + 默认模型选择器）、编辑与改名（`removeProvider` + `setConfig`，旧别名与默认指针迁移）、冲突拒绝、`oauth` 托管只读。
  2. 「用 `kimi provider create/update` 添加与修改供应商」——两个子命令的完整选项表与逐字可执行示例（占位符用 `YOUR_API_KEY` / `api.example.com`）。
- **按实际行为书写（含与 design §5 的偏差）**：`create` 的 `--api-key` / `--base-url` / `--model` / `--max-context-size` 实际全部必填（design 把 `--base-url` 写成可选，以 T6 实测为准，文档写明「没有留空取默认值」）；`update` 未给的字段保持原值（`--type` 保留存储类型，含引擎独有的 `astron`；无清空 api_key 的选项）；改名与删行走 `removeProvider` → `setConfig`，旧别名与悬空的 `default_model` / `default_provider` 被级联清理，默认指针迁移到新 id；冲突（id 被占 / 别名冲突）退出码 1 且不写盘。
- **CLI 参考文档未跳过**：仓库确有 `docs/{en,zh}/reference/kimi-command.md` 的 `### kimi provider`，故在其中补 `#### kimi provider create` 与 `#### kimi provider update` 两个子节（选项表 + 示例），并把「五个动作」改为「七个动作」，中英同步；providers.md 的 ② 反向链接到该参考页。既有 `/provider` 小节的「添加或删除」改为「添加、编辑或删除」并补 `E` 键。
- **changeset**：`.changeset/manual-provider-add-edit.md`，frontmatter `"@moonshot-ai/kimi-code": minor`。第一段 `Add hand-filled provider setup: ...`（`/provider` → add → 手动填写 + 行上 `E` 编辑/改名 + CLI `kimi provider create`/`update`）；第二段 `Remove the ` + `` `kimi-web` `` + ` app from this repository ...`（该 Web 应用的 Vue 源码不再随仓库提供，`kimi web` 与它服务的预构建产物不变）。**写法取舍**：第二段刻意不写 `apps/kimi-web` 字面量，以保持 T7 验收的 `rg 'apps/kimi-web'`（排除 node_modules/specs/reports）仍为 0 命中，复核结果确为 0 命中。**未改任何 `package.json` 的 `version`**（`git diff -- package.json` 仅两处删除：workspaces 的排除项与 typecheck 里的 kimi-web 片段）。
- **门禁结果**（24 核，bun）：
  - `bun run lint` ❌ 12 error / 11105 warning —— 12 个 error 全部落在 9 个**本任务未改动**的文件：`packages/agent-core-v2/src/workspace/workspaceFs/internal/fsSearch.ts` ×3（await-thenable）、`packages/kaos/src/local.ts` ×1（no-unused-vars）、`packages/klient/src/transports/memory/dispatcher.ts` ×2、`packages/minidb/{src/compaction.ts, src/index-manager.ts ×3, src/options.ts, bench/maintenance.ts ×2, bench/measure-session-memory.ts, test/review-round6.test.ts ×3}`。`git status --short` 对这 9 个文件均为 0 行改动 → 与 HEAD 逐条一致（T7 遗留亦记录 HEAD 即 12 error）。
  - `bun run typecheck` ✅ exit 0（含 `build:packages`）。
  - 9 个 `check:*` ✅ 全绿：`locale-keys`、`locale-placeholders`、`t-coverage`、`status-surface-i18n`、`no-hardcoded-prose`、`no-comments`、`service-naming`、`nix-workspace`、`catalog-versions`。
  - `(cd tools/review && zig build test)` ✅ 3/3 steps、**96/96 tests passed**；为排除缓存命中，用 `zig build test --cache-dir /tmp/t8-zig-cache --summary all` 强制重编译复核，仍 96/96（zig 0.17.0）。
  - `cd apps/kimi-code && bun --bun x vitest run test/utils test/tui/commands test/tui/components/dialogs test/cli test/i18n` ✅ **112 文件 / 1562 用例全通过**（21.5s），含 `utils/provider-form` 35、`dialogs/provider-form-dialog` 14、`dialogs/provider-manager` 9、`tui/commands/provider` 18、`cli/provider` 59、`i18n/locale-parity` 2。
- **未做（需人工）**：tasks.md T8 的手工 TUI 验收（真实 `/provider` 添加 → `E` 改名 → 删除，以及留空 `base_url` 的内联错误）需在终端交互并会写入属主的 `~/.kimi-code/config.toml`，留给属主按 tasks.md 执行；文档侧已按同一行为逐条对齐。

## 终审修复（独立终审：1 必段 + 3 缺陷 + 1 注释/死键）

单一写入者，无并发。逐条记改动与验证；负向验证见 §自检。

1. **托管 provider 表单明文渲染已存 api_key（R7 违反，必段）**
   - `provider-form-dialog.ts` 的 `apiKeyLine`：`disabled` 分支由 `dim(raw)` 改为 `dim(maskInputLine(raw))`。取「渲染前掩码」而非「不预填」，保留「预填值经 `onDone` 原样回传」的既有语义；`render()` 从此永不输出明文。
   - 断言：`test/tui/components/dialogs/provider-form-dialog.test.ts` 的托管用例新增 `not.toContain('sk-secret')` + `toContain('•')`（按键遍历后再断言一次）；`test/tui/commands/provider.test.ts` 的托管 fixture 加 `apiKey: 'sk-managed'`，渲染与按键遍历后均断言不含明文。
2. **CLI 不能清空 api_key**：`handleProviderUpdate` 调 `planEditWrite` 时传 `{ clearApiKey: opts.apiKey !== undefined && opts.apiKey.trim() === '' }`（显式空串 = 清空；省略 = 保留）。
   - 用例：`clears the stored api key when --api-key '' is passed`（`apiKey` 落盘为 `''`，`baseUrl`/`customHeaders`/`maxOutputSize` 不变，patch 里 `apiKey: ''`）；「省略时保留、给值时替换」的既有用例不变。
3. **冲突文案错位**：`tui.dialogs.providerForm.error` 新增 `idTaken`（「该供应商 ID 已被占用」/"That provider ID already exists"）与 `aliasConflict`（「这些模型别名已属于其它供应商」/"Those model aliases belong to another provider"），en/zh 同步。TUI `commands/provider.ts` 与 CLI `sub/provider.ts` 各自以同名 `PROVIDER_WRITE_REFUSAL_KEYS` + `refusalMessage(code, keys)` 组合为「理由 (冲突键)」——`providerIdTaken` → `idTaken`、`collisions` 非空 → `aliasConflict`，冲突键仍 join 在消息里（例：`That provider ID already exists (demo2)`；TUI 外层仍是 `providerFormFailed`）。
   - 用例：TUI 改名撞 id 用例改断 `idTaken (taken)`；CLI 两条既有冲突用例的 stderr 由「非空」收紧为 `idTaken` / `aliasConflict` 文案 + 冲突键（`other` / `demo2/gpt-4.1`）。
4. **新增时不查 id 是否已存在（静默改写）**：TUI `handleManualProviderAdd` 与 CLI `handleProviderCreate` 都在写盘前 `getConfig()` 判 `providers[id] !== undefined` → 报 `idTaken`（TUI 走 `showError` 且不写盘；CLI 写 stderr + `exit(1)` 且不写盘）。
   - 用例：TUI `refuses an id that already exists instead of merging over it`（`setConfig`/`refreshConfigAfterLogin` 未调用、config 逐字未变）；CLI `refuses an id that already exists instead of merging over it`（退出码 1、无 `setConfig`、`apiKey`/`baseUrl`/`customHeaders`/`maxOutputSize` 原样）。
   - 连带调整：TUI「写盘失败」用例原以已存在的 `demo` 触发 `setConfig` 失败，现改用 `fresh`，否则先被新守卫拦下。
5. **注释与死键**：`utils/provider-form.ts` 的 `planEditWrite` 文档改为「保住字段仅限纯函数层；哪些键落盘由引擎 section schema 决定——SDK-only 的 `stream`/`temperature`/`maxTokens`/`searchDisable` 会被丢掉」；删除 0 引用的 `tui.statusMessages.providerFormNoModels`（en+zh，全仓 `grep` 0 命中）。

### 自检（真跑）

- `cd apps/kimi-code && bun --bun x vitest run test/utils/provider-form.test.ts test/tui/components/dialogs/provider-form-dialog.test.ts test/tui/components/dialogs/provider-manager.test.ts test/tui/commands/provider.test.ts test/cli/provider.test.ts test/i18n/locale-parity.test.ts` → **6 文件 / 140 用例全绿**（35 / 14 / 9 / 19 / 61 / 2）。
- `cd apps/kimi-code && bun run typecheck` → exit 0。
- `bun run check:locale-keys` ✅、`check:locale-placeholders` ✅、`check:t-coverage` ✅、`check:no-hardcoded-prose` ✅（基线仍 528，0 新增）。
- 12 个相关文件 scoped `oxlint --type-aware` → **0 error / 22 warning**，逐条核对全部落在 HEAD 或本轮之前写入的既有行（0 新增）；`bun run lint` 全量 **12 error / 11105 warning**，12 个 error 全在 `packages/{kaos,klient,minidb}`（与 HEAD 基线一致）。
- **负向验证（#1）**：把 `apiKeyLine` 的 `disabled` 分支改回 `dim(raw)` → `renders a managed provider read-only`（组件）与 `renders a managed provider read-only and never writes`（命令）**双双失败**，失败 diff 直接显示明文行 `│  > sk-managed │` / `│  > sk-secret │`；还原后两条用例复跑通过（2 passed | 31 skipped）。

### 已知留白

1. **models.dev 目录导入路径无自动化用例**：`/provider` → 添加 → 已知第三方 需要 mock 远端 catalog 抓取，既有实现与本次均未覆盖；本轮补的是 api.json（custom registry）路径端到端用例与「三入口菜单齐」用例，目录路径代码原样未改（其模型选择器仍为内联实现，不在共用 helper 内）。
2. **`stream` / `temperature` / `maxTokens` / `searchDisable` 引擎侧不保留（既有分歧）**：纯函数层改名会保住这些字段，落盘时被引擎 section schema 丢弃（见 requirements §3 与本次 #5 的注释口径）；如需真正保住，属独立议题。

### 其它记录

- `oxfmt --check` 仍有 4 处既有偏差（`en.ts` 1 处 `promptOptimizerOutputTooLongAction`、`test/tui/commands/provider.test.ts` 2 处 `expect` 换行、`utils/provider-form.ts` 1 处一行签名合并、`test/utils/provider-form.test.ts` 1 处 import 顺序），均不在本轮改动行内，未改动；如需仓库级格式化应单独开一次全量 `oxfmt --write`。
- 冻结件状态：`utils/provider-form.ts` 本轮仅改注释（#5）；`provider-form-dialog.ts` 本轮仅改 `apiKeyLine` 掩码（#1）。两者都不是 spec 原定「不要动」的范畴，属终审指定修复。

## 收尾：属主实跑的最终门禁（2026-10-12）

- **9 个 `bun run check:*`**：全部 OK（locale-keys / locale-placeholders / t-coverage / status-surface-i18n / no-hardcoded-prose / no-comments / service-naming / nix-workspace / catalog-versions）。
- **`(cd tools/review && zig build test)`**：exit 0。
- **`rg -n 'apps/kimi-web'`**（排除 node_modules/specs/reports）：**0 命中**。
- **整仓 `bun --bun x vitest run`**：1040 文件 passed / 10 skipped；**18770 passed / 66 skipped / 1 todo / 0 failed**。
- **`apps/kimi-code` 五个受影响目录 sweep**（utils / tui/commands / tui/components/dialogs / cli / i18n）：连跑 4 次，其中 1 次报 `1 failed / 1565`。
  - 失败项：`test/cli/telemetry.test.ts > initializeServerTelemetry > configures the sink with ui_mode="web" and the CLI product identity`，**Test timed out in 20000ms**（该次耗时 21.3s）。
  - 判定：**既有负载敏感 flake，非本次回归**——该文件未被本次改动触碰（`git status` 为空）；单独运行 2 次分别 7.0s / 6.2s 全绿；只在 112 个文件并行时才触顶。
- **根 `bun run typecheck`**：见任务输出的最终结论（后台执行）。
- **未提交**：`git status` 保持「334 项删除已暂存 + 引用清理/实现改动未暂存 + 4 个新文件未跟踪」，等待属主决定是否 commit / push，以及是否补 `git tag archive/kimi-web-0.1.2 <sha>`。

## 终审修复（已并入）

- 托管 provider 编辑表单：`disabled` 时渲染前掩码（此前 `dim(raw)` 明文可见），两条「不含明文」断言补齐；负向验证（改回 `dim(raw)`）如期失败。
- CLI `update --api-key ''` 现在真的置空（`clearApiKey` 判定），与 TUI 对称。
- 冲突文案改用专用键 `error.idTaken` / `error.aliasConflict`（en/zh 成对），CLI 与 TUI 共用。
- 新增供应商前判重：TUI/CLI 在 `providers[id]` 已存在时拒绝写盘（此前 deepMerge 会静默覆盖同 id 的 type/baseUrl/apiKey）。
- 删除死键 `tui.statusMessages.providerFormNoModels`；`stream`/`temperature`/`maxTokens`/`searchDisable` 的注释改为「纯函数层保住、落盘由引擎 section schema 决定」。
