---
"@moonshot-ai/kimi-code": patch
---

Bound the memory kept for failed session resumes: at most 64 failed session ids are retained, oldest first out, and the table is cleared on dispose. A failure that settles after shutdown is no longer recorded. `whenResumeSettled` still throws the original error for a retained failure, and a call that observed the failure before it was evicted keeps throwing it.
