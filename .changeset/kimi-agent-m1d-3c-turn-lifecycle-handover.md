---
"@moonshot-ai/kimi-code": minor
---

Rust 引擎接管 durable turn 生命周期（M1d 3c）：turn.prompt/started/cancel/ended 与 turn 遥测改由引擎单写，v2 loop 退成折叠方（`ownsTurnLifecycle` 能力位 + `onTurnEvent`/`onTurnTelemetry` 桥）。无双份折叠，transcript 与 undo 锚点以引擎 turn id 为准。
