---
"@moonshot-ai/kimi-code": patch
---

Keep the bottom panel stack inside the terminal: each panel's height ceiling is now a total-row budget that accounts for its own borders and padding, the queue pane caps how many queued messages it draws (newest first, with a hidden count when there is room), and the dock declares a static ceiling per row. Previously a long Updates entry or a deep queue could push the editor and footer off screen — on a 6-row terminal the Updates box alone rendered 8 lines.
