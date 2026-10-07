---
"@moonshot-ai/kimi-code": minor
---

Show two decode rates in the footer instead of one: the rate of the step just finished, and the
session's average, side by side. They answer different questions — how fast the reply in flight went,
and how fast the session has been going — and they come from the same measurement, so they can only
disagree about which steps they cover, never about how they count.

A step whose decode window is shorter than 500 ms contributes no rate of its own, because at that
length the window is too short to say anything reliable about throughput: measured against a live
provider, a 300 ms window read 33–37% high while a 500 ms window read under 9%. The footer holds the
previous reading rather than showing a figure it cannot stand behind, and the session average keeps
accumulating throughout.
