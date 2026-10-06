---
"@moonshot-ai/kimi-code": patch
---

Shift-Tab now cycles Plan and Spec instead of leaving whichever mode was active.

With neither active it enters Plan, a second press switches to Spec, and a third turns Spec off; the cycle continues from there. Previously it only left the active mode, so getting from Spec to Plan took two presses and the second one looked like it undid the first.

Shift-Tab no longer enters or leaves Swarm or Tower; those keep their own `/swarm` and `/tower` commands. Leaving Spec mode also clears the footer's spec stage, so the next spec cannot be labelled with the previous one's progress.
