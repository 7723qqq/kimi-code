---
"@moonshot-ai/kimi-code": patch
---

Follow upstream #4013 and roll back the workspace trust-boundary hardening (#3964). The engine's own git calls no longer pin repo-local `core.hooksPath` / `fsmonitor` / external-diff configuration, the file tools no longer re-resolve read and write targets through symlinks to block an aliased `.kimi-code/local.toml`, and the project-local config applies without workspace-trust gating (its `additional_dir` entries are also no longer rejected for resolving to your home directory or the filesystem root). The rationale is upstream's: once you trust a repository, content inside it is your own responsibility, so the engine stops defending against it — only the pre-trust window stays guarded.
