---
uid: "51e00001"
id: kimi-code.sdk.node.native-client
parent: kimi-code.sdk.node
name: {zh: "原生 RPC 客户端", en: "Native RPC client"}
description:
  zh: >
      原生传输：SDKRpcClientNative、ensurePluginStore 种子逻辑与插件 API 面。
      
  en: >
      The native transport: SDKRpcClientNative, ensurePluginStore seeding and the plugin API surface.
      
revision: 18c71cdd8583b337dd80efc94225c9033f341f42
updated_at: "2026-10-03T16:26:56.355Z"
fingerprint: 633fba64d8b9859d3b8d6591b1eab868532c0a56ce7fd3b9a76aa4cef495d7b7
source:
  - path: "packages/node-sdk/src/native/sdk-rpc-client-native.ts"
apis:
  - protocol: rpc
    path: "createSession"
    description:
      zh: >
          创建 agent 会话
          
      en: >
          Create an agent session
          
  - protocol: rpc
    path: "prompt"
    description:
      zh: >
          运行一轮 prompt
          
      en: >
          Run a prompt turn
          
  - protocol: rpc
    path: "listPlugins"
    description:
      zh: >
          列出已安装插件
          
      en: >
          List installed plugins
          
deps:
  - kind: call
    to: kimi-code.engine.napi.bindings
    from_api: "rpc:listPlugins"
    to_api: "rpc:pluginList"
    label: {zh: "napi 调用", en: "napi calls"}
---
