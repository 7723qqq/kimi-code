# Implementation and acceptance tasks

## 1. Pin the official client contract and reproduce the gaps

- Inventory the pinned bundle's REST methods, WebSocket requests, frame handlers, and turn-to-chat conversion.
- Compare them with the current routes/projections and matching upstream source, prioritizing normal chat, tools, approval, history/reconnect, compaction, undo, fork, and file history.
- Add failing tests in existing kap-server fold/feed/subscription suites for the confirmed gaps.

Acceptance:
- Artifact identity and reference commit are recorded; `git diff f082f04a09 -- apps/kimi-code/dist-web` remains empty.
- Every discovered API-client method and socket command has a compatibility-matrix row, with evidence or an explicit unresolved status; no untested row is described as verified.
- Before the fix, a step-start followed by text/thinking/tool deltas fails to produce the client-required item sequence, and a persisted multi-step conversation fails its expected step/turn metadata assertions.

## 2. Provide safe participant replay and undo support

- Adapt the upstream dispatcher prerequisites and #4893's opt-in participant staging to the fork's silent-commit semantics.
- Preserve ordinary participant and replayable-state behavior.

Acceptance:
- Existing `test/state/eventDispatcher.test.ts` tests pass.
- Initial and late attachment project an anchor user message instead of dropping it.
- Replay calls the begin/end lifecycle exactly once per attached participant; no intermediate conversation frames are published.
- A transition failure leaves the previous committed state byte-equivalent and usable, drops staged mutable state, and rejects readiness; a subsequent supported recovery does not retain failed staging.
- Mutable undoable participants without custom undo are rejected. Checkpoint operations during mutable replay are rejected.
- Successful replay publishes a frozen result; subsequent live changes do not mutate previous snapshots.
- Disposal during queued attachment releases subscriptions and settles readiness rather than leaving a pending promise.

## 3. Restore the official conversation event fold

- Restore/adapt upstream `applyConversationRecord`, step/item tracking, interactions, subagent references, tasks, compaction and custom undo.
- Retire the context-only rebuild as the authoritative feed path in the same change.

Acceptance:
- Live and cold folding of the same recorded fixture produce identical turn/item IDs, turn numbers, timestamps, step indexes, outputs, notes and terminal outcomes.
- Text and thinking deltas appear before the final result, remain on their originating step, and are not duplicated when the durable content arrives.
- Tool lifecycle covers input, awaiting approval, execution, progress, final success/failure/interruption, and recorded `task_id`.
- An approval has its matching `interaction_id`; a subagent call has the recorded `agent_refs` without inferring IDs from prose.
- A retry removes only the abandoned step's unfinished items; a stopped tool is interrupted, while an actual failed tool remains failed.
- Compaction adds its system item but keeps previous visible turns. Clear/undo remove exactly the specified history; undo remains serialized under concurrent requests.
- Legacy message records remain readable and never acquire fabricated step metadata.
- The existing task-link, tool-lookup, note, media-redaction and reasoning-timing regressions remain green; indexes match the restored arrays after reset/undo.

## 4. Align subscription lifecycle and confirmed REST differences

- Adapt subscription reservation/acknowledgement/seed sequencing and generation cleanup.
- Repair mismatches demonstrated by the pinned REST client, with cases attached to each compatibility row.

Acceptance:
- A flat official `subscribe` request receives a successful `response` before `turns` and pending interaction frames; the frontend's reset-on-response cannot erase a newly seeded approval.
- An event arriving while the initial page is loading is delivered once after the page.
- A connection closing during subscribe leaves no target or listener behind. Removed agents receive no new events after unsubscribe.
- Reconnection yields a complete latest page and consistent agent/task/interaction state; stale attachment generations cannot overwrite it.
- Unknown session/agent and failed restore produce explicit error frames, not silent empty success.
- Tested REST request/response shapes match the bundle; missing turn and missing agent remain distinct (40422/40421), and duplicate undo returns one success and one missing-turn error.
- Retained Operation Log transcript routes/frames and their existing tests continue to work.

## 5. Validate with the actual official bundle

- Use the repository's server/test helpers and a deterministic local model stream, disposable home/workspace, and a real browser rendering the unchanged bundle.
- Capture screenshots plus request/frame observations for the exercised paths. Shut down the test server/browser resources created for the run and remove only owned temporary files.

Acceptance:
- Normal chat visibly streams before completion; tool execution, approval, cancellation and retry render the intended states.
- Reload/reconnect preserves content and IDs. Compaction retains earlier visible history. Undo removes the selected turn; fork and file-history requests use its recorded `turn_number`.
- REST and WebSocket contract tests pass against the running server, not just isolated functions.
- Browser console/network has no unhandled protocol errors in the exercised scenarios. Any unavailable platform interaction is explicitly marked unverified and blocks claims about that scenario.
- Baseline and final long-history replay measurements use the same fixture and environment; final states match. No clone/commit operation scales as one full-history copy per record.

## 6. Close the migration and validate delivery

- Update bilingual protocol docs and the upstream ledger/PLAYBOOK through existing tooling; reopen #4663/#4893 claims superseded by the new consumer and record actual port evidence.
- Run affected tests, then owning package suites sequentially, and all impacted typechecks/builds. Build the CLI and run its existing smoke command.

Acceptance:
- `agent-core-v2` dispatcher/context/undo and `kap-server` conversation/socket/route tests pass; affected package suites complete with failures and platform skips reported accurately.
- Server and CLI builds and CLI smoke pass, as do applicable boundary, comment-free, locale, API-surface and structural gates.
- The official `dist-web` bytes remain unchanged. No temporary configuration points at the local test provider, no owned server remains listening, and no scratch files remain in the deliverable.
- Final report distinguishes the completed conversation migration, the REST audit's verified coverage, and any unresolved compatibility rows. It does not claim the entire Web app is aligned while required matrix rows remain unresolved.
