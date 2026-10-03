---
uid: e1e00004
id: kimi-code.engine.core.compaction
parent: kimi-code.engine.core
name: {zh: "上下文压缩", en: "Compaction"}
description:
  zh: >
      上下文压缩：窗口核算、micro 压缩与压缩指令提示词。
      
  en: >
      Context compaction: window accounting, micro-compaction and the compaction instruction prompt.
      
revision: 18c71cdd8583b337dd80efc94225c9033f341f42
updated_at: "2026-10-03T16:26:56.313Z"
fingerprint: 8a26909b33cf9251094c9aa916a0d64637b6addac7df2bbeabb7f3b60deb40a7
source:
  - path: "packages/kimi-agent/src/compaction/mod.rs"
  - path: "packages/kimi-agent/src/compaction/micro.rs"
apis: []
deps:
  - kind: call
    to: kimi-code.engine.llm
    label: {zh: "模型调用", en: "model calls"}
---
