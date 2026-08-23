---
"@moonshot-ai/kimi-code": patch
---

Reject oversized RESP requests from their declared bulk length instead of buffering the whole payload, avoiding large redundant copies and unbounded memory retention on the wire.
