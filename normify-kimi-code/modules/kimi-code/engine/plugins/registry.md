---
uid: e4e00001
id: kimi-code.engine.plugins.registry
parent: kimi-code.engine.plugins
name: {zh: "插件注册表", en: "Plugin registry"}
description:
  zh: >
      插件注册表：SQLite 安装态、技能目录、MCP 配置、命令与 node 运行时重写。
      
  en: >
      The plugin registry: SQLite-backed install state, skill dirs, MCP configs, commands and the node-runner rewrite.
      
revision: 67ba21094b198c6b3276a9e9650565e17f1d9d40
updated_at: "2026-10-03T15:32:22.794Z"
fingerprint: 476306017c3ba89ec856be3a581b08b37a5911c5ec0563fb750f3543afa4dde7
source:
  - path: "packages/kimi-agent/src/server/plugins.rs"
apis:
  - protocol: rpc
    path: "install_plugin_from"
    description:
      zh: >
          从目录 id、source 或本地路径安装插件
          
      en: >
          Install a plugin from catalog id, source or local path
          
  - protocol: rpc
    path: "set_plugin_enabled"
    description:
      zh: >
          启用或禁用已安装插件
          
      en: >
          Enable / disable an installed plugin
          
---
