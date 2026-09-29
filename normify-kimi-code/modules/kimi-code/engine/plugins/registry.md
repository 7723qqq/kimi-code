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
      
revision: 779fa7ba58daaeed4dd885c941bf1c29d2fe902e
updated_at: "2026-09-29T11:43:38.996Z"
fingerprint: 604ad12b8341f69731b74675b1bd42500f0b05640c333dea98aea5c21c3ee476
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
