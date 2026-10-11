---
"@moonshot-ai/kimi-code": patch
---

Fix the status strip's bottom edge and the updates box's mouse behaviour

The strip's frame closed on a grey line under a focused unit: the bottom border
was painted with the resting border colour unconditionally, while the top edge,
the side bars and the rules followed the focused region. It now follows the last
unit's chrome like the rest of the frame.

The updates box no longer needs a priming click before the wheel does anything
(the first wheel was computed from a stale offset, produced the tail position
the render had already pinned, and got swallowed as "no move"), and clicking it
no longer takes the keyboard — the pointer reads, `Ctrl-N` owns the keys, and a
click folds or unfolds the box exactly like clicking a tool card.

A newly arrived update also opens at its **top** and is read downward on the
panel's own timer, stopping at its end; the next update restarts from the top,
and scrolling by hand takes over immediately.

The approval prompt's folded summary now prints one option per row instead of
packing them into as few rows as the width allows. The numbering and the
clickable spans no longer move with the terminal width.
