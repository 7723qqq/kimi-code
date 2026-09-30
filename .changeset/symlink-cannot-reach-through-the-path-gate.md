---
"@moonshot-ai/kimi-code": patch
---

A symbolic link inside the workspace can no longer be used to read a secret it points at. Following `notes.txt` to an environment file, out of the workspace, or nowhere at all is now refused with the reason, instead of quietly returning the contents.
