---
'@moonshot-ai/kimi-code': patch
---

Repair the session REST contracts so the bundled web UI works again: session detail, messages, status, goal and profile answer the shapes the API declares, sessions list paginates with a real `has_more`, tasks use the protocol field names, OAuth login is snake_case, capabilities are objects, plugin exports are zip, and `POST /config` applies every section of its patch schema. The interactive CLI also sends the engine's real system prompt again, so AGENTS.md, the skills catalog and the environment listing are present. Setting `merge_all_available_skills = false` now stops layering every discovered skill directory.
