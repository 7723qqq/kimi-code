---
uid: e1e00001
id: kimi-code.engine.core.turn-loop
parent: kimi-code.engine.core
name: {zh: "回合循环", en: "Turn loop"}
description:
  zh: >
      回合状态机：run_turn、step 调度、重试、tool-call id 账本与墙钟预算。
      
  en: >
      The turn state machine: run_turn, step scheduler, retry, tool-call id ledger and wall-time budget.
      
revision: 64fbdf60ddb2b5432773ef2fbc5b6fc95bf8a139
updated_at: "2026-09-27T10:29:21.414Z"
fingerprint: b5f75fed8d05f05b6376612efcb487f8dc318a53bb5aec40e5034b6057276bba
source:
  - path: "packages/kimi-agent/src/turn_loop/run_turn.rs"
  - path: "packages/kimi-agent/src/turn_loop/turn_step.rs"
  - path: "packages/kimi-agent/src/turn_loop/retry.rs"
apis: []
deps:
  - kind: call
    to: kimi-code.engine.llm
    label: {zh: "模型调用", en: "model calls"}
  - kind: call
    to: kimi-code.engine.tools
    label: {zh: "工具执行", en: "tool exec"}
---
