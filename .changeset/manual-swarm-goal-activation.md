---
"@moonshot-ai/kimi-code": minor
---

Add manual activation for Swarm and Goal modes in the web UI.

Web users can now toggle Swarm mode from the composer modes menu and the mobile settings sheet, and create, pause, resume, or cancel goals inline. The underlying protocol and service layers accept the new `swarm_mode`, `goal_objective`, and `goal_control` runtime controls and log dispatch entries so the back-end RPCs can be wired without changing the front-end contract.
