# DeepSeek Harness Capability Fusion — Selection & Comparison Notes

Session report for merging selected capabilities from
[deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) (MIT) into
this fork of kimi-code. Source checkout used for comparison:
`G:\deepseekharness` (upstream `main`, commit `47f9438`).

Ported modules carry a source note in their header naming the upstream package
and license. This document records the capability matrix, the selection
decisions, and the rationale for deferrals.

## Comparison matrix

Legend: **ported** = already merged into this fork (with attribution);
**equivalent** = kimi-code has a comparable capability (no port needed);
**gap** = no kimi equivalent found; **deferred** = genuine gap but not ported
this round (rationale in the table); **n/a** = architecture-specific to the
Cordis plugin model, not transferable.

| deepseek-harness capability | verdict | kimi-code counterpart / note |
|---|---|---|
| `guard/repeat-tool-reminder` (advisory repeat-call reminders, thresholds 3/5/8) | **equivalent** | `agent/toolDedupe` — per-turn dedupe + cross-step repeat reminders with 3/5/8 escalation, force-stop at 12, state persisted in `agentState`, telemetry (`tool_call.dup_type`). Stronger than upstream. |
| `guard/timeout-policy` (per-call tool deadlines, structured `TOOL_TIMEOUT` result) | **gap → ported this round** | No per-call deadline in kimi's tool runtime: `Tool` contract has no `timeoutMs`; execution aborts only on user cancellation / loop abort. Ported as `RunnableToolExecution.timeoutMs` + deadline wrapper in `AgentToolExecutorService`. Reuses existing `createDeadlineAbortSignal`. |
| `mcp-client` connection lifecycle (auto-reconnect with bounded exponential backoff) | **ported** | `mcpCore/connection-manager.ts` (commit `0c808bb82`). |
| `sandbox` (process confinement, read-only policy) | **ported** | `workspace/sandbox/sandbox.ts`. |
| `subagent` delegation-depth accounting | **ported** | `session/agentLifecycle/subagentMetadata.ts`. |
| `code-runtime` worker-thread execution | **ported** | `features/codeRuntime/codeWorkerSource.ts`. |
| `skill` catalog / provider precedence | **ported** | `app/skillCatalog/types.ts` (inspired-by note). |
| `web` search/fetch providers | **equivalent** | Fork ported the open-websearch engine set (commits `8d3bde547`, `30427bb76`). |
| `core` / `api` / `host` / `client` / `sdk` / `acp` | **n/a** | Both projects are full agent engines; kimi uses DI × Scope, deepseek-harness uses Cordis plugins. Cross-importing engines is out of scope. |
| `llm` provider family | **equivalent** | `kosong` (providers, tool-schema projection). |
| `terminal` / `shell` / `subprocess` / `fs` | **equivalent** | `os/backends/*`, `kaos`, `kimi-native-tools` (nativeBash), `session/terminal`. |
| `plan` / `goal` / `todo` / `schedule` | **equivalent** | `features/plan`, `agent/goal` (+deadline scheduler), `session/todo`, `app/cron`. |
| `workflow` | **equivalent** | `app/workflow` (registry/runtime/service/tools). |
| `compaction` | **equivalent** | `agent/fullCompaction`, `agent/microCompaction`, native compaction. |
| `session` (JSONL/SQLite backends, titles, reporting) | **equivalent** | `session/sessionLog`, `session/sessionTitle`, `transcript`, `persistence/*`. |
| `session-query` (full-text, lineage, semantic filtering) | **ported (rounds 4–6)** | `features/sessionQuery` — corpus/filters/lineage, event full-text search, and the model-facing `session_query` tool; built on minidb full-text + the transcript event log. |
| `interaction` (approval seams, permission presets, ask-user) | **equivalent** | `agent/permission*`, `agent/toolApproval`, `agent/tools/ask-user-question`. |
| `attachment` (content-addressed durable storage) | **ported (round 7)** | `features/attachment` — content-addressed attachment store + service, layered on the existing blob/media originals. |
| `spill` (tool-result spill to disk) | **ported (round 3)** | `features/spill` — truncated tool output persisted to a session-scoped artifact with a model-facing locator; wired into Bash and FetchURL. |
| `extensions` (model-written plugin mount/unmount) | **deferred** | kimi has a plugin system; self-modification surface is risky and needs its own design. |
| `hooks` (Claude Code / Codex wire protocol) | **deferred** | Overlaps with in-flight subagent backends work (`session/subagent/backend/*`). |
| `e2b` (cloud sandbox) | **deferred** | Niche; requires external service; OS-level sandbox already ported. |
| `preset` / `bundle` / `boot` / `typert` / `context` / `storage` / `credentials` / `settings` / `identity` / `feedback` / `jobs` / `util` | **equivalent / n/a** | Covered by kimi config (`app/config`), `minidb`, `oauth`, `_base/utils`, feedback collection, task tooling. Cordis-specific composition (`preset`, `bundle`) not transferable. |

## This round's selection

Ported: **`timeout-policy`** — per-call tool execution deadline.

- Upstream: `packages/guard/timeout-policy` + `packages/util/timeout` (MIT).
- Rationale: genuine gap (no kimi equivalent); small and self-contained; the
  abort-signal seam already exists in `AgentToolExecutorService`; high value
  (a hanging tool currently blocks the turn until user cancellation or goal
  deadline).
- Adaptation notes:
  - Upstream wraps the whole `tools/execute` event and replaces the tool
    result with a structured `TOOL_TIMEOUT` error. kimi has no per-call
    execute event; the wrapper lives inside `runSingleExecution`, keyed off
    an optional `timeoutMs` on `RunnableToolExecution`.
  - Upstream's `deadline()`/`timeoutOf()` (TimeoutReason with capability code)
    maps to the existing `createDeadlineAbortSignal` + `timedOut()`.
  - Timeout surfaces as an error tool result (`Tool "X" timed out after Nms`)
    so the model sees the reason; the existing 2s abort grace still applies.

Deferred (documented for a future round): `session-query`, `spill`,
`extensions`, `attachment`, `e2b`.

## Second round: session statistics strip

Ported: **`ui-conversation` StatsLine** — the live session statistics strip
(turns · steps | LLM · tool wall time | avg TTFT · tok/s | cache hit · tokens).

- Upstream: `packages/client/ui-conversation/src/client/chat/StatsLine.tsx` +
  `turn-metrics.ts` + `message-chrome.ts` (MIT).
- Data path: the kap-server WS already streams raw engine frames
  (`turn.started` / `turn.step.completed` with `usage`,
  `llmFirstTokenLatencyMs`, `llmStreamDurationMs`, `llmRequestBuildMs`;
  `tool.call.started` / `tool.result` with frame timestamps), so the whole
  port is client-side in `apps/kimi-web` — no protocol changes needed.
- Adaptation notes:
  - Upstream folds a durable server-side `sessionStats` projection and a
    `tokenUsage` projection; kimi-web accumulates live from the raw frame
    stream (`lib/sessionStats.ts`, pure reducer) and overlays durable token
    totals from the session usage snapshot so cache-hit share and billed
    tokens survive a reload (timings are "since subscribe", like upstream's
    window-scoped fallback).
  - Upstream's `deriveStats` node fold maps to the kimi client-side
    projector's per-frame handling; subagent (non-main-agent) frames are
    excluded the same way the transcript projector excludes them.
  - UI: `StatsLine.vue` mounts above the composer in `ChatDock.vue`,
    mirroring the composer-dock placement upstream; groups with no data drop
    out wholesale.
- Verification: `vue-tsc` clean for the touched files (two pre-existing
  errors in `useAppearance.ts` remain, untouched), oxlint clean, locale
  placeholder check OK; the pure-logic unit tests
  (`apps/kimi-web/test/session-stats.test.ts`) were typechecked but not run
  (vitest cannot start in the sandboxed shell).

Deferred (documented for a future round): `session-query`, `spill`,
`extensions`, `attachment`, `e2b`.

## Third round: spill storage

Ported: **`spill`** — tool-output spill storage (oversized tool results
persisted to a session-scoped artifact with a model-facing locator).

- Upstream: `packages/spill/spill` + `packages/spill/spill-local` (MIT).
- Rationale: kimi truncates oversized tool output (50k chars via
  `ToolResultBuilder`) and only Bash persisted truncated output to a task
  snapshot; spill generalizes the "truncate → persist → model-readable
  reference" pattern to any tool.
- Adaptation notes:
  - Upstream's Cordis `SpillStore` service maps to `ISpillService` (Session
    scope) contributed by a `SpillFeature` unit with a `[spill] root` config
    section (default: lazily-created 0700 per-process temp root).
  - The DI-free store mechanics (`privateRoot`, `encodeSegment` safe-path
    encoding, `sessionDir` hash scoping, exclusive `wx`/0600 writes) port
    verbatim from `spill-local/src/store.ts`.
  - `ToolResultBuilder` gained an optional `onTruncated(fullText)` hook that
    collects the full untruncated stream (bounded at 50 MB) and attaches a
    `spilled?: SpillRef` to built results via `spillFullText()`; hook
    failures degrade best-effort (inline truncated result stands).
  - Consumers: `BashTool` (spill hint alongside the existing task-output
    path) and `FetchURLTool` (page-content spill). `ReadTool` was not wired:
    it truncates per-line with an inherent file path the model can re-read.
  - `SpillService.readText` refuses locators outside the configured root.
- Verification: `tsc --noEmit` clean; new unit tests
  (`test/features/spill/spill.test.ts`, 17 cases) covering encoding, exclusive
  writes, builder hook semantics, and service round-trip/escape guard; full
  `agent-core-v2` suite green (this round also refreshed an outdated
  `tool.test.ts` tools-snapshot that predated the lsp/select_tools tools).

Deferred (documented for a future round): `session-query`, `extensions`,
`attachment`, `e2b`.

## Fourth round: session-query (stage A — corpus, filters, lineage)

Ported: **`session-query` stage A** — the logical-corpus read model: session
listing with availability, ANDed/ORed session filters, and fork lineage
tracing.

- Upstream: `packages/session-query/session-query` (MIT).
- Adaptation notes:
  - `SessionRecord` maps to kimi's `SessionSummary` (id/cwd/createdAt) plus
    `parentSessionId` read from the session index's
    `custom.parent_session_id` fork-provenance field; `live` comes from the
    workspace lifecycle session registry, `persisted` from the session index.
  - `filters.ts` ports the upstream pure predicates verbatim
    (id/cwd/created-at/parent/availability with per-clause OR and
    cross-clause AND); `materializeSessionResultFilters` validates and
    detaches clauses, reporting `session_query.*` error codes.
  - `lineage.ts` walks `parentSessionId` into ancestor chains and complete
    descendant trees with the upstream `complete`/`unresolvedParentId`
    contract.
  - `SessionQueryService` (App scope) lists the corpus through
    `ISessionIndex.listRecent` keyset pages (all sessions, archived
    included) and stamps live ids from `IWorkspaceLifecycleService`.
  - Event-level records, full-text search, and the model tool are deferred
    to stage B/C.
- Verification: `tsc --noEmit` clean; oxlint clean; new unit tests
  (`test/features/sessionQuery/sessionQuery.test.ts`, 19 cases) covering
  filter semantics, lineage walks, and service resolution against stubbed
  index/registry sources; full `agent-core-v2` suite green.

Deferred (documented for a future round): `session-query` stages B (full-text
search) and C (model tool), `extensions`, `attachment`, `e2b`.

## Fifth round: session-query (stage B — event filtering and full-text search)

Ported: **`session-query` stage B** — event-level filtering and full-text
search over a session's wire journal.

- Upstream: `packages/session-query/session-query` (MIT).
- Adaptation notes:
  - The event source is the main-agent wire journal (`wire.jsonl`): one event
    is one wire record (seq = journal order, type = record type, time =
    record timestamp), read through `IAppendLogStore` and cached per session
    with the journal `revision()` as the invalidation key — the same
    "revision unchanged ⇒ cache fresh" contract the store documents.
  - `wireRecordText` renders the searchable text of a record (textual
    payload fields plus `content`-part and `message`-nested text); subagent
    journals are out of scope.
  - `filterSessionEvents` ports the upstream metadata/literal-text predicates
    (seq/time/type/text; the text clause is a case-insensitive,
    whitespace-flexible literal scan, regex-injection safe).
  - `searchEventDocuments` ranks by exact-token overlap using the embedded
    store's own tokenizer (`@moonshot-ai/minidb` `tokenize`, ASCII words +
    CJK uni/bigrams), builds bounded snippets (±40 chars), and pages through
    an opaque offset cursor. Query text is data, never query syntax.
  - `SessionQueryService` gained `filterEvents` / `searchEvents` /
    `searchSessions`; cross-session search defaults to live sessions
    (bounded work) and honors session filters to widen the corpus.
  - The upstream SQLite-backed index is NOT ported — the engine layer keeps
    an in-memory journal cache; durable archive search remains kap-server's
    minidb search surface.
- Verification: `tsc --noEmit` clean; oxlint clean; new unit tests
  (`test/features/sessionQuery/eventSearch.test.ts`, 16 cases) covering
  filters, ranking/snippets, cursor paging, and revision-keyed cache
  rebuild; full `agent-core-v2` suite green.

Deferred (documented for a future round): `session-query` stage C (model
tool), `extensions`, `attachment`, `e2b`.

## Sixth round: session-query (stage C — the model tool)

Ported: **`session-query` stage C** — the `session_query` agent tool.

- Upstream: `packages/session-query/tool-session-query` (MIT).
- Adaptation notes:
  - Three operations, one per call: `session_search` (cross-session
    full-text search, force-scoped to the caller's workspace cwd),
    `event_search` (within-session search, current session by default), and
    `session_trace` (fork lineage). Upstream `event_trace`/`event_read` are
    deferred (kimi's query service has no event-trace/window reads yet).
  - `toolInput` ports the argument schemas, ISO 8601 timestamp bounds, and
    filter construction; the upstream sub-millisecond boundary handling is
    dropped (kimi event times are integer epoch milliseconds).
  - `toolPresentation` renders model-readable text with snippets and a
    result cap; `session_query` is main-agent-only.
- Verification: `tsc --noEmit` clean; oxlint clean; new unit tests
  (`test/features/sessionQuery/sessionQueryTool.test.ts`, 15 cases) covering
  schema validation, filter construction, the three operations against a
  stubbed service, and rendering; full `agent-core-v2` suite green.

Deferred (documented for a future round): `extensions`, `attachment`, `e2b`.

## Seventh round: attachment storage

Ported: **`attachment`** — content-addressed image attachment storage.

- Upstream: `packages/attachment/attachment` + `packages/attachment/attachment-local` (MIT).
- Rationale: kimi has agent-scoped blobs and media originals, but no
  content-addressed, cross-session durable object store with image
  admission.
- Adaptation notes:
  - `IAttachmentService` (App scope) saves/reads images under
    `sha256:<hex>` content addresses; identical payloads deduplicate and a
    reference verifies against the object it names. Writes are exclusive +
    owner-only with a directory sync before the reference is reported.
  - Admission policy: declared media type must match the bytes (magic-byte
    sniffing via kimi's `sniffMediaFromMagic`), byte and decoded-pixel
    limits, and a full jimp decode. The upstream sharp pipeline is replaced
    by kimi's existing image toolchain; dimensions come from
    `sniffImageDimensions` (native + TS fallback).
  - `[attachment] root` (default: private per-process temp dir) and
    `limits` config section.
  - Protocol/tool integration (attachment references in messages) is
    deferred — this round ports the storage seam only.
- Verification: `tsc --noEmit` clean; oxlint clean; new unit tests
  (`test/features/attachment/attachment.test.ts`, 11 cases) covering
  digest addressing/deduplication, name sanitization, admission rejections,
  and service round-trip; full `agent-core-v2` suite green.

Deferred (documented for a future round): `extensions`, `e2b`.

## Verification

- `tsc --noEmit` on `agent-core-v2` and `kosong` (typecheck of the full app is
  currently blocked by unrelated duplicate locale keys in the working tree).
- oxlint (non-type-aware) on changed files.
- New unit tests in `test/agent/toolExecutor/toolExecutor.test.ts` covering:
  timeout firing, in-budget completion, user-cancellation precedence.
