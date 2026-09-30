---
uid: e0e00005
id: kimi-code.engine.server
parent: kimi-code.engine
name: {zh: "服务器与 WS 网关", en: "Server & WS gateway"}
description:
  zh: >
      独立服务器：REST API、WebSocket 事件流、transcript 投影与会话托管。
      
  en: >
      Standalone server: REST API, WebSocket event stream, transcript projection and session hosting.
      
revision: 435e51cd310eb9df90ddb522a8d245cae01e86cf
updated_at: "2026-09-30T19:09:30.071Z"
fingerprint: c6103943175dbf0ddae4b9ae9908d236e278322f4529743d7e93f5d4ddb99366
source:
  - path: "packages/kimi-agent/src/server/mod.rs"
  - path: "packages/kimi-agent/src/server/hub.rs"
deps:
  - kind: dataflow
    to: kimi-code.engine.core
    label: {zh: "会话与事件状态", en: "session/event state"}
---
