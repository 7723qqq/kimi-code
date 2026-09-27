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
      
revision: 64fbdf60ddb2b5432773ef2fbc5b6fc95bf8a139
updated_at: "2026-09-27T10:30:28.790Z"
fingerprint: 4c99775a64eff055c081bdacb4d8f82c2e9c5cb6d490d802ae50e1970cd88215
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
    to: kimi-code.libs.i18n
    label: {zh: "文案与 locale", en: "localized strings"}
  - kind: call
    to: kimi-code.engine.napi
    label: {zh: "直连原生模块", en: "direct native imports"}
---