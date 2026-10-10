# Design — 每项的最终处置与实现方式

每项给出：**证据**（`path:line`）→ **处置**（改 / 不改 + 理由）→ **具体改动** → **验证**。

调查中被推翻的报告判断单列在 §D。

---

## A 组 — 一致性与违反自身规则

### A0 事前基线：两处已存在的红灯（调查新发现，不在原报告内）

这两项在**动工前**就已存在，且都会影响后续任务的验收判据，因此单列。证据均在干净工作树上复现（除 A0.2 本身即工作树改动）。

#### A0.1 `check-no-comments.mjs` 当前是失败状态

**证据**：`bun scripts/check-no-comments.mjs` → **exit 1，154 处违规**，全部位于 `packages/agent-core-v2`（src 78 处 / test 76 处；130 处普通注释 + 24 处 JSDoc）。涉及文件在 HEAD 上均未修改（`git status --porcelain` 为空），说明违规是**已提交**状态。

主要来源文件：
| 文件 | 违规数 |
|---|---|
| `packages/agent-core-v2/test/app/agentProfileCatalog/modelAdaptations.test.ts` | 29 |
| `packages/agent-core-v2/test/features/deepseekAdaptation/deepseekAdaptation.test.ts` | 23 |
| `packages/agent-core-v2/test/app/agentProfileCatalog/profile-shared.test.ts` | 18 |
| `packages/agent-core-v2/src/app/agentProfileCatalog/modelAdaptations.ts` | 15 |
| `packages/agent-core-v2/src/agent/profile/profileService.ts` | 11 |
| `packages/agent-core-v2/src/human/test/llm/thinking.test.ts` | 9 |
| `packages/agent-core-v2/src/human/test/llm/deepseek-reasoning-replay.test.ts` | 9 |
| `packages/agent-core-v2/src/human/test/llm/tokens.test.ts` | 8 |
| `packages/agent-core-v2/src/human/llm/requester/bases/openai/requester.ts` | 7 |
| `packages/agent-core-v2/src/human/llm/modelFamily.ts` | 7 |

**归因**：`git log` 显示这些文件由最近两次提交引入/改动 —— `89f0e8df79 feat(agent-core-v2): document-driven DeepSeek adaptation and reasoning`（同一天）与 `ba08b334a5 refactor(agent-core-v2): drop the unproduced model-adaptation kind`，即最新一轮工作。CI 的 lint job 会跑该脚本，因此这条红灯也会在 CI 上出现。

**处置**：这是本轮**范围外**的既有缺陷（原报告未列出）。确认的用户指令是「逐项落地报告中的待改进事项」，A0.1 不在报告内。可选：(a) 仅记录为发现的阻塞项，本轮不动（推荐，保持范围纪律）；(b) 追加为独立任务一并修复（154 处注释需删除或改写为代码自解释，属实质代码改动，且会触碰 `check-no-comments` 的豁免边界）。

**对其它任务的影响**：T12（C14 的 `stale-artifacts` 核对）与 T16（收尾验证）**不得**把 `bun scripts/check-no-comments.mjs` 退出码 0 作为通过条件；只能要求「违规数不高于 154」或明确标注该脚本为既有红灯。

#### A0.2 工作树中已有未提交的 locale JSON 改动

**证据**：`git status --porcelain` 为：
```
 M apps/kimi-code/src/i18n/locales/en.json
 M apps/kimi-code/src/i18n/locales/zh.json
```
`git diff --stat` 为 2 文件 6 增 2 删，内容是与最新 TUI 提交（`15dc06d8ae fix(tui): show the prompt rewrite working and fold its preview`）配套的新增文案 key（`cli.statusMessages.promptOptimizingLabel`、`tui...diffPreview.wrappedRowsTruncated`）。

**含义**：CI 的 freshness 步骤 `bun scripts/generate-locale-json.cjs && git diff --exit-code -- '**/locales/*.json'`（`ci.yml:188`）**在动工前就是红的**。也就是说这 14 个 JSON 并非「生成后无人使用」这么简单——它们确实由 `generate-locale-json.cjs` 从 `.ts` 生成并被 CI 校验新鲜度，只是**没有任何运行时/构建期读者**。

**处置**：不清理这两处未提交改动（不属于本轮范围，属用户在手工作）。T5 若选方案 A（删除管线），必须先与用户确认这两处 worktree 改动如何处置；若选方案 B，则这两处改动应由 commit 解决而非删除文件。**T5 的所有验收都不得依赖「工作树干净」。**

---

### A1 DEVELOP.md kosong 描述（改）

**证据**
- `DEVELOP.md:182` 称「`agent-core-v2`'s `src/kosong/` keeps the DI/trait composition machinery and imports the shared layers from here (its `contract/` directory is a thin re-export)」。
- `packages/agent-core-v2/src/kosong/` 不存在（`ls` 报 No such file or directory）；`packages/agent-core-v2/src/llm-adapter/` 是实际边界，`src/human/llm/` 是实际 provider 代码。
- `docs/en/llm.md:16` 与 `packages/agent-core-v2/scripts/check-import-boundaries.mjs:141` 均明确 kosong 内核已删除、禁止导入（检查器会直接报错）。

**改动**：重写 `DEVELOP.md:182` 该段。删除 `src/kosong/` 与「thin re-export」两句，改为陈述三分工：provider/request 代码在 `packages/agent-core-v2/src/human/llm/`，v2 兼容边界是 `src/llm-adapter/`，kosong 是**冻结的旧内核**、`agent-core-v2` 不得导入（由 `check-import-boundaries.mjs` 强制）。同时修正 `DEVELOP.md:166` 的目录注释（`kosong/ — LLM / provider abstraction layer` → 标注为冻结旧内核）。

**验证**：`grep -n "src/kosong" DEVELOP.md` 无输出；`grep -rn "kosong" DEVELOP.md` 的每处描述与 `docs/en/llm.md` 一致。

### A2 kosong 定位（改：文档 + 去死引用）

**证据（消费者全清单）**
| 位置 | 性质 |
|---|---|
| `packages/node-sdk/src/{interaction,replay,model-provider,kimi-code-model-provider,types,errors,context,catalog}.ts` + `config/model.ts` | **真实使用**，`tsdown.config.ts:28` 显式 alias 到 `../kosong/src/index.ts` |
| `packages/oauth/src/open-platform.ts:10` | 真实使用（`providers/astron-models`） |
| `apps/vis/server/package.json:32` + `tsdown.config.ts:11` `neverBundle` | **死引用**：`grep -rn kosong apps/vis/server/src` 无输出，`dist/server.mjs:5901` 命中的是 `agent-core-v2/src/app/kosongConfig/errors.ts`（同名巧合，非该依赖） |
| `apps/vscode/tsdown.config.ts:31` alias | 可疑引用：`grep -rn kosong apps/vscode/src` 无输出 |
| `packages/agent-core-v2/src/human/llm/modelFamily.ts:45` | 仅注释提及 |

另外 `docs/en/llm.md:60` 说明双方**各自持有一份** wire 规则，唯一的一致性保障是 `packages/kosong/test/cache-field-parity.test.ts`。

**处置**：kosong 实为「已发布 SDK 的冻结 provider 契约来源」，不是待删除的死包。因此**收敛引用面而非删除**：
1. 删除 `apps/vis/server` 的死依赖（`package.json` 一行 + `tsdown.config.ts` 的 `neverBundle` 条目）。
2. 核实 `apps/vscode` 的 alias 是否为死配置；若其 `src` 无引用则一并删除。
3. 在 `packages/kosong/README.md` 顶部加定位说明：冻结内，只服务已发布 SDK 的 provider 契约；与 `human/llm` 的规则副本由 `cache-field-parity.test.ts` 对齐；主引擎不导入。
4. 不重写 `node-sdk` 到 `human/llm`（见 §E 被否方案）。

**验证**：`cd apps/vis/server && bun run typecheck && bun run build` 通过；`grep -rn kosong apps/vis/server/src` 与 `apps/vscode/src` 均为空。

### A3 notify 常量边界泄漏（改）

**证据**：`apps/kimi-code/src/tui/utils/notify-result.ts:1-4` 从 `@moonshot-ai/agent-core-v2` 值导入 `NOTIFY_USER_DELIVERED_OUTPUT` / `NOTIFY_USER_SUPPRESSED_OUTPUT`（定义在 `packages/agent-core-v2/src/features/notify/tools/notify-user/notify-user.ts:8-9`）。`apps/kimi-code/DEVELOP.md:45` 与根 `DEVELOP.md` 均要求该 app 只经 `@moonshot-ai/kimi-code-sdk` 消费引擎，`cli/v2` 例外——本文件在 `tui/` 下，属违规。消费者只有 3 处，全在本 app 内（`tool-call.ts:1748,2567`、`controllers/notify.ts:233`）。

**方案**：`packages/node-sdk/src/index.ts` 增加两个值的再导出（照 `config-rpc.ts:1` 已有的值导入先例）；`notify-result.ts` 改从 `@moonshot-ai/kimi-code-sdk` 导入，`notifyResultState()` 函数留在 app 内（它是展示层映射，不属于 SDK）。SDK 允许 `alwaysBundle: [/^@moonshot-ai\//]`，值导出可被打包。

**验证**：`grep -rn "agent-core-v2" apps/kimi-code/src/tui` 无输出；`cd apps/kimi-code && bun run typecheck` 通过；`bun run build:packages` 与 SDK 的 `build:dts`（api-extractor）通过。

### A4 tsconfig 过期排除项（改）

**证据**：`tsconfig.json:48` 排除 `"packages/agent-core"`；该目录不存在（只有 `packages/agent-core-v2`）。

**改动**：删除该行。**验证**：`bun run typecheck` 通过；`grep -n "agent-core\"" tsconfig.json` 无输出。

### A5 i18n 收敛（改，但范围比报告小 —— 需在 ExitSpecMode 选择）

**证据（推翻「三套内容重复」）**- `apps/kimi-code/src/i18n/locales/en.ts` 有 2204 个叶子 key，命名空间 `{errorCodes, common, cli, startup, tui}`。
- `packages/i18n/src/locales/en.ts` 有 606 个叶子 key，命名空间 `{errors, plugin, session, background, shell, tools, flags, v2*, svc, serverErrors, toolsV2}`。
- **两者 key 交集为 0** —— 不是重复内容，是两套不相交的命名空间。
- 运行时也已正确分层：`apps/kimi-code/src/i18n/index.ts`（229 行，Rust 引擎）与 `packages/i18n/src/i18n.ts`（181 行，JS 回退）各司其职；`kimi-inspect` / `vis-web` / `vscode/webview-ui` / `kimi-web` 是 27–43 行的薄封装，统一委托 `packages/i18n-shared/src/web.ts`。**没有三重复制**。

**真正的缺陷**：7 个 locale 目录共 14 个**已提交的** `en.json`/`zh.json` **没有任何消费者**——
- 全仓（含 `.rs` / vite / tsdown / flake.nix / `.bat` / `dist-web`）搜索 `from '.../locales/en.json'`、`locales/en.json` 字面量、`include_str` 均无运行时读取；
- Rust 引擎的入口 `packages/kimi-native-tools/src/napi_bindings.rs:54,65,92,108` 接收的是**内存字符串**，由 `apps/kimi-code/src/i18n/index.ts:100` 的 `JSON.stringify(en)` 构造，不读磁盘；
- 唯一提及这 14 个文件的地方是 `tools/review/src/checks/stale_artifacts.zig:193-215`（作为 `containsPath` 的测试夹具字面量）。

**方案 A（推荐）**：删除整条无用管线 —— 14 个 JSON、`scripts/generate-locale-json.cjs`、CI 中 `ci.yml:188` 的 `generate-locale-json.cjs && git diff --exit-code -- '**/locales/*.json'` 步骤、`stale_artifacts.zig` 的 locale `Generator` 条目与 3 个引用这些路径的 zig 测试、`DEVELOP.md:445` 的「Locale JSON must be regenerated」约定与 `DEVELOP.md:207` 的脚本清单行。
**方案 B（保守）**：保留管线，仅在 `DEVELOP.md` 与 `packages/i18n/README.md` 写明「这些 JSON 当前无仓库内消费者，由外部/未来消费者使用，因此保留生成与新鲜度门禁」。
**风险**：仓库内证据充分，但无法排除仓外消费者 —— 这一点交由用户决定。

**验证（方案 A）**：`git ls-files | grep -c 'locales/.*\.json'` = 0；`bun scripts/check-locale-keys.mjs`、`check-locale-placeholders.cjs`、`check-t-call-coverage.mjs` 全绿；`zig build test`（tools/review）通过；`./tools/review/zig-out/bin/review` 仍为 0 error。

---

## B 组 — 重复代码

### B6 + B7（合并为一项：删除死模块）

**证据**
- `packages/agent-core-v2/src/human/compaction/` 的 5 个 `.ts` 全部无外部引用：`CompactError`、`isContextOverflowError`、`isShrinkableSummaryError`、`createCompactionController`、`CompactionEvent`、`buildCompactionSeed`、`compactionContinuationMessage` 计数均为 **0**；全仓 `grep -rn "human/compaction"` 命中 **0** 处。
- 仅有的「消费者」是 `src/human/index.ts:76-79`（一个没有任何导入者的 barrel）与 `src/human/test/compaction/controller.test.ts`（该测试**会被运行**：`vitest.config.ts:6` 的 `include` 含 `src/human/test/**/*.test.ts`）。
- 两个 `.md` 均为逐字节重复：`compaction-summary-prefix.md` md5 `1dfade51…`、`compaction-instruction.md` md5 `f285482c…`，在 `agent/fullCompaction/` 与 `human/compaction/` 各一份。
- 该模块的职责已被 `human/session/machine.ts`、`human/persist/v2/fold.ts`（`fold.ts:198` 连省略提示句都与 `shape.ts` 逐字相同）、`agent/fullCompaction` 承接 —— 是一次重构后的遗留孤儿（`git log` 显示最近三次改动均为 `agent-core-v2` 的 loop/wire 重构）。
- 附带隐患：`controller.ts:6-7`、`machine.ts:17-18` 用 `#/session/machine` / `#/session/stores`，在 `tsconfig.json` 的双重映射 `"#/*": ["./src/*.ts", "./src/human/*.ts"]` 下实际解析到 `src/human/session/*` —— 同一 specifier 两种含义。

**处置**：删除 `src/human/compaction/`（7 个文件）、`src/human/index.ts:76-79` 四行、`src/human/test/compaction/controller.test.ts`。删完后 `compaction-summary-prefix.md` 与 `compaction-instruction.md` 各只剩 `agent/fullCompaction/` 一份 —— **B6 的「合并」由 B7 的删除自动完成，不需要单独改文件**。

**验证**：`check:boundaries` OB（当前基线 OK 1710 files）、`check:deep-imports` OK、`cd packages/agent-core-v2 && bun run typecheck`、`bunx vitest run --project agent-core-v2` 全绿；`rg "human/compaction"` = 0。

### B8 删除 `scripts/scan-hardcoded.mjs`（改）

**证据**：`package.json` 只挂 `scan-hardcoded-v2.mjs`（`scan:hardcoded`）；`scripts/scan-hardcoded.mjs` 全仓无引用，仅在 `DEVELOP.md:215` 以 `scan-hardcoded[-v2].mjs` 的形式被提到；`tools/review/src/checks/gate_wiring.zig:271` 只引用 v2。

**改动**：删除 `scripts/scan-hardcoded.mjs`；`DEVELOP.md:215` 改为单列 `scan-hardcoded-v2.mjs`。**验证**：`rg "scan-hardcoded\b" --glob '!zig-cache'` 只剩 v2；`./tools/review/zig-out/bin/review` 无新增 warning。

### B9 + B10 dev 脚本收敛（改；`cli/v2` 目录不改名）

**证据**
- `apps/kimi-code/package.json:67-69` 的 `dev:server`、`dev:kap-server`、`dev:kap-server:multi` **命令字符串逐字节相同**；`package.json:34-35` 的根 `dev:kap-server`、`dev:v2` 分别转发到后两者。
- `dev:v2` 有真实文档消费者：`apps/kimi-web/DEVELOP.md:54`（说明 58628 端口）与 `apps/kimi-inspect/README.md:10`。
- `cli/v2/` 的命名是**成文策略**（`apps/kimi-code/DEVELOP.md:45`「`@moonshot-ai/agent-core-v2` inside the `cli/v2` runner only」），且被 3 个测试文件与 i18n 注释引用。

**改动**
1. 保留 `dev:server` 为唯一实现；删除 `dev:kap-server`、`dev:kap-server:multi`；根 `dev:kap-server` 删除，根 `dev:v2` 保留为指向 `dev:server` 的别名（因两个 app 的文档引用它，且「第二实例」语义在 klient/kap-server 的多进程调试中真实存在）。
2. 修正 `apps/kimi-web/DEVELOP.md:54` 与 `apps/kimi-inspect/README.md:10`：说明 `dev:v2` 与 `dev:server` 是**同一命令**，所谓 58628 端口差异不存在（需实际确认端口来源；若端口由 `KIMI_CODE_DEV_SERVER` 之外的因素决定，则在文档中写明真实差异，不臆造）。
3. **不重命名** `apps/kimi-code/src/cli/v2/`：它是被文档与测试固化的策略名词，改名属大范围结构调整，收益低于风险。

**验证**：`apps/kimi-code/package.json` 中不再有重复命令；`grep -rn "dev:kap-server"` 除 git 历史外为 0；两个 app 的文档与 `package.json` 一致。

---

## C 组 — 可维护性（先评估，确认后执行）

### C11 `loopService.ts` 拆分 + 禁注释

**证据（部分修正报告）**：文件 2374 行的构成是 —— 1–138 行 import + 前置类型，139–2211 行 `AgentLoopService` 类（约 2070 行），2213–2374 行**模块级**类型/辅助函数（`MachineGateDecision`、`normalizeFinishReason`、`machineUserMessage`、`PromptWaiter`、`ActiveTurn`、`cancelReasonFor` 等）。所以「2374 行单类」的说法不准确：约 160 行本来就是模块级代码。`scripts/check-no-comments.mjs` 对该包**全面禁止**行注释/块注释/JSDoc（仅允许 `oxlint-disable`），实测 `loopService.ts` 注释行数 = 0。

**方案 A（推荐，纯机械搬移）**：把 2213–2374 的模块级声明移入新文件 `src/agent/loop/loopInternals.ts`（或 `loopState.ts`），把 139 行前的公共类型块留在 `loop.ts`。类本身不动，无行为变更，文件降到约 2100 行。
**方案 B（按关注点拆分类）**：把 prompt 登记/waiter、machine 桥接与事件投影、gate 与 quiescence 拆成协作者。这是引擎最热路径，风险高，需要完整回归。
**方案 C（改禁注释策略）**：为 `agent-core-v2` 开放 JSDoc —— 与 `DEVELOP.md:432` 的明文规则冲突，不建议。
**C11 的注释可读性问题**：在方案 A 之外，只能靠「更小的文件 + 更清晰的命名」缓解，不能靠注释。若用户希望加注释，必须同时修改 `DEVELOP.md` 与 `check-no-comments.mjs`，属策略变更。

**验证（方案 A）**：`check:boundaries`、`check:deep-imports`、`bunx vitest run --project agent-core-v2` 全绿；`git diff --stat` 显示只有搬移（新增文件 + 原文件删行）；`loopService.ts` 行数 < 2150。

### C12 超大文件拆分

| 目标 | 证据 | 建议 |
|---|---|---|
| `apps/kimi-code/test/tui/kimi-tui-message-flow.test.ts`（10122 行） | 7 个顶层 `describe`：532（主流程）、9070 `/model status displayName`、9118 `/effort`、9294 transcript folding、9418 footer hint、9493 survey、9826 fold clicks。后 5 个共约 1050 行，彼此独立 | **改**：把 9070 起的独立 describe 拆到同目录兄弟测试文件（`kimi-tui-model-effort.test.ts`、`kimi-tui-transcript-fold.test.ts`、`kimi-tui-survey.test.ts`）。主流程 532–9070 保留 |
| `apps/kimi-code/src/tui/components/messages/tool-call.ts`（2733 行） | 大量纯函数（`formatByteSize:185`、`formatElapsed:191`、`extractKeyArgument:446`、`parseArgsPreview:369`、`tailNonEmptyLines:519`、`makeWorkspaceRelativePath:404`）与类 `ToolCallComponent:582` 混居 | **改**：纯函数移入 `#/tui/utils/tool-call-format.ts`（本 app 已有 `tui/utils/` 惯例）。类不动 |
| `packages/node-sdk/src/sdk-rpc-client-v2.ts`（2928 行） | 单一 RPC 客户端，按 domain 分组方法 | **评估**：拆分会影响 `scripts/build-dts.mjs` 的 api-extractor 公共 API 快照，风险中等。建议本轮**只出方案不执行** |
| `apps/kimi-code/src/tui/controllers/*`（session-event-handler 1495 等） | — | 不在报告清单内，不动 |

**验证**：`cd apps/kimi-code && bun run typecheck && bunx vitest run --project cli` 全绿且用例总数不变（拆分前后 `--reporter=json` 的 test 计数一致）。

### C13 `human/` 命名说明文档（改）

**证据**：`packages/agent-core-v2/src/human/` 有 190 个 `.ts`、约 33k 行，内含 `agent/`、`llm/`、`session/`、`store/`、`persist/`、`compaction/` 等与 `src/agent`、`src/session` 同名的目录；目录下唯一文档是 `src/human/llm/AGENTS.md`（内容仅一句，指向 `docs/en/llm.md`）。

**改动**：新增 `packages/agent-core-v2/src/human/AGENTS.md`，说明：`human/` 是**纯内核**（不是「面向人类」层）；对外路径是 `#human/*`，内部用 `#/...` 且因 tsconfig 双重映射 `"#/*": ["./src/*.ts", "./src/human/*.ts"]` 会解析到 `human/` 内，命名冲突时需显式用 `#human/`；与 `src/agent`、`src/session` 的职责边界；并记录本轮删除 `human/compaction/` 的替代关系。`.md` 不受 `check-no-comments.mjs` 约束（该脚本只扫 `.ts/.tsx/.mts/.mjs`）。
**验证**：`zig build`/`review` 无新增 warning（`gate-wiring` 会检查「文档声称的门禁是否真的在跑」，新增文档不得出现不存在的脚本名）。

### C14 生成物 / 运行产物（不改代码，交付核对结论）

**证据（已核实）**：`git ls-files` 显示 `reports/` **0 个**跟踪文件、`packages/agent-core-v2/.contract-types-tmp/` **0 个**、任意 `*/dist/` **0 个**；三者均已在 `.gitignore`（`.gitignore:2` `dist/`、`:7` `.contract-types-tmp/`、`:22` `reports/`）。唯一被跟踪的预构建产物是 `apps/kimi-code/dist-web/`（524 文件），而 `DEVELOP.md` 明确其「replace, never overlay」同步约定 —— 属**有意提交**。
`./tools/review/zig-out/bin/review` 实测 **0 error / 10 warning**，其中无 `stale-artifacts` 条目（10 条均为 `upstream-drift` 6 条与 `scripts-wiring` 4 条，且都已记录在案）。
**处置**：**无仓库改动**。交付物是本项核对记录；仅顺带在 C16 中处理 review 报出的 4 条 `scripts-wiring` warning。

### C15 `minidb` 在本地 `bun run test` 中可运行（改：加独立脚本）

**证据**：`vitest.config.ts:8` 的 `'!packages/minidb'` 来自提交 `20a0ba9b17`（PR #3504，标题即「speed up kap-server suite and exclude minidb from default projects」），是**有意的性能取舍**，不是疏漏。`packages/minidb` 有 45 个测试文件，`vitest.config.ts` 里 `testTimeout: 30_000` 说明其耗时确实大。

**方案**：不改默认 project 列表（尊重上游取舍），在根 `package.json` 增加 `"test:minidb": "cd packages/minidb && bun --bun run vitest run"`，并在 `DEVELOP.md` 的测试章节注明「minidb 不参与根 `bun run test`，本地请用 `bun run test:minidb`（CI 有独立 job）」。
**新增脚本的连带要求**：新脚本会被 `tools/review` 的 `scripts-wiring` 判定为「无人调用」，需在 `tools/review/scripts-wiring-baseline.txt` 追加一行（该台账的语义正是「维护者手工运行的脚本」）。
**验证**：`bun run test:minidb` 通过；`review` 无新增 warning。

### C16 把 CI-only 脚本收敛到根 `package.json`（改）

| 脚本 | 当前位置 | 处置 |
|---|---|---|
| `scripts/check-no-comments.mjs` | `ci.yml:181` | 加根脚本 `check:no-comments`，CI 改为调用它 |
| `scripts/check-locale-placeholders.cjs` | `ci.yml:186` | 加根脚本 `check:locale-placeholders`，CI 改为调用它 |
| `scripts/check-nix-workspace.mjs` | `nix-build.yml:33` | 加根脚本 `check:nix-workspace`（本地可复现 flake 同步检查） |
| `scripts/measure-image-tokens.cjs` | 全仓 0 引用 | 加根脚本 `measure:image-tokens`，作为**手工**标定工具（脚本头部说明它需要真实端点与 `PROVIDER`/`MODEL`/`CONFIG` 环境变量，不是门禁） |
| `scripts/check-service-naming.mjs` | 全仓 0 引用；脚本头自称「Nothing invokes this script」；其第一个扫描根 `packages/services/` 已不存在 | **需用户选择**：删除该死脚本 + `DEVELOP.md:213` 清单行，或加根脚本 `check:service-naming` 使其可复现 |

**连带要求**：以上新增的「手工」脚本（`measure:image-tokens`，以及若保留的 `check:service-naming`）需追加到 `tools/review/scripts-wiring-baseline.txt`。
**验证**：`bun run check:no-comments`、`bun run check:locale-placeholders`、`bun run check:nix-workspace` 各自退出码 0；`review` 0 error。

### C17 `.changeset/` 206 条待发布条目（只读盘点，不执行发布）

**证据**：`.changeset/` 有 206 个非 README 的 `.md`；`bunx changeset status` 显示本次将 bump 8 个 patch、7 个 minor、1 个 major（`@moonshot-ai/kimi-code`）。`CONTRIBUTING.md:257` 说明这是**设计使然**：「Before an intentional release, preview the user-facing changelog with the `pre-changelog` skill, then prune accumulated non-user-facing changesets from `main`」；同文件 `:254` 说明本 fork 的 release PR 已被注释掉、不会自动发布。

**处置**：不做 `changeset version`、不删条目。交付物为**只读盘点**：按「用户可见 / 非用户可见（docs·test·CI·内部重构）」分类列出可清理候选，供发布窗口前使用 `pre-changelog` skill 时参考。若要真的批量清理，应作为一次独立发布动作，不在本轮范围内。

---

## D 组 — 肯定项

无改动，`reports/` 与 `dist-web` 的现状已在 C14 核实为有意为之。

---

## §E 被否方案（记录理由）

1. **把 `node-sdk` 从 kosong 改接到 `human/llm`** —— 会打破 `docs/en/llm.md:60` 描述的「两份规则由 `cache-field-parity.test.ts` 对齐」契约，并使私有的 `agent-core-v2` 成为**已发布 SDK** 的 provider 契约来源；属架构变更，超出「逐项落地」范围。
2. **把 `notifyResultState()` 移入 SDK** —— 该函数把工具输出字符串映射为 TUI 展示语义（`'displayed' | 'suppressed'`），是展示层概念；只导出两个常量即可消除边界违规。
3. **重命名 `apps/kimi-code/src/cli/v2/`** —— 该名字是被 `apps/kimi-code/DEVELOP.md:45` 固化、并被 3 个测试与 i18n 注释引用的策略名词；改名是大型结构调整，收益低。
4. **把 `human/` 里每个模块都加 JSDoc 以解决可读性** —— 直接违反 `DEVELOP.md:432` 与 `check-no-comments.mjs`；仅在用户明确要改策略时才考虑。
5. **为了让本地 `bun run test` 覆盖 minidb 而把它加回默认 projects** —— 会回退 #3504 的有意优化；改用独立脚本即可达成「本地可运行」的目标。
6. **把 `apps/kimi-code/dist-web/` 从版本控制移除** —— 524 个文件是有意提交的预构建包（`DEVELOP.md` 有专门同步约定）；移除会破坏发布物，属明确越界。
