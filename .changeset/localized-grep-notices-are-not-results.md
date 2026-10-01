---
"@moonshot-ai/kimi-code": patch
"@moonshot-ai/kimi-agent": patch
---

Read the Grep and Glob notices the engine renders in your language as notices instead of as search results, and localize the Glob paging report: a localized "no files matched" line no longer counts as a file, the count-mode totals and page windows survive translation, and a transcript recorded before you switched language still parses. The lines that tell the model how to continue a search stay in English on purpose — they are part of the tool's contract, not interface text.
