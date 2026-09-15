---
"@moonshot-ai/kimi-code": patch
---

Fix a crash when dismissing the update prompt with Enter. Restoring the terminal's raw mode from inside the keypress handler corrupted Bun's TTY handle, so the process segfaulted a moment later while the TUI was starting up. The restore now runs outside the input callback.
