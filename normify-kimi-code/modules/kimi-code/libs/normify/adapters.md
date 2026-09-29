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
      
revision: 779fa7ba58daaeed4dd885c941bf1c29d2fe902e
updated_at: "2026-09-29T11:43:39.004Z"
fingerprint: 0a26361ca5747e56c03275e946592b8f90ab5cb16029a0597eb32b3e1cae9b9b
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
