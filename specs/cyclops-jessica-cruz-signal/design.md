# Design

## Recommended approach

Restore the upstream recorded-event conversation read model while retaining the fork's execution engine. Adapt the source corresponding to `f082f04a09`, including the relevant #4663, #4730, #4772, #4789 and #4893 behavior, rather than designing another parallel Web protocol.

```
Existing machine engine
  -> durable ContextAppendMessage / ContextAppendLoopEvent / turn / interaction / task records
  -> IEventDispatcher conversation participant
  -> ConversationState (turns, steps, items, undo anchors)
  -> ConversationFeed diff + volatile overlays
  -> REST turns page / WebSocket frames
  -> unchanged official dist-web
```

`IAgentContextMemoryService.get()` remains the model-context source; it ceases to be the authoritative conversation-history source. The retained transcript/Operation Log surface stays independent and is not deleted.

## Artifact and contract inventory

- Pin the hash and Git reference of `apps/kimi-code/dist-web`, with `index.html` as the entry selector.
- Inspect the REST client and socket client in `assets/index-Y30h7qWu.js`. The client includes session/profile/prompts/steer/undo/fork, workspace/files, plugins/capabilities, providers/config, OAuth, and task operations; this inspection does not by itself prove runtime reachability of every method.
- Maintain a compatibility matrix in this spec's implementation progress file, citing bundle locations, corresponding server entry points, tests and unresolved dependencies. Use existing repository searches, TypeScript parsing support and API surface tests; do not introduce another parser dependency or a synthetic replacement frontend.
- The earlier REA attempt failed at worker startup (`unknown option --max-old-space-size=1024`). Direct source inspection and Git comparison are the available evidence; no REA semantic result is claimed. Tool installation/configuration repair is not required for this migration.

## Dispatcher adaptation

Files: `packages/agent-core-v2/src/state/eventDispatcher.ts`, `eventDispatcherService.ts`, `state.ts`, and their existing tests.

Extend `DurableAgentRuntimeParticipant` with optional replay lifecycle callbacks, custom undo, and explicit mutable replay. Default behavior for existing participants is unchanged. The implementation follows the upstream semantics but preserves this fork's `commit(state, silent)` contract and one-notification-per-restore behavior.

- Before replay, retain the last published conversation state; expose no partially replayed page.
- Stage mutable participant state privately and publish a frozen result only after successful replay. Failures discard staged state and retain the previous published view; they must not corrupt its object graph.
- Apply the same rules to initial attach, late attach, restore reruns, and disposal during queued attachment.
- Mutable replay cannot use implicit checkpoint snapshots. Require a custom undo handler when the participant is undoable, and reject invalid combinations before attachment.
- Ensure the append-message wrapper performs both the undo-anchor bookkeeping and the participant transition. The local `expandedRuntimeFolds` currently returns at an anchor before invoking the domain transition, which cannot serve the restored conversation fold.
- Keep replay queues and waiter resolution bounded by existing lifecycle rules; verify recovery after a failure rather than suppressing it.

This deliberately reopens #4893: the previous not-applicable verdict was valid while this fork had no conversation participant. This design introduces that consumer, so the upstream optimization becomes relevant. It does not imply adoption of upstream's loop journal or `packages/core`.

## Recorded conversation fold

Files: `packages/kap-server/src/services/conversation/conversationFold.ts`, `conversationItems.ts`, `conversationFeed.ts`, `conversationService.ts`, and `protocol/conversation.ts`.

Restore `applyConversationRecord` and the upstream event handlers for turn prompts/steers/cancellation, step begin/end/content/tool calls/results, interruptions/retries, interactions, subagent spawns, tasks, compaction, clear and undo. Preserve the fork's already-correct media/path redaction and tool-result note handling.

The fold owns stable IDs and per-step metadata. Legacy message records remain supported as fallback input; current records use their actual turn and step identity. Preserve the prior numeric tool-lookup optimization where its invariants hold, but invalidate/rebuild indexes on undo and reset. Correctness takes precedence over retaining an index whose coordinates no longer match the restored arrays.

`ConversationFeed` attaches the participant before initial restore or via `attachLate` after restore. It no longer schedules whole-context rebuilds from `ContextSpliced`, `TurnPrompt`, or `PromptCompleted`. The participant transition is authoritative for durable facts; assistant/thinking/tool-input/output deltas remain transient overlays keyed by the same item IDs as the durable fold. A sealed item replaces its matching overlay without duplicate final text. Retry/reset removes only the affected step's unfinished items.

Use current core events (`ToolProgress`, current loop-record shapes) through a small translation at this boundary when upstream names/types differ. Do not add a second execution or tool-progress subsystem merely to match an upstream internal class name.

Retain `task_id` support from the preceding batch. Durable task records establish associations; restored task state may supply supplementary known links, but must not recreate removed tools. Keep `TURN_NOT_FOUND=40422` and `AGENT_NOT_FOUND=40421`: no literal reference to either numeric value or domain-code string was found in the pinned main bundle; runtime error-path tests must confirm compatibility. Reintroducing a known collision is not the default alignment strategy.

## Subscriptions and REST

Files: `transport/ws/v1/wsConnectionV1.ts`, `sessionEventBroadcaster.ts`, `protocol/ws-control.ts`, `routes/conversation.ts`, plus confirmed REST mismatches from the artifact inventory.

- Keep the official flat `subscribe`/`unsubscribe`/`response` shape. Existing transcript options remain solely for the retained Operation Log clients.
- Separate subscription reservation from snapshot delivery so response ordering is deterministic rather than dependent on await/microtask timing.
- Seed one requested agent with `turns`, then buffered live frames; maintain generation checks through reconnect, close, restore and unsubscribe.
- Send pending interactions after the successful response, because the actual frontend clears its interaction cache on that response.
- Unknown agent/session and restore failure produce the documented error/`turns.failed` path, never a success with permanently empty content.
- Compare REST request fields and projected responses against the actual client methods, not only OpenAPI shape. Fix demonstrated differences with contract tests; do not silently widen validation or grant additional filesystem access.

## Verification strategy

1. Extend existing fold/feed tests to use real recorded event sequences, not just legacy messages.
2. Extend core dispatcher tests with replay rollback, late attachment, custom undo and mutable staging cases from the applicable upstream tests.
3. Add a Web contract integration test alongside kap-server tests, using `startServer`, the real socket, temporary home/workspace, and deterministic model stream. Exercise the exact request frames extracted from the official client and verify complete response sequences.
4. Launch the pinned official bundle against the same disposable test setup. Verify a normal prompt streams before completion, tool state/progress and approval are visible, reload/reconnect preserves content, compaction retains displayed history, and undo/fork/file-history act on the displayed turn. Capture screenshots and network evidence; no live credentials or external model calls are needed.
5. Measure cold replay over fixed 1k/4k/8k event fixtures before and after. Verify final fold equality and prove clone/commit work is per replay rather than per record; timings are supporting evidence, not a flaky unit-test threshold.
6. Run affected tests first, then owning packages sequentially, typechecks, builds, CLI smoke, relevant gates and docs build. Surface platform skips and pre-existing failures separately.

## Rejected alternatives

- Patch missing fields onto the current context rebuild: it cannot recover compressed-away history, real step identity or durable interaction transitions.
- Modify the minified frontend to accept the fork's output: this hides server drift and makes every bundle update costly.
- Add a second manual wire scanner beside the dispatcher: it would duplicate restore/undo ordering and race the live event bus.
- Replace the whole machine loop or adopt `packages/core`: unnecessary for a read-model protocol migration and outside this request.
