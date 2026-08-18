# Unified Read/Write Model Design (proposal)

> **Status (2026-08-15)**: This document is a design proposal whose unified read/write model **has been implemented** (src/wire/model.ts, src/wire/op.ts, src/wire/wireService.ts, src/wire/wireContribution.ts). The body keeps the original proposal for traceability; refer to the current code for types. The deleted record types mentioned in the document are covered by the update note below.

> Goal: define a **single** read/write model for agent-core-v2, unifying views, topics, write operations, and subscription, resolving loops, inconsistent definition styles, and confused event visibility. This document is based on a complete survey of the current state of agent-core-v2 / server-v2 / TUI (apps/kimi-code); every claim has file:line evidence.
>
> Reading order: §1 problems → §2 conceptual model (core) → §3–§6 primitive specs → §7 subscription protocol → §8 loop control → §9 migration path. Appendix A maps "existing mechanisms → new model" item by item.
>
> **Update note**: when this document was written, `todo.set` / `turn.launch` / `context.splice` were still wire record types in agent-core-v2. Later refactors (v1 vocabulary alignment) deleted these three replay-only / pre-alignment types, uniformly switching to v1's `tools.update_store` (`key: 'todo'`), `turn.prompt`, `context.append_message`, etc. Read the examples and mappings involving these types with the above substitution in mind.

---

## 0. Hard constraint: persistence layer frozen, only the interface is unified

This design **changes no on-disk artifacts**:

- `wire.jsonl` path derivation (`sha256(agentHomedir)[0:16]`, scope `'wire'`, `wireRecordService.ts:66, 359-361`) unchanged;
- **one physical log file per agent** layout unchanged;
- `PersistedWireRecord` data structure (record type strings, fields, `metadata` envelope, `time` stamp) unchanged; the record shapes of the existing 18 domains are byte-compatible;
- `protocol_version` / migration chain (1.0→1.5) mechanism unchanged; this design **introduces no new log-format migration**;
- fork implementation (appendLogStore-layer filtered copy + inserting `metadata`/`forked`) unchanged;
- server-v2's SessionEventJournal (second journal) and `{seq, epoch}` wire semantics unchanged.

Unification happens at the **in-process API surface**: write entry points, read models, subscriptions, phases, type registry. Further storage-layout convergence (session single log, seq persistence, journal merge) moves to Appendix C as long-term options, out of scope for this phase.

---

## 1. Current state and problems

### 1.1 Current state in one sentence

The core is already a **half-finished event-sourcing system**: each agent has a wire record append stream (`wireRecordService.ts`) with a unified facade `IAgentRecordService` (append / signal / define / defineView), but:

- declarative views only migrated 2 domains (contextMemory, contextSize); the remaining ~12 domains still do "append records + hand-written private state + two apply paths (live/resume) + manual notification";
- the same fact has up to **4 expressions**: wire record (`goal.update`), AgentEvent signal (`goal.updated`), replay record (`goal_updated`), getter snapshot (`getGoal()`);
- **6 event mechanisms coexist**: Emitter, OrderedHookSlot, ViewHandle.onChange, IEventService (untyped), AsyncEventQueue, bare callbacks/Promises;
- each session has **two append logs and two sequence spaces**: the agent wire log (core) + SessionEventJournal (server-v2 edge, `sessionEventBroadcaster.ts:1-25`).

### 1.2 Problem list (the design must answer each)

**Write path**
- W1 command implementations have three styles: append + separate apply (most domains) / append-is-fold (contextMemory) / append then reuse the resume function (turn, `turnService.ts:57-83`).
- W2 `define` facet merge semantics contradict the comment ("first writer wins" vs. the later one actually overwriting, `recordService.ts:139-146`); dispose only unregisters the resumer without clearing facets, asymmetric with `defineView`'s full cleanup.
- W3 the Session domain borrows the main agent's wire for writes (todo/cron); when main is missing, writes are **silently dropped** (`sessionTodoService.ts:99-100`) and need `as never` to bypass types.
- W4 fork rewrites the wire log directly at the appendLogStore layer, bypassing the entire write model (`sessionLifecycleService.ts`'s `fork` / `copyAgentWire`).
- W5 appends during restore are silently swallowed at the wireRecord layer (`wireRecordService.ts:81`), yet recordService still folds views and runs facets — "into memory, not onto disk" is entirely implicit.

**Read path**
- R1 ~12 hand-written read models (goal/usage/plan/swarm/permission*/turn/task/todo…), live and resume apply paths kept consistent by hand.
- R2 replay read model has two channels: declarative `toReplay` + imperative `push/patchLast/removeLastMessages`; boundary logic duplicated in two places (`recordService.ts:55-64` vs `contextMemoryService.ts:137`).
- R3 `plan.status()` embeds file IO in the read model; `sessionActivity.status()` is pure polling with no events.
- R4 `messageLegacy` picks a read model by the heuristic "trust replay if replay is non-empty, otherwise trust the view" (`messageLegacyService.ts:100-116`).
- R5 `captureLiveRecords` is a dead switch nobody uses; `IQueryStore` has a contract but no implementation.

**Event visibility**
- V1 `task.started/terminated` is double-registered in both WireRecordMap and AgentEvent; the write path does append+signal with the same name twice (`taskService.ts:796-807`); the `toLive` facet is used by exactly one place in the whole codebase (permissionMode).
- V2 `agent.status.updated` is a "scattered snapshot event written by multiple domains": plan/swarm/usage/contextSize/profile each hand-assemble different fields.
- V3 signals during resume are implicitly suppressed via `emitLive` (skill/swarm) — "whether this signal gets out" depends on the phase at call time, invisible at the call site.
- V4 `IEventService` payloads are untyped, event names are bare strings, and the same event has two publishers.
- V5 `prompt.submitted` exists in the protocol but nobody emits it; `AsyncEmitter/handleVetos` is dead code.

**Loops and phases**
- L1 subscriber write-back chains are real and unconstrained: turn.onEnded→goal continues→launches turn again; loop.afterStep→steer flush→splice; onContextOverflow→compaction→splice→possibly overflow again (truncated by an explicit counter, `fullCompactionService.ts:100-105`).
- L2 `foldViews` fires change synchronously with no reentrancy protection (`recordService.ts:282-295`): an onChange handler that appends reenters undetected.
- L3 restore correctness relies on three implicit contracts: DI construction order + hook registration order + "resumers before hooks"; `doResume` must manually pre-warm contextMemory (today's `doResume` / `materializeSession` in `sessionLifecycleService.ts`).
- L4 phase rules (restoring / postRestoring / live) differ across the four channels (append/signal/push/hook), with no single place defining them.

**Requirements inferred from consumers (server-v2 / TUI)**
- C1 the server needs: seq/epoch watermarks, durable/volatile dichotomy, disconnect backfill, snapshot-at-watermark (`snapshot.ts:1-14`). All of this is reinvented at the edge today (a second journal + InFlightTurnTracker rebuilding streaming state at the edge).
- C2 the TUI needs per-entity subscription (transcript/toolCall/todo/run state/usage/mode/goal/background tasks/sub-agents/pending interactions) instead of joining 44 event kinds itself; the TUI adapter layer is ~4000 lines with many "state patching" hacks (three-way reconciliation at terminal states, back-deriving todo from inputs, reverse-engineering replay, /tasks polling).
- C3 the TUI needs "history replay = same read model cold start + seamless seq continuation"; today replay and live are two independent code paths joined by time approximation, dropping window events.
- C4 writes need echoes (renameSession synthesizes its own client event; the v2 router hand-emits `event.session.created` three times, `sessions.ts:260,503,619`); optimistic UI needs confirm/failure semantics.
- C5 the protocol already defines durable seq + `VOLATILE_EVENT_TYPES` (`protocol/src/events.ts:1475-1503`) but neither core nor TUI uses it — the classification should move up to the definition site.
- C6 **cold reads must first fully resume**: v1 reading message history triggers the whole resume (root cause of snapshot p99 5s+); v2's GET implicitly creates the main agent (`tasks.ts:282`, `tools.ts:218`) — reads have side effects, and "no handle, no read model".
- C7 the session aggregate read model is missing: half of `toWireSession`'s fields are fake values (status/usage/message_count, `sessions.ts:737-756`); session status has three independent computations in v1.
- C8 **wire types duplicated + lossy hand-written projections**: Goal/Usage/Task/PermissionRule are repeated field-by-field in core and protocol; PermissionRule has no mapping code and the wire is always `[]`; multi-answer questions are joined with `join(',')`; 8 of the 43 wire events have no emission point in v2.
- C9 in-flight streaming state is folded at the edge (InFlightTurnTracker) and explicitly drops subagent events (`inFlightTurnTracker.ts:15-17`) — the tension between "one stream per agent" and "one cursor per session" is unresolved.
- C10 pending approvals/questions are in-memory dangling Promises in v1, lost on power failure; v2 collects them into the interaction service but they are still not durable facts.

---

## 2. Conceptual model

Model = **5 primitives + 1 stream structure + 1 phase machine**. All existing mechanisms map into it (Appendix A); mechanisms outside these 5 categories are retired or demoted to implementation details.

```
                         ┌────────────────────────────────────────────────────────────┐
   Command ──commit──▶   │  Stream (session logical stream, in-process seq;            │
  (decision, live only)  │  physically still per-agent wire.jsonl, see §0)             │
                         │  entries: fact | signal                                     │
                         └──────┬───────────────────────────┬───────────────────────────┘
                                │ fold (sync)                │ unified subscription (edge keeps its journal)
                                ▼                            ▼
                             View graph                   subscribers (server/TUI)
                          (pure-function fold)             snapshot + since(seq)
                                │
                                ▼ onChange (queued dispatch)
                             Effect (live-only, can only issue Commands)
```

### 2.1 The five primitives

| Primitive | One-sentence definition | Question it answers | Mature systems |
|---|---|---|---|
| **Fact** | something that happened, persisted, replayable | "what changed the state" | ES event, Kafka record |
| **Command** | validation + decision, produces 0..n Facts; itself stateless, not replayed | "who decides the change" | CQRS command, Redux action creator |
| **View** | pure-function fold over the Fact stream, the only state carrier | "what is the state" | Redux reducer+selector, Kafka Streams KTable |
| **Signal** | typed, registered volatile event, never persisted, not folded | "where is the process now" | CDP streaming event, protocol volatile |
| **Effect** | strategy subscribing to Fact/View changes, writing back only via Commands | "what do facts trigger next" | ES process manager / saga |
| **Hook** (kept, unchanged) | ordered participation/veto inside a write operation | "who can intercept this operation" | koa middleware, VS Code participant |

Verdicts (replacing the extension of service-design.md §4):

> - "This **already happened** and must still exist after resume" → **Fact** (commit).
> - "I want to **decide** whether and how it happens" → **Command** (service method).
> - "I want to know the **current state**" → **View** (get/onChange), never hand-write private fields again.
> - "This is just **in-progress progress**; losing it on disconnect is fine" → **Signal**.
> - "The system must **do something next** after a fact" → **Effect** (live-only).
> - "I want to participate/veto **during** this operation" → **Hook** (unchanged).

### 2.2 Stream structure (Stream / Topic) — logical stream, physical layout unchanged (§0)

- **Logically one stream per Session, partitioned by `agentId`**; **physically still one wire.jsonl per agent**; the session stream is an in-process stitched view of each agent's log. Write APIs route by partition to the corresponding agent's physical log; readers/subscribers only face the logical stream.
- **Session-level facts (`todo.set`, `cron.*`) physically keep landing in the main agent's wire.jsonl** (data-compatible, record shapes unchanged), but the interface collects them into `sessionStream.commit(fact)`: type-safe (kills `as never`), and when main is missing, **throw or queue explicitly** instead of silently dropping (W3's interface-layer fix; physical relocation is a long-term Appendix C item).
- **seq is an in-process logical sequence number**: monotonically increasing on the session stream, **not persisted** (data structure frozen). It serves view versioning, write echoes, and in-process subscription cursors; the persistent cross-restart cursor remains the server's SessionEventJournal (unchanged). Core guarantee: the event order forwarded to the edge = logical seq order, so the edge journal's seq is monotonically consistent with the core logical seq.
- fork keeps the current implementation (copying the main agent's wire log); expressed at the interface as `stream.forkInto(target)`, still implemented through appendLogStore (W4's interface-layer closure: one entry point, no more hand-written code scattered in sessionLifecycle).
- One logical stream at App scope (config/model catalog/session lifecycle), replacing `IEventService` (V4) — the App stream has no persistence anyway, a pure interface replacement.
- **Topic = a typed filtering view over the stream, not an independent mechanism.** Subscribers express it with `subscribe({types?, agentId?, sinceSeq})`; the server does not create a channel per topic.

### 2.3 Phase machine (the single definition site)

```
replaying ──(log folded)──▶ ready ──(first live commit)──▶ live
```

| Phase | commit(fact) | View fold | View onChange | Signal | Effect |
|---|---|---|---|---|---|
| replaying | **throws** (programming error) | ✅ (silent) | ❌ | **throws** | ❌ doesn't run |
| ready→live | ✅ | ✅ | ✅ (queued) | ✅ | ✅ |

Compared with the current state: appends during restore are silently swallowed (W5), signals are implicitly suppressed (V3), and the four channels each have their own phase rules (L4). In the new model, **phase rules are written once at each of the four entry points (commit/emit/fold/effect)**, and violations are loud (throw), not silent.

> Today's "legitimately wanting to write during resume" scenarios (goal's fork reminder regenerated on every restore) are handled by a **context injector** (the existing `IAgentContextInjectorService`) or a one-shot Effect at the ready phase — derived content should not masquerade as a replay side effect. The `postRestoring` window is removed: task disk reconciliation, cron startup, etc. fold into one-shot Effects at the ready moment.

---

## 3. Type system: single registry + visibility declared at the definition site

### 3.1 One registry, two kinds of entries

Keep the declaration-merging open registry pattern (consistent with ErrorCodes/FlagRegistry/config sections), but merge the three universes — `WireRecordMap` (18 augmentation points), `AgentEvent` (44 protocol kinds), `AgentReplayRecordPayload` (7 kinds) — into one `EventMap`, where each entry declares at its **definition site** whether it is a fact or a signal:

```ts
// in-domain declaration (declaration merging, same style as today)
declare module '#/stream' {
  interface EventMap {
    'todo.set': Fact<{ todos: readonly TodoItem[] }, { scope: 'session' }>;
    'goal.update': Fact<GoalPatch, { scope: 'agent'; blobs?: BlobSelector }>;
    'assistant.delta': Signal<{ turnId: number; text: string }>;
    'tool.progress': Signal<ToolProgress>;
  }
}
```

- **Visibility is a type property, not a call-site decision** (solves V1/V3): `commit()` only accepts Fact entries, `emit()` only Signal entries; misuse doesn't compile. The `task.started` double registration and append+signal double-fire style disappears at the type level.
- **Data compatibility** (§0): a Fact entry's type string and payload shape = the existing `WireRecordMap` entry, byte-for-byte unchanged; Signal entries = existing volatile `AgentEvent`s. The merge happens only at the type-registry level, producing no new on-disk/wire shapes.
- protocol's `VOLATILE_EVENT_TYPES` is **generated** from this registry (signals are volatile), the classification lives in exactly one place (C5).
- `blobs` (large-content offload) remains a Fact-definition property, declared with the entry.
- **The wire protocol (AgentEvent) is unchanged this phase**: the Fact → AgentEvent projection is kept, but converges from "scattered per-domain toLive facets / manual signals" to a single `live(payload): AgentEvent | undefined` declaration at the Fact's definition site. Multi-domain events like `agent.status.updated` (V2) are emitted by one projector uniformly driven by the relevant views' onChange, no more per-domain hand-assembly. Wire-type single-sourcing (C8, protocol schema generated from EventMap/view types) is a directional goal in Appendix C; this phase only does "projection functions declared alongside types, no hand-written projections in the routing layer".

> Compatibility note: v1 protocol consumers (messageLegacy/sessionLegacy) remain as edge translation layers, translating from the new Envelope stream to the old shapes, no longer influencing the core model in reverse.

### 3.2 Relationship with contract generation

`gen-contract-types.mjs`'s direction of stripping implementations and keeping interfaces is unchanged: `EventMap`, View output types, and Command interfaces are the contract surface; the `defineFact/defineView/defineEffect` registration calls happen in implementation-class constructors and are stripped. If shared fold code is given to clients (§7.3), the pure-function part of views goes in `viewDefs/` (no DI dependencies) and can be packaged by the contract.

---

## 4. Write path spec

### 4.1 Command: decision separated from state

```ts
// the only legal shape (W1 three styles → one style)
setTodos(todos: TodoItem[]): void {
  // 1. validate/decide (may read views, run hooks, have side-effect compensation logic)
  const next = normalize(todos);
  // 2. produce facts (0..n)
  this.stream.commit({ type: 'todo.set', todos: next });
  // 3. no step 3: no private-field mutation, no manual fire — state is folded by views, notifications come from views
}
```

Rules:
- **Commands hold no foldable state.** All "must still exist after resume" state lives in views. Service private fields may only hold real runtime resources (process handles, timers, connections).
- **Commands don't run during replay** (guaranteed by the phase machine). The hack of reusing live commands for resume disappears: replay only folds facts.
- "Promise first, compensate later" commands (plan.enter cancel after failure) are just two commits — compensation is also a fact, naturally replayable.
- The `define()` facet mechanism retires: `resume` → view fold; `toLive` → redact at the definition site; `toReplay` → transcript view (§5.3); `blobs` → Fact-definition property. W2's merge/dispose semantics problems disappear with the API.

### 4.2 Write echoes and causality (C4)

`commit()` returns `{ seq }`. RPC write interfaces pass it through to the client; optimistic UI uses the standard rebase pattern "locally pending → confirmed when an echo ≤ seq arrives" (the minimal version of Replicache's mutation-id idea). "Writes without echoes" like `renameSession` become impossible — a write is a commit, and a commit is necessarily in the stream.

---

## 5. Read path spec: three layers of Views

### 5.1 State Views (migrating R1's ~12 domains)

The existing `View<TState, TPayload, TOutput>` (`record.ts:57-68`) is already the right shape; promote it to the only state carrier and add three things:

1. **Version number**: `ViewHandle.get()` returns `{ value, seq }` — value and watermark consistent, snapshot routing no longer needs the "drain queue then read" dance (`snapshot.ts:10-14`).
2. **Derived composition**: `derive(view A, view B, f)` read-only combinator (synchronous, pure), replacing `sessionActivity.status()`-style cross-service ad-hoc polling (R3) and `permissionGate.data()`-style manual assembly. Combinators create no new fold state, only caching + change propagation (equivalent to Redux reselect / VS Code derived observable).
3. **No IO**: view outputs must be pure in-memory. `plan.status()` reading files → split into a "planFilePath state view" + the caller reads the file itself (or an Effect caches file content as a view).

`agent.status.updated` (V2) retires: each of its fields comes from some view; subscribers subscribe to the corresponding view/topic directly, no more "scattered snapshot events written by multiple domains".

### 5.2 Cross-scope Views

Session-level views (todo, background task table, pending interactions, sessionActivity) fold the session partition plus the needed agent partitions. The TUI's "background task table with terminal states" (C2) becomes a first-class view here: folding `task.started/terminated` + `subagent.*` facts, with the terminal-state reconciliation logic moving from the TUI's 50-line comment into a pure function.

### 5.3 Transcript View (replacing the replay builder, solving R2/R4/C3)

UI history (today's `AgentReplayRecord[]`) is a fold: `transcript = fold(facts)`, producing structured `Turn[] → Step[] → (Message | ToolCall{call,result,progress?})`.

- The two channels (toReplay + push/patchLast) disappear; fullCompaction's patchLast backfill becomes a regular case in the fold for `full_compaction.complete`.
- boundary/trimming logic (partial resume's range/segment/frozen) becomes the fold's parameterized initial condition, written once.
- messageLegacy's "replay or view" heuristic disappears: cold start and hot reads are the same view.
- TUI resume: `GET snapshot` gets `{ transcript.get(), seq }` → `subscribe(sinceSeq)` continues. Replay and live are one code path (C3).

### 5.4 Where streaming deltas land (TUI requirement §4)

Signals don't fold into persistent views, but their **shape is normalized**: streaming-text signals carry `{ turnId, stepId, cumulative: string }` (cumulative text) or periodic checkpoints, paired with finalize boundaries on facts (`turn.step.completed` etc. are already facts). The TUI's 50ms throttling and phase-switch finalization are naturally supported by "cumulative + boundary facts"; tolerance for out-of-order/loss rises sharply (losing a signal only loses intermediate frames; boundaries are guaranteed by facts).

### 5.5 Ephemeral Views (absorbing InFlightTurnTracker, solving C9)

A fourth kind of view: **folds facts + signals, lives only in the live phase** (rebuilt from empty state after restart/resume, not part of replay). Declared like a state view, with an extra `ephemeral: true` marker. Uses:

- `inFlightTurn`: today's edge-side `InFlightTurnTracker` (follows only main, drops subagents) becomes a core standard ephemeral view, folded per agentId partition — the subagent tension disappears because the session has one seq (§2.2);
- the TUI's `streamingPhase`: from "client-guessed derived state" to a field of a core ephemeral view.

Snapshots include the ephemeral views' current values (consistent with seq), so reconnects don't lose in-progress state; but they write no logs and don't replay — that's the canonical answer to "volatile streams can be folded".

### 5.6 Cold reads and materialization (solving C6/C7)

Views are pure folds, so **cold reads come naturally**: without instantiating agent/session scopes, `foldOffline(log, viewDef)` directly yields any view's value. Two consumption surfaces are specified:

- **Cold-read API**: `readView(sessionId, name)` — handle present (hot) reads memory, handle absent (cold) folds from the log, same read semantics; **reads never trigger resume, never create agents** (kills GET creating the main agent, and reading messages triggering the whole resume).
- **Session aggregate view**: `sessionSummary` (status/usage/messageCount/lastSeq/title) defined as a cross-partition fold — exactly the fields `toWireSession` fakes today. `ISessionIndex`'s list entries upgrade from "directory tree as index" to a disk materialization of this view (`IQueryStore`'s contract lands here: projector = view fold, checkpoint = seq), so the list page no longer opens every session's log.

---

## 6. Event mechanism convergence

| Current mechanism | Destination |
|---|---|
| `Emitter` (28 sites) | View.onChange covers state-class events; kept only for genuine runtime-resource events (process output, fs watch) |
| `OrderedHookSlot` (24 slots) | **kept as-is** — it serves write-path participation/veto (tool execution, prompt building, loop stepping), orthogonal to read models |
| `ViewHandle.onChange` | kept; notification dispatch is queued (§8) |
| `IEventService` | merged into the App stream (typed facts/signals) |
| `AsyncEventQueue` | kept as an internal implementation detail of the LLM stream adapter; remove the compatibility re-export |
| `AsyncEmitter`/`handleVetos` | deleted (dead code; HookSlot already covers the capability) |
| bare callbacks (onUpdate etc.) | tool execution progress switches to Signals; RPC reverse calls (approval/question) stay |

`wireRecord.hooks.onRestoredRecord / onResumeEnded` retire: restore orchestration folds into the phase machine (fold everything → one-shot ready Effect), and L3's triple implicit ordering contract disappears.

---

## 7. Subscription protocol (unified consumption surface for server and TUI)

### 7.1 In-process subscription surface (wire protocol unchanged this phase)

```
Core exposure (in-process):
  sessionStream.subscribe({ sinceSeq?, types?, agentId? })
    → AsyncIterable<{ seq, time, agentId, kind: 'fact'|'signal', type, payload }>
  readView(sessionId, name) → { value, seq }        // cold/hot consistent, see §5.6
```

- **seq is the core's in-process logical sequence number** (§2.2): assigned at commit/emit, monotonic, not persisted. View version numbers, write echoes, and Effect causality markers all reference it.
- **server-v2's broadcaster keeps its current job** (journal, persistent `{seq, epoch}`, backfill, resync, zero wire-protocol changes), but its consumption source switches from "per-agent `record.on` subscription + lifecycle backfill" (`sessionEventBroadcaster.ts:256-275`) to **one subscription to the session logical stream**: agent add/remove, agentId/sessionId attachment, and durable/volatile classification (from the registry) are all done by the core. The edge's seq is monotonically consistent with the core logical seq; snapshot's "atomically read after draining the queue" simplifies to "read the view's `{value, seq}`".
- Disconnect/reconnect/epoch/resync semantics fully follow the current protocol (`ResyncReason` unchanged).
- Journal merge (deleting the edge's second ledger, C1's full solution) depends on seq persistence and is a long-term Appendix C item; this phase's interface-layer win for C1: the edge no longer invents classification, stitching, and consistency dances itself.

### 7.2 server-v2 gets thinner

The edge keeps journal/seq/epoch/backfill (§0, §7.1); the rest thins out: auth, connection management, unified stream pass-through (durable/volatile classification, agent stitching, projections all done by the core), REST read routes = pass-through of `readView()` (hot/cold consistent, §5.6). The snapshot route goes from "ad-hoc assembly across 6 services + drain queue for consistency" (`sessionLegacyService.ts:278-300`, `snapshot.ts:10-14`) to "read several views' `{value, seq}`". Write routes = Command pass-through (the actionMap `resource:action` allowlist pattern stays — it already proved "command = service method"); the router hand-emitting events (C4) is replaced by "write is commit, commit is necessarily in the stream". Pending approvals/questions are promoted to durable facts + a `pendingInteractions` view (C10): approval requests and decisions are facts, not lost on power failure, and the wire projection no longer relies on `as ApprovalRequest` assertions.

### 7.3 Client-side read models (optional advanced step)

View definitions are dependency-free pure functions (§3.2) and can be shared with node-sdk/TUI via the contract package: clients incrementally maintain the same views with `fold(snapshot, envelopes)`. The "join events to rebuild state" part of the TUI's 4000-line adapter layer (terminal-state reconciliation, todo back-derivation, streamingPhase guessing) is replaced by shared folds. This step doesn't block the core refactor and can be deferred.

---

## 8. Loop control

Three mechanisms, all centralized in the stream implementation:

1. **Commit queue**: `commit()` synchronously folds all views, but **onChange notifications are enqueued** and dispatched in order after the current commit stack exits (equivalent to VS Code observable transactions, Redux's dispatch-in-reducer prohibition). Committing again inside an onChange handler → enqueued behind, no fold reentrancy (solves L2). Multiple changes in the same microtask can be coalesced (views natively support equals dedup).
2. **Effect registration**: subscriber write-backs (L1's goal continuation, swarm auto-exit, steer flush, overflow→compaction) are explicitly registered as `defineEffect(name, { on: [...types] | view, run(ctx) })`:
   - runs only in the live phase (replacing 4 hand-written restoring guards);
   - can only call Commands (no bare fact commits, so decision logic can't be bypassed);
   - facts produced by Effects carry a `cause: { effect, seq }` causality marker, making loops auditable in logs; the trigger depth of the same Effect on the same cause chain is capped (default 1), turning loops like overflow→compaction→overflow from "hand-written counters everywhere" into a declared `maxCauseDepth`.
3. **Phase machine** (§2.3): commit/emit throw during replay, Effects don't run — loops physically don't exist on the replay path.

---

## 9. Migration path (each step independently deliverable, no breaking of existing consumers)

1. **P0 stop the bleeding** (no architecture change): fix `define` merge/dispose semantics (W2); change restore-period appends from silent swallowing to assert/log (W5 made visible); delete dead code (AsyncEmitter, compatibility re-exports, captureLiveRecords).
2. **P1 registry merge**: EventMap + Fact/Signal dichotomy + new `commit/emit` API (old append/signal stay as transitional aliases); `VOLATILE_EVENT_TYPES` becomes generated.
3. **P2 view flattening**: migrate the 12 hand-written domains to views in dependency order (goal, the most complex, last); introduce the `derive` combinator, rework sessionActivity/permissionGate.
4. **P3 transcript view**: rewrite the replay builder as a fold, retire the two channels; messageLegacy reads the transcript view.
5. **P4 phase machine + Effects**: absorb onRestoredRecord/onResumeEnded/postRestoring; the four restoring guards and goal's silent suppression become Effects/queues; pending interactions become durable facts + an ephemeral `inFlightTurn` view (prerequisite for retiring the server tracker).
6. **P5 logical stream and subscription surface**: session logical stream (stitching the existing per-agent wire.jsonl, physical layout unchanged); in-process logical seq; `sessionStream.commit` absorbs todo/cron borrowed writes; `forkInto` closes the fork entry point; the server-v2 broadcaster consumes the unified stream (wire protocol unchanged); `readView` cold reads + `sessionSummary` materialization (new index file, not touching wire.jsonl).
7. **P6 (optional)**: share view folds with clients; slim the TUI adapter layer; finish wire-type single-sourcing (protocol schema generated from EventMap/view types).

Further storage-layer convergence (Appendix C) is entirely out of this phase: P1–P5 introduce no new log formats or migrators.

P1–P4 complete inside the core, fully transparent to server/TUI; P5 needs one protocol upgrade coordinated with server-v2 (Envelope fields unchanged, seq semantics move from edge to core).

---

## 10. Comparison with mature systems (anchors for complexity control)

| Borrowed from | Primitives adopted | Explicitly not adopted |
|---|---|---|
| Event Sourcing / CQRS | fact is the truth, command/query separation, projections, process manager | aggregate roots/repository layer — scope containers already provide the boundary |
| Redux / Elm | pure folds, selector composition, dispatch queue | global single store — split by scope |
| Kafka | partitioned log, offset as seq, consumer-owned cursors | broker/consumer groups — not needed in a single process |
| Replicache / LiveStore | client-shared folds, mutation echo rebase | CRDT merging — single writer (core) has no concurrent writes |
| VS Code | Emitter-style API, observable transactional dispatch, contract/impl separation | — |
| CDP / LSP | domain events + snapshot-then-stream, volatile classification | — |
| XState | explicit phase machine | hierarchical state machines — only 3 phases, not worth it |

Complexity budget: the new model's **mechanism count drops from 6+4 (events×phases) to 5+1+3** (primitives×stream×phases), and every problem (21 items across W/R/V/L/C) can point to the mechanism that resolves it (Appendix A).

---

## Appendix A: Problem → mechanism mapping

| Problem | Resolving mechanism |
|---|---|
| W1 three command styles | §4.1 the single Command shape |
| W2 define semantics | §4.1 facet retirement (P0 fixes first) |
| W3 borrowing main wire | §2.2 sessionStream typed interface (physically still main wire; loud when main missing) |
| W4 fork bypasses the write model | §2.2 forkInto single entry point (implementation unchanged) |
| W5 silently swallowed appends | §2.3 commit throws during replay |
| R1 hand-written read models | §5.1 state views flatten |
| R2 replay dual channel | §5.3 transcript view |
| R3 read models with IO/polling | §5.1 no IO + derive combinator |
| R4 replay-or-view heuristic | §5.3 cold and hot share one source |
| R5 dead switch/empty contract | P0 deletes; IQueryStore implemented on demand after P5 as a disk-materialized view |
| V1 double registration, double fire | §3.1 Fact/Signal dichotomy, type-enforced |
| V2 scattered snapshot events | §5.1 subscribe per view |
| V3 implicit suppression | §2.3 phase rules made loud |
| V4 untyped bus | §2.2 App stream + EventMap |
| V5 dead code | P0 deletes |
| L1 subscriber write-back | §8.2 Effect registration + causality depth |
| L2 synchronous fire reentrancy | §8.1 commit queue |
| L3 restore ordering contract | §2.3 absorbed by the phase machine |
| L4 scattered phase rules | §2.3 single definition site |
| C1 two journals | §7.1 edge consumes the unified stream (journal merge → Appendix C) |
| C2 per-entity subscription | §5 view system + §7.1 types filtering |
| C3 replay = cold start | §5.3 + §7.1 snapshot/sinceSeq |
| C4 write echoes/router hand-emitted events | §4.2 commit returns seq + §7.2 |
| C5 scattered volatile classification | §3.1 generated from the registry |
| C6 cold reads need resume/reads have side effects | §5.6 readView cold/hot consistent |
| C7 session aggregate fake values | §5.6 sessionSummary materialized view |
| C8 wire types duplicated | §3.1 single-sourcing |
| C9 in-flight folded at edge/subagent dropped | §5.5 ephemeral view + §2.2 single seq |
| C10 pending interactions lost on power failure | §7.2 durable facts |

## Appendix B: Open questions

1. Session logical stream stitching order: the allocation point of logical seq under concurrent commits from multiple agents (suggestion: a session-level monotonic counter, allocated inside the commit queue, naturally totally ordered); whether sub-agent high-frequency writes need independent backpressure.
2. Whether Signal backpressure/coalescing policy should sink into the core (today the TUI throttles at 50ms itself) — suggestion: the core provides per-type coalescing hints (`coalesce: 'replace' | 'append'`), the edge executes.
3. The goal domain's state is large (budget/heartbeat/continuation); after view-ification, fold performance and fact granularity need dedicated design (possibly split into multiple sub-views).
4. Storage location and invalidation strategy for the `sessionSummary` materialized index (new file, not touching wire.jsonl; suggestion: seq checkpoint + log mtime double check).

## Appendix C: Long-term storage-layer convergence (explicitly not in this phase)

All of the following depend on breaking §0's freeze constraint and are filed separately once the interface unification is stable:

1. **Session single-log partitioning** (physically merging per-agent wire.jsonl, todo/cron relocated to the session partition), needs a v1.6 migrator; benefit: more accurate fork semantics, stitching layer disappears.
2. **seq persistence** (log offset as the durable watermark), only then can the server's SessionEventJournal (C1's full solution) and edge tailing be deleted.
3. **Wire-type single-sourcing finish**: protocol zod schemas generated from EventMap/view output types, killing the duplicated Goal/Usage/Task/PermissionRule definitions.
4. The v1.5 migrator already embeds a mini replay machine; if items 1/2 are done in the future, the migration should repay it in one go, avoiding piling more semantics into the migrator.

## Appendix D: Interface and scenario code examples

> Examples follow the repository's existing habits: contract files hold interfaces + `createDecorator`, implementation-class constructors do runtime registration (strippable by `gen-contract-types`), the type registry uses declaration merging. All examples satisfy §0's freeze constraint: no new on-disk formats.

### D.0 Core interfaces (`#/stream` contract)

```ts
// ---- type registry: two kinds of entries, visibility is a type property (§3.1) ----
export interface FactMap {}    // augmented per domain: 'todo.set' → payload shape (= current WireRecordMap, byte-compatible)
export interface SignalMap {}  // augmented per domain: 'assistant.delta' → payload shape (= current volatile AgentEvent)
export interface ViewMap {}    // augmented per domain: view name → output type (following current record.ts:47)

export type Fact<K extends keyof FactMap = keyof FactMap> =
  { [T in K]: { readonly type: T; readonly time?: number } & Readonly<FactMap[T]> }[K];
export type Signal<K extends keyof SignalMap = keyof SignalMap> =
  { [T in K]: { readonly type: T } & Readonly<SignalMap[T]> }[K];

/** Commit receipt: in-process logical seq (not persisted, §2.2), used for write echoes / optimistic UI (§4.2). */
export interface CommitReceipt { readonly seq: number }

/** Fact definition-site declaration (replacing define()'s facets, §4.1). */
export interface FactOptions<K extends keyof FactMap> {
  /** the single live projection (replacing scattered toLive/manual signals, V1/V2). undefined = no broadcast. */
  readonly live?: (fact: Fact<K>) => AgentEvent | undefined;
  /** large-content offload selector (following current blobs semantics). */
  readonly blobs?: WireRecordBlobSelector<Fact<K>>;
}

export interface View<TState, TPayload, TOutput = TState> {
  readonly init: TState;
  select(fact: Fact): TPayload | undefined;          // filter + extract
  reduce(state: TState, payload: TPayload, fact: Fact): TState;  // pure function
  derive?(state: TState): TOutput;
  equals?(a: TOutput, b: TOutput): boolean;
  /** true = folds Signals, lives only in the live phase, in snapshots but not replayed (§5.5). */
  readonly ephemeral?: boolean;
  selectSignal?(signal: Signal): TPayload | undefined;  // declarable only on ephemeral views
}

export interface ViewHandle<T> {
  /** value and watermark read consistently (§5.1); snapshots no longer need the drain-queue dance. */
  get(): { readonly value: T; readonly seq: number };
  onChange(h: (c: { old: T; new: T; seq: number }) => void): IDisposable; // queued dispatch (§8.1)
}

export interface EffectContext {
  readonly cause: { readonly type: string; readonly seq: number; readonly depth: number };
}
export interface EffectSpec {
  readonly on: readonly (keyof FactMap)[];   // or { view: keyof ViewMap }
  /** causality depth cap: the max chain depth at which facts caused by an Effect re-trigger this Effect (§8.2), default 1. */
  readonly maxCauseDepth?: number;
  run(fact: Fact, ctx: EffectContext): void | Promise<void>;  // can only call Commands, no bare commits
}

export type StreamPhase = 'replaying' | 'ready' | 'live';

/** Agent partition (physical = that agent's wire.jsonl, unchanged). */
export interface IAgentStream {
  readonly _serviceBrand: undefined;
  readonly phase: StreamPhase;

  commit<K extends keyof FactMap>(fact: Fact<K>): CommitReceipt;   // throws during replaying (§2.3)
  emit<K extends keyof SignalMap>(signal: Signal<K>): void;        // throws during replaying

  defineFact<K extends keyof FactMap>(type: K, opts?: FactOptions<K>): IDisposable;
  defineView<K extends keyof ViewMap>(name: K, view: View<any, any, ViewMap[K]>): IDisposable;
  view<K extends keyof ViewMap>(name: K): ViewHandle<ViewMap[K]>;
  defineEffect(name: string, spec: EffectSpec): IDisposable;
  /** one-shot callback at the ready moment (replacing onResumeEnded/postRestoring, L3/L4). */
  onReady(fn: () => void | Promise<void>): IDisposable;
}
export const IAgentStream = createDecorator<IAgentStream>('agentStream');

/** Session logical stream: stitched view of each agent partition + session-level facts (§2.2). */
export interface ISessionStream {
  readonly _serviceBrand: undefined;
  /** session-level facts: physically land in the main agent's wire (data-compatible); throw when main is missing, no more silent drops (W3). */
  commit<K extends keyof FactMap>(fact: Fact<K>): CommitReceipt;
  defineView<K extends keyof ViewMap>(name: K, view: View<any, any, ViewMap[K]>): IDisposable;
  view<K extends keyof ViewMap>(name: K): ViewHandle<ViewMap[K]>;
  /** unified subscription surface (§7.1): the server broadcaster's only consumption entry; agent stitching/classification done by the core. */
  subscribe(opts: {
    sinceSeq?: number;
    types?: readonly string[];
    agentId?: string;
  }, handler: (e: {
    seq: number; time: number; agentId: string;
    kind: 'fact' | 'signal'; event: AgentEvent;   // wire shape unchanged (§0)
  }) => void): IDisposable;
  /** fork's single entry point (W4); implementation is still appendLogStore-layer copy, unchanged. */
  forkInto(targetSessionId: string): Promise<void>;
}
```

### D.1 Scenario: rewriting the todo domain (triple bookkeeping → Command + View)

Today: `setTodos` mutates private fields + `append` (`as never`) + manual fire; resume has a separate resumer that only mutates fields without notifying (`sessionTodoService.ts:84-113`). After the rewrite:

```ts
// ---- type declarations (payload byte-identical to today's todo.set in wire.jsonl) ----
declare module '#/stream' {
  interface FactMap { 'todo.set': { todos: readonly TodoItem[] } }
  interface ViewMap { todo: readonly TodoItem[] }
}

// ---- view: the single state logic for live and resume ----
const todoView: View<readonly TodoItem[], readonly TodoItem[]> = {
  init: [],
  select: (f) => (f.type === 'todo.set' ? f.todos : undefined),
  reduce: (_state, todos) => todos,
};

export class SessionTodoService extends Disposable implements ISessionTodoService {
  constructor(@ISessionStream private readonly stream: ISessionStream) {
    super();
    this._register(stream.defineView('todo', todoView));
  }

  /** Command: validate + commit, no third step (§4.1). */
  setTodos(todos: readonly TodoItem[]): CommitReceipt {
    const next = todos.map(({ title, status }) => ({ title, status }));
    return this.stream.commit({ type: 'todo.set', todos: next });
    // no private-field mutation (state lives in the view); no fire (notifications come from view.onChange);
    // main agent missing → commit throws (today it silently drops);
    // after resume, todo is automatically in place (view replay fold), no resumer needed.
  }

  getTodos(): readonly TodoItem[] {
    return this.stream.view('todo').get().value;
  }
}
```

### D.2 Scenario: goal state and live projection (four expressions → one)

Today goal has four vocabularies: `goal.update` record, `goal.updated` signal, `goal_updated` replay record, `getGoal()` getter. After the rewrite only fact + view remain:

```ts
declare module '#/stream' {
  interface FactMap {
    'goal.create': { goal: GoalInit }
    'goal.update': { patch: GoalPatch }        // incremental fact, shape unchanged
    'goal.clear': {}
  }
  interface ViewMap { goal: GoalSnapshot | null }
}

export class AgentGoalService extends Disposable implements IAgentGoalService {
  constructor(@IAgentStream private readonly stream: IAgentStream) {
    super();
    // the live projection is declared once at the definition site: replaces manual signal('goal.updated')
    // (V3's loudness also lives here: replay never reaches the projection, no implicit suppression needed)
    this._register(stream.defineFact('goal.update', {
      live: (f) => ({ type: 'goal.updated', patch: f.patch }),
    }));
    this._register(stream.defineView('goal', goalView));  // fold below
  }

  /** high-frequency budget updates: silent suppression no longer needed — view.equals dedup + notification queue coalescing (§8.1). */
  recordTokenUsage(usage: TokenUsage): void {
    this.stream.commit({ type: 'goal.update', patch: { usage } });
  }

  getGoal(): GoalSnapshot | null {
    return this.stream.view('goal').get().value;
  }
}

const goalView: View<GoalState, GoalFold, GoalSnapshot | null> = {
  init: EMPTY_GOAL_STATE,
  select: (f) =>
    f.type === 'goal.create' ? { kind: 'create', goal: f.goal }
    : f.type === 'goal.update' ? { kind: 'patch', patch: f.patch }
    : f.type === 'goal.clear' ? { kind: 'clear' }
    : undefined,
  reduce: applyGoalFold,          // the two parallel logics (restoreUpdate/appendStatusUpdate) merge into one (R1)
  derive: toSnapshot,
  equals: goalSnapshotEquals,     // budget micro-changes don't trigger notifications (replacing the silent flag)
};
```

### D.3 Scenario: derived composite view (replacing polling sessionActivity)

```ts
declare module '#/stream' {
  interface ViewMap {
    pendingInteractions: readonly PendingInteraction[]
    activeTurns: ReadonlyMap<string /* agentId */, ActiveTurnInfo>
    sessionActivity: SessionStatus   // derived, no own fold state
  }
}

// derive: read-only combinator (§5.1), synchronous pure function + change propagation; no polling, no cross-service ad-hoc assembly
sessionStream.defineView('sessionActivity', deriveViews(
  ['pendingInteractions', 'activeTurns'],
  (pending, turns): SessionStatus => {
    if (pending.some((p) => p.kind === 'approval')) return 'awaiting_approval';
    if (pending.some((p) => p.kind === 'question')) return 'awaiting_question';
    if (turns.size > 0) return 'running';
    return 'idle';
  },
));
```

### D.4 Scenario: ephemeral view `inFlightTurn` (absorbing the edge InFlightTurnTracker)

```ts
declare module '#/stream' {
  interface SignalMap {
    'assistant.delta': { turnId: number; stepId: number; cumulative: string }  // cumulative text (§5.4)
    'tool.progress': { toolCallId: string; channel: 'stdout' | 'stderr'; chunk: string }
  }
  interface ViewMap { inFlightTurn: InFlightTurn | null }
}

const inFlightTurnView: View<InFlightState, InFlightFold, InFlightTurn | null> = {
  ephemeral: true,                       // folds signals, live-only, in snapshots but not replayed (§5.5)
  init: NO_TURN,
  select: (f) =>                          // facts provide boundaries
    f.type === 'turn.launch' ? { kind: 'start', turnId: f.turnId }
    : undefined,
  selectSignal: (s) =>                    // signals provide in-progress content
    s.type === 'assistant.delta' ? { kind: 'text', ...s }
    : s.type === 'tool.progress' ? { kind: 'tool', ...s }
    : undefined,
  reduce: foldInFlight,                   // the edge tracker logic moves into the core; subagents no longer dropped (C9)
  derive: (st) => st.turn,
};
```

### D.5 Scenario: Effect (the only legal shape for subscriber write-back)

```ts
// swarm auto-exit: today hangs on turn.hooks.onEnded writing directly (L1)
export class AgentSwarmService extends Disposable {
  constructor(@IAgentStream private readonly stream: IAgentStream) {
    super();
    this._register(stream.defineEffect('swarm-auto-exit', {
      on: ['turn.ended'],                // runs only in the live phase; physically absent during replay (§8.3)
      run: () => {
        if (this.isActive()) this.exit();   // can only call Commands — exit() commits internally
      },
    }));
  }
}

// overflow → compaction: hand-written consecutiveOverflowCompactions counter → declarative depth cap
stream.defineEffect('overflow-compaction', {
  on: ['turn.step.overflowed'],
  maxCauseDepth: 2,                      // compaction-triggered re-overflow continues at most 2 levels, stops automatically beyond
  run: (fact, ctx) => fullCompaction.begin({ cause: ctx.cause }),
});
```

### D.6 Scenario: resume / replay / partial replay (phase machine + transcript view)

```ts
// restore orchestration (the old doResume manual pre-warming and the resumer/hook triple ordering contract → one flow, L3)
async function resumeAgent(stream: AgentStreamImpl): Promise<void> {
  await stream.replay();
  // internally: read the existing wire.jsonl (path/format/migration chain unchanged, §0) → fold each record into all views
  // (silent: no onChange, no Effects, no broadcast) → any commit/emit during this period throws directly (W5 made loud)
  await stream.markReady();
  // triggers the onReady one-shot callbacks: task disk reconciliation, cron startup, goal normalize
  // (the old postRestoring window / onResumeEnded hooks all fold in here)
}

// transcript view: UI history = fold (replacing the replay builder's dual channel, R2/R4)
declare module '#/stream' {
  interface ViewMap { transcript: readonly TranscriptTurn[] }
}
// partial replay: the old range/segment/frozen mechanism → the fold's parameterized initial condition, written once
stream.defineView('transcript', transcriptView({ range: { start: 120 } }));

// RPC resumeSession return value (shape-compatible with the current ResumeSessionResult):
const { value: replay, seq } = stream.view('transcript').get();
return { replay, seq };   // seq gives the client the subscription continuation watermark (C3)
```

### D.7 Scenario: server-v2 consumption surface (broadcaster source switch + snapshot + write echoes)

```ts
// broadcaster: the old "per-agent record.on subscription + onDidCreate/onDidDispose backfill" → one subscription
const sub = sessionStream.subscribe({ sinceSeq: 0 }, ({ seq, kind, event }) => {
  // durable/volatile already classified by the registry (kind), agentId/sessionId already stitched;
  // journal/epoch/backfill/resync unchanged (§0); edge seq monotonically consistent with core logical seq
  broadcaster.dispatch(seq, kind, event);
});

// snapshot route: ad-hoc assembly across 6 services + drain queue → read views' {value, seq} (C6/C7)
app.get('/sessions/:id/snapshot', async (req, reply) => {
  const transcript = await readView(req.params.id, 'transcript'); // cold/hot consistent: offline fold when no handle,
  const activity   = await readView(req.params.id, 'sessionActivity'); // never triggers resume/creates agents
  const inFlight   = await readView(req.params.id, 'inFlightTurn');
  reply.send({ as_of_seq: transcript.seq, messages: transcript.value,
               status: activity.value, in_flight_turn: inFlight.value });
});

// write route: write is commit, commit is necessarily in the stream — the router hand-emitting event.session.created three times disappears (C4)
app.post('/sessions/:id/todos', async (req, reply) => {
  const { seq } = todoService.setTodos(req.body.todos);
  reply.send({ seq });   // the client's optimistic-UI confirmation watermark: settled when an echo ≤ seq arrives
});
```

### D.8 Scenario: TUI consumption (replay = cold start + seq continuation)

```ts
// today: SessionReplayRenderer reverse-engineers the LLM context + joins the live stream by time approximation (C3)
// after the rewrite:
const snap = await api.snapshot(sessionId);          // { as_of_seq, views... }
renderTranscript(snap.messages);                     // structured data isomorphic with live
ws.subscribe({ sessionId, sinceSeq: snap.as_of_seq }); // seamless continuation, no window events dropped

// optimistic writes:
const pending = optimisticApply(localState, input);
const { seq } = await api.setTodos(sessionId, input);
pending.confirmWhen((echo) => echo.seq >= seq);      // write echo rebase (§4.2)
```
