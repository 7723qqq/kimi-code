# Spec Mode Hardening — Tasks

Each task is independently landable and independently checkable. Run the package test
command from the repo root per `DEVELOP.md`; the suite for this work is
`packages/agent-core-v2/test/features/spec/` plus the touched package suites.

Task 0 gates Task 1. Tasks 2 through 6 do not depend on each other.

## Task 0 — Resolve F7: find out whether non-file write accesses exist

Investigate `packages/agent-core-v2/src/tool/toolContract.ts` for the access kind union and
every constructor on `ToolAccesses`; then grep the codebase for `ToolAccesses.` call sites
that produce a write or readwrite operation.

**Acceptance criteria**

- A written answer either way: "no non-file write access kind exists" or a list of the kinds
  that do, with the file and line for each.
- If the answer is "none", no production code changes in this task.
- Either way, `specService.guardToolExecution` gains a branch that vetoes an access kind not
  equal to `'file'`, and a test at `specGuard.test.ts` fires a write access of an
  unrecognised kind at the guard and asserts `decision?.veto?.isError === true`.

## Task 1 — Realpath-aware containment for the write guard (F1, R1)

Add `isWithinDirectoryResolved` to `packages/agent-core-v2/src/tool/path-access.ts` with the
`RealpathResolver` interface from `design.md`. Rewire `AgentSpecService.guardToolExecution`
to use it via a `waitUntil` hook.

**Acceptance criteria**

- A new unit test in the path-access suite: for a base `/ws/specs/s1`, a candidate built
  through a symlink whose real target is `/tmp/out/x.md` returns `false`; the same candidate
  when the target really is inside the base returns `true`.
- A new guard test in `specGuard.test.ts`: with a host filesystem stub whose `realpath`
  reports `<specDir>/evil.md` resolving to `/tmp/evil.md`, the guard vetoes a write to
  `<specDir>/evil.md`.
- `specGuard.test.ts` still passes unchanged for the write-inside case (line 183), the
  write-outside case (191), the `../` escape case (201), the mixed-access case (211), the
  read-only case (224), the `TaskStop` case (230) and the exit-then-write case (236).
- Writing a document that does not yet exist inside the spec directory is allowed: a guard
  test writes `<specDir>/tasks.md` against a stub whose `realpath` rejects with ENOENT for
  that path, and asserts no veto.
- Behaviour when resolution fails follows the chosen option from Choice 1, and a test pins
  that choice explicitly.

## Task 2 — One `spec_submitted`, honest `spec_resolved` (F2, F6, R2)

Delete the emission at `exitSpecModeReview.ts:32`; keep one in
`ExitSpecModeTool.execution`; stop reporting `approved` on the auto-permission path.

**Acceptance criteria**

- Running the existing spec test suite, a test that intercepts telemetry records for one
  `ExitSpecMode` call in `manual` mode asserts exactly one `spec_submitted`.
- That record's `file_count` equals the number of non-empty documents, verified by a case
  where `progress.md` is absent and the three required documents are present yielding
  `file_count === 3`, and a case where one required document is empty — the latter is
  rejected before submission, so the assertion is that no `spec_submitted` is emitted at all.
- In `auto` permission mode, one `ExitSpecMode` call emits no `spec_resolved` with
  `outcome === 'approved'`; it emits the new distinct outcome instead.
- `SpecResolvedEvent['outcome']` in `app/telemetry/events.ts` includes the new value, and
  `pnpm -w tsc --noEmit` (or the repo's typecheck command per `DEVELOP.md`) passes.
- The reject / revise / dismiss paths still emit their existing outcomes: a test drives
  `approvalResult` for each of `cancelled`, `Revise` and `Reject and Exit` and asserts
  `dismissed`, `revise` and `rejected_and_exited` respectively.

## Task 3 — Read each document once per exit (F3, R3)

Add `readDocuments(dir)`; rebuild `status()` on it; give `recordRevision(data?)` the
already-read `SpecData`; have `ExitSpecModeTool` read `status()` once and thread it through.

**Acceptance criteria**

- A test using a host filesystem stub that counts `readText` calls asserts a single
  `ExitSpecMode` invocation in `manual` mode calls `readText` exactly three times for the
  three required documents — not nine.
- `recordRevision(data)` writes the same blob bytes as before: a test asserts the recorded
  `SpecRevision.sha256` equals the sha256 of the concatenation built in the current
  implementation's format (`# <name>\n\n<content>` joined by blank lines).
- Calling `recordRevision()` with no argument still works and still records a revision,
  preserving the existing signature's optionality.
- The existing `status()` assertions at `specGuard.test.ts:250`, `:261` and `:269` pass
  unchanged.

## Task 4 — `clear()` actually clears (F4, R4)

Implement the chosen option from Choice 2.

**Acceptance criteria**

- A test enters spec mode, writes all three documents, calls `clear()`, then asserts
  `status()?.missing` equals all three required file names and `status()?.complete === false`.
- After `clear()`, `EnterSpecMode` succeeds: previously `svc.enter('spec-2')` rejected with
  `/already in spec mode/i` (pinned at `specGuard.test.ts:247`); after `clear()` plus
  `exit()`, a test asserts the new enter resolves.
- Under Choice 2A, a test asserts the three document paths are absent from the host
  filesystem stub after `clear()` and the directory itself still exists.
- Under Choice 2B, a test asserts the spec directory path is absent from the host filesystem
  stub after `clear()`.
- `clear()` with no active spec remains a no-op that resolves without touching the host
  filesystem: a test asserts the host filesystem stub records zero delete calls.

## Task 5 — Distinguish exit from cancel in replay (F5, R5)

Add `lastTransition` to `SpecState`, set it in both handlers, and collapse the duplicated
handler bodies.

**Acceptance criteria**

- A test dispatches `SpecModeExit` and asserts `agentState.get(specKey).lastTransition === 'exit'`;
  a sibling test dispatches `SpecModeCancel` and asserts `'cancel'`.
- After an exit followed by a re-enter, `lastTransition` still reads `'exit'` — asserted by a
  test that enters, exits, re-enters and reads the field.
- Both handlers still emit exactly one `AgentStatusUpdated` with `specMode: false`: a test
  that counts emissions across a cancel and across an exit gets one each.
- `packages/agent-core-v2/docs/state-manifest.d.ts` reflects the new field, regenerated
  rather than hand-edited, and the suite that asserts the manifest is current passes
  (`packages/agent-core-v2/test/index.test.ts`).

## Task 6 — Close out

**Acceptance criteria**

- The full `packages/agent-core-v2` test suite passes, plus the `apps/kimi-code` TUI tests
  that reference spec mode (`approval-adapter.test.ts`, `create-tui-state.test.ts`,
  `footer-status-bar.test.ts`, `footer.test.ts`, `welcome.test.ts`, `fullscreen-layout.test.ts`).
- `bun run lint` and the repo's typecheck pass with no new warnings introduced by these
  changes.
- A changeset exists for the affected package per `CONTRIBUTING.md`; running the changeset
  check the repo uses reports it as present.
- Every finding F1–F7 in `requirements.md` has a disposition in the final report: fixed,
  or recorded as a non-issue with the evidence that closed it.
- `git diff --stat` shows no file outside the scope listed in `requirements.md` → Boundaries,
  other than the two the design names (`tool/path-access.ts`, `app/telemetry/events.ts`).
