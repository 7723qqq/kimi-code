---
uid: e1e0000a
id: kimi-code.engine.server.ws
parent: kimi-code.engine.server
name: {zh: "WS 网关", en: "WS gateway"}
description:
  zh: >
      WS 网关：/api/v1/ws、hub 扇出、协议信封与交互回路。
      
  en: >
      WS gateway: /api/v1/ws, hub fan-out, protocol envelopes and interaction round-trips.
      
revision: 18c71cdd8583b337dd80efc94225c9033f341f42
updated_at: "2026-10-03T16:26:56.337Z"
fingerprint: a4023a2248b187da0aaa152254bb8da5d0a0cfb8a5849b541f9559655bb322af
source:
  - path: "packages/kimi-agent/src/server/ws.rs"
  - path: "packages/kimi-agent/src/server/ws_protocol.rs"
  - path: "packages/kimi-agent/src/server/hub.rs"
apis:
  - protocol: ws
    path: "/api/v1/ws"
    description:
      zh: >
          WebSocket 事件流
          
      en: >
          WebSocket event stream
          
---
