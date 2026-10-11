---
"@moonshot-ai/kimi-code": patch
---

Fix the built-in Rust engine never loading in a build that shipped it. The addon was compiled as `index.<platform>.node` while the loader looked for a file whose name starts with `kimi_agent`, so the check never matched, the engine silently fell back to the JavaScript loop, and the fifteen integration tests covering it were skipped rather than failing.
