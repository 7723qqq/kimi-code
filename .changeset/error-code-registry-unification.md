---
'@moonshot-ai/kimi-code': minor
'@moonshot-ai/kimi-code-sdk': minor
---

Error codes become one registry, and the codes that were being dropped now survive

Four separate lists of error codes disagreed with each other. The engine's
`ErrorCodes` registry and its hand-written `KimiErrorCode` type had drifted in
both directions: 32 registered codes were unrepresentable in the type, and 13
typed codes were never registered — so `isErrorCode()` returned false for them
and `toErrorPayload` rewrote them to `internal`. Eleven of those 13 were being
thrown by the SDK itself (`session.id_required`, `session.title_empty`,
`session.state_invalid`, the approval/question handler errors, and others), so a
caller saw `internal` with no code and no localized message. `KimiErrorCode` is
now derived from the registry, and all 13 codes are registered, which makes the
two impossible to drift apart again.

The SDK's `KIMI_ERROR_INFO` table mirrored 59 of the engine's codes. The other
109 crossed the RPC boundary as `internal`. All 109 are now declared with a
title, a retryable flag and where the code warrants one an action, and
`restateEngineError` logs a warning instead of downgrading silently — so a
future drift is observable rather than invisible.

The WebSocket event whitelist in the server declared 113 codes: 6 of them
(`activity.*`) are produced nowhere in the repository, and 61 real engine codes
were missing, including the storage and wire failures most worth reporting —
a `storage.io_failed` event failed validation and was dropped. The whitelist now
matches the registry exactly and a test pins the agreement.

`AttachmentError` now extends `Error2` and its five codes are registered, so an
attachment failure keeps its code instead of collapsing to `internal`. One call
site in `attachmentStore.ts` had its code and message arguments swapped, so the
error carried `'Attachment reference is invalid.'` as its code; that is fixed.

Provider transport failures keep their cause: `APIConnectionError` and
`APITimeoutError` (and the base class) accept the originating SDK error, so the
status, headers and parsed body behind a failed request are no longer discarded
when it is classified.

Compatibility: the `ErrorEvent.code` union only grows (136 to 168 codes), so
existing `switch` and comparison sites keep compiling and keep matching the same
codes. `KIMI_ERROR_INFO` gains entries; no existing entry changed its meaning.
The server's event whitelist only widens for real codes — the six `activity.*`
codes were removed, and nothing in this repository ever emitted them. Consumers
that hard-coded one of those six as a possible event code are affected; no such
consumer exists here. `AttachmentError` is still an `Error`, now also an
`Error2`; nothing in the repository branched on its previous exact type.
