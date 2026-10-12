---
"@moonshot-ai/kimi-code": patch
---

Report a swarm-level failure as failed, let the Updates box fold again, and stop layout measurement from advancing the read-through (a12/F1 + a12/F2 + a12/F3 of the 2026-10-12 audit).

A swarm that threw after at least one member finished rendered `Completed.` in the header while its cells showed ✗: the total status read the members' phases before the swarm's own failure flag, so `markSwarmFailed`'s verdict was dead code for that caller. The swarm's own state now wins, with `aborted` still first.

The Updates box could be opened but never closed by clicking it: `hasHiddenContent` asked whether the box was folded, so an expanded box always reported "nothing hidden" and the surface's click fell through. It now compares the body's rendered height against the granted budget, the same answer the approval region gives, so a clipped body can be folded back.

Measuring the box for the surface's budget pass ran a full render, including the writes that follow the tail and stop the read-through. Measuring at the box's own cap — a larger budget than the surface then grants — pinned a following view to a tail the next paint scrolled away, so a layout pass skipped the unread middle of an update. Measurement is now pure layout.
