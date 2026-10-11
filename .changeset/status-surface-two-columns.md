---
'@moonshot-ai/kimi-code': minor
---

Status strip above the editor becomes one box with two columns

The todo list, the approval prompt and the mid-turn updates were three regions
stacked vertically, and the container decided their placement, ordering,
blocking and focus by name. They now sit in one box: the todo list and the
approval prompt in the left column, the updates box in the right. A region
declares where it wants to go and what it is, so adding another one no longer
means editing the container.

Mouse: clicking a region folds or unfolds it, and clicking an approval's
printed option answers with it. Previously a click on the approval was consumed
by focus and changed nothing, so the one blocking interaction in the app was
the one thing a click could not touch. Clicking a folded approval now opens it,
and opening it no longer makes it impossible to fold shut again.

Keyboard: `Tab` moves the keyboard between the two columns while the strip has
focus; `Ctrl+N` keeps grabbing and releasing it. Arrow keys still mean whatever
the focused region says they mean — stepping through an approval's options in
the left column, scrolling the updates box in the right.

Mouse interaction exists in fullscreen mode only; the regular layout has no
mouse support, and its `Ctrl+N` entry point is unchanged.
