---
"@moonshot-ai/kimi-code": patch
---

Instruction files in subdirectories are now pointed out when a tool reaches into them, instead of only the one at the workspace root being mentioned once. A model that just read such a file is not told to read it again.
