---
"@moonshot-ai/kimi-code": patch
---

Keep the Grep and Glob tools from walking ignored directories outside a git repository. Ripgrep only applies `.gitignore` rules inside a git repository, so a workspace that is not a repo had every `node_modules` and build output in the search path — a single search then read tens of thousands of extra files and saturated the machine. The tools now force the ignore rules to apply, which is what the workspace file-search path already did.
