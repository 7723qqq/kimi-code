---
uid: e1e00003
id: kimi-code.engine.core.subagent
parent: kimi-code.engine.core
name: {zh: "子代理", en: "Subagents"}
description:
  zh: >
      子代理编排：manager、fork、persistent/secondary 代理与 btw 侧信道。
      
  en: >
      Subagent orchestration: manager, fork, persistent and secondary agents, the btw side-channel.
      
revision: bbe0193dc9919ed29c2f1d4666406bfe96175b5d
updated_at: "2026-09-30T20:01:23.967Z"
fingerprint: b57882655d4f422bd5ec11e132a53610eacf0bf9b29af48a723e9a63029adc33
source:
  - path: "packages/kimi-agent/src/subagent/manager.rs"
  - path: "packages/kimi-agent/src/subagent/fork.rs"
  - path: "packages/kimi-agent/src/subagent/btw.rs"
apis: []
deps:
  - kind: call
    to: kimi-code.engine.core.turn-loop
    label: {zh: "驱动子回合", en: "runs sub turns"}
---
