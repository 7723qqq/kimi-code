---
"@moonshot-ai/remote-control": patch
---

Bound the Remote Control tunnel on both sides: cut off a request whose chunks carry no payload, cap a tunneled response at 32 MiB (configurable through `maxHttpResponseBytes`), and close the previous socket pair when the relay reopens an already-open stream id instead of leaking it.
