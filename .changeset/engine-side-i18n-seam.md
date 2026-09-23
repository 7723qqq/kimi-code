---
'@moonshot-ai/kimi-code': minor
'@moonshot-ai/kimi-agent': minor
'@moonshot-ai/kimi-code-sdk': minor
---

Localize the engine's permission text, and show it in the approval prompt.

The reasons the local permission engine attaches to a verdict, the ACP approval
button labels, and the pure-native fallback messages now follow the host locale
instead of being hardcoded English. Resolution is a synchronous in-process
lookup against the locale JSON the host installs (`setEngineLocale` /
`clearEngineLocale`), so it works from the synchronous `permission::evaluate`
where a host round-trip cannot. An unwired host keeps the previous English
behaviour.

`PermissionCheckRequest` now carries the engine's `reason`, so an approval
prompt can say *why* it is asking — "access to sensitive file requires
approval: .env" — instead of only naming the tool. It rides the existing
`event.approval.requested` payload and the SDK's `ApprovalRequest` as an
optional field, and renders beneath the prompt's title. Hosts and payloads that
omit it are unaffected.

Adds `scripts/check-engine-i18n-parity.mjs`, wired into CI, which fails the
build when a Rust fallback drifts from the locale entry it mirrors, when a key
is missing from either language, or when an `engine.*` locale key has no
`LocalizedText` using it — the last of which is how a typo'd key would
otherwise render English forever, unnoticed.

The native file tools' and Bash's failure surface now follows the locale too:
the argument-validation errors, path/encoding refusals, no-match results and
command failures a user stops to read. Informational footers ("Total lines in
file", "Showing matches …") are deliberately still English, as are the
tool-protocol instructions that tell the model how to page through results.
