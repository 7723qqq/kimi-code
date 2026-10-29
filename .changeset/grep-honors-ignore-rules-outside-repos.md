---
"@moonshot-ai/kimi-code": patch
---

Keep a Grep or Glob from taking over the machine. The tools now ask ripgrep to apply the ignore rules even when the workspace is not a git repository, so a search no longer walks `node_modules` and every build output, and they cap ripgrep at four threads, so one search cannot saturate every core.
