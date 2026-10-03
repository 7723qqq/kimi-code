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
      
revision: 67ba21094b198c6b3276a9e9650565e17f1d9d40
updated_at: "2026-10-03T15:32:22.787Z"
fingerprint: a52a4671f7bd584e5e24d87a773613da0b74d460e534c0ceb85d69a97d5ca4cd
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
