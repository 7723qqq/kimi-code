---
uid: "50e00001"
id: kimi-code.sdk.node
parent: kimi-code.sdk
name: {zh: "Node SDK", en: "Node SDK"}
description:
  zh: >
      宿主侧 SDK：原生 RPC 客户端、会话门面、插件/技能/MCP 门面与配置解析。
      
  en: >
      The host-side SDK: native RPC client, session facade, plugin/skill/MCP facades and config resolution.
      
revision: cdc277fdbc82a31db4f838e3e1f49061c45cc018
updated_at: "2026-10-03T11:18:21.984Z"
fingerprint: 1059f18107b0ed0a9ae8104813a6887a69b69200e0edcae67757c091463cb2e6
source:
  - path: "packages/node-sdk/src/native/sdk-rpc-client-native.ts"
  - path: "packages/node-sdk/src/kimi-harness.ts"
deps:
  - kind: call
    to: kimi-code.engine.napi
    label: {zh: "进程内 napi 调用", en: "in-process napi calls"}
---
