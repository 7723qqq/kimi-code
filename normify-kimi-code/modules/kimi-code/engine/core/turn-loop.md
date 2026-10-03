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
      
revision: 5d7ef5644a0810da5d401c2951b5e5cd2f441df9
updated_at: "2026-10-03T10:50:05.006Z"
fingerprint: a1bcdbbb3ba9e1fd6022666e16eca74b6b774777147838403ce76d008119bc50
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
