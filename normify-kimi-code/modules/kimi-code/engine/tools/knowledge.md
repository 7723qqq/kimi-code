---
uid: e1e00007
id: kimi-code.engine.tools.knowledge
parent: kimi-code.engine.tools
name: {zh: "知识与记忆", en: "Knowledge & memory"}
description:
  zh: >
      注册工具名：Skill、Knowledge、memory_read/write/append/delete/list/str_replace、Lsp。
      
  en: >
      Registered tool names: Skill, Knowledge, memory_read/write/append/delete/list/str_replace, Lsp.
      
revision: 60e70d6896fce2a853b5a66abeba2b577029053e
updated_at: "2026-09-27T10:55:36.275Z"
fingerprint: 8f22e8c8e35ae06299fc07ff9cd462aa07f4111283683985b02ddf9854212469
source:
  - path: "packages/kimi-agent/src/tools/skill.rs"
  - path: "packages/kimi-agent/src/tools/memory_tool.rs"
  - path: "packages/kimi-agent/src/tools/memory_store.rs"
  - path: "packages/kimi-agent/src/tools/lsp_tool.rs"
apis:
  - protocol: rpc
    path: "Skill"
    description:
      zh: >
          按名称加载技能
          
      en: >
          Load a skill by name
          
  - protocol: rpc
    path: "Knowledge"
    description:
      zh: >
          查询知识库
          
      en: >
          Query the knowledge base
          
  - protocol: rpc
    path: "memory_read"
    description:
      zh: >
          读取 agent 记忆
          
      en: >
          Read agent memory
          
  - protocol: rpc
    path: "memory_write"
    description:
      zh: >
          写入 agent 记忆
          
      en: >
          Write agent memory
          
  - protocol: rpc
    path: "Lsp"
    description:
      zh: >
          语言服务查询
          
      en: >
          Language-server queries
          
---
