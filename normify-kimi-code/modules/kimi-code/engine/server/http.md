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
      
revision: 7f51dbe916b917d5243c352efa2daf0c94bcb921
updated_at: "2026-10-01T15:12:03.017Z"
fingerprint: 7ab3d51e2b107ad6dc71e54b5188d680d37ac94c4569bf8933d5476cb55a61f0
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
