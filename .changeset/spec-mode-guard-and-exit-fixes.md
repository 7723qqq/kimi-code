---
"@moonshot-ai/kimi-code": patch
"@moonshot-ai/kimi-code-sdk": patch
---

Fix four defects in spec mode's write guard and exit flow.

- The write guard decided containment lexically, so a path inside the spec directory that was a symlink to somewhere else passed the check while the write landed outside. Containment is now confirmed against the real path.
- A tool whose file accesses the guard could not inspect — including the `ToolAccesses.all()` that tools such as `Team` declare, and the default the executor applies when a tool declares no accesses at all — was treated as having nothing to check and allowed through. The guard now denies an access kind it cannot inspect.
- `clear()` emptied the three documents instead of removing them, leaving a spec directory whose contents still counted as a spec. It now deletes the documents, keeping the directory.
- `spec_submitted` was emitted twice per exit with two different document counts, and an auto-approved spec was reported as user-approved. The event is now emitted once with the real count, and the unreviewed path reports a distinct outcome.

Exiting and cancelling spec mode were indistinguishable once persisted; the replay state now records which one ended the session. `ExitSpecMode` also reads the three documents once instead of three times per call.
