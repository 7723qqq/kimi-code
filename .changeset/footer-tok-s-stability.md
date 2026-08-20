---
"@moonshot-ai/kimi-code": patch
---

Footer tokens-per-second now uses provider-reported decode time and an exponential moving average so cached and batched responses no longer show inflated rates.