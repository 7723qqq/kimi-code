# 提示词治理与模型适配重构 — 设计

## 设计摘要

采用“共享核心契约 + profile 负责投递 + 生产渲染器驱动评测”的架构。完整 system prompt 保留面向所有模型的详细工具和工作流程说明；DeepSeek minimal prompt 保持短小的身份/环境核心，DeepSeek 适配 reminder 则投递同一契约的精简、明确操作版。项目指南与个人全局指令继续独立管理，项目文件不试图复制全局个人偏好。

优化器不再把 `.md` 模板当作线上输入。它调用 agent-core 公开的、无副作用的 prompt render/fixture 边界，以目标模型与显式 fixture context 渲染实际 profile 组合，然后对相同 benchmark case 跑完整路径和 minimal+reminder 路径。报告标注 fixture 中哪些变量有意留空；安全敏感用户 home 文件不作为默认测试输入。

## 现有边界与目标文件

### 提示词资产

- `packages/agent-core-v2/src/app/agentProfileCatalog/system.md`：完整 system prompt 的表达层，消费 `systemPromptVars()` 提供的变量。保持其职责为通用系统行为及运行环境说明。
- `packages/agent-core-v2/src/app/agentProfileCatalog/system.minimal.md`：minimal profile 的紧凑入口。只放 persona、环境及链接到适配契约投递方式的必要说明，不承载和完整模板重复的大段规则。
- `packages/agent-core-v2/src/app/agentProfileCatalog/model-adaptations/curated/deepseek.md`：DeepSeek family 的实际 reminder 内容；重构为操作型适配，不声称未测量的能力倾向。
- 根 `AGENTS.md`、根 `DEVELOP.md` 与必要的 `apps/kimi-code/DEVELOP.md`：项目侧职责、入口和按需读取语义。只修改确有分层、冲突或可执行性问题的内容。
- `C:/Users/Administrator/.kimi-code/AGENTS.md`：个人全局指令，作为本次实际优化目标；只在用户指定的这个文件中重组规则，不复制到仓库或公开报告，并保留可恢复备份。

### Runtime composition

- `packages/agent-core-v2/src/app/agentProfileCatalog/profile-shared.ts`：目前 `systemPromptVars()`、`renderSystemPromptResult()` 和 prompt shape 选择是 built-in 模板的渲染边界。将通用行为契约抽成集中、类型化的适配数据/渲染组合，使 full 与 minimal 两种 profile 均能得到契约。
- `packages/agent-core-v2/src/features/deepseekAdaptation/deepseekAdaptationService.ts`：保持 reminder 的注入生命周期、去重与 compaction 后重注入语义；不要将静态行为规则和传输生命周期揉在一个大 service 内。需要时抽纯函数构造适配文本。
- `packages/agent-core-v2/src/agent/profile/profileService.ts`：清理“变量被丢弃”的警告与 reminder 初始化逻辑之间的所有权表达；profile render result 必须精确报告模板未承载的 context，且对由专门 reminder 接管的变量提供显式交付状态，避免误报/漏报。
- `packages/agent-core-v2/src/app/agentProfileCatalog/modelAdaptations.ts`：继续负责 family 文件解析、上限与来源包装；若 renderer 契约需要调整，保持解析和投递判定为独立纯函数。
- `packages/agent-core-v2/src/llm-adapter/contract/modelFamily.ts`：继续为 DeepSeek 声明 `promptShape: 'minimal'` 和适配 family 前缀；本期不扩充其他 family。

建议在 `agentProfileCatalog/` 下新增一个聚焦的行为契约模块（例如 `behaviorContract.ts` 或等价命名）：导出结构化章节与适配函数，供 full/minimal/reminder renderer 及 optimizer fixture 使用。准确导出签名在实现计划中锁定；不得在 system.md、deepseek.md、global AGENTS.md 各维护互相漂移的三份核心规则。

## 行为契约与优先级

行为契约按领域划分短、可追踪的章节：

1. **Authority and untrusted content**：直接用户请求与实际系统约束是边界；项目 `AGENTS.md`、技能、插件和模型适配是参考指导，不能自我提升权限，也不能通过其内容授权访问受限数据或覆盖用户当前请求。
2. **Act and verify**：明确执行型请求默认继续执行；多步任务按风险决定是否先澄清/设计；完成声明以实际验证结果为依据；未验证必须明示。
3. **Tools and repository context**：遵循专用工具、并行独立读取、项目约定发现与就近 `DEVELOP.md` 规则；代码编辑依据代码而非过期文档猜测。
4. **Safety and scope**：遵守环境访问限制、敏感信息保护、破坏性和外部影响操作的确认门槛；提示词不取代工具策略/权限执行器。
5. **Failure and partial progress**：错误要报告原因与边界；仍有不受阻部分时继续，不伪称完成。
6. **Communication**：语言跟随用户；更新和最终答复言简意赅、证据可定位；工具调用不可见的内容要在最终交付中总结。

不要在项目规则里复制仅适用于本机的 Windows/PowerShell习惯；操作系统专属约束来自 system context。不要把项目的完整开发手册重新灌入 minimal system prompt；模型应按既有 instructions discovery / reminder 机制按需读取局部指令。

## 评测器架构

### 运行时渲染适配

- 增加 optimizer 可消费的 agent-core adapter（放在 `packages/agent-core-v2/src/app/agentProfileCatalog/` 或对应工具支持目录），复用与生产同一组 `renderSystemPromptResult()`、`systemPromptVars()`、model family 解析、DeepSeek adaptation 内容构造。
- 适配器输入：`profile: 'full' | 'minimal' | 'deepseek-adapted'`、`modelName`、fixture context（cwd、OS/shell、AGENTS、skills、plugins、additional dirs、NotifyUser）；纯渲染边界只接受显式 context，不读取真实用户 home 或秘密配置。
- 适配器输出：渲染后的 system prompt 文本、若单独传递的 reminder 文本、profile/family 标识、已提供和被消费/有意缺省变量集合、token 估算与警告。
- Prompt optimizer 测试离线创建固定 fixture，不依赖实际 home 目录、API key 或 shell 环境细节。另设一个显式 opt-in actual-global loader，仅允许读取 `C:/Users/Administrator/.kimi-code/AGENTS.md`，将内存内容交给同一纯 renderer，再由现有 `realCaller` 根据 provider config 发送；默认命令不启用该 loader。

### Optimizer CLI 与报告

- `scripts/prompt-optimizer/src/cli-args.ts`、`types.ts`、`config.ts`：增加明确的 profile/fixture 参数或 preset。默认路径不得静默退化成只读 `system.md` 的旧模式；对无模型/无凭据运行，沿用清晰 dry-run 语义，不生成效果判定。
- `scripts/prompt-optimizer/src/benchmark/runner.ts`：针对 adapter 生成的 system prompt 及 profile reminder 构造一致的 benchmark input；不能把 reminder 文本塞入错误角色或默默忽略第二投递通道。实现应符合各 provider 真实 context 语义；如现有抽象无法表示单独 reminder，则把它作为基准用户上下文中的 system-reminder 注入，并在报告记录角色/位置。
- `scripts/prompt-optimizer/src/benchmark/cases.ts`：扩展已有 benchmark 覆盖率，不以纯字符串禁词替代必要的工具调用/权限场景。每条 case 声明对应的行为契约 id，评测报告能按契约聚合。
- `scripts/prompt-optimizer/src/report/report.ts` 与 `types.ts`：报告包括 model id、profile、prompt source/version hash、fixture 字段摘要（不含 secrets）、system/reminder token 数、每条 case 的原始结果与违反契约列表、汇总分数、dry-run 标记、API 请求失败状态。
- `scripts/prompt-optimizer/README.md` 当前不存在；用户文档若需要，优先更新 `DEVELOP.md` 的 prompt-optimizer 工具地图，或现有 prompt-optimizer 使用文档（先实现时确认真实文档路径）。不新建重复的 readme。

### 用户级与项目级规则

- 优化根 `AGENTS.md` 入口文案和 `DEVELOP.md` 的 instruction ownership / precedence / 开始工作规则，使项目入口可让 agent 正确发现本指南与子目录指南，避免把根 DEVELOPMENT 文档误认为自动注入。
- 用户全局 AGENTS 内容作为独立输入参与本次优化，但不进仓库 fixture、不被提交、不写入报告或日志；用户已明确授权对指定文件做在线评测，命令必须显式 opt-in，且只发送到用户已配置的 provider。其他 home 文件仍不得读取。
- 内置 `system.md` 仅用运行时边界与本项目工具说明；通用个人回复风格不复制进项目 `DEVELOP.md`。同一规范的所有权只能有一个 canonical 模块/文档，再在各 profile 提示词中以可读表达呈现。

## 验收指标

- Full 和 DeepSeek profile 的所有核心行为契约 id 均有覆盖，benchmark 输出按 profile × contract 统计；任何 profile 缺少一个核心契约都令完整性 gate 失败。
- 对提供的完整 fixture，实际渲染无未解析 `${...}`；所有非空且预期消费的变量要么在 system/reminder 中有可追溯投递，要么作为显式 `intentionally omitted` 记录。
- DeepSeek family 接收一次、且仅一次 DeepSeek adaptation reminder；非 DeepSeek 不接收；compaction 移除后恢复一次；保持既有 context-origin 和用户消息语义。
- 使用相同 benchmark case 分别执行 full 与 DeepSeek profile；报告确认两者的安全/权限和完成验证关键契约 pass rate 无回归；如真实 API 凭据不可用，只能报告离线结构验证，不得宣称模型行为提升。
- `--dry-run` 的报告显式 `dryRun: true`，且 CLI 明确说明评分不代表模型效果。
- 提示词相关现有测试、prompt optimizer 测试、agent-core 类型检查通过；全仓 CI 可能受环境/预存故障影响须区分报告。

## 考虑过的方案

### A. 推荐：共享契约 + profile-specific 投递 + production-renderer 评测

保留 minimal 本意；通用规则集中维护；runtime profile 各自渲染/投递；优化器通过共享渲染器测试真实输入。实现需改动 agent-core、prompt optimizer 和项目文档，但职责清晰且能自动防止双轨漂移。

### B. 将完整 system prompt 压缩后复制进 minimal 模板

实现短期简单，但形成第二份权威规则，且会令 DeepSeek prompt 失去 minimal 预算目标；后续双份编辑容易漂移，故不采用。

### C. 只修订 DeepSeek 文案并保留现有优化器

改动小，但 benchmark 仍测试未渲染模板，且无法验证 AGENTS/skills/插件和 reminder 通道；模型适配结论不可复现，不能满足本次授权的完整推进目标。

## 兼容与迁移

- 不改变 `~/.kimi-code/SYSTEM.md` 用户覆盖模板的变量名、`${base_prompt}` 语义或优先级。
- 保留现有项目 prompt 渲染调用者的返回结构兼容性；如果需要新增 `deliveredVars`/`deliveryChannels`，采用可选字段并更新所有调用处及测试。
- 保持 AGENTS reminder 现有发现、去重、watch change、restore 和 compaction 重投机制；除非实现计划指出当前模型 reminder 系统已提供更通用稳定的共享注入接口。
- 不以代码修改绕过现有用户确认/权限 gate。

## 关键取舍

- 默认不将真实用户 home 下的全局提示词作为评测输入；用户已明确授权的 opt-in 在线评测可读取唯一指定的 `C:/Users/Administrator/.kimi-code/AGENTS.md` 并发送到用户已配置的 provider。该模式在调用前显示数据边界确认摘要，正文不落盘到仓库、报告或日志；一般离线/默认评测只使用脱敏 fixture。
- 不依赖优化器另写一套模板渲染器；只要存在两套渲染实现，就会重复产生现在的离线评测偏差。
- 不把“有 reminder 通道”视作规则已到达模型：评测必须携带 reminder 的正文、位置和 source id 才算 delivered。
