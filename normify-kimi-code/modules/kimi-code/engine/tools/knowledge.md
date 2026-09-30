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
      
revision: 435e51cd310eb9df90ddb522a8d245cae01e86cf
updated_at: "2026-09-30T19:35:42.952Z"
fingerprint: 7baef776cdfed96cc2bad0663f7e39a0313a605bc930b637b07a5b7d965c944f
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
