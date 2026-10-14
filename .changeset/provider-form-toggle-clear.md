---
'@moonshot-ai/kimi-code': patch
---

Deleting a model's thinking or beta API flag in the provider form now removes the stored value. Cycling the flag to "not declared" used to show it as removed while the write kept the old value.
