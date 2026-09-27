---
uid: "1e100002"
id: kimi-code.libs.normify.adapters
parent: kimi-code.libs.normify
name: {zh: "Normify 适配层", en: "Normify adapters"}
description:
  zh: >
      宿主适配层：31 工具注册表、MCP 服务器与独立 CLI。
      
  en: >
      Host adapters: the 31-tool registry, the MCP server and the standalone CLI.
      
revision: 64fbdf60ddb2b5432773ef2fbc5b6fc95bf8a139
updated_at: "2026-09-27T10:29:21.424Z"
fingerprint: ac33f8deb3179b652c28eaf28a7831d8c4a89aa76b21b5ea31aebecd3d31bf8d
source:
  - path: "packages/normify/src/tools.ts"
  - path: "packages/normify/src/mcp.ts"
  - path: "packages/normify/src/cli.ts"
apis:
  - protocol: rpc
    path: "normify_validate"
    description:
      zh: >
          全项目零容忍校验
          
      en: >
          Zero-tolerance validation
          
  - protocol: rpc
    path: "normify_build"
    description:
      zh: >
          确定性编译与冻结回执
          
      en: >
          Deterministic compile + frozen receipt
          
  - protocol: rpc
    path: "normify_render"
    description:
      zh: >
          渲染交互式 HTML
          
      en: >
          Render the interactive HTML
          
deps:
  - kind: call
    to: kimi-code.libs.normify.engine
    label: {zh: "调用内核", en: "kernel calls"}
---
