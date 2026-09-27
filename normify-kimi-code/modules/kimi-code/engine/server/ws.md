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
      
revision: 64fbdf60ddb2b5432773ef2fbc5b6fc95bf8a139
updated_at: "2026-09-27T10:29:21.420Z"
fingerprint: 08f5a8a4fccddddbd40eb26d68c162eba62d01b313a2fafcf879c5b08fe12cd4
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
