---
"@moonshot-ai/kimi-code": major
---

The published CLI now requires the Bun runtime: `engines` is `bun >= 1.4.0` instead of `node >= 22.19.0`, and a Node-only install stops receiving binary updates. Reinstall through the install script or `bun add -g @moonshot-ai/kimi-code`; Windows users without Bun keep getting a message pointing at https://bun.sh.
