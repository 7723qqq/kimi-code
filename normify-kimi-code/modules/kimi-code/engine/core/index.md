---
uid: e0e00001
id: kimi-code.engine.core
parent: kimi-code.engine
name: {zh: "回合循环与会话", en: "Turn loop & sessions"}
description:
  zh: >
      引擎核心：run_turn 状态机、会话生命周期、压缩、子代理编排与事件总线。
      
  en: >
      Engine core: the run_turn state machine, session lifecycle, compaction, subagent orchestration and the event bus.
      
revision: 3fb50fc35994bafa62a0e4385b314425825bda71
updated_at: "2026-09-30T20:22:55.494Z"
fingerprint: a75d6263831a9132ac898019adc950c9d30feb04b9154c69b5f21a96633c951e
source:
  - path: "packages/kimi-agent/src/turn_loop/run_turn.rs"
  - path: "packages/kimi-agent/src/session/mod.rs"
  - path: "packages/kimi-agent/src/pipeline/mod.rs"
deps:
  - kind: call
    to: kimi-code.engine.llm
    label: {zh: "模型补全", en: "model completions"}
  - kind: call
    to: kimi-code.engine.tools
    label: {zh: "工具执行", en: "tool execution"}
---
