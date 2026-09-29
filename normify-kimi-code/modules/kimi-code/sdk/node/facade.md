---
uid: "51e00002"
id: kimi-code.sdk.node.facade
parent: kimi-code.sdk.node
name: {zh: "Harness 门面", en: "Harness facade"}
description:
  zh: >
      公开门面：KimiHarness、会话包装、agent-file 发现与 marketplace/config 辅助。
      
  en: >
      The public facade: KimiHarness, session wrapper, agent-file discovery and marketplace/config helpers.
      
revision: 779fa7ba58daaeed4dd885c941bf1c29d2fe902e
updated_at: "2026-09-29T11:43:39.006Z"
fingerprint: 144eede413240e1f2efc76c6f08081045a62d2dae65eaa153732a729949aee5a
source:
  - path: "packages/node-sdk/src/kimi-harness.ts"
  - path: "packages/node-sdk/src/agent-file.ts"
  - path: "packages/node-sdk/src/marketplace.ts"
apis: []
deps:
  - kind: call
    to: kimi-code.sdk.node.native-client
    label: {zh: "委托原生客户端", en: "delegates to native"}
---
