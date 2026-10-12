---
"@moonshot-ai/agent-core-v2": patch
"@moonshot-ai/kosong": patch
"@moonshot-ai/oauth": patch
"@moonshot-ai/kimi-native-tools": patch
"@moonshot-ai/kimi-code": patch
---

One definition per number, and one account per credential (B3 of the 2026-10-12 audit).

**The request budget is measured in bytes** (`agent-core-v2`). `estimateLlmRequestBytes` summed `String.length`, i.e. UTF-16 code units, while the config item, the docs and the telemetry all say bytes. A CJK-heavy turn therefore measured about a third of its real size, so proactive media eviction fired only after the provider had already rejected the body, and `estimated_request_bytes` under-reported by the same factor. Every counter is now a UTF-8 byte count. Escape hatches are unchanged (`llm_requester.request_byte_budget`, `KIMI_LLM_REQUEST_BYTE_BUDGET`) — note that a CJK session's effective threshold is now about a third of what it was.

**A goal budget charges what the request cost** (`agent-core-v2`). The token budget counted output tokens only, but a real request carries 10-20x more input than output, so a 500k budget never fired. `chargeableTokens` (fresh input + cache writes + output, cache reads excluded) matches the native ledger, and `/goal` hard stops now happen at the number the user asked for — which means an existing budget value will trip earlier than it used to.

**Anthropic thinking budgets are clamped to `max_tokens`** (`agent-core-v2`). `high`/`on` hard-coded 32000 thinking tokens while pre-4 Claude models cap `max_tokens` at 8192 or 4096, and Anthropic requires the budget to be strictly smaller — every such turn failed with a provider 400 that the client could have predicted. The budget is now clamped below the real ceiling, and when even that is impossible (cap ≤ 1024) a local `ThinkingConfigError` (`budget-exceeds-cap`) names the two escape hatches instead of leaving it to the provider.

**Gemini usage is reported even without a finish reason** (`agent-core-v2`). The usage handler was gated on the same chunk carrying a `finishReason`, so blocked, filtered or truncated responses — which still carry `usageMetadata` — were charged zero tokens. The two conditions are independent now.

**Native and SDK paths read one usage rule** (`kosong`, `kimi-native-tools`). The Rust fast-path metadata carried no cache-write counter, so native-served turns reported `inputCacheCreation: 0` and an `input - cached` remainder that could go negative, while the SDK path reported both fields verbatim — the same response got two different token counts depending on which path served it. `cache_creation_input_tokens` is now decoded in Rust (both `message_start` and `message_delta`), carried through the napi metadata, and mapped by the same verbatim rule the SDK reader uses; a parity test drives one payload through both.

**The Responses reader rejects a contradictory cache split** (`kosong`). The Chat Completions reader had always rejected a DeepSeek `prompt_cache_hit/miss` pair that sums to more than the prompt total, but the Responses reader took it verbatim and inflated both buckets — the same payload got two classifications in one package. Both now share `resolveDeepSeekCacheSplit`, including the fallback to `input_tokens_details.cached_tokens`.

**Native fast paths authenticate as the SDK path does** (`kosong`). The per-request `auth` (the documented rotation entry point) was ignored on all three native branches, which sent the constructor credential instead — billing the wrong account and dropping per-request headers whenever the native addon happened to load.

**A failed token refresh cannot destroy a working credential** (`oauth`). `getValidAccessToken`'s fallback imported `~/.gemini/oauth_creds.json` and persisted it BEFORE checking whether it was usable, and an import with no `refresh_token` overwrote the stored one with an empty string — a single transient 5xx or a stale file forced a re-login. The import takes `persist: false` on that path, is written only after the usability check, and a missing refresh token keeps the stored value. The device-code endpoints also redact secrets from server-provided error text, as the rest of the OAuth surface already did.

**Logout is ordered against refresh** (`oauth`). `logout()` removed the token without taking the refresh lock, and a refresh that found the file missing "missing" fell back to its pre-lock snapshot — so a refresh already waiting on the lock completed and wrote the credential back, leaving a signed-out user still logged in. Logout now takes the lock (best effort) and a vanished file ends the refresh with `OAuthUnauthorizedError` instead of resurrecting it.

**ACP terminal login names the real binary** (`kimi-code`). The legacy `_meta['terminal-auth'].command` was `process.argv[1]`, which under a Bun single-file build is a `/$bunfs/...` virtual path — every client spawn of it failed with ENOENT, on every native install. A native build now advertises `process.execPath`; a script install (`npm i -g`, whose bin IS `dist/main.mjs`) keeps `argv[1]`, because `execPath` there would point at node/bun.

**`output_bytes` is a byte budget on the wire and in the reader** (`agent-core-v2`, `kap-server`). `readOutput`'s tail argument was applied as `slice(-tail)`, i.e. characters, while the route declared the honest `Buffer.byteLength` — a 4096-byte request returned up to 4x that for CJK text and re-decoded the whole 16 MiB log each poll. The tail is now a byte budget, sliced at a character boundary so the declared size is never exceeded.
