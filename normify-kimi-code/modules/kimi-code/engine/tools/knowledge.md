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
      
revision: 7f51dbe916b917d5243c352efa2daf0c94bcb921
updated_at: "2026-10-01T15:12:03.019Z"
fingerprint: 16fd047280b15e883659b8ca1d6cc48862cb8b63c999b0f0a7f518934bbb6db6
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
