---
'@moonshot-ai/kimi-code': patch
---

Stop renaming a provider whose identity is owned outside `config.toml` — the `/login` account, an Open Platform id, or a custom-registry import — since the next login or refresh re-adds the original id beside the copy; rename one by editing `config.toml` by hand. Also refuse `kimi provider remove` for the `/login` account unless `--force` is passed.
