---
uid: e0e00007
id: kimi-code.engine.napi
parent: kimi-code.engine
name: {zh: "NAPI 绑定", en: "NAPI bindings"}
description:
  zh: >
      引擎的 JS 边界：napi 导出（会话创建、插件注册表、工具回调）与 JS 侧类型契约。
      
  en: >
      The engine's JS boundary: napi exports (session creation, plugin registry, tool callbacks) and the JS-side type contract.
      
revision: 18c71cdd8583b337dd80efc94225c9033f341f42
updated_at: "2026-10-03T16:26:56.330Z"
fingerprint: db08c41166396156a2625fd2f94dd158ecb6256834ba8c6e2d65ea6c304f8feb
source:
  - path: "packages/kimi-agent/src/napi_bindings.rs"
  - path: "packages/kimi-agent/index.native.d.ts"
deps:
  - kind: call
    to: kimi-code.engine.core
    label: {zh: "同 crate 引擎核心", en: "same-crate engine core"}
  - kind: call
    to: kimi-code.engine.mcp
    label: {zh: "插件 MCP 配置", en: "plugin MCP configs"}
  - kind: call
    to: kimi-code.engine.plugins
    label: {zh: "注册表插件 API", en: "registry plugin APIs"}
---
