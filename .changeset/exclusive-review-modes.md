---
"@moonshot-ai/kimi-code": patch
"@moonshot-ai/kimi-code-sdk": patch
---

Stop Plan, Spec, Swarm and Tower modes from being active at the same time.

Entering one of them now leaves whichever conflicting mode was active, so the mode badge no longer shows two states that disagree and the write restrictions of two modes can no longer combine to block every edit. Plan and Swarm may still run together.

Shift-Tab now leaves the current mode instead of only toggling Plan, so it works from Spec, Swarm and Tower mode too; with no mode active it still enters Plan as before.

`/spec` and `/swarm` now report an error when the mode did not actually change, instead of reporting success. `/status` gained Spec mode and Swarm mode rows, and the `status_line.command` payload gained `specMode`, `swarmMode` and `towerMode`.
