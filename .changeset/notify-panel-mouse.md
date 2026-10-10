---
"@moonshot-ai/kimi-code": patch
---

Make the Updates panel (Ctrl+N) mouse-interactive, the same way the transcript's fold blocks are. The wheel over the box scrolls the current update instead of falling through to the transcript, and it no longer takes keyboard focus — browsing is not `Ctrl+N`, so the next keystroke still goes to the editor. Scrolling up stops the view from following new updates until you scroll back to the bottom. Clicking a tab switches to that agent; clicking `+N done` expands the folded agents and the tab becomes `−N done` so the same spot folds them back. Clicking anywhere else on the box folds or unfolds it, through the same capability the transcript's folded cards use.

Fixes two defects in the previous release of this feature: a `+N done` click did nothing because the handler acted on both the press and the synthesized click, toggling twice; and expanding the folded group removed its tab, leaving no way to fold it again.
