---
"@moonshot-ai/kimi-code": patch
---

Keep Home, End, PageUp and PageDown working while the fullscreen transcript scrolls. Fullscreen took those keys for transcript scrolling as soon as the conversation was long enough, so the prompt could not move its cursor to either end of the line and a docked dialog (help, approval preview, task list, trust prompt) could not page its own content.

---
"@moonshot-ai/kimi-code": patch
---

Show the todo list, the pending approval and the mid-turn updates again in the default (non-fullscreen) interface. Their shared status strip was not mounted, so the todo list never appeared and an approval prompt was invisible while still blocking submission.

---
"@moonshot-ai/kimi-code": patch
---

Stop claiming "Copied!" for a mouse selection that never reached the clipboard. Fullscreen selection copy now uses the same verified clipboard path as `/copy` and reports failure when only the unverified terminal escape was available.
