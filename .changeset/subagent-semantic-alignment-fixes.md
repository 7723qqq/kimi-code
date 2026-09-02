---
"@moonshot-ai/kimi-code": minor
---

Semantic alignment fixes from a TS↔Rust review of the subagent paths: native `resume` turns now distill their summary under the same profile policy as the initial run (v2 runs every subagent turn through `distillSummary`), and a max-token-truncated subagent turn fails the run with the verbatim v2 error (`Subagent turn failed before completing its final summary: reason=max_tokens`) instead of being reported as a successful completion with a truncated summary. Distillation usage accumulation and the failure event surface are shared between foreground, resume and background paths.
