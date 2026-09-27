---
uid: e1e0b431
id: kimi-code.engine.tools.basics
parent: kimi-code.engine.tools
name: {zh: "核心文件与 shell 工具", en: "Core file & shell tools"}
description:
  zh: >
      注册核心工具名：Read、Write、Edit、Bash、Grep、Glob、ListDirectory 与 goal/cron/task/ask 族。
      
  en: >
      Registered core tool names: Read, Write, Edit, Bash, Grep, Glob, ListDirectory and the goal/cron/task/ask families.
      
revision: 60e70d6896fce2a853b5a66abeba2b577029053e
updated_at: "2026-09-27T10:55:36.276Z"
fingerprint: 4983edbbe563221282ca0d3720a3f89bfd34a9c9447633f1bcf674a35324c92c
source:
  - path: "packages/kimi-agent/src/tools/core_tool_defs.rs"
  - path: "packages/kimi-agent/src/tools/sandbox.rs"
  - path: "packages/kimi-agent/src/tools/goal_tools.rs"
  - path: "packages/kimi-agent/src/tools/cron_tools.rs"
apis:
  - protocol: rpc
    path: "Bash"
    description:
      zh: >
          运行 shell 命令
          
      en: >
          Run a shell command
          
  - protocol: rpc
    path: "Read"
    description:
      zh: >
          读取文件
          
      en: >
          Read a file
          
  - protocol: rpc
    path: "Edit"
    description:
      zh: >
          编辑文件
          
      en: >
          Edit a file
          
  - protocol: rpc
    path: "Write"
    description:
      zh: >
          写入文件
          
      en: >
          Write a file
          
  - protocol: rpc
    path: "Grep"
    description:
      zh: >
          搜索文件内容
          
      en: >
          Search file contents
          
---
