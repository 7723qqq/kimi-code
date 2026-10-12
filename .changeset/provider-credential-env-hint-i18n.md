---
'@moonshot-ai/kimi-code': patch
---

Translate the credential-env hint a provider import prints in the TUI, instead of leaving it in English

When an imported provider declares a credential env var, `/provider` printed a
hardcoded English sentence while `kimi provider add` printed the same sentence
from the locale tree. Both now use that one key, so the hint is translated and
reads identically in both front ends.
