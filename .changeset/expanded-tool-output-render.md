---
"@moonshot-ai/kimi-code": patch
---

Speed up terminal rendering by reusing unchanged output lines across renders. Markdown blocks, shell execution output, truncated tool output, and the tool card spacer now cache their rendered lines and only re-render when their content or the terminal width changes, so long tool outputs no longer re-wrap on every frame.