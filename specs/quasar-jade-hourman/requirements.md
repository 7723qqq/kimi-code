# Requirements: 2.6.3 Request-Correctness Tranche

## Goal

Implement the first approved, independently testable tranche of the full `@moonshot-ai/kimi-code` 2.6.3 tag alignment in this Bun-based fork. Port five upstream model-request/tool-selection behaviors into the existing `agent-core-v2` architecture; do not claim that this completes the full release alignment.

## Audience and outcomes

Kimi Code users and SDK hosts must observe these behaviors:

1. When a model cannot dynamically load tools, eligible tools marked deferred for dynamic disclosure are still sent as inline tool definitions, subject to existing profile and permission filters.
2. A retryable LLM attempt followed by context overflow can still compact history and complete the request; the recovered response and step projection are preserved.
3. A response with raw finish reason `repeat` is a retryable empty-response failure even if partial text or tool-call data was emitted.
4. A streaming response that ends without a finish event is a retryable provider failure, not a successful partial answer. Empty/reasoning-only responses retain their existing classification, and existing non-streaming protocol behavior, if present, is unchanged.
5. OpenAI-compatible usage under the first choice is retained when top-level usage is absent or null; top-level usage wins when both are present.

## Upstream source scope

These are the five behavior commits in the 2.6.3 release-tag comparison:

- `a29c2d0379e6ffe95b2bdeafe143bdf149815dac` — deferred-tool fallback.
- `1101ea7d60377c606094bf05497cb9bd0dc2242f` — repeated model responses.
- `cd83fdd96b65e2c96544b028111fe60c4869181c` — overflow recovery after an earlier retry.
- `1311098df26e08a5a4a5e86566646ca851b11e42` — incomplete streamed responses.
- `c15cc1c56155bdc20b7f84d41e530d8ceb870d7f` — OpenAI choice-level usage.

The duplicate model-resume commit does not represent an additional behavior. The written specification covers only these five fixes.

## Boundaries

- Production changes are limited to `packages/agent-core-v2` and a user-facing changeset for this tranche. Follow the fork's existing machine loop, LLM requester adapter, tool-select projection and OpenAI protocol-format boundaries; do not copy upstream paths that do not exist in this fork.
- Add regression coverage in existing owning test files. Exercise consumer-visible request behavior and the real local projection/settlement paths where the existing harness permits.
- Preserve valid responses, existing retry/timeout defaults, prompt history, model/tool filtering, persisted tool-selection state, and current API/wire shapes.
- Do not update package versions, release changelogs, or publish in this tranche. The eventual full-release metadata sync is a separate approved tranche; its changelog must not be duplicated by this changeset.

## Out of scope

Separate 2.6.3 sub-projects: legacy-session recovery when the configured default model is removed; session-index schema mismatch handling; deferred-tool dynamic-loading behavior beyond the no-dynamic fallback specified above; restored background-task prompt-only recording; invalid-config recovery; Tower wake-origin filtering; foreground-shell event origin routing; external Stop-hook lifecycle; subagent quiescence; Windows WebBridge stop/replace/restore; and final version/release-note synchronization.

No dependency changes, public API additions, server protocol changes, unrelated refactors, upstream-main merge, version bump, or publishing are required.