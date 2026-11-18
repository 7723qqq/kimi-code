# Official Web Protocol Alignment Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task. No commit or push is authorized.

**Goal:** Restore the recorded conversation protocol consumed by the pinned official Web bundle.

**Architecture:** Reuse the existing dispatcher as the sole durable-event authority. Adapt upstream conversation folding and participant replay lifecycle; keep the machine execution engine and Operation Log.

**Tech Stack:** Bun, TypeScript, Immer, Zod, Fastify, ws, existing browser tools.

**Spec:** requirements.md, design.md, tasks.md in this directory.

## Constraints and review focus

Follow the referenced repository conventions. Preserve the dirty-worktree baseline and official dist-web bytes. Required review cases: late subscription during restore, replay failure without partial publication, retry item identity, compaction versus visible history, and socket closure during initial page delivery. These are covered by the tasks below.

## 1. Dispatcher replay contract

Files: core `src/state/{eventDispatcher,eventDispatcherService,state}.ts`, `test/state/eventDispatcher.test.ts`.

Produces: optional `onUndo(state,count)`, `mutableReplay`, `onWillReplay()`, and `onDidReplay(state,{ok})` on DurableAgentRuntimeParticipant while retaining `commit(state,silent)`.

- [x] Add regression tests for append anchors reaching the participant transition; custom undo; staged replay with one final publish; failed replay preserving the previous view; late-attach disposal.
- [x] Run `bun test --isolate --timeout 30000 ./test/state/eventDispatcher.test.ts` from agent-core-v2 and capture the failing cases.
- [x] Adapt the relevant upstream implementation, including mutable participant staging from #4893. Keep the default participant path unchanged, isolate staged objects, reject invalid checkpoint combinations.
- [x] Run that test file and package typecheck. Do not continue on a regression.

## 2. Conversation record fold and feed

Files: kap `src/services/conversation/{conversationFold,conversationItems,conversationFeed,conversationService}.ts`, `src/protocol/conversation.ts`; existing fold/feed tests.

Consumes: task 1 participant lifecycle. Produces: `applyConversationRecord(state,record)`, custom conversation undo, recorded steps/identities and official turn/item frames.

- [x] Add upstream-style recorded-event regression fixtures for step streaming, final sealing, interactions, subagents, tasks, compaction and undo; pin retained note/media behavior.
- [x] Run the two service tests to reproduce the missing metadata/deltas.
- [x] Adapt upstream f082f04a09's conversation record handlers and feed; remove context-only authoritative rebuilding. Translate current ToolProgress/loop events at this boundary without changing the execution engine.
- [x] Reconcile the preceding batch's index/task-link tests with the new authoritative path, retaining their behavioral assertions.
- [x] Run fold/feed tests, sessions/rating tests and kap typecheck; verify live/cold result equality.

## 3. Subscription and client contract

Files: kap `src/transport/ws/v1/{wsConnectionV1,sessionEventBroadcaster}.ts`, `src/protocol/ws-control.ts`, existing socket tests and a focused Web-bundle contract integration test.

- [x] Assert official flat subscribe commands yield response before seed and interactions, buffer mid-seed changes, and discard closed/unsubscribed generations.
- [x] Repair demonstrated ordering/lifecycle differences without removing Operation Log compatibility.
- [x] Inventory every API-client method in the pinned bundle against local route and projection. Attach test evidence to confirmed differences; do not treat a path match as semantic coverage.
- [x] Exercise REST and a real WebSocket through startServer with disposable fixtures; run relevant transport tests and the kap suite.

## 4. Browser and delivery verification

Files: existing e2e/test helpers, protocol docs, upstream ledger/PLAYBOOK; progress.md records measurements and coverage.

- [x] Serve the unchanged official bundle from an isolated temporary home and deterministic local provider. Use the existing startServer/testing helpers rather than a second application implementation.
- [x] Verify streaming before completion, tools, approval, reconnect, retry, compaction, undo, fork and file history in the actual browser; retain relevant screenshot/network evidence and clean up owned processes.
- [x] Benchmark identical fixed event fixtures at 1k/4k/8k scale, with fold equality and clone/commit-count assertions.
- [x] Update bilingual protocol docs and ledger decisions reflecting the restored participant consumer.
- [x] Run owning-package suites sequentially, impacted builds/typechecks, CLI smoke and structural gates; verify dist-web unchanged and no owned temporary resources remain.
