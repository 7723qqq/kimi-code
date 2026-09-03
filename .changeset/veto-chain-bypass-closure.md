---
"@moonshot-ai/kimi-code": minor
"@moonshot-ai/agent-core-v2": minor
---

Close the last two real instances of the native-path veto-chain bypass (P23). Audit result: of the nine host `onBeforeExecuteTool` listeners, staleGuard, goal approval/veto, external hooks, tool dedupe and the plan-mode write gate already have engine-native equivalents; the swarm batch rule and the tower-tool inert guard have no exposure (those tools never execute natively); the two real bypasses were swarm mode's `Agent` denial and the btw side-channel's full tool denial. Both are now resolved host-side into deny reasons (`agentToolVeto` / `toolsVeto` on the engine input, part of the session fingerprint) and enforced by a new engine veto gate that outranks permission, rejects affected native calls locally with the verbatim reason (no host fallback), and reports the denial via the `tool.native` event so the transcript keeps a terminal state. The tower #2/#3 bypasses remain known exemptions while the TOWER experiment flag stays dormant.
