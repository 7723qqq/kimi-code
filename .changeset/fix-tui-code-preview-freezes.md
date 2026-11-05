---
"@moonshot-ai/kimi-code": patch
"@moonshot-ai/pi-tui": patch
---

Stop large Write/Edit previews from freezing the whole window: code previews now highlight only the lines they draw, and the approval strip no longer repaints its hidden body every frame. The status strip now uses the same pointer rules and coordinate translation as every other dialog, so approval clicks respect the settling guard and the wheel scrolls the expanded body. Pointer hit tests no longer re-render a whole subtree on every motion event at an unseen width, and full-screen pointer targets are indexed once per frame instead of walking the whole layout tree on every motion event.
