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
      
revision: 71b8b2333357cbc1b2dad100399da38d1b7fb8ec
updated_at: "2026-10-03T08:25:20.449Z"
fingerprint: 46e1b582b55f53a7d995d45b27eab290ab6fc1a528a3efe17465163cb09beed9
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
