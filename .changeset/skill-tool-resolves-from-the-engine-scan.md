---
"@moonshot-ai/kimi-code": patch
---

Fix the `Skill` tool: it now resolves the skill from the engine's own scan — the same roots and the same `merge_all_available_skills` policy the system prompt's `# Skills` section is rendered from — instead of depending on a host state-bridge domain that was never implemented. The tool previously failed every call with `State read error: [-32001] unknown state domain: skill`, and the failure was misreported to the model as an unknown domain rather than the intended "this host cannot load skills" message, because the bridge fallback replaced the host's error with its own. The host bridge is kept as the fallback for a skill only the host knows about.
