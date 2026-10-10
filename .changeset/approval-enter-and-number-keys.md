---
'@moonshot-ai/kimi-code': patch
---

Answer an approval with Enter or its printed number

The approval prompt takes the keyboard when it appears and lists one numbered
option per row, but only the arrow keys reached it. Pressing Enter did nothing,
and pressing a number did nothing either: the editor forwarded ←/→, ↑/↓,
PgUp/PgDn, `[`/`]` and Esc to the status strip and dropped every other key, so
the approval's own Enter and number handling was never called.

This was invisible from the tests because they answered the approval by calling
the region directly — `approval-region.ts` already implemented both Enter and a
`handleNumber` quick-pick — so the capability was covered while the path to it
was not. The forwarding table is now exercised end to end, which is the layer
that was wrong.

Enter now submits the highlighted option, and the printed number submits that
option directly, without expanding the approval first. Both only apply while the
strip holds the keyboard, which it does whenever an approval is up, so the
editor keeps Enter for a newline and the digit keys for typing at every other
time. Digits are decoded the same way the rest of the editor decodes them, so
they still work in terminals using the Kitty keyboard protocol.

Clicking a printed option already answered with it; that is unchanged.
