---
uid: e5e00001
id: kimi-code.engine.napi.bindings
parent: kimi-code.engine.napi
name: {zh: "NAPI 导出", en: "NAPI exports"}
description:
  zh: >
      napi 导出面：会话创建、插件注册表导出、工具回调与遥测接线。
      
  en: >
      The napi export surface: session creation, plugin registry exports, tool callbacks and telemetry wiring.
      
revision: 50b922733b1fa9ebbaeb783d689f3f4bc68d98bb
updated_at: "2026-10-04T09:09:15.224Z"
fingerprint: e761f269816cf22e549c1ecd5c3fa2a3417b69362c6448e90ef4c75e975d90d2
source:
  - path: "packages/kimi-agent/src/napi_bindings.rs"
apis:
  - protocol: rpc
    path: "initPluginStore"
    description:
      zh: >
          在数据目录上打开插件注册表
          
      en: >
          Open the plugin registry against a data dir
          
  - protocol: rpc
    path: "pluginInstall"
    description:
      zh: >
          从 id、source 或本地路径安装插件
          
      en: >
          Install a plugin from id, source or local path
          
  - protocol: rpc
    path: "pluginList"
    description:
      zh: >
          列出已安装插件
          
      en: >
          List installed plugins
          
deps:
  - kind: call
    to: kimi-code.engine.plugins.registry
    from_api: "rpc:pluginInstall"
    to_api: "rpc:install_plugin_from"
    label: {zh: "由注册表支撑", en: "registry-backed"}
---
