# 设计：手填添加 / 编辑供应商（TUI + CLI）与删除 `apps/kimi-web`

## 1. 蓝本对照（dist-web → 本次落点）

| 官方（dist-web） | 本次实现 | 说明 |
|---|---|---|
| 字段 `Name* / API Protocol* / API Key* / Base URL* / Models*` | 同字段、同顺序 | 无 `default_model` 字段（官方 i18n 有键但代码 0 引用） |
| 类型 6 值 `kimi/openai/openai_responses/anthropic/google-genai/vertexai` | 同 6 值 | 与 `rest-modelCatalog.ts:23-30` 逐字一致 |
| 类型切换：`anthropic` 去 base_url 尾部 `/v1` | 同 | `normalizeBaseUrlForType` |
| Models 表格三列 `Model ID* / Context* / Display name`，≥1 行、可增删 | 三字段行编辑器 + 行列表（见 §3） | TUI 无表格布局能力，改成「行摘要 + 内联行编辑」，字段与校验不变 |
| 校验：id 正则 / apiKey 新增必填 / baseUrl 仅非空 / context 正整数 | 同 | 抽成纯函数 `validateProviderForm` |
| 错误：表单顶部内联 danger + 滚动 | 表单内联 hint 行 | TUI 无 toast；沿用 `custom-registry-import.ts` 的 `hint` 机制 |
| `POST /providers` body `{id,type,models:[{model,max_context_size,display_name?,capabilities?,support_efforts?,adaptive_thinking?}],api_key?,base_url?}` | `setConfig` patch（camelCase 同名映射） | TUI 进程内直连引擎，不用 REST |
| 编辑：`PUT /providers/{id}` + `new_id`；预填 key 仅当 `hasApiKey && !managed` | `removeProvider(id)` + `setConfig(...)`，改名迁移逻辑照抄 kap PUT | 见 §4 |
| 托管只读（`id === 'managed:kimi-code' && type === 'kimi'` 时字段禁用） | 同判据 | 从 config 的 `oauth` 字段判断更稳（design 采用：`provider.oauth !== undefined`） |

## 2. 文件与模块

**新增（apps 内共享，避免动已发布的 SDK 表面）**

- `apps/kimi-code/src/utils/provider-form.ts` — 纯函数模块（无 TUI/pi-tui 依赖）：
  ```ts
  export const PROVIDER_WIRE_TYPES = ['kimi','openai','openai_responses','anthropic','google-genai','vertexai'] as const;
  export type ProviderWireType = (typeof PROVIDER_WIRE_TYPES)[number];
  export interface ProviderFormModelRow { model: string; maxContextSize: string; displayName: string }
  export interface ProviderFormValue { id: string; type: ProviderWireType; apiKey: string; baseUrl: string; models: ProviderFormModelRow[] }
  export type ProviderFormError = 'idRequired'|'idInvalid'|'apiKeyRequired'|'baseUrlRequired'|'modelRequired'|'contextSizeRequired'|'contextSizeInvalid'|'modelDuplicate';
  export function validateProviderForm(value: ProviderFormValue, opts: { requireApiKey: boolean }): ProviderFormError | null;
  export function normalizeBaseUrlForType(baseUrl: string, type: ProviderWireType): string;
  export function defaultModelRow(): ProviderFormModelRow;
  export function buildAddPatch(value: ProviderFormValue): KimiConfigPatch;                    // providers + models（合并语义）
  export function planEditWrite(current: KimiConfig, value: ProviderFormValue, previousId: string,
                                opts?: { clearApiKey?: boolean }):
    { removeProviderId: string; patch: KimiConfigPatch;
      collisions: string[]; providerIdTaken: boolean };        // 改名/删行/默认指针迁移/冲突探测
  ```
- `apps/kimi-code/src/tui/components/dialogs/provider-form-dialog.ts` — 表单组件（add / edit 两种 mode）。

**改动**

- `apps/kimi-code/src/tui/commands/provider.ts` — 添加子菜单加第三项 `'manual'`；新增 `handleManualProviderAdd`；列表行新增编辑入口。
- `apps/kimi-code/src/tui/components/dialogs/provider-manager.ts` — 行级操作增加 `E`（编辑），`onEdit` 回调；键位提示更新。
- `apps/kimi-code/src/cli/sub/provider.ts` — 新增 `create` / `update` 子命令与 handler；`cli/commands.ts` 注册。
- `apps/kimi-code/src/i18n/locales/{en,zh}.ts` — 新增键（§6）。
- 删除 `apps/kimi-web/**`（§7）。

## 3. TUI 表单组件设计

- 结构 mirror `CustomRegistryImportDialogComponent`（`Container implements Focusable`、`handleInput`、`render(width)`、`onDone(result)`），保持边框/页脚/主题一致。
- **字段焦点顺序**：`id → type → apiKey → baseUrl → models → [Save]`。`Tab`/`Shift-Tab`/`↑`/`↓` 移动；`Enter` 前进（在 models 区表示「编辑当前行」，在最后一项表示提交）；`Esc` / `Ctrl-C` 取消。
- **type 字段**不进输入框：`←/→` 或 `Space` 在 6 值间循环（Dialog 自绘，不复用 ChoicePicker）。
- **models 区**：渲染为行摘要列表（`▸ 1. kimi-k3   1048576`），键位：
  - `↑/↓` 选择行；`A` 追加行（用 `defaultModelRow()` 并进入行编辑）；`D` 删除选中行（**最后一行不可删**，与官方 `disabled:n.length<=1` 一致）；
  - `E` 或 `Enter` 进入行编辑子模式：字段 `Model ID → Context → Display name`，`Enter` 在最后一个字段返回列表并写回；`Esc` 放弃本行修改返回列表。
  - 行编辑子模式仍在同一组件内（`mode: 'list' | 'row'` 两个内部状态），避免嵌套对话框。
- **apiKey 输入**：默认掩码为 `•`（复用 `custom-registry-import.ts` 的 `maskInputLine` 思路），`Ctrl-R` 切换明文（官方是眼睛按钮；TUI 用键位）。
- **错误显示**：`hint` 行显示 `tui.dialogs.providerForm.error.<code>`，与 `custom-registry-import.ts` 的 `hint` 同机制；提交失败时保留全部输入。
- **托管只读**：`mode==='edit' && provider.oauth !== undefined` → 全部字段禁用，页脚显示 `tui.dialogs.providerForm.managedReadonly`。

## 4. 写盘语义（关键设计）

- **添加**：`harness.setConfig(buildAddPatch(value))`
  ```
  providers: { [id]: { type, baseUrl?, apiKey? } }
  models:    { [`${id}/${model}`]: { provider: id, model, maxContextSize, displayName?,
                                     capabilities: ['tool_use','thinking'], adaptiveThinking: true } }
  ```
  不写 `thinking`、不写 `defaultModel`（与官方 add 一致）；`baseUrl`/`apiKey` 为空串时省略键。
- **编辑**：`await harness.removeProvider(previousId)` → `await harness.setConfig(planEditWrite(...).patch)`
  - `removeProvider` 在 v2 是**一次原子多段替换**，会级联删掉该 provider 的 `models` 别名与悬空的 `defaultModel`/`defaultProvider`（`packages/node-sdk/src/sdk-rpc-client-v2.ts:800-824` 的 `planProviderRemoval`）；这正是「删行/改名不留残渣」所需。
  - `planEditWrite` 用 `harness.getConfig()` 的结果计算下一状态：新 `providers[newId]`、按行重建 `${newId}/${model}` 别名（每行沿用旧别名上未被表单编辑的字段：`maxOutputSize/capabilities/supportEfforts/adaptiveThinking/protocol/baseUrl/overrides` 等），并在 `previousDefaultModel` 属于该 provider 且新别名存在时把 `defaultModel` 指向 `${newId}/${model}`；`defaultProvider === previousId` 时迁移为 `newId`。
  - **清空 API key 的磁盘语义**：`planEditWrite(..., { clearApiKey: true })` 写 `apiKey: ''`，落盘是 `api_key = ""`——键不会消失（引擎 `providersToToml` 只在值为 `undefined` 时删凭据键），运行期按「无凭据」处理（引擎 `nonEmpty`、`packages/oauth` 的 `reconcileProviderCredentialUpdate`）。不要改写成 `undefined`：跨序列化会丢键，而 `deepMerge` 反而保留旧密钥，等于清不掉。
  - **写盘前的冲突探测**：`planEditWrite` 同时返回 `collisions`（本 patch 将写入、但当前属于其它 provider 的别名键）与 `providerIdTaken`（`newId` 已是另一个 provider 的 id）；调用方（TUI / CLI）在二者任一非空 / 为 true 时拒绝写盘并报错。
  - **为什么用「先删后写」而不是一次 `replaceConfigSections`**：与仓库既有 catalog 导入路径同构（`node-sdk/src/catalog.ts:138-142` 的注释明确要求删除键时必须先 `removeProvider`），且在 v1 harness 上同样可用；代价是两次写之间有一个窗口（失败时用户看到错误、供应商处于「已删除」状态，可重新添加）。备选见 §8。
- **CLI 与 TUI 共用** `validateProviderForm` / `buildAddPatch` / `planEditWrite`，CLI 只负责参数解析、交互确认与输出。

## 5. 命令流程

**TUI `/provider`**

1. `promptProviderAddSource`（`provider.ts:131-150`）`options` 增加 `{ value: 'manual', label: t('tui.statusMessages.manualProviderOption') }`；返回值联合类型加 `'manual'`。
2. 新增 `handleManualProviderAdd(host)`：挂载 `ProviderFormDialogComponent({ mode: 'add' })` → 校验通过后 `harness.setConfig(...)` → 成功：`showStatus(t('tui.commands.provider.added'))` + `authFlow.refreshConfigAfterLogin()` → 进入既有 `TabbedModelSelectorComponent` 步骤（与目录导入同一条 `provider.ts:277-295` 路径，用于选默认模型）。
3. 列表行编辑：`provider-manager.ts` 的 `handleInput` 增加 `E`；`buildRows` 保留 provider 行对象；回调 `onEdit(providerId)` → `handleProviderEdit(host)`：`harness.getConfig()` 预填（api_key 直读明文供输入框掩码展示）→ 表单（mode: 'edit'）→ `removeProvider + setConfig` → 刷新 + 重挂列表（沿用 `provider.ts:125-129` 的重新 new+mount 模式）。

**CLI**

- `kimi provider create --id <id> --type <wire> --api-key <k> [--base-url <u>] [--model <m> [--max-context-size <n>] [--display-name <d>]] [--default] [--json]`
  - 未给 `--model` 时报错（`models` 必须 ≥1，与契约一致）；`--max-context-size` 缺省时要求必须显式给出（不做隐式 131072，避免写死错误预算），错误文案给出提示。
- `kimi provider update <id> [--new-id <id>] [--type ...] [--api-key ...] [--base-url ...] [--model ...] [--max-context-size ...] [--display-name ...] [--default] [--json]`
  - 未提供的字段保持原值；`models` 未提供时保留原行集合（仅改其它字段）。
- 两个 handler 复用 `utils/provider-form.ts`；输出沿用 `cli/sub/provider.ts:599-616` 的脱敏风格。

## 6. i18n（en + zh 同步）

新增（键名对齐现有风格）：
- `tui.dialogs.providerForm.*`：`titleAdd / titleEdit / idLabel / typeLabel / apiKeyLabel / baseUrlLabel / modelsLabel / modelRowLabel / modelIdLabel / contextLabel / displayNameLabel / addRow / removeRow / save / footerList / footerRow / footerSave / apiKeyManaged / managedReadonly / error.idRequired / error.idInvalid / error.apiKeyRequired / error.baseUrlRequired / error.modelRequired / error.contextSizeRequired / error.contextSizeInvalid`
- `tui.statusMessages.*`：`manualProviderOption`（添加子菜单第三项）、`providerFormAdded`、`providerFormUpdated`、`providerFormFailed`、`providerFormNoModels`
- `cli.commandDescriptions.providerCreate` / `providerUpdate`、`cli.optionDescriptions.providerCreate*`（`--type/--api-key/--base-url/--model/--max-context-size/--display-name/--default/--new-id`）

门禁：`check-locale-keys` / `check-locale-placeholders` / `check:t-coverage` / `check:no-hardcoded-prose`（基线不得新增条目）。

## 7. 删除 `apps/kimi-web`（引用清单，逐条可验）

**随目录删除**：`apps/kimi-web/**`（334 跟踪文件，含自身的 `DEVELOP.md`、`bun.lock`）；本地未跟踪的 `apps/kimi-web/node_modules`（约 600MB）由执行者清理。

**必须同步修改**

| 文件 | 位置 | 动作 |
|---|---|---|
| `package.json` | `:10` `"!apps/kimi-web"`；`:40` typecheck 末尾的 `(cd apps/kimi-web && bun run typecheck)` | 删除排除项与 typecheck 片段 |
| `.github/workflows/ci.yml` | `:105-125+` `test-kimi-web` job（含 cache key `hashFiles('apps/kimi-web/bun.lock')`、install、typecheck、tests、style） | 删除整个 job |
| `DEVELOP.md` | `:51` vite 行、`:78` apps 列表、`:129-131` Web UI 段、`:347`、`:397-399`、`:411` CI 列表第 5 条、`:535` i18n 归属表、`:620` workspaces 段 | 逐处改写：删除 kimi-web 表述，保留 `dist-web`（预构建产物仍在，属 kimi-code） |
| `CONTRIBUTING.md:65` / `CONTRIBUTING.zh-CN.md:64` | typecheck 覆盖说明中的 “`kimi-web`” 与 “五个 app” 计数 | 同步改为 5 个 app |
| `scripts/check-locale-keys.mjs:53-54` | kimi-web locale 树条目 | 删除该条目 |
| `scripts/check-t-call-coverage.mjs:51-59,75,115` | kimi-web 树与相关注释 | 删除该条目与失效注释 |
| `scripts/check-no-hardcoded-prose.mjs:41` | `'apps/kimi-web/src'` | 删除 |
| `scripts/scan-hardcoded-v2.mjs:65-67,160,276` | kimi-web 模块描述 | 删除该模块条目与专用分支 |
| `tools/review/src/checks/silent_catch.zig:115` | `expect(isSource("apps/kimi-web/src/App.vue"))` | 删除该断言 |
| `tools/review/src/checks/scripts_wiring.zig:22-23,113,125` | 以 kimi-web 为「独立安装」范例的注释与清单项 | 改为仍然成立的范例（`apps/vis` 已在覆盖内），删除 kimi-web 项 |
| `tools/review/src/checks/ci_coverage.zig:263` | `expect(!typecheckCovers(script, "apps/kimi-web"))` | 删除该断言 |
| `tools/review/{silent-catch,text-as-protocol,orphan-exports,scripts-wiring}-baseline.txt` | 含 `apps/kimi-web/...` 的行 | 删除这些行；若文件头注释提到 kimi-web 一并更新 |
| `tools/review/check-catalog-versions.mjs` | 命中需确认（可能是注释） | 按实际内容清理 |

**明确不动（避免误删）**

- `plugins/official/kimi-webbridge/**`、`plugins/marketplace.json` 中的 `kimi-webbridge` 条目、`packages/node-sdk/src/{kimi-harness,sdk-rpc-client-v2}.ts` 与 `test/kimi-harness.test.ts` 里的 `kimi-webbridge`（同名能力插件，非 `apps/kimi-web`）。
- `specs/**`、`reports/**` 里的历史引用（历史记录不改写）。
- `apps/kimi-code/dist-web/**`（官方预编译产物，本次蓝本，保留）。

## 8. 备选方案（ExitSpecMode 选项）

- **A（推荐）**：编辑写盘 = `removeProvider(previousId)` + `setConfig(patch)`。与仓库既有 catalog 路径同构、v1/v2 通用；代价是两次写之间的窗口。
- **B**：编辑写盘优先用 `replaceConfigSections`（v2 单次原子多段替换，`harness.supportsAtomicSectionReplace` 为 false 时回退 A）。写盘原子、语义更干净；代价是多一条能力分支与对应测试。

（已否决的第三方案：让 TUI 调 daemon REST `POST/PUT /providers`。TUI 无 HTTP 客户端，且会把进程内直连改成对本地服务的依赖，收益为零。）

## 9. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 编辑走「先删后写」，进程在两次写之间退出会留下已被删除的供应商 | 两次写连续执行且失败即报错；用户在 `/provider` 列表可见状态并重加。选 B 可消除 |
| 写 `capabilities: ['tool_use','thinking']` 对不支持 thinking 的模型可能造成误解 | 与官方蓝本一致；`thinking` 能力影响的是 UI 选项而非请求（`resolveThinkingEffortForModel` 以模型记录为准）。若实测有问题，退回「只写 `tool_use`」为独立议题 |
| 改名迁移漏改 `[secondary_model]` 里的引用 | 与 kap PUT 行为保持一致（PUT 也不动 secondary pool，见 `docs/en/reference/server-api.md:479` 与实现的已知偏差）；spec 明确不做 |
| 删除 `apps/kimi-web` 触碰 `tools/review` 的 Zig 测试与基线 | T7 的验收要求 `(cd tools/review && zig build test)` 与 9 个 `check:*` 全绿；基线只减不增 |
| i18n 新增键漏配 en 或 zh | `check:locale-keys` + `locale-parity.test.ts` 会失败 |

## 10. 约束（引用，不复制）

- 遵循根 `DEVELOP.md` 与 `apps/kimi-code/DEVELOP.md` 的规则；改动前读最近的 `DEVELOP.md`。
- 不复制本仓库全局规则到本 spec；写代码时按 `DEVELOP.md` 执行（含 changeset 流程与提交规范）。
