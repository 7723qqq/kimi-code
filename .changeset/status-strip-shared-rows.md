---
'@moonshot-ai/kimi-code': patch
---

Keep the Updates box readable when the todo list is long

The status strip holds the todo list and the Updates box in one band, half the
width each. Its row pool was handed out in priority order, and the todo list
outranks the Updates box — so a long list took the rows the box needed and left
the rest of that column blank underneath. An expanded list was the worst case
because the region reports the height of the whole list on purpose, to reserve
room for the fold; collapsing the list, or having an approval on screen (which
takes the todo list's slot), was what made the box display fully again.

The two informational regions now divide the pool instead: each takes at most
its share, a region that wants less than its share leaves the surplus to the
others, and a region is never cut below the rows it declares it cannot draw
anything readable without — the Updates box needs its title row plus one body
row, and a one-row grant is the stub it folds itself into. A blocking approval
is still served first with exactly what it asked for.

**Behaviour change**: when both panels have content the todo list no longer
shows every row the strip could give it — it keeps its half, and the Updates box
keeps the other half. On a tall terminal with a short todo list nothing changes
(a lone region still takes the whole strip); the difference appears only while
both have something to show.
