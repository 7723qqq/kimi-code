---
"@moonshot-ai/kimi-code": patch
---

Fix swarm mode having no effect in the terminal: the mode never reached the model, its end was never announced, and the indicator could stay on after the task finished. Swarm members now also report completion, failure, or cancellation instead of appearing to run forever.
