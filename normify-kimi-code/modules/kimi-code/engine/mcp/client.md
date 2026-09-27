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
      
revision: 60e70d6896fce2a853b5a66abeba2b577029053e
updated_at: "2026-09-27T10:48:22.256Z"
fingerprint: 999675431888da12b6cdab7608d7f5b2d261087e48baa1407caf518e4b2ce78c
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
