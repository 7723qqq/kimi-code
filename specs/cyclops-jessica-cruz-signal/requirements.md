# Official Web protocol alignment

## Goal

Make the fork's server work with the official Web bundle already shipped in `apps/kimi-code/dist-web`, rather than maintaining superficially similar REST and WebSocket schemas whose behavior differs. The primary audience is users of `kimi web`, including long-running sessions and reconnecting clients.

The reference artifact is `assets/index-Y30h7qWu.js`, selected by `index.html`. Read-only Git comparison found no differences between the local `dist-web` and upstream commit `f082f04a09`. This is a pinned compatibility target, not a claim that it is the latest remote release.

## Confirmed gaps

- The bundle sends flat `subscribe`/`unsubscribe` commands with `request_id`, and consumes `turns`, `turn.*`, `item.*`, `notice`, and flat interaction/task/agent frames. It does not use `subscribe_v2`. Several existing docs still describe the older protocol.
- `ConversationFeed.rebuild()` currently projects `IAgentContextMemoryService.get()`, a model-context view, instead of the recorded conversation. It invents timestamps from message positions. Compression and retry can change this view independently of the visible conversation.
- `conversationFold.applyMessage()` never fills the step tracks required by `ConversationFeed.liveTarget()`. The live path can therefore discard assistant/thinking/tool deltas despite matching their event names.
- Cold projection loses recorded turn numbers, steps, and interaction/subagent associations. The bundle uses `turn_number` for file history/fork targets, `step_index` for presentation, and `interaction_id` plus `awaiting_approval` for approval state.
- The local participant API lacks the replay lifecycle and custom-undo/mutable-participant features used by the corresponding upstream feed. Simply restoring the upstream feed file is insufficient.

These are code/artifact observations. Browser reproduction remains part of implementation verification, not a completed claim.

## Requirements

1. Preserve the official bundle unchanged. Its actual client behavior determines the compatibility contract; matching server types alone is insufficient.
2. Restore a single recorded-event conversation projection for live and cold views. Compaction must not delete already-visible conversation history; undo must remove the intended turns, not unrelated history.
3. Preserve recorded turn numbers and timestamps, stable turn/item identifiers, steps, reasoning timing, tool displays/results, approval/question associations, subagent references, and task links when the source records provide them. Do not invent metadata missing from legacy records.
4. Deliver live streaming through the official turn/item protocol: start a containing turn before its items, append deltas to the correct item, settle it once, and remove abandoned retry items without duplicate or missing content.
5. Preserve subscription ordering and recovery: successful command response precedes its initial conversation page and pending interactions; page delivery buffers concurrent live changes; reconnect, unsubscribe, disposal, and restore failure do not leak listeners or apply stale generations.
6. Audit the REST methods called by the pinned bundle against server registrations, request validation, response projections, and errors. Record and fix confirmed incompatibilities inside this Web-facing surface. Separate implemented, verified, and unresolved cases.
7. Keep the fork's machine-based execution engine, session locking, security validation, TUI behavior, and Operation Log functionality. Adapt the projection/dispatcher boundary rather than replacing the execution engine.
8. Validate using the unchanged official bundle against a disposable local server with deterministic model responses, plus focused protocol tests, owning-package suites, builds, and performance checks for long-history replay.

## Scope and exclusions

Included: kap-server conversation fold/feed/routes/subscriptions; the core dispatcher features necessary to support that projection safely; consumer contract fixes shown by the pinned bundle; protocol docs and upstream applicability records.

Excluded: updating the bundled frontend to a different release, editing minified assets, adding unrelated upstream features, replacing the machine loop with `packages/core`, changing external provider APIs, publishing, committing, or migrating/deleting user databases.

The prior uncommitted fixes are the baseline and must survive. Existing repository conventions are owned by `AGENTS.md`, `DEVELOP.md`, and `CONVENTIONS.md`.
