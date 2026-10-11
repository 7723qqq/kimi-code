---
"@moonshot-ai/kimi-code": patch
---

Report a configuration section that fails validation when it is registered, instead of dropping it silently. A section whose values no longer passed its schema was removed from the effective config with no diagnostic, so the setting simply stopped applying — the session started with defaults and nothing said why. It now reports `Ignoring invalid config section '<domain>': <reason>`, matching how the neighbouring environment-overlay failure already behaved.
