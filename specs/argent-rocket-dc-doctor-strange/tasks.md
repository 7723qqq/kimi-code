# Tasks

Each task is independently checkable. Tasks 1–5 must land before task 6: the coverage check goes green
only once the 20 pre-existing misses are gone, and task 6 adds the CI gate that would then red the
pipeline if it ran first.

## Task 1 — Reproduce the defect as a scan

Write a throwaway scan (a `scripts/`-style Node script run with `node --import tsx`, not committed) that
loads `apps/kimi-code/src/i18n/locales/en.ts`, collects leaf keys, walks every non-test `.ts` under
`apps/kimi-code/src` for `t('key')` literals, and prints the unmatched set.

**Acceptance**

- Prints exactly these 20 keys, no more and no fewer: `tui.messages.toolCall.failed`,
  `tui.msys2Prompt.{hint,install,installDescription,installFailed,installSuccess,installSuccessNoSwitch,installing,manualInstallHint,restartHint,skip,skipDescription,title}`,
  `tui.promptOptimize.{accept,discard,failed,hint,noSession,title}`, `tui.slashCommands.spec`.
- Also prints the 4 keys as they would resolve today by calling the repo's own `translate` path (or by
  reading the nested object) and shows it returns the key string itself — the evidence for the
  user-visible symptom.

## Task 2 — Fix the 15 `tui.dialogs` call sites

Apply the table in design §1 for `tui.promptOptimize.*` (5 references in 2 files) and
`tui.msys2Prompt.*` (10 references in 2 files). Change only the key literal on each line.

**Acceptance**

- `grep -rn "tui\.promptOptimize\.\|tui\.msys2Prompt\." apps/kimi-code/src --include=*.ts` prints no
  line, except where the occurrence is already `tui.dialogs.`.
- Rerunning the task 1 scan drops those 15 keys from the unmatched list; the remaining 5 are
  `tui.messages.toolCall.failed` and the four `tui.slashCommands.spec`-adjacent keys.
- `git diff --stat` touches only the four source files named in design §1.

## Task 3 — Fix `tui.messages.toolCall.failed`

One-line change at `apps/kimi-code/src/tui/components/messages/tool-call.ts:2054` to
`tui.dialogs.toolCall.failed`.

**Acceptance**

- The task 1 scan no longer lists this key.
- `grep -rn "toolCall.failed" apps/kimi-code/src --include=*.ts` prints exactly one line, and it
  contains `tui.dialogs.`.

## Task 4 — Restore `tui.slashCommands.spec` in both locales

Add the entry described in design §2 to `apps/kimi-code/src/i18n/locales/en.ts` and `zh.ts`, beside the
existing `plan` entry, then run `bun run generate:locale-json`.

**Acceptance**

- The task 1 scan reports zero unmatched keys.
- `bun scripts/check-locale-keys.mjs` exits 0 with `kimi-code: 1701 keys match` (was 1700 before this
  task: the key was missing from both locales, so both grew by exactly one).
- `git diff -- '**/locales/*.json'` shows the same single key added to `en.json` and `zh.json`, values
  matching the `.ts` sources.
- `git diff -- 'apps/kimi-code/src/i18n/locales/en.ts'` shows one added line inside the
  `tui.slashCommands` block and nothing else.
- Resolving `tui.slashCommands.spec` through the engine returns a sentence in both locales, and the two
  strings differ.

## Task 5 — Update the test mocks

Change the six `tui.promptOptimize.*` mock entries in
`apps/kimi-code/test/tui/controllers/prompt-optimizer.test.ts:11-16` and the four in
`apps/kimi-code/test/tui/components/dialogs/prompt-optimize-panel.test.ts:8-11` to the
`tui.dialogs.promptOptimize.*` paths.

**Acceptance**

- `bun vitest run apps/kimi-code/test/tui/controllers/prompt-optimizer.test.ts apps/kimi-code/test/tui/components/dialogs/prompt-optimize-panel.test.ts`
  passes.
- The rendered-text assertions in those tests are unchanged — only the mock's key strings moved.
- Reverting a single call site from task 2 (temporarily) makes a test fail rather than pass, proving the
  mock now tracks production paths.

## Task 6 — Extend the coverage check and wire it into CI

Generalise `scripts/check-t-call-coverage.mjs` to the `{ name, sourceDirs, localeFile }` shape, add the
`apps/kimi-code` entry, add a `check:t-coverage` script to `package.json`, and add the CI step beside
the existing locale steps in `.github/workflows/ci.yml`.

**Acceptance**

- `bun scripts/check-t-call-coverage.mjs` (and `bun run check:t-coverage`) exits 0 on the current tree,
  and its summary line reports the `apps/kimi-code` source with the number of files and unique keys it
  scanned.
- Introducing one fake call `t('tui.dialogs.promptOptimize.nope')` in a source file makes the command
  exit 1 and print that key with its file path; reverting it restores exit 0.
- The existing three package sources still report the same unique-key count as before the change.
- CI runs the new step; a run on a branch with the fake key fails at that step.

## Task 7 — Optional: drop the orphan `cli.msys2Prompt.notice`

Only if chosen at approval. Remove the entry from `en.ts` and `zh.ts`, regenerate the JSON.

**Acceptance**

- `grep -rn "cli\.msys2Prompt" .` (excluding `node_modules`, `dist`) prints nothing.
- `bun scripts/check-locale-keys.mjs` still exits 0 with both locale sources reporting equal counts.

## Task 8 — Full verification

Run the project's own gates on the finished tree.

**Acceptance**

- `bun run typecheck` passes.
- `bun run lint` passes.
- `bun vitest run apps/kimi-code/test/tui` passes.
- `bun scripts/check-locale-keys.mjs`, `bun scripts/check-locale-placeholders.cjs`, and
  `bun scripts/generate-locale-json.cjs && git diff --exit-code -- '**/locales/*.json'` all exit 0.
- The task 1 scan reports `MISSING keys: 0` against both `en.ts` and `zh.ts` leaf sets.
- A changeset exists for `@moonshot-ai/kimi-code` at patch level describing the two user-visible strings
  (see `.agents/skills/gen-changesets/SKILL.md`).

## Task 9 — Write up the prompt-optimizer review

Produce the review the request asked for as a document in this spec directory, covering the four
implementation sites and the issues found. No code change.

Sites to cover:

- `packages/agent-core-v2/src/features/promptOptimizer/promptOptimizer.ts` — constants, system reminder,
  `PromptOptimizerContext`, service interface.
- `.../promptOptimizerService.ts` — forked child agent, reminder injection, tool denial, truncation,
  cleanup.
- `.../flag.ts` and `feature.ts` — `prompt_optimizer` flag, env override
  `KIMI_CODE_EXPERIMENTAL_PROMPT_OPTIMIZER`, off by default.
- `apps/kimi-code/src/tui/controllers/prompt-optimizer.ts` and
  `components/dialogs/prompt-optimize-panel.ts` — draft capture, recent-turns assembly, accept/discard.
- `scripts/prompt-optimizer/` — the offline benchmark harness (separate from the runtime path).

Issues to state plainly, each with its file and line:

- The 5 mis-pathed keys (fixed by tasks 2–5) are the only user-visible defect found; the earlier runs
  never showed it because nothing exercised the panel outside mocked tests.
- `PROMPT_OPTIMIZER_MAX_CONTEXT_TURNS = 6` (`promptOptimizer.ts:7`) is declared but the TUI controller
  keeps its own `MAX_RECENT_TURNS = 6` and `MAX_RECENT_TURN_CHARS = 400`
  (`controllers/prompt-optimizer.ts:9-10`); the engine constant has no reader, so the two limits can
  drift apart.
- `buildOptimizerInput` truncates the draft to `PROMPT_OPTIMIZER_MAX_INPUT_LENGTH` silently
  (`promptOptimizerService.ts:106`); the user is not told their draft was cut before rewriting.
- The service slices the result to `PROMPT_OPTIMIZER_MAX_OUTPUT_LENGTH` without re-checking that the
  cut left a complete prompt (`promptOptimizerService.ts:90`).
- `recentTurns` swallows every failure with a bare `catch { return undefined }`
  (`controllers/prompt-optimizer.ts:97-99`), so a broken `getContext()` degrades silently.

**Acceptance**

- The document names each site with a path and the behaviour it implements.
- Every issue listed above carries a file and line reference that resolves on the current tree.
- It states explicitly that the review found no change needed to the optimizer's implementation.

## Suggested order and stopping points

Tasks 1→5 are one atomic change: they must land together or CI stays red at task 6. Task 6 is a separate
commit. Task 7 is independent and optional. Tasks 8–9 close the work out. A reasonable stopping point
after task 5 is "the reported bug is fixed and tests are green"; the coverage gate (task 6) is what
keeps it fixed.
