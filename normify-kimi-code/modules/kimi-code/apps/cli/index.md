---
uid: a0e00001
id: kimi-code.apps.cli
parent: kimi-code.apps
name: {zh: "CLI/TUI 主程序", en: "CLI & TUI app"}
description:
  zh: >
      终端主应用：命令解析、TUI 交互、会话编排、斜杠命令与插件面板，经 node-sdk 驱动引擎。
      
  en: >
      The terminal app: command parsing, TUI, session orchestration, slash commands and the plugin panel, driving the engine via the node SDK.
      
revision: 67ba21094b198c6b3276a9e9650565e17f1d9d40
updated_at: "2026-10-03T15:32:22.776Z"
fingerprint: a9c95ca649784914f77d1efd8484564bbf88862d2f9e6bab0db98a6361747bfe
source:
  - path: "apps/kimi-code/src/main.ts"
  - path: "apps/kimi-code/src/cli/commands.ts"
  - path: "apps/kimi-code/src/tui/kimi-tui.ts"
deps:
  - kind: call
    to: kimi-code.sdk.node
    label: {zh: "经 SDK 驱动引擎", en: "drives engine via SDK"}
  - kind: call
    to: kimi-code.libs.tui
    label: {zh: "TUI 框架", en: "TUI framework"}
  - kind: call
    to: kimi-code.libs.i18n-shared
    label: {zh: "locale 探测与共享类型", en: "locale detection + types"}
  - kind: reference
    to: kimi-code.libs.i18n-catalog
    label: {zh: "词条键的类型来源", en: "key types only"}
  - kind: call
    to: kimi-code.engine.napi
    label: {zh: "直连原生模块", en: "direct native imports"}
---
