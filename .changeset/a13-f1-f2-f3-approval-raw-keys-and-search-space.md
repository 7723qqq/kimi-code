---
"@moonshot-ai/kimi-code": patch
---

Give the status strip a raw-key channel, so an approval's inline rejection reason can actually be typed and `Ctrl+E` preview opens (a13/F1 + a13/F2 of the 2026-10-12 audit). The editor only forwarded keys through `statusSurfaceKeyOf`, whose vocabulary (arrows, PgUp/PgDn, `[`/`]`, Enter, Esc, digits) carries no printable text and no `Ctrl+E`/`Ctrl+O`: a `requires_feedback` choice showed an input box that could not be typed into, Enter only re-prompted, and the panel's own ` · ctrl+e preview` hint pointed at a key that never arrived, leaving long diffs clipped to ten lines. The editor now offers each key to a new `onStatusSurfaceRawInput` before the normalized mapping; the surface hands it to the focused region's optional `handleRawInput`, and the approval panel consumes the whole keyboard while its input is up (so digits and Enter are text, not answers) or just `Ctrl+C`/`Ctrl+D`/`Ctrl+E`/`Ctrl+O` otherwise.

Also stop the searchable experiments list from stealing spaces (a13/F3): a space toggled the highlighted experiment even mid-query, so searching "web search" flipped two switches and Enter persisted them. The single-key toggle now applies only while the query is empty, and the space joins the query once searching has started.
