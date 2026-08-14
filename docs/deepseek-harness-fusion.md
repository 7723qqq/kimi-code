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
| `session-query` (full-text, lineage, semantic filtering) | **deferred** | kimi has minidb full-text + kap-server search surface; semantic-filtering / lineage query language would be a new API surface. |
| `interaction` (approval seams, permission presets, ask-user) | **equivalent** | `agent/permission*`, `agent/toolApproval`, `agent/tools/ask-user-question`. |
| `attachment` (content-addressed durable storage) | **deferred** | kimi has `agent/blob` + media originals; a content-addressed public attachment identity is a protocol-level change. |
| `spill` (tool-result spill to disk) | **deferred** | kimi truncates oversized tool output (native truncation + `toolResultTruncation`); spilling to files requires a model-visible read path and context-memory integration. |
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

## Verification

- `tsc --noEmit` on `agent-core-v2` and `kosong` (typecheck of the full app is
  currently blocked by unrelated duplicate locale keys in the working tree).
- oxlint (non-type-aware) on changed files.
- New unit tests in `test/agent/toolExecutor/toolExecutor.test.ts` covering:
  timeout firing, in-budget completion, user-cancellation precedence.
