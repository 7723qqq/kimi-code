---
uid: e3e00002
id: kimi-code.engine.mcp.client
parent: kimi-code.engine.mcp
name: {zh: "MCP 客户端", en: "MCP clients"}
description:
  zh: >
      MCP 客户端与传输：stdio 拉起、SSE/HTTP、共享客户端状态、输出规范化与错误。
      
  en: >
      MCP clients and transports: stdio spawn, SSE/HTTP, shared client state, output normalization and errors.
      
revision: 9796b6da830de4efc4229058662f35dcb063a0b7
updated_at: "2026-10-03T11:48:47.394Z"
fingerprint: 6c6ecf6f5310e42d77a13aceefb84fd3cffabb9ebf16a1009fe8e4ec143cb4a2
source:
  - path: "packages/kimi-agent/src/mcp/client.rs"
  - path: "packages/kimi-agent/src/mcp/client_shared.rs"
  - path: "packages/kimi-agent/src/mcp/sse.rs"
  - path: "packages/kimi-agent/src/mcp/http.rs"
  - path: "packages/kimi-agent/src/mcp/errors.rs"
  - path: "packages/kimi-agent/src/mcp/output.rs"
apis: []
deps:
  - kind: call
    to: kimi-code.engine.mcp.manager
    label: {zh: "由管理器拉起", en: "spawned by manager"}
---
