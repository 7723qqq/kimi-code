# Spec Mode Hardening — Design

## Approach

Five fixes, each against a finding in `requirements.md`, plus one investigation that gates
the guard fix. The shape of every fix is "move the responsibility to the one place that can
see the whole picture", not "add a check at each site".

The affected code stays inside `packages/agent-core-v2/src/features/spec/`. Two files outside
it are touched: `tool/path-access.ts` (a new realpath-aware containment helper) and
`app/telemetry/events.ts` (only if a resolved-outcome value changes).

### F1 / R1 — containment must survive symlinks

`specService.guardToolExecution` currently calls `isWithinDirectory(access.path, dir, pathClassFor())`.
That helper is lexical (`path-access.ts:167`): it normalizes and compares prefixes, so
`<specDir>/link` where `link -> /etc` is judged inside the spec directory.

Add a sibling helper rather than changing `isWithinDirectory`, because the lexical form is
load-bearing for workspace policy where no filesystem is available:

```ts
// tool/path-access.ts
export interface RealpathResolver {
  realpath(path: string): Promise<string>;
}

export async function isWithinDirectoryResolved(
  candidate: string,
  base: string,
  resolve: RealpathResolver,
  pathClass: PathClass = DEFAULT_PATH_CLASS,
): Promise<boolean>
```

Its contract: `isWithinDirectory` must pass lexically **and** the resolved form of the
candidate's deepest existing ancestor must be inside the resolved base. Resolution failures
(ENOENT on a not-yet-created file) are not errors — the deepest existing ancestor is resolved
instead, so writing a new `tasks.md` still works.

This makes `guardToolExecution` async. The hook already supports that: `ExitSpecMode` uses
`event.waitUntil(...)` at `specService.ts:207`, and `event.veto(...)` is synchronous, so the
guard becomes a single `waitUntil` that resolves to a veto or to nothing. Ordering with the
existing `ExitSpecMode` and `TaskStop` branches is preserved by keeping them ahead of the
access scan.

**Decision left open → Approach A vs B for the guard's failure mode.** When realpath cannot
resolve at all (broken symlink, permission denied, host without realpath), does the guard
fail open or fail closed? See "Open choices" below.

### F2 + F6 / R2 — one emission site

`spec_submitted` today has two sites that disagree about `file_count`. The review path
(`exitSpecModeReview.ts:32`) counts documents with content; the execution path
(`exitSpecModeTool.ts:78`) reports the constant 3. Delete the review-path emission and keep
exactly one `spec_submitted` in `ExitSpecModeTool.execution`, using the count of non-empty
documents from the `status()` it already reads.

Make the review path's emission conditional on "the user will actually be asked": the
`requestApproval` call at `exitSpecModeReview.ts:35` only runs when
`this.modeService.mode !== 'auto'` (gated at `specService.ts:206`). Delete the
`spec_resolved: approved` emission in the auto branch (`exitSpecModeTool.ts:84`) and emit a
distinct outcome for it instead, so analytics cannot read an auto-approved spec as
user-approved.

That requires one new value on `SpecResolvedEvent['outcome']` in
`app/telemetry/events.ts:213` — the event schema is a TypeScript union, so adding a member is
a compile-checked change and the property description at `events.ts:861` needs no edit.

### F3 / R3 — read the documents once per exit

Introduce a private `readDocuments(dir): Promise<Record<SpecRequiredFile, string>>` on
`AgentSpecService` and have `status()` build its `SpecData` from it. Then:

- `recordRevision()` reads once instead of once per file.
- `ExitSpecModeTool` calls `status()` once and threads the resulting `SpecData` into
  `recordRevision(data)` and into the review display, instead of calling `status()` twice and
  `recordRevision()`'s internal reads on top.

`recordRevision` gains an optional pre-read parameter rather than a cache on the service.
A cache would need invalidation on every write the agent makes outside the service, and the
guard cannot see those. Passing the already-read data down is the smaller, honest change.

Per-turn cost is unchanged: the injection at `specModeInjection.ts:31` still reads three
files once per turn. Reducing that is a change to the reminder cadence, which is out of
scope.

### F4 / R4 — `clear()` means cleared

`clear()` currently writes `''` into each required file (`specService.ts:137-143`). Change it
to call `IHostFileSystem`'s delete for each required file, and to run `hostFs.rmdir`-equivalent
on the spec directory when it is empty. `status()` then sees unreadable files, which
`readSpecFile` already maps to `''` (`specService.ts:192-198`), so `missing` reports all three
and `stage` falls back to `specify`.

`IHostFileSystem` may not expose a delete for a single file — the design must confirm the
interface before implementing, and if only a directory delete exists, delete the spec
directory outright (it contains only the three documents plus an optional `progress.md`,
which is why the progress file is listed in `SPEC_ALL_FILES` but not required).

### F5 / R5 — exit and cancel must differ in replay

`specKey` currently has two handlers with identical bodies. Keep both event classes — they
carry different intent and the SDK exposes `setSpecMode(false)` (cancel) separately from the
model's `ExitSpecMode` (exit) — but record which one fired so a replay can tell them apart.

Add a field to `SpecState`:

```ts
export interface SpecState {
  readonly active: boolean;
  readonly id?: string;
  readonly revisionCount?: Readonly<Record<string, number>>;
  readonly lastTransition?: 'cancel' | 'exit';
}
```

Set it in each handler. `lastTransition` is not cleared on enter, so it always describes the
most recent termination. Both handlers keep emitting `AgentStatusUpdated`; collapse the two
bodies into one shared local function so the duplicated emission cannot drift.

### F7 — investigate before widening the guard

Search the tool contract for access kinds other than `'file'` and for write-capable
non-file operations. If none exist, the filter at `specService.ts:235-241` is correct as
written and no change is made. Either way, add the explicit `default` branch that vetoes an
unrecognised access kind, so the guard keeps failing closed if the contract grows later.

## Constraints

- The review display contract (`kind: 'spec_review'`, `dir`, `documents`, optional `options`)
  is consumed by the TUI approval adapter and asserted in
  `apps/kimi-code/test/tui/reverse-rpc/approval-adapter.test.ts`. Changing its shape means
  changing that test; the design does not change it.
- `guardToolExecution` becoming async must not change the ordering guarantees the executor
  hook provides. The existing test at `specGuard.test.ts:177-181` fires the hook and awaits
  it; the new shape must satisfy the same call pattern.
- `specKey` is registered as replayable and undoable (`specOps.ts:82-84`) and appears in
  `docs/state-manifest.d.ts`. A new `SpecState` field must be reflected there; the manifest
  is generated, so regenerate rather than hand-edit.
- No new dependency. `realpath` comes from the injected host filesystem interface or from
  `node:fs/promises` where the host is Node — confirm which before implementing.

## Open choices

Two of these change the deliverable materially and are put to the user at approval time.

**Choice 1 — guard failure mode (F1).** When containment cannot be resolved:

- **A, fail closed.** An unresolvable path is denied with the existing denial message.
  Safest; risks blocking a legitimate first write of a new document on a host whose realpath
  behaves unexpectedly.
- **B, fall back to lexical.** An unresolvable path falls back to today's
  `isWithinDirectory` answer. Preserves current behaviour exactly; leaves the symlink hole
  open on hosts where resolution fails.

**Choice 2 — cleanup shape (F4).**

- **A, delete the three documents, keep the directory.** A fresh `EnterSpecMode` reuses the
  directory; the empty directory remains visible on disk.
- **B, delete the whole spec directory.** Truly clean, but `clear()` currently returns early
  when no spec is active (`specService.ts:138-139`) and the directory id is a hero slug
  (`generateHeroSlug`), so a reused id would silently collide with nothing rather than an
  empty directory — the id is regenerated per enter, so either shape works.

## Alternatives rejected

**Wrapping every write tool in a spec-specific tool.** Rejected: it multiplies the tool
surface and puts the boundary in N places instead of one, which is the defect class F1
belongs to.

**Making the guard resolve paths synchronously via `fs.realpathSync`.** Rejected: the
service is constructed against `IHostFileSystem`, which is not necessarily Node, and a
synchronous filesystem call inside an async hook invites blocking a host that has no such
API.

**Adding a document cache to `AgentSpecService` for F3.** Rejected: invalidation is
unsolvable from inside the service, because writes go through the file tools, not through
the service. A stale cache would make `status()` lie about `missing`, which is the one thing
`ExitSpecMode` gates on.

**Merging `SpecModeExit` into `SpecModeCancel` for F5.** Rejected: the SDK already separates
the two entry points, and a merged event would lose the distinction the fix is meant to
create.
