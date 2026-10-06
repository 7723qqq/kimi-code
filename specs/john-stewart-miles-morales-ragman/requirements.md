# Spec Mode Hardening — Requirements

## Goal

Spec mode is shipped but never reviewed as its own change set. This work audits the
implementation in `packages/agent-core-v2/src/features/spec/` and the surfaces it touches,
then fixes the concrete defects the audit finds.

The deliverable is a corrected spec-mode implementation plus the tests that pin each fix.
The deliverable is **not** a design document for spec mode — spec mode already exists and
its shape is settled.

## Audience

Maintainers of `agent-core-v2` who own the spec feature, and whoever next touches the write
guard, the reminder injection, or the exit-review flow. They need the guard to be the thing
that actually enforces the boundary, so they can reason about it locally instead of tracing
every call site.

## What the audit already established

These are findings, not requirements. Each is checked against the code and carries a
location. They are the candidates this work decides on.

| # | Finding | Location | Confidence |
|---|---------|----------|-----------|
| F1 | The write guard decides containment with `isWithinDirectory`, which is pure lexical `pathe.normalize` + prefix comparison. A spec-directory path that is a symlink to somewhere else passes the guard while the write lands outside. | `specService.ts:226`, `path-access.ts:167` | Mechanically established; impact depends on whether `IHostFileSystem` follows links, which is host-specific |
| F2 | `spec_submitted` is emitted twice for one exit: once when the review display is built and once in the tool's execution. The two sites disagree on `file_count` (documents with content vs. `SPEC_REQUIRED_FILES.length`). | `exitSpecModeReview.ts:32`, `exitSpecModeTool.ts:78` | Certain |
| F3 | `status()` reads and re-reads all three documents on every call. It is called once per turn by the reminder injection, and again by `recordRevision()` and by both `ExitSpecMode` paths, so one exit costs three full reads. | `specService.ts:171`, `specModeInjection.ts:31`, `specService.ts:145`, `exitSpecModeTool.ts:39`/`62` | Certain |
| F4 | `clear()` writes `''` into each required file. "Clear the spec" leaves three empty files that still count as a spec directory, and `status()` reports them as `missing`. | `specService.ts:137` | Certain |
| F5 | `SpecModeExit` and `SpecModeCancel` have byte-identical state transitions and identical `AgentStatusUpdated` emission; nothing downstream distinguishes them, so persisted replays cannot tell a user cancel from a model-driven exit. | `specOps.ts:92-105` | Certain |
| F6 | `spec_resolved` is emitted from five sites across two files, and the `approved` outcome is emitted even in the auto-permission path where the user never actually approved. | `exitSpecModeReview.ts:57-142`, `exitSpecModeTool.ts:84`/`91` | Certain |
| F7 | The guard filters accesses to `kind === 'file'` with `operation` write/readwrite, so a non-file write access class would pass unchecked. Whether such a class exists today is unverified. | `specService.ts:235-241` | Unverified — the open question is whether a non-file write access class exists |

## Requirements

**R1 — Keep the guard honest.** The write guard must deny every write whose resolved target
is outside the active spec directory, including paths that reach outside through a symlink,
and including multi-access tool calls where any single access lands outside. Existing
behaviour for reads and for the `TaskStop` / `CronCreate` / `CronDelete` denials must not
regress.

**R2 — One event per real occurrence.** Each of `spec_enter_resolved`, `spec_submitted` and
`spec_resolved` must be emitted at most once per user-visible occurrence, and `spec_resolved`
must not report `approved` for a spec the user never saw.

**R3 — One read per exit.** A single `ExitSpecMode` call must read each document once, not
three times, without changing what the review panel shows.

**R4 — `clear()` must mean cleared.** After `clear()`, `status()` must report the spec
directory as empty of documents, and a subsequent `EnterSpecMode` must be able to start a
fresh spec.

**R5 — Exit and cancel must be distinguishable in replay.** A persisted session replayed
after a `SpecModeExit` and one replayed after a `SpecModeCancel` must be distinguishable
from the event stream alone.

**F7 resolution is a requirement, not an assumption.** If the investigation finds no
non-file write access class, the finding is recorded as non-issue and R1's scope narrows to
file accesses; the guard must then still fail closed on an access kind it does not
recognise.

## Boundaries

- Scope is `packages/agent-core-v2/src/features/spec/` and the files it directly couples to:
  `tool/path-access.ts`, `feature/spec` templates under `injection/`, `tools/*/` prompt
  markdown, and the telemetry definitions in `app/telemetry/events.ts`.
- Callers outside that scope (the TUI `/spec` command, the node SDK methods, the transcript
  and `vis` wiring) are read-only inputs to the audit. Touch them only if a fix requires it,
  and say so in the design.
- Where the repo already documents a convention, follow it rather than restating it here:
  see `DEVELOP.md`, `CONTRIBUTING.md`, and the per-package `AGENTS.md`.

## Out of scope

- Redesigning spec mode. The four-reminder injection scheme, the stage model, the
  `spec_review` display contract and the exit/reject/revise option set are retained as-is.
- Changing what the spec documents contain or how they are prompted. The reminder texts are
  edited only where a fix in this spec contradicts them.
- The unmerged working-tree changes currently present on this branch. They are not part of
  this change set and must not be swept into it.
- Making `spec` an experimental flag again. Commit `b1d3c24fcb` deliberately removed the flag
  gate; that decision stands.
- Adding new telemetry events or new spec-document files.
