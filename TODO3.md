# Agent 服务测试 / 迁移 TODO

这里记录 `packages/agent-core/test/services/agent` 里仍被跳过、仍依赖旧 `src/agent`、或仍缺少服务层等价覆盖的事项。它不是失败测试清单；当前全仓测试可以为绿，但这些条目表示后续迁移还没有收口。

恢复对应行为或测试时，应在同一个改动里移除匹配的 `it.skip` / `describe.skip`，或恢复被暂时关闭的 resume parity 断言。

## 判断口径

- **测试迁移债**：测试仍绑在旧 `src/agent` 类、旧 harness 假设、或旧 wire record 形状上。优先改测试到 `src/services/agent` 的服务接口；只有确认服务行为缺失后才下沉为功能缺失。
- **功能缺失**：服务层还没有实现旧 Agent 已有的一整块能力，或对应 builtin / runtime / restore 入口不存在。
- **行为待对齐**：服务层已有入口，但与旧实现或产品预期仍有语义差距，需要用测试锁住后修复。
- **协议升级不是缺陷**：当前服务层 canonical wire protocol 是 `AGENT_WIRE_PROTOCOL_VERSION = 1.5`。`context.splice` / `turn.launch` 是 v1.5 的设计结果；旧的 `context.append_message`、`context.append_loop_event`、`turn.prompt` 等应只作为 migration fixture 或历史日志输入出现。

## Wire 协议口径

- v1.5 migration 已经覆盖旧 record 到 `context.splice` / `turn.launch` 的转换，包括 prompt append 去重、tool call/result 投影、compaction summary、undo、forked goal 清理，以及中断 tool call 的合成 error result。
- 不要把“新日志不再写 `context.append_message` / `context.append_loop_event`”记录为 bug。当前测试若仍期望这些 record，应改成：
  - 直接断言当前 v1.5 `context.splice` / `turn.launch` 输出；或
  - 明确构造带旧 `protocol_version` 的迁移输入，测试 `migrateV1_*` / restore migration 行为。
- 如果 replay/range 测试只是在构造历史消息流，优先使用当前 v1.5 record；只有要覆盖历史兼容时才使用旧 record。

## 测试迁移债

- [ ] 将剩余直接引用旧 `src/agent` 的测试迁移到服务层：
  - `goal.test.ts`：用 `IGoalService`、wire record、event bus / replay builder 覆盖旧 `GoalMode` 行为。
  - `injection/plan-mode.test.ts`：用 `IPlanModeService` + `IDynamicInjector` 覆盖 plan reminder 内容和 cadence，而不是旧 `PlanModeInjector`。
  - `injection/plugin-session-start.test.ts`：等待服务层 plugin session-start injection 入口后再迁移；当前仍只能测旧 injector。
- [ ] 重写 `records/index.test.ts` 里的 skipped replay range 覆盖。旧测试可以保留“历史日志输入”的意图，但断言应基于 v1.5 `context.splice`，不要要求恢复 `context.append_message` / `context.clear` / `context.undo` 作为当前输出。
- [ ] 清理 skipped 测试中的旧 wire snapshot。`context.test.ts`、`resume.test.ts`、`plan.test.ts`、`turn.test.ts`、`permission.test.ts`、`compaction/full.test.ts`、`compaction/micro.test.ts` 里仍有大量旧 record 形状；解除 skip 前先判断是“迁移 fixture”还是“当前协议快照”。
- [ ] 给 service runtime 的 `Skill` model-tool 语义补等价测试后，恢复 `skill-tool-manager.test.ts` 中 skipped 的 model-invocable skill 覆盖。用户 slash skill activation 已有 `IAgentSkillService`，不要混为同一件事。

## 功能缺失

- [x] 增加服务原生 foreground task 语义：`detached: false`、等待 foreground release、注册时 abort signal、foreground task 不计入 detached/background task limit。覆盖测试：`background/foreground-persistence.test.ts`、`background/manager.test.ts`。
- [x] 定义并实现 foreground task detach 持久化状态迁移，包括 detach 前已完成输出 flush 到磁盘。覆盖测试：`background/foreground-persistence.test.ts`。
- [x] 将旧 manager 的 background notification delivery 行为迁移到服务层：`turn.steer`、context replay、`Notification` hook delivery、idle auto-turn launch、busy-turn buffering，以及 restore 后的 terminal notification injection。覆盖测试：`background/rpc-events.test.ts`、`bg-idle-notification-repro.test.ts`。
- [ ] 将 Bash builtin 迁移到服务 runtime，包括 Bash 专属 permission turns、plan-mode Bash 行为、approval/cancel/steer 交互，以及 Bash 执行前后的 hook cadence。覆盖测试：`permission.test.ts`、`plan.test.ts`、`tool.test.ts`、`turn.test.ts`。
- [ ] 将仍缺服务层 model-tool 入口的旧 Agent-bound tools 迁完：`Agent`、media upload/read、goal tools、question tools、model-invoked `Skill`。注意：`AgentSwarm` 已由 `SwarmModeService` 注册，`TodoList` / `Cron*` / `EnterPlanMode` / `ExitPlanMode` 也已经是 service-owned tools，不应再列入“未注册 builtin”。覆盖测试：`tool.test.ts`、`turn.test.ts`、`skill-tool-manager.test.ts`。
- [ ] 将 plugin session-start injection 完整迁移到服务层 dynamic-injection runtime，包括 skill lookup、instruction rendering、warning behavior，以及 replay de-duplication。覆盖测试：`injection/plugin-session-start.test.ts`。
- [ ] 做一次 full-compaction 服务行为对齐：manual/auto lifecycle、micro-compaction access、OAuth retry、hooks、provider-overflow retry accounting、todo-store integration、history-change cancellation，以及 resume parity。覆盖测试：`compaction/full.test.ts`。
- [ ] 做一次 micro-compaction 服务行为对齐：cutoff/projection/telemetry 语义、cache-miss detection、restore、undo，以及与 full-compaction 的交互。覆盖测试：`compaction/micro.test.ts`。

## 行为待对齐

- [ ] 恢复 skipped 的 resume projection 覆盖：从历史记录重建 turn counter、tool-store 状态、compaction/goal replay cards、延迟 reminders、pending tool results，以及中断 tool call 的合成结果。这里应按 v1.5 canonical records 断言；旧 records 只用于 migration 输入。覆盖测试：`resume.test.ts`、`context.test.ts`、`records/index.test.ts`。
- [ ] 恢复 session 级 approval replay 到 `PermissionRulesService.sessionApprovalRulePatterns`，不能只恢复一次性的 approval notification。覆盖测试：`permission.test.ts`。
- [ ] 恢复 registered user-tool 的 full resume parity：restore 后应恢复 active registered tools、permission mode、累计 usage，以及 completed-turn context。覆盖测试：`tool.test.ts`，以及 `basic.test.ts` / `config.test.ts` 中暂时关闭的 `expectResumeMatches()`。
- [ ] 完成 `PlanModeService` 行为对齐：path derivation、filesystem calls、clear/read/exit flow、approval rejection handling、plan reminders、injection cadence，以及 resume parity。Bash-in-plan-mode 依赖 Bash builtin 迁移，单独跟 Bash 项收口。覆盖测试：`plan.test.ts`、`injection/plan-mode.test.ts`。
- [ ] 恢复服务层 goal replay 语义：`goal.*` records、fork boundaries、goal-cleared reminders、goal injector boundary cadence，以及 goal-outcome cleanup。覆盖测试：`goal.test.ts`、`injection/goal.test.ts`、`records/index.test.ts`、`resume.test.ts`。
- [ ] 恢复 turn-flow hook / event parity：`PreToolUse`、`PostToolUse`、`PostToolUseFailure`、`StopFailure`、`Interrupt`、provider finish-reason details、model-not-configured diagnostics、LLM request logging，以及 duplicate tool-call telemetry。覆盖测试：`tool.test.ts`、`turn.test.ts`。
- [ ] 完成 swarm-mode parity：manual/task/silent modes、task-exit behavior、turn-failure/cancel exits，以及 replay restore behavior。`AgentSwarm` 的基础 service-owned tool 入口已经存在，剩余重点是行为和恢复语义。覆盖测试：`tool.test.ts`、`turn.test.ts`。
