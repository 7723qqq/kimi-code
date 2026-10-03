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
      
revision: 67ba21094b198c6b3276a9e9650565e17f1d9d40
updated_at: "2026-10-03T15:32:22.801Z"
fingerprint: ff232bccd30fe26a6462dc1730d09a29b697b5fe247490d3638103ad18472b03
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
