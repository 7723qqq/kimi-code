---
uid: e4e00002
id: kimi-code.engine.plugins.archive
parent: kimi-code.engine.plugins
name: {zh: "插件归档", en: "Plugin archives"}
description:
  zh: >
      插件归档：下载、解压、识别插件根并暂存进托管目录。
      
  en: >
      Plugin archives: download, unzip, detect the plugin root and stage into the managed directory.
      
revision: 18c71cdd8583b337dd80efc94225c9033f341f42
updated_at: "2026-10-03T16:26:56.330Z"
fingerprint: 9fe6c202be297d45d9e2fb776340b94df753e773321d37c778340f6dd9658d70
source:
  - path: "packages/kimi-agent/src/server/plugin_archive.rs"
apis: []
deps:
  - kind: call
    to: kimi-code.engine.plugins.registry
    label: {zh: "落地进注册表", en: "lands in the registry"}
---
