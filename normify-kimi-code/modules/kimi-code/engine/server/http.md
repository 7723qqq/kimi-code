---
uid: e1e00009
id: kimi-code.engine.server.http
parent: kimi-code.engine.server
name: {zh: "REST API", en: "REST API"}
description:
  zh: >
      REST 面：插件/工作区/会话/配置路由、fs 路由、鉴权与宿主守卫。
      
  en: >
      REST surface: plugin/workspace/session/config routes, fs routes, auth and host guard.
      
revision: 5d7ef5644a0810da5d401c2951b5e5cd2f441df9
updated_at: "2026-10-03T10:50:05.007Z"
fingerprint: 90f6b7a0ba70f1fff9626d898fec65ae595f3c825f9ed03a8c6e86636854a6e9
source:
  - path: "packages/kimi-agent/src/server/mod.rs"
  - path: "packages/kimi-agent/src/server/auth.rs"
  - path: "packages/kimi-agent/src/server/fs_routes.rs"
apis:
  - protocol: http
    method: GET
    path: "/api/v1/plugins"
    description:
      zh: >
          列出已安装插件
          
      en: >
          List installed plugins
          
  - protocol: http
    method: POST
    path: "/api/v1/plugins"
    description:
      zh: >
          安装、启用、禁用或移除插件
          
      en: >
          Install / enable / disable / remove a plugin
          
  - protocol: http
    method: GET
    path: "/api/v1/files"
    description:
      zh: >
          静态文件与文件系统路由
          
      en: >
          Serve static files and fs routes
          
---
