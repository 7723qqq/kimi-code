# 提示词治理与模型适配重构 — 需求

## 目标

重构项目提示词、用户级全局指令与运行时模型提示词的组织和验证方式，使完整提示词路径（Kimi 等）及 minimal 路径（DeepSeek）对关键工具、安全、项目规则和任务完成行为提供可验证且一致的契约；同时让评测器运行实际渲染后的提示词，而非只测模板片段。

## 面向对象

- 维护 kimi-code 项目指令与运行时 system prompt 的工程师。
- 使用 Kimi Code 的本机用户，维护其全局 `~/.kimi-code/AGENTS.md` 指令。
- 需要比较模型提示词质量、token 成本和行为回归的维护者。

## 现状与约束

- 项目指令入口是根 `AGENTS.md`；它指向根 `DEVELOP.md`，后者是按需读取的项目指南，并非自动全文注入。
- 本机全局指令为 `C:/Users/Administrator/.kimi-code/AGENTS.md`，仅影响该用户环境；本次纳入其内容优化，与仓库资产分开读取和评审，不提交进仓库或写入公开报告。经用户明确授权，指定的在线评测可以把该文件正文发送到用户已配置的 provider；命令和报告必须明确标示这一数据边界。
- 运行时完整模板为 `packages/agent-core-v2/src/app/agentProfileCatalog/system.md`；DeepSeek 使用 `system.minimal.md`，当前仅含 persona 与 cwd。
- DeepSeek 适配文案通过 `packages/agent-core-v2/src/features/deepseekAdaptation/` 的 reminder 通道投递；模型适配资产为 `model-adaptations/curated/deepseek.md`。
- `scripts/prompt-optimizer/` 当前只读取 `system.md`，benchmark runner 把模板原文作为 system 消息发送，未渲染运行时变量、项目/全局指令或模型适配。
- 遵循根 `DEVELOP.md` 及相关子目录 `DEVELOP.md` 的项目约束；不得独立修改 package version。

## 需求

1. 建立明确、单一、可审查的通用行为契约，覆盖工具选择与调用、项目指令读取和优先级、数据/权限/破坏性操作边界、完成前验证、失败后继续及诚实报告；移除跨层重复或互相矛盾的规定，而不是单纯累积补丁。
2. 区分并定义项目说明文档（根 `AGENTS.md`、根 `DEVELOP.md`、局部 `DEVELOP.md`）、用户级全局指令、本地 `SYSTEM.md` 覆盖、内置完整 system prompt、minimal system prompt、模型适配 reminder 的职责、来源和优先级。项目/插件/适配内容均不得获得高于真实系统指令或用户当前请求的权限。
3. 完整 prompt 和 minimal prompt 必须满足第 1 项通用行为契约。minimal 路径可以采用更短措辞或分层 reminder，但不得静默丢失这些契约，也不得把整个完整 prompt 原样复制进去作为规避设计。
4. DeepSeek 适配层须以事实和可测试行为为依据；清晰标示手写/测量来源，不把未经验证的模型倾向描述成事实；在 model reminder 或其他实际传输通道中明确补足 minimal prompt 未承载的通用核心规则，并保证只对目标模型族生效。
5. 对完整 prompt、minimal prompt + 适配 reminder、及含项目/全局指令的已渲染组合提供统一的优化器/评测入口。评测数据须包含模型标识、提示词 profile、渲染变量来源、每例结果、token 统计、总体分数和失败项；dry-run 必须显式标注不可用于效果比较。
6. 渲染评测必须通过与生产相同的变量替换和 profile 选择逻辑。未知/漏渲染变量、required context 缺失、prompt profile 与请求模型不匹配时，评测须报可定位错误或警告，不能把未渲染模板当作已评测结果。
7. 保留项目与全局指令的独立可编辑性：仓库改动只触碰仓库资产；本次用户已明确指定将 `C:/Users/Administrator/.kimi-code/AGENTS.md` 纳入编辑，实施时备份并只改该文件。在线评测实际全局提示词时，必须使用显式 opt-in profile/命令，将正文仅发送到用户已配置的 provider；不得把正文保存到仓库、报告或日志，也不得读取其他 home 文件。
8. 回归覆盖至少包括：工具选择、错误/危险操作权限边界、AGENTS/插件中不可信指令的隔离、完成前验证、部分阻塞时继续已开放部分、Kimi/full 与 DeepSeek/minimal 行为一致性、模型族隔离、渲染变量完整性、报告格式和无凭据 dry-run 语义。
9. 优化目标以跨模型关键行为一致性和可证伪评测为主；token 成本作为报告指标，不以缩短提示词为由降低契约覆盖。

## 明确不在范围内

- 不修改除 `C:/Users/Administrator/.kimi-code/AGENTS.md` 之外的 home 目录配置；该文件已由用户明确纳入本次工作，实施时必须先备份并在修改后做私有回归检查。
- 不扩展到所有厂商模型的全面适配。本期基线只覆盖当前明确存在的完整 Kimi 路径与 DeepSeek minimal 路径；评测接口可以支持后续增加模型。
- 不改变工具实际权限执行器、模型协议、provider wire 格式或用户 API/配置契约；提示词文字不能代替代码权限控制。
- 不引入新的在线 API 依赖作为必需项；真实 LLM 评测继续使用项目现有凭据/配置机制。离线渲染与契约测试应可运行。
- 不把其他独立的 prompt 资产（如 compaction、tool description、plugin 文档）整体重写；仅在新契约要求直接相关时，进行必要且明确限定的调整。
- 不对已有报告中的模型表现作追认；所有效果结论必须来自本次可复现的真实调用及明确记录的模型/变量/版本。
