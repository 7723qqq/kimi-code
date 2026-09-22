---
'@moonshot-ai/kimi-code': patch
---

A `locale = "undefined"` line in `tui.toml` no longer discards the whole configuration: it is read back as an unset locale (the default applies), and the settings writer no longer produces that literal — an unset locale now round-trips as a commented guide line.
