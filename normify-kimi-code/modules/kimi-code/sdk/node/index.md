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
      
revision: 435e51cd310eb9df90ddb522a8d245cae01e86cf
updated_at: "2026-09-30T19:09:30.073Z"
fingerprint: e52c5299b4bce0fbb785db5ec057e6917b3ce90a8259093523bfc55db50a55fe
source:
  - path: "packages/node-sdk/src/native/sdk-rpc-client-native.ts"
  - path: "packages/node-sdk/src/kimi-harness.ts"
deps:
  - kind: call
    to: kimi-code.engine.napi
    label: {zh: "进程内 napi 调用", en: "in-process napi calls"}
---
