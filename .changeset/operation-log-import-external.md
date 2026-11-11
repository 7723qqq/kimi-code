---
"@moonshot-ai/agent-core-v2": patch
"@moonshot-ai/kimi-code": patch
---

The experimental operation log no longer refuses every tool when the repository changed outside the log (for example an editor save, a build, or another session). Instead it imports the external change as its own undoable operation and continues, so the log stays a complete, recoverable history rather than blocking on a view mismatch. Undo, redo, and restore reconcile the same way: a diverged repository is imported first, then the action proceeds. Because the import is recorded as the most recent operation, undoing immediately after an external change reverses that import first.