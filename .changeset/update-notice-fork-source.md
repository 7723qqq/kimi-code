---
'@moonshot-ai/kimi-code': patch
---

When the install source cannot be detected (a source checkout, which is how this fork runs), the update notice now points at `git pull && bun run build` in the checkout instead of `npm install -g @moonshot-ai/kimi-code` — that npm package is the upstream project's, and installing it would replace the fork with the official build.
