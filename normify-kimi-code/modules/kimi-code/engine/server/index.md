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
      
revision: dc564cfd4f7045437b3c0368cfe8b95ae10b2326
updated_at: "2026-10-02T14:00:48.408Z"
fingerprint: c1dc76c37aa3ab061e34319907d2847acaa75abf3a893b936cd0de5dffb23842
source:
  - path: "packages/kimi-agent/src/server/mod.rs"
  - path: "packages/kimi-agent/src/server/hub.rs"
deps:
  - kind: dataflow
    to: kimi-code.engine.core
    label: {zh: "会话与事件状态", en: "session/event state"}
---
