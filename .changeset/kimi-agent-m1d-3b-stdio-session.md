---
"@moonshot-ai/kimi-code": minor
---

Rust 引擎 stdio 传输升级为 EngineSession 会话句柄（M1d 3b）：napi 与 stdio 两个传输都通过进程级会话驱动 turn（准入/FIFO/pump/取消/背压引擎侧持有），`host/goal` 每 turn 现读保持 goal 预算接线。为 3c 的 turn 所有权翻转铺路。
