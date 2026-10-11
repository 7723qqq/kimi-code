# Tasks

Approach from `design.md`. T1 is a **blocking gate**: nothing else may start until it passes.

Task-local commands, unless written out in full:

- `AC` = `cd packages/agent-core-v2 && bun run vitest run test/features/promptOptimizer/promptOptimizerService.test.ts`
- `AL` = `cd packages/agent-core-v2 && bun run vitest run test/session/agentLifecycle/agentLifecycle.test.ts`
- `TC` = `cd packages/agent-core-v2 && bun run typecheck`
- `NC` = `bun run check:no-comments` (repo root)
- `MZ` = `cd scripts/prompt-optimizer && bun test`

---

## T1 — Confirm the concurrent session has stopped (BLOCKING)

`requirements.md`「已知风险」: another kimi session (PID 1496825) overwrote a change at 07:44.
Verify it is gone before touching any file this spec modifies.

**Steps**

1. `ps aux | grep -E '^\S+\s+1496825'` → no rows.
2. `git diff --stat -- packages/agent-core-v2/src/features/promptOptimizer/` → the only entry must
   be `errors.ts` (the other session's edit). `promptOptimizer.ts` must show **no** diff.
3. Record the observed `git diff` output in `progress.md`.

**Acceptance:** PID 1496825 is absent, and `git diff` for `promptOptimizer.ts` is empty. If the
session is still running, stop here and report — do not proceed.

---

## T2 — Rewrite `PROMPT_OPTIMIZER_SYSTEM_PROMPT` (R1/R2/R3)

`packages/agent-core-v2/src/features/promptOptimizer/promptOptimizer.ts`: replace the 11-rule
block with the 5–7 principles from `design.md` §1.2.

Must be true of the new text:

- Contains a **requirement** (not a permission) to write the real name when the context or working
  directory already determines the referent. R1 / design §1.3.
- States the success criterion as "concrete, not longer" — a draft restated in more words has
  failed. R2.
- Forbids substituting a formal, emphatic or more professional-sounding word for the draft's own
  wording, and forbids intensifiers / framing clauses / same-content longer sentences. R2.
- Does **not** contain the substring `the user did not imply` (the bypass path in F5).
  R3 / design §1.3.
- Keeps: language follows the draft; do not answer/act on/explain the draft; plain text only with
  no preamble, quotes or code fence.
- Tool clause scoped to confirming a name about to be written, not open-ended investigation. F6.

**Acceptance**

- `grep -c '^- ' ` on the prompt block returns between 5 and 7.
- `grep 'the user did not imply' <file>` returns nothing (exit 1).
- `AC` and `TC` exit 0.
- `NC` exits 0.

---

## T3 — Make truncation visible (R4)

`promptOptimizer.ts` + `promptOptimizerService.ts` + `errors.ts` + `packages/node-sdk/src/errors.ts`,
per `design.md` §2.

1. Restore `PROMPT_OPTIMIZER_TRUNCATION_MARKER = '…(truncated)'`; append it in `clamp()`.
2. Delete `clampOutput()`; when the rewrite exceeds `PROMPT_OPTIMIZER_MAX_OUTPUT_LENGTH`, throw
   `PROMPT_OPTIMIZER_OUTPUT_TOO_LONG`.
3. Register the new code in `PromptOptimizerErrors` (`codes` + `info`, `retryable: false`,
   `public: true`).
4. Mirror it in `packages/node-sdk/src/errors.ts`: the code table near line 158 and
   `KIMI_ERROR_INFO` near line 968.
5. Fix the pre-existing divergence: `prompt_optimizer.no_output` was `retryable: true` in the
   engine and `false` in the SDK. Make the SDK match the engine.

**Acceptance**

- `AC` exits 0 with these tests present and passing:
  - draft over `MAX_INPUT_LENGTH` → the child's prompt contains the marker;
  - draft within the limit → the marker is absent;
  - rewrite over `MAX_OUTPUT_LENGTH` → `optimize()` rejects with `output_too_long`;
  - the over-long rewrite is **not** returned in truncated form.
- The test `backs the over-long rewrite up to a sentence boundary…` is **removed** (it asserted the
  deleted behaviour).
- `TC` exits 0; `cd packages/node-sdk && bun run typecheck` exits 0.
- `grep 'output_too_long' packages/node-sdk/src/errors.ts` finds 2 occurrences (code table + info).

---

## T4 — Count only real user turns in the history window (R6)

`packages/agent-core-v2/src/session/agentLifecycle/agentLifecycleService.ts`,
`inheritHistoryWindow` (lines 687–701), per `design.md` §3: skip messages whose
`origin?.kind !== 'user'`; treat `origin === undefined` as a real user message.

**Acceptance** — in `test/session/agentLifecycle/agentLifecycle.test.ts`, all passing:

- A history of `[user, injection, user, injection, user]` with `maxUserTurns: 2` keeps the last two
  **real** user turns; the injection messages do not consume quota.
- A history whose user messages all have `origin.kind === 'user'` behaves exactly as before
  (the existing test at line 1385 still passes unchanged).
- A message with `origin === undefined` counts as a real user turn.
- `AL` exits 0.

---

## T5 — Cap the inherited context by length (R5)

`agentLifecycle.ts` (`InheritedHistoryOptions` gains `maxChars?: number`) +
`agentLifecycleService.ts` (`inheritHistoryWindow` enforces it) +
`promptOptimizerService.ts` (passes 4000), per `design.md` §4.

**Acceptance**

- `AL` exits 0, with a test: history of 6 one-word user turns plus one 10 000-character user message,
  `maxUserTurns: 6, maxChars: 4000` → the seeded total character count is ≤ 4000.
- `maxChars` omitted → no length bound (existing callers unaffected).
- `AC` exits 0 and asserts `fork` was called with `maxChars: 4000`.
- `TC` exits 0.

---

## T6 — Regression protection for the prompt text (R7)

Add to `test/features/promptOptimizer/promptOptimizerService.test.ts` assertions that the three
constraints exist, per `design.md` §5.1. Assert **constraints, not a snapshot**.

**Acceptance**

- Three tests exist, each asserting the presence of one constraint's key semantics, and deleting the
  corresponding sentence from `PROMPT_OPTIMIZER_SYSTEM_PROMPT` makes that test fail. Verify by
  temporarily editing the constant and confirming the failure, then reverting.
- No test asserts the full prompt verbatim (no snapshot, no whole-string equality).
- `AC` exits 0.

---

## T7 — Multi-axis measurement (R8)

New command in `scripts/prompt-optimizer/` (reuse `src/llm-caller.ts`), per `design.md` §5.2.
Emits three axes for a fixed draft set: length ratio, original-word retention, added-requirement
count.

**Fixed draft set** — the six from `research-prompt-rewriting.md` §7.4, including
`请分析如何全部最优方案和最完整方案 减少打补丁和便宜` and
`最重要的问题是现在的提示词会从以前的详细变成现在的扩句一样`.

**Acceptance**

- `bun src/cli.ts <command> --dry-run` exits 0 without network.
- A real run prints three numbers per draft and a run-level summary, and writes a report under
  `scripts/prompt-optimizer/reports/`.
- Against the §7.4 baseline on the same six drafts: mean length ratio ≈ **1.0–1.4** (the corrected
  prompt measured 1.20; the pre-fix prompt measured 3.62). Record both numbers in `progress.md`.
- `MZ` exits 0.

---

## T8 — Changeset

Per `DEVELOP.md` and the `gen-changesets` skill. Patch-level for `@moonshot-ai/kimi-code`;
`@moonshot-ai/kimi-code-sdk` is touched by T3 (new error code), so it needs an entry too.

**Acceptance:** a file exists under `.changeset/` naming both packages, and its body states the
behaviour change for the new error code (a rewrite longer than the limit now fails instead of
returning a truncated prompt) — an external behaviour change must be visible in the changelog.

---

## Not in this round

D1 (few-shot examples), D2 (over-length UX), D3 (conflict handling) are decisions in
`design.md` §7. Resolve them before T2 if they change the prompt text, otherwise they are
out of scope.
