- T9 方向确认（用户选择“按上游对齐”）：`llmRequesterService` 保留为 core requester 的适配层，
  内部不再使用旧 human `LlmRequester.generate(config, content, control)`，改为
  `protocolRegistry.request(model, params, execution).with({...}).generate(rest, control)`
  并消费 `LlmRunEvent`/`LlmOutcome`；goal judge、compaction、guardian 等消费方保持调用
  `IAgentLLMRequesterService`。当前已把 agent-core-v2 tsc 错误从 217 降到 56，
  core 测试 164 pass、core tsc 通过；剩余 56 条集中在：
  `llmRequesterService` 的 requester/事件/模型字段（21）、旧 human `ToolCall` 执行签名
  （`human/agent/machine.ts` 5）、PowerShell 旧任务 API（3）、microCompaction 的
  profile/telemetry（2）、catalog/media/gateway 的边角类型（若干）。#4820/#4630/#4831
  仍未标记完成，T10-T14 未执行。
�� retry、taskService 的 `onDidChangeTask`、
    detached 工具释放 lease；TUI subagent store 有 retry 文案。其 `loop/core/*`
    路径已被 #4630 的新结构取代。
  - 阻塞点：`packages/agent-core-v2 && bunx tsc --noEmit` 仍有 126 个错误，
    `bun run build` 在 dts 阶段失败（`packages/core/src/llm/protocol/protocol.ts`
    未生成 dts）。根因是 fork 的中间态同时存在 `packages/core` 与
    `agent-core-v2/src/human/llm` 两套 LLM 契约，以及 fork 独有功能仍绑旧接口：
    llmRequester/model catalog 的 Model/Message 迁移、PowerShell 任务服务的
    registerTask/persistOutput/waitForForegroundRelease、helloWorld 状态与 telemetry、
    LSP 错误域、PDF document_url 内容块、frozen model overrides 等。已把
    human/llm 的 usage/errors/finish-reason 收敛为 core 的 re-export，并迁移了
    tool executor 的旧 hook 消费方（registerHook/registerLegacyStarting），
    错误数从 195 降到 126，但这不是可宣称完成的 Gate。
nix` 补登记 `./packages/core`
  （区间内 core 包已存在但未登记，`check:nix-workspace` 因此转绿）；bun install 已执行。
  `apiSurface.snapshot` 由 Bun runner 改写为 Bun snapshot 格式并记录当前 /api/v1 路由表
  （含 kap.md、interactions、:wait；无 /api/v2），重复运行稳定 2 pass。
  #4891 的 kap-server/src 差异实际为 13 个路径（含 rename 源为 14 个；任务文本写 15，
  已按 `git show --name-only` 的真实路径数记录并在 audit 行的 local 列逐项分类）。
  #5060 因 #4966 文档页已移植，由 NA 改判 ported；台账 remaining 6
  （#4820/#4630/#5019/#5023/#5072/#4831）。

## 2026-11-21 T9/T10 完成记录（2.7.0）

- LLM requester 完整重构：`AgentLLMRequesterService` 不再持有 `ModelRequester`，改为注入
  `IAgentLoopService`，通过 `prepareOperation` 取得 2.7.0 的 core requester，再以
  `generate({content, profile}, {signal, onEvent})` 消费 `llm.streaming.*` / `llm.retrying` /
  `llm.ended`；`AgentLLMRequestFinish` 直接使用 core `AssistantMessage`/`LlmTiming`。
  goal judge、guardian 的公开调用不变；`prepareTurnConfig`/`currentCredentialProvider` 等
  无消费者的旧接口与状态键删除。
- 结构收尾：删除旧 `ModelRequester`/`model-requester-impl`、旧 fullCompaction 生成器、
  旧 human machine/session/tool/persist/tool-select 内核、旧 contextProjector、
  cacheBreakService/cacheObservation、toolSelect schema reminder；PowerShell 改到 2.7.0
  executor 任务模型（`set({task})`/`detach`/`write`），删除 ProcessTask 的旧注册用法。
- PDF 能力保留：core message 增加 `document_url`，Anthropic `document` 块、Google
  `inlineData`、OpenAI `file`、Responses `input_file` 四个 lowering 补齐；新增
  `packages/core/test/llm/document-part.test.ts` 4 例。
- 类型/构建：`packages/core && bunx tsc --noEmit` 0 errors；
  `packages/agent-core-v2 && bunx tsc --noEmit` 0 errors；
  `bun run build` 成功（index.mjs 3.40 MB，index.d.mts 786 KB）。tsconfig 去掉全局
  `paths` 的整包猜测，改用包内 `package.json#imports` 解析；Bun 运行时仍需要
  `tsconfig.json` paths，故增加 `tsconfig.build.json`（清空 paths）专供 tsdown dts。
- 测试：core 168 pass / 18 files；llmRequester 17；state manifest 2；context 37；
  read-media 60；fullCompaction prompt-cache 18；goal 125；taskService 33；
  toolSelect 5；protocolAdapter 22。`check:no-comments` OK（2146 files，0 baseline）。
- 台账：`bun scripts/upstream-ledger.mjs --report` -> total 262, closed=262,
  remaining=0, STATUS: clear；#4820/#4630/#4831 ported，#5019 equivalent，
  #5023/#5072 not-applicable（已写理由与 absent/grep 探针）。
- 未决红项：`test/agent/loop/loop.test.ts` 的 aborted-turn resume 比较仍差一条
  user message；`coreLoopService.test.ts` 的 max-steps 通知用例 30s 超时；
  `taskManager.test.ts` 两个 `toFake`/grace 用例失败（Bun 1.4.4 忽略 toFake）。
  这些不是本轮 requester 代码的编译/构建错误，但按 Gate 不能宣称全绿。

- 构建脚本去 pnpm：`sync-web-dist.mjs`、`build-vis-asset.mjs`、`native/web-assets.mjs`
  改为 `process.execPath`（bun）+ workspace 目录 cwd；`check-web-assets`/`smoke`/
  `native/assets` 的提示改为 `bun run build`/`bun install`。`apps/kimi-code && bun run build`
  通过，`bun run smoke` -> Bundle smoke passed (dist/main.mjs)。构建产生的未跟踪
  `dist-web` 新文件已回收，已跟踪的 pinned bundle 恢复到 HEAD。
- `src/human/package.json` 增加 `"#human/*": "./*.ts"`：human 内部文件使用 `#human/...` 时，
  Bun/rolldown 在 build tsconfig 清空 paths 后仍能解析；否则 CLI/engine build 失败。
- 其余门禁现状：locale keys/placeholders 因工作树预先删除了 `apps/kimi-code/src/i18n`
  而失败；scan:residue、strict-request-bodies、no-hardcoded-prose、boundaries、
  deep-imports 各有既存 findings（非本轮文件）。不把这些报成绿。
- locale 门禁：`apps/vis/web` 与 `apps/vscode/webview-ui` 的 app-local i18n 在 2.7.0
  已不存在，`scripts/check-locale-keys.mjs` 与 `check-locale-placeholders.cjs` 仍枚举旧路径；
  已删除这两个源，`check:locale-keys`/`check:locale-placeholders` 现在通过。

## 2026-11-21 晚 — Bun 原生流水线与三棵 i18n 树回补

- **Bun 原生构建恢复**：2.7.0 导入把 `apps/kimi-code/scripts/native` 整体换回上游 SEA
  （`02-sea-blob.mjs`/`03-inject.mjs`/`build.mjs` + `postject`），而 `build:native:bun`
  脚本仍指向已不存在的 `build-bun.mjs`，即脚本坏死。已把该目录与
  `test/native`、`test/scripts/native` 一并恢复到 HEAD 的 Bun 版本，删除 SEA 三件套，
  从 `devDependencies` 去掉 `postject`（`bun install` 重生成锁文件）。
- **新形态**：`bun build --compile` 不继承 `tsdown.native.config.ts` 的 `neverBundle`。
  2.7.0 起 `canvas`（经 d3 族）与 `cpu-features`（经 ssh2）进入打包图，编译报
  `Could not resolve: ../build/Release/canvas.node`。在 `build-bun.mjs` 补
  `--external canvas --external cpu-features` 后通过；已写入 `.upstream/PLAYBOOK.md`。
- **验证**：`bun run build:native:js` 通过（main.cjs 21.83 MB + 两个 worker）；
  `bun run build:native:bun` 通过（652 modules，产物 221.0 MB）；
  `dist-native/bin/win32-x64/kimi.exe --version` -> `2.7.0`，退出码 0。
- **i18n 回补**：三棵 locale 树被导入整目录删除（CLI 7386 行、vis/web、vscode webview），
  CLI 的 2910 处 `t()`、vis/web 与 vscode webview 的调用全部归零。已恢复
  `apps/kimi-code/src/i18n`、`apps/vis/web/src/i18n`、`apps/vscode/webview-ui/src/i18n`
  （en/zh 键数 2922/396/34，三棵树的 zh 均无缺键）。
- **调用点回灌**：按 HEAD 的 diff 位置与英文值精确匹配重新包 `t()`，跳过模板三元、
  比较位、对象键与 `case`。CLI 回灌 1171 处（145+5+44 文件），vis/web 77 处（18 文件）。
  第四遍曾把 `'backgrounded'` 这类 `SubagentPhase` 协议值包成 `t()`，被 `tsc` 抓到并已回退；
  `text-as-protocol` 0 error，确认没有把文案变成比较对象。
- **i18n 验证**：`check:locale-keys` 2922 keys match、`check:locale-placeholders` OK；
  `check:t-coverage` 的 kimi-code 段 1049 unique keys 全命中，卡在
  `apps/vis/web/src/i18n/locales/en.ts` 缺失——恢复该树后该步应可继续。
  编译产物 `--help` 在英文与 `KIMI_LANG=zh-CN` 下分别输出英文/中文选项说明。
  `check:no-hardcoded-prose` 违规文件 203 -> 160。
- **仍未完成**：160 个文件超 prose ledger（CLI 134、vis/web 16、vscode webview 8、
  vscode src 2），这些是 2.7.0 新增或改写后无对应 key 的文案，需要逐条建 key 并补中文；
  CLI `tsc` 余 7 条为导入既存（`message-replay.ts` 结构性、`test/setup.ts` vitest 类型、
  kap-server 2 条），非本轮 i18n 改动引入。
- **工具限制**：本机无 `zig`，`tools/review/zig-out/bin/review.exe` 是旧二进制；它对
  `apps/desktop/src/{main,preload,renderer,shared}` 报的 6 条 `bun-native` 与源码里的
  `NON_BUN_PATHS` 相悖，属旧二进制误报，未按其输出改基线。基线只做了删除失效条目以外
  的判断前先核对源码。
- 本轮未提交、未推送；工作区仍含前序导入的 3000+ 文件改动，按批次提交前需先分类。

### 运行时资产层（同一轮补记）

- 导入不只换掉构建脚本，也把运行时资产解析换成了 SEA 形态：`native-assets.ts` 里
  `getSeaAssetSource()` 通过 `nodeRequire('node:sea')` 取资产，而 `bun build --compile`
  的资产由 `bun-entry.ts` → `bun-assets.setup.ts` 写进 `globalThis.__KIMI_BUN_ASSETS__`。
  只修构建不修运行时，二进制一旦读资产（`kimi vis`、minidb/search worker、原生 helper）就落空。
- 已恢复 `src/native/bun-assets.ts`，把 `getSeaAssetSource` 换成
  `getEmbeddedAssetSource()`（返回 `getBunEmbeddedAssetSource()`），并删除
  `NodeSeaModule`/`loadSeaModule`/`createRequire` 这套 SEA 装载；`minidb-worker.ts`、
  `search-worker.ts`、`web-assets.ts` 三处消费者同步改名。
- 顺带修正缓存键：`ensureNativeAssetTree` 用**校验后** manifest 计算缓存根（2.7.0 用原始
  manifest，与 HEAD 的测试契约不符）。`test/native/native-assets.test.ts` 由
  9 pass / 1 fail 转 10 pass。
- 验证：`test/native` 26 pass、`test/scripts/native` 49 pass、`bunx tsc --noEmit` 余 5 条
  均为既存错误；重编产物 221.0 MB，`--version` 为 `2.7.0`，`vis --help` 正常。
- `asset-utils.ts` 在 HEAD 也无消费者，未恢复；`smoke-gate.ts` 的消费者 `cli/main.ts`
  仍是 2.7.0 版本，未接线，留作后续批次。

## 2026-11-21 夜 — i18n 整体补和（第一轮）

- **工具**：新增 `.tmp/i18n-prose.mjs`（与 `check-no-hardcoded-prose.mjs` 同口径的提取器，
  含模板 `${...}` 展开）、`.tmp/i18n-locale.mjs`（按点号嵌套插入键，保持缩进与尾逗号）、
  `.tmp/i18n-apply-plan.mjs`（按 span 替换并从模板自动推导 `{{pN}}` 消息）、
  `.tmp/i18n-automap.mjs`（消息形状匹配既有键，自动取参数名）、`.tmp/i18n-author2.mjs`
  （按消息文本匹配作者行，避免行号漂移）。提取器与检查器在同一文件上计数一致（32/32）。
- **自动复用**：269 处直接映射到既有键（参数名沿用 `{{source}}`/`{{label}}`/`{{minutes}}` 等），
  覆盖 77 个文件，零翻译成本。
- **作者翻译**：`tui.commands.prompts`（19 处反馈/SSH 面板文案）、`tui.commands.config`（状态提示，
  复用既有 `planModeAlreadyOn/Off`、`permissionModeUnchanged`）、`tui.dialogs.sessionPicker`
  （复用 `minutesAgo/hoursAgo/daysAgo/footerShowing`）、`tui.dialogs.tasksBrowser`
  （复用 `relativeTime*`，新增面板标题/空态/预览标题）。
- **结果**：超账本文案文件 203 → **114**，缺口字面量 669 → **319**；locale 键 2922 → **2984**
  （en/zh 一致、占位符一致）；CLI `t()` 调用点 1152 → **1519**。
  `check:locale-keys`/`placeholders`/`t-coverage` 全绿，`text-as-protocol` 0 error。
- **分类判断（未翻译项）**：剩余 319 条含三类不应翻译的内容，必须逐条判定后再动：
  C2 提示词（如 `## Approved Plan:`）、C4 日志/遥测事件名（如 `manual upgrade check failed`、
  `background update ...`）、以及布局相关的前导空格文案（复用无空格的既有键会丢缩进）。
  按 `CONVENTIONS.md` 的分类表，C2/C4 保持英文并作为已复核债务留在账本，不套 `t()`。
- **验证**：`apps/kimi-code` typecheck 仅余 5 条导入既存错误（`message-replay` 结构性、
  `test/setup.ts` vitest 类型、kap-server 2 条）；`tasks-browser.test.ts` 48 pass；
  `mermaid-preferences.test.ts` 4 pass。

### 新发现：测试层仍是 vitest 形态（阻塞 T13）

- `1604` 个测试文件 `from 'vitest'`，`464` 个文件用 `vi.fn/spyOn/useFakeTimers`，`65` 个用
  `vi.mock(..., importOriginal)`；根 `package.json` 也被导入带回了 `vitest` 4.1.4 依赖。
- 实测 `bun test --isolate test/cli/acp.test.ts`：`vi.spyOn` 返回 undefined，
  `exitSpy.mockRestore()` 直接抛错，7 个用例全 fail；`test/tui/commands/desktop.test.ts`
  因 `importOriginal` 不是函数在收集阶段就报错。
- 结论：fork 的 `bun:test` 迁移被整体回退，当前测试套件在 `bun test` 下不可用，
  T13 全量 Gate 无法执行。这比剩余的 i18n 缺口更阻塞，应作为下一批主线。

## 2026-11-22 凌晨 — vitest → bun:test 迁移（第一轮）

### 先按用户要求核对 Bun 源码（`D:/kimi/bun`），不靠试

- `src/runtime/test_runner/jest.rs` 的 `create_mock_objects`：`bun:test` 的 `vi` 只有
  `fn / mock(=mock.module) / spyOn / restoreAllMocks / resetAllMocks / clearAllMocks`
  加上 `fake_timers::put_timers_fns` 注入的 9 个方法；**没有** `waitFor`、`stubGlobal`、
  `stubEnv`、`hoisted`、`mocked`、`resetModules`、`importActual`、`doMock`、`doUnmock`。
- `src/jsc/bindings/BunPlugin.cpp` 的 `JSMock__jsModuleMock`：工厂**不带参数**（所以
  `importOriginal` 必须改写）；工厂**可以返回 Promise**；模块已加载时**就地 patch 导出**
  （`overrideLoadedModuleExports`），未加载时登记为虚拟模块供后续 import。
- `src/runtime/test_runner/timers/FakeTimers.rs` 的 `FAKE_TIMERS_FNS`：只有
  `useFakeTimers/useRealTimers/advanceTimersToNextTimer/advanceTimersByTime/runOnlyPendingTimers/runAllTimers/getTimerCount/clearAllTimers/isFakeTimers`，
  **缺 `advanceTimersByTimeAsync`**（仓库用了 950 次）。
- `expect/toMatchObject.rs` 走 `jest_deep_match`；`toEqual` 走 `jest_deep_equals`
  （**不**做 Jest 的“忽略 undefined 字段”，仓库有 `retainedDefault: undefined` 这类断言）。

### 已落地

- 新增 `packages/testkit/src/vitest.ts`（导出为 `@moonshot-ai/testkit/vitest`）：转发 `bun:test`
  并补 `hoisted`(立即求值)、`mocked`(恒等)、`importActual`(内置模块走 `createRequire` 避免自等死锁)、
  `requireActual`(同步)、`stubGlobal/stubEnv/unstubAll*`(记录并还原描述符/环境变量)、
  `waitFor`(轮询)、`advanceTimersByTimeAsync`、`resetModules`(空实现)、`doMock`/`doUnmock`，
  并包装 `expect` 让 `toEqual`/`toHaveBeenCalledWith` 忽略 undefined 字段（保留 `.not`/`.resolves`）。
- 改写 **1170** 个测试文件 `from 'vitest'` → `@moonshot-ai/testkit/vitest`（packages/*、apps/kimi-code、
  apps/vis），并给 18 个包补 `@moonshot-ai/testkit: workspace:*`。
- `importOriginal` 工厂改写 **62 处**（改为 `() =>` + `import('P')`/`requireActual`）；
  异步工厂改同步 **28 处**，避免“工厂里 await import 自己”的死锁。
- `packages/testkit` typecheck 通过。

### 试点结果与失败分类

- `packages/oauth`：18/21 通过。两条失败是**测试与实现本身不符**，不是框架差异：
  `expect(call[1].signal).toBe(controller.signal)`（实现用 `AbortSignal.any` 必然产生新对象；
  HEAD 的同名用例断言的是 aborted 状态跟随）；capabilities 数组顺序与实现不一致。
- `packages/telemetry`、`packages/tree-sitter-bash`、`apps/vis/server` 各 1 个文件失败；
  `packages/klient` 132 个用例后 pooled 运行失败且无法归因（需 `--per-file` 复跑）。
- 待分类的典型差异：`toMatchObject` 的 undefined 字段、`vi.fn` 的 `mockRejectedValue` 语义、
  以及上游 2.7.0 自带的测试/实现不一致。

### 未迁移与阻塞

- `apps/desktop`（435 个文件，Electron/主进程 mock）、`apps/vscode`（11 个，扩展宿主）
  仍用 `vitest`；4 个 `*.bench.ts` 依赖 vitest 的 `bench`（`bun test` 不执行，暂留）。
- 因此根 `vitest@4.1.4` 依赖与 29 份 `vitest.config.ts` 暂时不能删。
- 结论：迁移骨架已通，但“全绿”还差逐包 triage；当前不能宣称 T13 可执行。

### 兼容层第二轮加固（同一夜）

- **类型**：`Mock<T> = Bun.Mock<T> & T` 且 `vi.fn<T>(impl?: (…args: Parameters<T>) => ReturnType<T>)`，
  修掉 `vi.fn<typeof fetch>(() => …)` 的 TS2741（`typeof fetch` 需要 `preconnect`）；
  `expect` 改为宽松签名并显式声明 `any/anything/arrayContaining/objectContaining/stringContaining/stringMatching/closeTo`
  等静态匹配器，规避 `noPropertyAccessFromIndexSignature`；`requireActual` 返回 `any`，避免展开未知类型。
- **语义**：`expect(value, message)` 现在会把自定义消息附加到失败信息；`advanceTimersByTimeAsync`
  改为 1ms 步进并在每步后让出微任务（队列为空时一次性跳到目标），接近 vitest 的“按时间顺序执行并 await”语义。
- **验证**：`packages/testkit` 与 `packages/oauth` typecheck 均 0 error。
- **新发现的硬限制**：在测试体内（模块早已加载）对 `node:os` 这类**内置模块**调用
  `mock.module`/`doMock`，Bun 的就地 patch 不改变已导入模块里的解构绑定：`oauth/identity`
  的 4 个用例仍读到真实的 `hostname/type/release`。同一文件里若 mock 建在模块顶层则生效
  （探针验证过），差别在“mock 时机晚于消费者导入”。这类用例只能在测试侧改造（改用注入或
  顶层 mock），无法靠兼容层消除。

### 跨包抽样（同夜）

| 包 | 结果 |
|---|---|
| `packages/product` | **275 pass / 0 fail**（9 文件，24.3s）✅ |
| `packages/oauth` | 18 pass / 3 fail（`custom-registry` 的 AbortSignal 断言、`refreshProviderModels` 的 capabilities 顺序、`identity` 的内置模块 mock 时机） |
| `packages/acp-server` | 18 tests，2 文件失败（`e2e-turn`、`lifecycle`） |
| `packages/session-import` | 4 文件失败；`conversion` 用运行器参数复跑为 37 pass / 2 fail，两条都是图片/符号链接相关（Windows 权限敏感） |
| `packages/telemetry` / `tree-sitter-bash` / `apps/vis/server` | 各 1 文件失败 |
| `packages/klient` | 132 用例后 pooled 无法归因，需 `--per-file` |

- 运行器 `run-package-tests.mjs` 本来就以 `--isolate --max-concurrency=1` 逐文件起进程，
  所以失败不是跨文件 mock 串味；单文件复跑可稳定区分“真失败”和“池化抖动”。
- 结论：迁移骨架可用（已有一个包全绿），剩余失败需按包 triage；`vitest` 依赖暂时保留。

### 包级 triage（2026-11-22 凌晨续）

- **`packages/oauth`**：`custom-registry` 38/38 全绿。原来那条
  `expect(call[1].signal).toBe(controller.signal)` 与实现的 `AbortSignal.any([...])` 必然冲突，
  按 HEAD 的正确语义改为“转发信号的 aborted 状态跟随 controller”。
  `refreshProviderModels` 4 处 `capabilities` 断言改为顺序无关比较（实现里
  `model.capabilities.toSorted()` 且注释写明顺序无语义），20/21 通过；最后 1 条是上游
  实现/测试不一致——用例名说“返回空模型时跳过刷新”，断言 `failed` 为空，而实现确实往
  `failed` 里推了一条 `provider returned no models`，保留原断言不掩盖。
  `identity` 14/17，剩余 3 条是内置模块 mock 时机问题（见下）。
- **`packages/acp-server`**：2 条失败均与迁移无关——一条断言 Windows 原生分隔符
  （实际给的是 POSIX 斜杠），一条 `session/delete` 后 `session/list` 仍含该会话（删除传播时序）。
- **`packages/session-import`**：`conversion` 37/39，失败两条为图片/符号链接（Windows 权限敏感）。
- **`packages/product`**：275/275 全绿。

### 内置模块 mock 的边界（复现记录）

- 成立的条件：测试文件**不**静态导入同一个内置模块，且消费者在测试文件自己的导入图里。
  在 `packages/oauth/test` 内用同形探针（`vi.mock('node:os')` + 相对消费者）验证通过。
- `identity.test.ts` 即使改成“顶层 `vi.mock` + `globalThis` 可变状态 + 去掉静态 `node:os` 导入”
  仍读到真实 `hostname/type`（工厂确认已执行），故回退为上游 `vi.doMock` 原写法并记为已知限制；
  该文件 3 条用例需要测试侧改成依赖注入才能过。

### 类型层收敛（2026-11-22 凌晨续二）

兼容层继续补齐 vitest 的调用形态，`packages/testkit` 自身 typecheck 恒为 0：

- `it/test/describe/beforeAll/afterAll/beforeEach/afterEach` 统一包一层，接受 vitest 的第三个
  `timeout` 参数（运行时丢弃）；`runIf`/`skipIf`/`each` 在类型与运行时都可用。
- `expect.poll`（轮询重试）、`expect.unreachable(message)`、`expect(value, message)` 自定义消息；
- `onTestFailed`（用 expect 失败标记 + `onTestFinished` 近似实现）、`TestContext`、
  `assert`（`node:assert` 的 `ok`，带 `asserts` 类型守卫）；
- `spyOn` 支持 `(obj, key, 'get' | 'set')` 三参形态，返回 `CompatMock<F>`，`mockImplementation`
  允许 `(…args: Parameters<F>) => ReturnType<F>`（不再要求 `typeof fetch` 带 `preconnect`）；
- `Mock<T> = Bun.Mock<T> & T`、`vi.mocked<T>(v): Mock<T>`；
- 清掉测试里 25 处匹配器类型参数（`toEqual<T>` / `objectContaining<T>`），修正
  `vi.doMock(import('X'))` 与 `async (importActual) => …` 两种遗漏写法。

各包 typecheck（仅统计 `error TS`）：

| 包 | 错误数 |
|---|---|
| `testkit` / `product` / `acp-server` / `minidb` / `telemetry` / `session-import` / `oauth` | **0** |
| `kap-server` | 2（均为导入既存的产品代码错误） |
| `agent-core-v2` | 9（测试侧调用形态：隐式 any、`fetch` 赋值、`mock.results` 取 `{}`） |
| `apps/kimi-code` | 17（2 条既存 + 15 条测试侧形态） |
| `klient` | 34（全部在 `../core/src`，跨包解析既存问题；`core` 独立 typecheck 为 0） |

- `kap-server` 的整包测试无法在本机执行：会启动 `reg.exe`，被安全策略拦截（非代码问题）。

### 类型归零与一次自伤回归（2026-11-22 凌晨续三）

- **自伤回归**：`it/describe` 一度用 Proxy 包装（为了接受第三个 timeout 参数），
  结果 Bun 的 `.each` 要求 `this` 是 `ScopeFunctions` 实例，直接报
  `Expected this to be instanceof ScopeFunctions`；`product` 从 275/275 掉到全红。
  已改为**不包裹运行时对象**，只就地挂 `runIf`/`skipIf` 并放宽类型，`.each` 恢复。
- 兼容层补：`runOnlyPendingTimersAsync`、`setSystemTime` 收窄为 `(time: number | Date) => void`、
  `fn` 返回 `CompatMock<T>`（`mockImplementation` 接受 `Parameters/ReturnType` 形态）、
  `spyOn` 三参重载返回 `CompatMock`。
- 类型收敛（`error TS` 计数）：

| 包 | 结果 |
|---|---|
| `testkit` / `agent-core-v2` / `product` / `acp-server` / `minidb` / `telemetry` / `session-import` / `oauth` | **0** |
| `apps/kimi-code` | 3（`message-replay.ts` 缺 return、kap-server 2 条，均为导入既存） |
| `kap-server` | 2（同上） |
| `klient` | 34（全在 `../core/src`，`core` 独立 typecheck 为 0，属跨包解析既存） |

- 本轮修掉的测试侧形态：自引用对象导致 `TS7022` 循环推断（3 个 controller 用例 +
  `v2-run-print`）、`it.each` 回调改循环（`options.test.ts`）、`mock.calls` 索引注解、
  `harness as never` 上下文导致 `vi.fn` 推断成 `never`、`testCtx.skip()`（Bun 钩子没有该上下文，
  改为用例内早返回）、`t.onTestFinished`（改模块级 `onTestFinished`）。
- 运行时回归验证：`product` 275/275、`minidb/batch` 5/5、`oauth` 仍为 `custom-registry` 全绿、
  `identity` 3 条与 `refreshProviderModels` 1 条已知失败。

### agent-core-v2 文件级抽样（2026-11-22 凌晨续四）

抽样（逐文件 `--isolate`）结果：绝大多数文件全绿，失败集中且可归因。

| 文件 | 结果 | 归因 |
|---|---|---|
| `test/llm-adapter/model/catalog.test.ts` | **52/52** | 修好后见下 |
| `test/agent/contextMemory/context.test.ts` | 37/37 | — |
| `test/agent/changeNotifier/*`、`blob/*`、`command/*` | 全绿 | — |
| `test/agent/media/file-type.test.ts` | 54/55 | `'my file.pdf'` 返回 `document`，用例期望 `unknown`（实现/用例不一致） |
| `test/app/auth/auth.test.ts` | 73/82 | `toHaveBeenCalledWith` 未调用：被测服务拿到的是另一个实例（待查） |
| `test/mcpCore/client-stdio.test.ts`、`connection-manager.test.ts` | 超时 | 挂起，需单独定位（疑似真实进程/端口） |
| `test/os/backends/node-local/host{Fs,Process}Service.test.ts` | 8/13、9/11 | 待查 |

**两个系统性发现**（都已修）：

1. **Bun 转译会省略“只用作类型”的导入**，连带的模块副作用（服务注册）一起丢失。
   `catalog.test.ts` 里 `import { ModelCatalog } from '…#/catalog-service'` 只在
   `as ModelCatalog` 出现，`registerScopedService(...)` 因此从未执行，52 条里 49 条报
   `unknown service 'modelResolver'`。加一条显式 `import '…/catalog-service';` 后恢复。
2. **`expect(promise).rejects.toSatisfy(fn)`**：Bun 的 `rejects` 链不接 jest-extended 的
   `toSatisfy`，会把未拆包的 Promise 当作 received。兼容层新增 `makeAsyncProxy`，自行
   `await` 后调用谓词；顺带修好该分支里方法丢失 `this` 的回归。

### 兼容层完整重写 + 迁移边界定案（2026-11-22 凌晨续五）

按“减少补丁、优先完整重构”的要求，`packages/testkit/src/vitest.ts` **整文件重写**（不再叠补丁）：

- 分成 7 段：模块加载 / 测试注册 / mock 与 spy / 进程与全局 stub / 定时器 /
  失败追踪 / 期望。每段只有一个实现，删掉了此前重复定义和失效分支。
- 关键一致化：
  - `it/describe/hook` 仍是 Bun 原对象，只就地挂 `runIf`/`skipIf` 并放宽类型
    （避免再次踩 `.each` 的 `this`）；
  - 匹配器统一走 `matcherView({subject, mode, negated, label})`，`resolves`/`rejects`
    只对 `toSatisfy` 与剪枝匹配器做特殊处理，其余交给 Bun，且始终以 bag 为 receiver；
  - stub 统一用 `Restorer` 栈（`unstubAllGlobals`/`unstubAllEnvs` 共用）；
  - 定时器的三个 async 变体共用 `flushMicrotasks()`。
- 回归验证：`product` 275/275、`catalog` 52/52、`context` 37/37、`auto-inject` 5/5、
  `capabilityService` 13/13、`oauth` 仍为已知 4 条；`testkit`/`agent-core-v2` typecheck 0，
  `apps/kimi-code` 3（既存）。

### 迁移边界定案（不再追 100% 覆盖）

- `apps/desktop`：**保留 vitest**。40 个测试导入 `.vue`，依赖 Vite 的 Vue SFC 插件链与
  `define`（`__KIMI_CORE_VERSION__`），`bun test` 无法提供，硬迁只会制造假失败。
- `apps/vscode`：**保留 vitest**。其 tsconfig 不含 `bun-types`，引入会与扩展宿主的 Node 类型
  冲突；且该扩展的产品代码本身仍缺 `./messageActions` 等文件（导入既存问题）。
- `apps/vis/{server,web}`：已迁移且 typecheck 0；`vis/web` 42/42 全绿。
- 因此根 `vitest` 依赖与那两个 app 的 `vitest.config.ts` 属于**合理保留**，不是未完成项。

### 系统性修复（2026-11-22 凌晨续六）

按“减少补丁、完整修复”的原则，这一轮修的都是**一类问题的一个根因**：

1. **`expect.poll` 没 await**：兼容层把 `callback()` 的 Promise 直接交给匹配器，导致
   `poll(...).toBe(true)` 永远不成立、只在超时后失败（acp-server 的 logout 用例卡满 10s）。
   已改为 `await callback()` 后再比较。
2. **DOM 环境缺失**：`app-markdown` 没有 `bunfig.toml`，23 条报 `document is not defined`。
   仓库里 `packages/vite-preset/test/dom.mjs` 本来就是完整的 jsdom preload（含 `matchMedia`、
   `:focus-visible`、afterAll 还原），直接复用即可；另给 `app-client`、`app-composer`、
   `app-ui` 补上同一条 preload。
3. **`new URL(...).pathname` 当文件路径**：Windows 下会得到 `/D:/...` 这种带前导斜杠的路径，
   `vis/server` 的 fixture 因此全挂。全仓 4 处统一改成 `fileURLToPath(new URL(...))`。
4. **路径分隔符断言**：被测代码返回 POSIX 风格、断言用原生分隔符。`vis/server` 的
   `import-store` 改用 `join` 构造期望；`acp-server` 的 `lifecycle`/`e2e-turn` 改用 `normalize` 比较。

效果：

| 包 | 修复前 | 修复后 |
|---|---|---|
| `apps/vis/server` | 108 pass / 73 fail | **181 pass / 0 fail** |
| `packages/app-markdown` | 419 pass / 73 fail | **484 pass / 8 fail** |
| `packages/acp-server` | 154+23+15 pass / 8 fail | 157+17 pass / 2 fail（`lifecycle` 的 `session/delete` 时序 + 1 条） |
| `packages/kosong` | — | **1424 pass / 0 fail** |
| `packages/core` | — | **168 pass / 0 fail** |
| `packages/app-ui` | — | **38 pass / 0 fail** |
| `apps/vis/web` | — | **42 pass / 0 fail** |

注：`apps/desktop`（Vue SFC 需 Vite）与 `apps/vscode`（缺 `bun-types`、产品代码不全）仍保留 vitest。

### Bun 事实基线（重要，勿再混淆）

| 对象 | 值 | 性质 |
|---|---|---|
| 安装的 bun | `1.4.4+38afee6c8`（`bun --revision`） | **二进制产物，行为的唯一真相** |
| tag `bun-v1.4.4` | `38afee6c84fc…` | 与二进制同提交的源码标记 |
| `D:/kimi/bun` 工作树 | `5c6d4e24cd18…`（tag 后 5 提交，改动 126 文件） | 开发中的源码，**比二进制新** |

规则：

1. **行为结论只能由安装的二进制实测得出**；源码只用于*解释*，不能推翻实测。
2. 引用源码时必须写 `tag bun-v1.4.4 (38afee6c)` + 行号，并用 `git show bun-v1.4.4:<path>` 只读读取。
3. **不要 `git checkout` 那棵树**：切 tag 得到的是同名提交的源码，不是安装的 bun；
   而且会破坏工作树里 tag 之后的改动。读 tag 用 `git show` 就够了。
4. 已核对（tag 行号）：`vi` 6 成员+9 定时器 `jest.rs:416-456`；`mock.module` 首参必须字符串、
   工厂不带参 `BunPlugin.cpp:731`；定时器 9 个无 async `FakeTimers.rs:493-501`；
   `toEqual`→`jest_deep_equals` `toEqual.rs:24`；`ERR_INVALID_THIS` `ErrorCode.cpp:1857`；
   类型导入消除 `parse_entry.rs:1899`、`p.rs:8883`。
5. 更正：`mock.module` 后 Bun 会 `removeEntry` 失效该 specifier 的 ESM entry，
   所以“完全没有模块缓存重置”是错的说法——是“只对被 mock 的模块自动失效，无全局重置”。

### 对齐 2.7.0：建立基线并补齐（2026-11-22 凌晨续七）

**先纠正一个前提**：2.6.3→2.7.0 的导入不是本轮做的，此前也**未验证过其完整性**。
参照物是本地 tag `@moonshot-ai/kimi-code@2.7.0`（6230 文件）。

文件级差集（工作树 9466 vs tag 6230）：
- **缺失 141**（2.7.0 有、本地无）：`scripts/checks/*` 10、`apps/kimi-code` 5（native 打包脚本、
  tsconfig.dev）、`packages/agent-core-v2` 2（wasm 生成脚本）、`packages/kap-server` 2、
  CI/.husky/元数据若干、release-notes 文档 81。
- **本地独有 3377**：fork 自有（specs/、workbuddy-agents-all/、tools/、packages/kosong、
  bun 版 testkit）+ 本地测试文件。

已补：
1. **60 个缺失文件**从 tag 落盘（剔除 pnpm 系与 release-notes：fork 用 bun、release-notes 是历史文档）。
2. **8 个 tag-only 脚本**补回 package.json，并按 fork 既有风格 pnpm→bun
   （`build:icons`/`dev:desktop-canary`/`dev:desktop:debug`/`dev:kap-server`/`dev:web`/
   `e2e:desktop`/`e2e:desktop:headless`/`package:macos`）。
3. **testkit 导出面对齐 2.7.0**：上游 `./vitest` 指向 `src/vitest/index.ts` 并暴露 fixtures
   （`modelFixtures`/`kapFixtures`/`useNetworkGuard`/`describeModel` …）。此前我把整个入口换成了
   bun 兼容层，等于丢掉了这些 helper。现按上游布局重组：
   `src/vitest/index.ts` = `export * from '../bun/index.js'`（fork 的 bun 版等价物，同名 API）+
   `export * from './api.js'`（bun:test 兼容层）。`product` 275/275 回归通过。
4. **i18n**：`check:t-coverage` 只剩 1 个缺失键 `tui.commands.prompts.sessionFilesHeading`
   （fork 自加的 t() 调用、tag 里也不存在），已补 en/zh 两份。
5. **`check:deep-imports`** 5 条违规（node-sdk 测试深引引擎内部路径）改为根入口导入，通过。
6. **`check:status-surface-i18n`** 指向的 `components/chrome/status-surface` 在 2.7.0/2.7.1/2.7.2
   **都不存在**（fork 自有门禁、路径已过期）；状态组件已并入 `components/messages/status-*`，
   改指向 5 个现有文件，通过。

2.7.0 自带校验现状：

| 校验 | 结果 |
|---|---|
| `check:locale-keys`（607 + 2984 键） | ✅ |
| `check:locale-placeholders` | ✅ |
| `check:t-coverage`（1516 个 t() 键 / 2175 文件） | ✅ |
| `check:catalog-versions` | ✅ |
| `check:service-naming` | ✅ |
| `check:deep-imports` | ✅ |
| `check:status-surface-i18n` | ✅ |
| `check:boundaries` | ❌ 10 条：`agent/tools/read-media-file` 与 `app/llmProtocol/usage` 越界引 human 实现；`human/test/llm/*` 4 条引共享测试助手 |

说明：`check:*` 这批门禁**不在 2.7.0/2.7.1/2.7.2 的 package.json 里**，是 fork 自有工具，
比 2.7.0 更严；因此 `check:boundaries` 的失败属于 fork 自身的分层债，不是 2.7.0 缺口。

### 2.6.3→2.7.0 逐文件核对（2026-11-22 凌晨续八）

方法按要求改为：**先取 2.6.3..2.7.0 变更清单，再逐文件读完整内容核对是否缺失**（不做整体哈希比对）。

- 变更清单：4582 个文件（A 2474 / D 741 / M 1309 / R 56），其中产品源码 2237 个。
- 产品源码中 **1794 个与 2.7.0 逐字节一致**。

390 个不一致的逐文件判定结果：

| 类别 | 数量 | 处理 |
|---|---|---|
| 本地单向领先（fork 增强） | 28 | 保留 |
| **纯缺失**（2.7.0 有、本地无） | **3** | **已补** |
| 双向改动 | 359 | 逐个查缺失符号定义 + 抽查语句级差异 |

**补齐的 4 处真实缺失**：

1. `apps/desktop/src/main/server/server-log.ts` — 缺整块 `createDesktopServerLogger()`/`mirrorToStdout()`
   （本地 16 行、2.7.0 383 行中的新增部分），按 2.7.0 逐字对齐。
2. `packages/agent-core-v2/src/agent/loop/loop.ts` — 缺 `onDidFinishStep` 上的语义注释。
3. `packages/app-client/src/client/useSideChat.ts` — `submitPrompt` 调用缺 `planMode`/`swarmMode` 两个字段。
4. `apps/kimi-code/src/native/native-assets.ts` — **缺 Node SEA（单文件可执行）资产支持**
   （`NodeSeaModule`/`loadSeaModule`/`getSeaAssetSource`）。本地用 bun 内嵌资产替代了它；
   两者正交，已让 `getEmbeddedAssetSource()` = bun 内嵌 ?? SEA 兜底，能力不丢。

**逐符号核对后确认非缺失**（fork 重构/等价实现，符号都存在于别处）：

- `apps/desktop/src/main/browser/*`、`server-auth.ts`、`telemetry.ts`、`embedded-server.ts`：
  实现已迁到 `apps/desktop/src/backend/`（562+410 行）与 `shared/`，`main/` 下是薄封装。
- `packages/oauth/src/open-platform.ts`：拆出 `open-platform-defs.ts`（本地 376 行 vs 2.7.0 241 行）。
- `packages/remote-control/src/remote-control.ts`：`gzipAsync`/`HttpsProxyAgent`/帧上限均已实现，仅写法不同。
- `packages/minidb/src/codec.ts`：`MAGIC`/`SUB_HEADER`/编码逻辑齐全（917 vs 849 行）。
- `packages/vite-preset`：`rawIconPlugin` 在位。

**同时修正的 2.7.0 删除项**：`human/llm/message.ts`、`human/utils/abort.ts`、
`llm-adapter/model/credential-recovery.ts` 均为 2.7.0 已删除的残留（前者被 57 个文件引用 →
已把 `#human/llm/message` 重写为 `#human/message` 后删除；后两者零引用 → 直接删除）。

**附带修复**：testkit 内部 128 处 `#/*` 导入改为相对路径。此前 `#/errors` 会被消费方
（如 agent-core-v2）的 tsconfig `paths` 劫持成对方的 `src/errors.ts`，导致 `TestkitError` 找不到。

验证：`agent-core-v2` typecheck 0、`app-client` 0、`apps/kimi-code` 3（既存）、`product` 275/275。

### 逐文件核对收尾（2026-11-22 凌晨续九）

对 390 个与 2.7.0 不一致的产品源码文件，全部按“逐文件 + 全部代码”核对完毕：

**`apps/kimi-code/src/tui/*`（95 个）**：全部是 **i18n 重构**——2.7.0 内嵌英文文案，本地改为
`t()` 调用（`check:t-coverage` 1516 个键全绿）。定点验证行为均在：
- `config.ts` plan 子命令（clear/on/off + 未知子命令报错）✓
- `registry.ts` goal 子命令（status/pause/resume/cancel/replace/next）✓
- `session-picker.ts` 相对时间（justNow/m/h/d ago）✓
- `question-dialog.ts` 提交确认常量（REVIEW_TITLE/SUBMIT_PROMPT/…）✓
- `kimi-tui.ts` 队列 /compact 跳过（`skippedQueuedCompact`）与回放错误处理 ✓

**其余 227 个（packages/*、apps/vis）**：按符号级逐一核对，2.7.0 定义的每个符号在本地都能找到
（`KNOWN_BLOCKS`/`isChainRecord`、`frame()`/`scanBalanced`、`startWorkerTextBuild`、
`mkdirSync`/`chmodSync`、`fetchImpl`、`formatTokens`/`canCopyUserTurn` 等），行级差异是换行/格式。

**desktop/vis 共 50 个**：符号全部在 `apps/desktop/src/backend/`（972 行）与 `shared/` 中；
`telemetry.ts` 的 `deviceId`/`KIMI_DISABLE_TELEMETRY` 由 `backend/telemetry.ts` 覆盖，
`shutdown` 本地用 `timeoutMs: 5000` 实现（2.7.0 是 `SHUTDOWN_TIMEOUT_MS=3000` + raceTimeout）。

**本轮新增真实缺失：0**。上一轮补齐的 4 处（server-log/logger、loop 注释、
useSideChat 的 planMode/swarmMode、native-assets 的 SEA）仍是全部真实缺口。

结论：2.6.3→2.7.0 的产品代码功能**已完整对齐**；其余差异是 fork 的三类有意改动：
① i18n（文案外置）② bun 化（testkit/脚本/哈希实现）③ 模块重组（desktop→backend、open-platform 拆分）。

### 清既存产品错误 + 补缺失测试基建（2026-11-22 凌晨续十）

**一、既存产品类型错误全部清零**（此前长期挂账的 3 条）：

1. `apps/kimi-code/src/tui/utils/message-replay.ts` — `contentPartToText` 缺 `document_url`
   分支（fork 的文档支持漏了 switch 项）；同时给 `MediaUrlKind` 补 `'document'`。
2. `packages/kap-server/src/services/messages/messageProjection.ts` — 同样缺 `document_url`，
   映射为协议 `file`（有 daemon ref 时）或降级文本。
3. `packages/kap-server/src/error-handler.ts` — `FastifyError`（fastify 的模块增强接口）与
   `Error2` 交叉后属性访问丢失 `details`；改为把收窄结果绑定到显式 `Error2` 类型的变量。
   （已验证：`isError2(err)` 的谓词签名正确、`FastifyError` 可赋给 `Error2`，纯粹是 TS
   在合并接口上的属性解析问题。）

结果：`packages/kap-server` typecheck **0**、`apps/kimi-code` **0**（此前各 2/3 条）。
`product` 275/275 回归通过。（kap-server 测试被 `reg.exe` 黑名单阻塞，未跑。）

**二、`check:boundaries` 10 → 5**

- `read-media-file.ts` 的 `VideoUploadInput` 从实现层 `#human/llm/media/upload` 改到
  vocabulary 层 `#human/media/upload`（同名类型已在 vocabulary 侧）。
- `image-formats.ts`（25 行纯策略数据 + 纯函数）**整体迁到 vocabulary** `human/media/`，
  实现侧 barrel 改为反向重导出（依赖方向才正确）；白名单登记 `media/image-formats`。
- `llm/usage` 登记进 `HUMAN_VOCABULARY`（只含 `TokenUsage` 类型 + `inputTotal` 纯函数，
  与 `llm/message`、`llm/request` 同类，属规则自身定义的 vocabulary）。

**三、补齐 fork 缺失的测试基建**（`test/helpers/` 此前是**空目录**，4 个测试文件无法运行）

新实现：
- `test/helpers/stubs.ts` — `setGlobal`/`restoreGlobals`、`setEnv`/`restoreEnvs`。
- `test/helpers/mockUpstream.ts` — 原生 socket 级上游双：
  `startMockUpstream`（SSE 文本/toolCall、`status`/`incomplete`/`truncate`/`stall` 场景、
  `gapMs` 分片间隔、请求捕获、`releaseStall`）、`startMockFilesApi`（multipart `/v1/files`）。
  按请求路径分发四种 wire：OpenAI chat、OpenAI responses、Anthropic messages、Google streamGenerateContent。

4 个测试文件从“模块缺失、完全无法运行”变为：

| 文件 | 现状 |
|---|---|
| `headers-timeout.test.ts` | 1/1 ✅ |
| `trait.test.ts` | 74/75 |
| `kimiRequestShape.test.ts` | 9/11 |
| `fast-upstream.test.ts` | 26/33 |

**剩余（协议帧细节，已定位）**：
1. `truncate` 场景：`upstream.requests` 捕获为 0（用例期望 1）——需查客户端在连接被
   `destroy` 前是否已发出请求/捕获时机。
2. `openai-responses` 的 toolCall 帧未被正确解析为 Read 调用。
3. Google `:streamGenerateContent` 的响应形态（现为换行分隔 JSON）与客户端解析不匹配。

### 测试基建收尾 + 边界清零（2026-11-22 凌晨续十一）

**`mockUpstream` 协议帧全部对齐，4 个测试文件 120 条全绿：**

| 文件 | 结果 |
|---|---|
| `fast-upstream.test.ts` | **33/33** |
| `headers-timeout.test.ts` | **1/1** |
| `kimiRequestShape.test.ts` | **11/11** |
| `trait.test.ts` | **75/75** |

逐个定位并修掉的帧问题：
1. `baseUrl` 需带 `/v1`（requester 追加 `/chat/completions` 等）；请求捕获改记 **pathname**
   （SDK 会附加 `?alt=sse` 等查询串，而断言按 wire 路由匹配）。
2. `truncate` 场景先 flush 再 `end()+destroy()`——原先立即 `destroy()` 把缓冲帧丢了，
   导致客户端一个 part 都收不到。
3. Google `:streamGenerateContent` 走 `alt=sse`，应答须是 **SSE data 帧**（原为换行 JSON）。
4. Google 的工具调用补 `functionCall` 帧。
5. `openai-responses` 工具调用补 `item_id`：parser 用 `itemId ?? outputIndex` 做流索引，
   只给 `output_index` 会命中 "unknown stream index"（实测确认：`function:Read` 解析成功后
   因此报 `llm.failed.remote`）。另补 `output_item.done` 让 finish 正常触发。
6. multipart 解析重写为按 boundary 切分：`type` 取**文件 part 的 Content-Type 头**
   （不是表单字段），`baseUrl` 同样带 `/v1`。

**`check:boundaries` 10 → 0（全绿，1843 文件）**：

把 `mockUpstream.ts`/`stubs.ts` 移入 `src/human/test/helpers/`（原在 `test/helpers/`），
4 个测试文件改用 `../helpers/...`。human 内核不再引用内核外模块，规则不必放宽。
`check:deep-imports` 同步 OK。

回归：`agent-core-v2` typecheck **0**、`product` **275/275**。

### 清 node-sdk 测试债（2026-11-22 凌晨续十二）

`packages/node-sdk`：**32 条失败 → 5 条**（315 pass）。`session-skills` **13/13 全绿**。

**一、Windows 路径类（最大类，逐条修复）**
测试大量断言直接用 `mkdtemp` 的反斜杠路径与产品输出（POSIX 风格 `/`）比较。处理方式是加
`wirePath()`（`replaceAll('\\','/')`）并对**两侧**归一后比较（幂等）：
- `resume` 用例的 `summary.workDir` / `additionalDirs` / `ISessionContext.cwd`
- `session meta` 的 `cwd`（注意 `environmentCwd` 反而保留平台拼写，按实际分别断言）
- `AGENTS.md` 变更通知里的路径、`attached originals` 用例的 cwd
- `projects.json` 的 `root` 比较（两处）
- `session-skills` 的 `skill.path.includes(...)`——**还叠加 8.3 短名 vs 长名**
  （`ADMINI~1` vs `Administrator`），改用唯一临时后缀匹配

**二、JSON 转义类**：`JSON.stringify(message)` 里断言 `Added directories: <dir>.`
——反斜杠被 JSON 转义，期望侧也要 `JSON.stringify(dir).slice(1, -1)`。

**三、真实产品 bug（已修）**：`fd` 后端的 suggest **不遵守非 git 仓库下的 `.gitignore`**
（`fd` 默认仅在 git 仓库内生效），而 node 回退路径是生效的——两条后端行为不一致。
`fdSuggest.ts` 补 `--no-require-git`，与 node 回退对齐。修复后
`serves suggestFiles through the workspace handler` 通过。

**四、shim 缺口（已补）**：`vi.spyOn(obj, key, 'get')` 原不支持 accessor
（`spyOn(target, prop) does not support accessor properties yet`）。在
`testkit/src/vitest/api.ts` 实现 `spyOnAccessor`（沿原型链找 descriptor、替换为 mock、
`mockRestore` 还原）。

**五、剩余 5 条**：
| 性质 | 条数 | 说明 |
|---|---|---|
| 环境限制 | 4 | 3× `EPERM: symlink`（Windows 无开发者模式/管理员）、1× `EPERM: watch` |
| 真问题 | 1 | `serves suggestFiles from a live remote session working directory`：远程会话的 suggest 返回 `[]`——诊断为**远程会话的 fs 根目录指到了 workDir 而非环境 cwd**（`ISessionWorkdir.fs` 的 roots 选择），涉及 workdirs 路由，需谨慎修改 |

### node-sdk 收尾：远程 suggest 与 symlink 回退（2026-11-22 凌晨续十三）

`packages/node-sdk`：**32 条失败 → 3 条**（319 pass，typecheck 0）。

**远程 suggest 返回空的真因（已修）**：
不是 workdirs 路由错，而是 **path 语义错配**。`FakeEnvironment` 默认 `pathClass: 'posix'`，
而测试的 fake-box 用本地（Windows）`HostFileSystem`/`HostProcessService` 服务真实文件。
于是 `path.resolve('C://Users//...')` 在 POSIX 解析器下把 Windows 绝对路径当**相对**路径，
roots 被拼成 `/kimi/kimi-code/packages/node-sdk/C:/Users/...`（实测确认），自然扫不到文件。
修复：`pathClass: process.platform === 'win32' ? 'win32' : 'posix'`——路径语义必须与
所提供的 fs/process 同平台。

**symlink 可移植性（部分修复）**：
Windows 无开发者模式/管理员时 `symlink` 报 EPERM。加 `linkFileOrCopy`：
文件链接失败退回复制——仅用于语义允许处（`points to the scanned agent directory`
只要求文件可发现）。该用例转绿。

**最终 3 条（环境限制，非代码问题）**：
| 用例 | 阻塞原因 |
|---|---|
| `waits for workspace directories before returning them` | 需 `fs.watch`，沙箱 EPERM |
| `discloses additional directories and instruction sources` | 需**真**文件符号链接（断言 realpath 解析到源文件），复制回退会破坏语义 |
| `reports failed configuration and instruction sources` | 需**故意的坏链接**（missing.md → 不存在），无法用复制替代 |

这三条在有 symlink 权限（Linux / Windows 开发者模式）的环境下应能通过。

### 清 app-markdown / oauth / telemetry（2026-11-22 凌晨续十四）

三包全部清零：**app-markdown 490/490、oauth 389/389、telemetry 85/85**。

**一、`vi.mock` 不提升（最大类，5 条）**
vitest 把 `vi.mock` 提升到静态 import 之前；bun 的 `mock.module` 不会，于是静态导入
拿到真模块、mock 无效。修法是**动态导入**：mock 注册后再 `await import(...)`
（`markdownWorkers.test.ts` 用 `beforeAll`，`Markdown.test.ts` 用顶层 await）。
顺带把 `markstream-vue` 的 mock 工厂改为接收 `importOriginal`，避免工厂内
`import('markstream-vue')` 自递归。

**二、shim 缺口（2 处）**
1. `expect(...)` 的 matcher 代理用 `value.bind(target)`——奇异可调用对象没有 `bind`。
   改用 `Function.prototype.bind.call(value, target)`。
2. `vi.resetModules()` 是空实现（bun 无法清模块注册表）。oauth 的 mock 测试改用
   **带唯一 query 的动态导入**（`../src/identity?fresh=N`）强制重新求值以拾取
   `vi.doMock` 的内置模块。

**三、运行时差异（telemetry）**
`runtime: 'node'` vs 实际 `'bun'`——产品如实上报运行时（`isBunRuntime()`）。
测试改为用同一判定；但注意**两处语义不同**：
- `sink.buildContext` 总是覆盖 `runtime` → 期望用 `CURRENT_RUNTIME`
- payload 组装保留事件自带的 context → 期望仍是 fixture 的 `'node'`
（第一遍我改错了第二处，按 diff 方向纠正。）

**四、bun 的 `process.emit` 语义（2 条 crash 用例）**
监听器抛错不会同步传回 `emit` 调用方：node 传播，bun 路由到 `uncaughtException`
（**异步**），且 bun test 会把 uncaughtException 记为测试失败。
最终方案：**直接调用已安装的 `unhandledRejection` 处理器**（`process.listeners(...).at(-1)`），
抛错同步传回，两平台语义一致，忠实地测到「它是 sole listener 时会重新抛出」。

**五、`min-height: 1lh` 断言（1 条）**
`getComputedStyle` 在测试 DOM 里把 `1lh` 解析成 px（浏览器原样返回）。
改为断言意图：空行与非空行保持同样的、非零的 min-height。

**六、fork 行为 vs 上游测试（1 条）**
`refreshProviderModels` 空模型列表记为 `failed` 是 fork 的**刻意修复**
（`bbd9b850e4: fix: report the providers a model refresh silently skipped`，
上游 2.6.3/2.7.0 均为静默 `continue`）。按 fork 意图更新测试期望（仍跳过刷新、
保留模型，但上报 skip）。注意文件里另有一条 `failed: []` 断言属不同场景
（fetch 根本没调用），第一遍替换落错了位置，已还原并精确改正。

**七、8.3 短名 vs 长名**（上轮遗留）`skill.path` 是 realpath 长名，`mkdtemp` 返回
`ADMINI~1` 短名——用唯一临时后缀匹配。

**剩余**：acp-server 2、migration-legacy 2、tree-sitter-bash 2，以及 node-sdk 的
3 条环境限制（symlink/watch EPERM）。

### ⚠️ 重要教训：机械对齐覆盖了 fork 刻意修复（2026-11-22 续十五）

清 acp-server 的 `session/delete` 后列表仍可见时，深挖出**两层根因**，其中一层是
**我自己早前"对齐 2.7.0"引入的回归**：

**根因一（真产品 bug，已修）**：`SessionIndexService.remove()` 在 read model
`preparing`/禁用时的回退是**空操作**（`() => Promise.resolve()`），而读路径会回退到
legacy 源（`docs` + `storage` 的 meta）。删除被丢在状态窗口里。
→ 新增 `removeLegacy()` + `deleteSessionSummary()`（**双存储都要清**：
`readSessionSummary` 读 `docs`，`statSessionStateFile` 读 `storage`，同一布局存两份）。

**根因二（我引入的回归，已还原）**：`SessionIndexProjector.sharedScanForRead()`。
`7cd64766c8 (#2701)` 的注释明确写着设计不变量：
> "Fallback reads use `sharedScanForRead()`: they join only a scan that is still in
>  flight and otherwise drive a fresh one, **so a read never serves a settled
>  snapshot that could predate a just-created session**."
> "**Fallback reads never reuse a settled scan at all**"

fork 刻意让回退读**不复用已落定的扫描**。而我在早前"对齐 2.7.0"时，把它机械回填成
上游的 `(!slot.settled || Date.now() < slot.reusableUntil)`（30 秒复用窗口），
重新引入了陈旧读。**已恢复 fork 不变量**（`!slot.settled`），并补回注释说明。

**教训**：上游/下游差异不能一律按"fork 有意改动"或"缺失"单向判定。必须：
1. 读 fork 的提交注释/测试，确认行为意图；
2. 出问题时追到根因，而不是改断言或打补丁。
本次 `sharedScanForRead` 若只看 diff 形态，会以为"上游更新所以按上游"，实际是
fork 后来修掉的 bug。

**结果**：acp-server **158/158 全绿**（含 `session/delete` 一致性用例）。

### 根因驱动清零剩余 6 条（2026-11-22 续十六）

按"不为绿而绿、不打补丁掩盖"的要求逐条深挖。**六条全绿，且每条都是根因修复**。

**1. acp-server `session/delete` 后列表仍可见（上节已述两层根因）**
- `remove()` 在 read model `preparing` 窗口回退为空操作 → 补 `removeLegacy()`（**双存储**：docs + storage）
- `sharedScanForRead` 被我早前对齐覆盖 → 还原 fork 不变量（`!slot.settled`）
→ **158/158**

**2. migration-legacy `expect(readFile(...)).resolves.not.toThrow()`**
初看像"断言怪"，实测钉死后发现是 **shim 语义缺口**。用还在跑 vitest 的 klient 包做了 6 组探针，
钉死 vitest 4 的真实契约：
| 用例 | vitest 结果 |
|---|---|
| `expect('hello').not.toThrow()` | **失败**（value 模式要求可调用） |
| `expect(Promise.reject(e)).resolves.not.toThrow()` | **失败**（前缀要求 resolve） |
| `expect(Promise.resolve('v')).resolves.toThrow()` | **失败**（非函数值视为"不抛"） |
| `expect(Promise.resolve(fn抛错)).resolves.toThrow('x')` | 通过 |
| `expect(Promise.resolve(fn抛错)).resolves.not.toThrow()` | **失败** |
| `expect(Promise.reject(e)).rejects.toThrow('boom')` | 通过 |

模型：**`resolves`/`rejects` 前缀要求落定方式**，`toThrow` 再作用于落定值（函数则调用、
非函数视为不抛）。bun 的 `toThrow` 要求可调用且对其他类型报错。
→ 在 shim 实现 `settlementThrowMatcher` 忠实还原（不是绕过断言）。
顺带修掉自己第一版的判断式错误（`pass !== view.negated` 在 pass=true/negated=true 漏判）。
→ **265/265**

**3. tree-sitter-bash wasm 加载失败**
`WASM_PATH` 硬编码 `packages/tree-sitter-bash/node_modules/...`（嵌套布局），
而依赖被提升到 workspace 根。改为 `createRequire(...).resolve('tree-sitter-bash/package.json')`
按 Node 模块解析查找（兼容嵌套与提升两种布局），硬编码路径仅作兜底。
→ wasm 真正加载后跑起与 tree-sitter-bash 的**差分对照**：**867/867**（大幅增加真实覆盖面）

**大盘（9 包复核）**：
| 包 | 结果 |
|---|---|
| acp-server 158 / migration-legacy 265 / tree-sitter-bash 867 | 全绿 |
| telemetry 85 / oauth 389 / app-markdown 490 | 全绿 |
| product 275 / core 168 | 全绿 |
| node-sdk 319/322 | 3 条为 symlink/watch 的 EPERM（环境限制） |
