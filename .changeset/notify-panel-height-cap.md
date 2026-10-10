---
"@moonshot-ai/kimi-code": minor
---

Cap the Updates panel (Ctrl+N) at 12 rows or half the terminal, whichever is smaller, and let a focused panel scroll the current update with `↑`/`↓`. Previously the panel rendered each update at its natural height, so a long update pushed the editor and footer off screen with no way to reach the hidden rows. Stepping between updates moved from `↑`/`↓` to `[`/`]` (also `PgUp`/`PgDn` outside fullscreen, where those keys belong to the transcript); the panel's title now reports how many rows are out of view.
