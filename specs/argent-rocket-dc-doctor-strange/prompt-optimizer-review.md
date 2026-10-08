# Prompt optimizer — implementation review

Read at commit `e1dd2db419`. Every claim names a file and line that resolves on that tree.

> **Update, 2026-10-08.** This document was originally a read-only review: "no change to the
> optimizer's implementation is proposed or made". That is no longer true — items 2–5 below have been
> fixed and items 1 and 6 are scheduled, each annotated in place with its current status. Two claims in
> the original text were also wrong and are corrected in the sections that carry them: the REST
> `optimize-prompt` action does not exist, and the translation defect's root cause is deeper than a
> mis-pathed key. Read the status annotations rather than the surrounding prose where the two disagree.

## What it is

An experimental feature that rewrites the prompt in the user's input box before they send it, using the
session's own model. Off by default.

Enable via the `prompt_optimizer` flag, or `KIMI_CODE_EXPERIMENTAL_PROMPT_OPTIMIZER=1`
(`packages/agent-core-v2/src/features/promptOptimizer/promptOptimizer.ts:11,13`). The flag is declared
with `surface: 'both'` (`.../flag.ts:12`), so it is reachable from both the flag CLI and the session
API.

## Where it lives

Three layers, plus an unrelated offline harness that happens to share the name.

**Engine — `packages/agent-core-v2/src/features/promptOptimizer/`**

- `promptOptimizer.ts` — the contract. Four size limits (`MAX_INPUT_LENGTH` 8000, `MAX_CONTEXT_LENGTH`
  4000, `MAX_CONTEXT_TURNS` 6, `MAX_OUTPUT_LENGTH` 8000, lines 3–9), the flag id and env var (11–13),
  the system reminder shown to the child agent (18–29), the `PromptOptimizerContext` input type
  (31–34), and `ISessionPromptOptimizerService` (36–43).
- `promptOptimizerService.ts` — `SessionPromptOptimizerService.optimize()`, registered at session scope
  (125–131). The whole feature is this one method.
- `flag.ts` / `promptOptimizerFeature.ts` — the flag definition and a feature that contributes the
  service only when the flag is on.

**TUI — `apps/kimi-code/src/tui/`**

- `controllers/prompt-optimizer.ts` — `PromptOptimizerController.optimize()`, called from
  `controllers/editor-keyboard.ts:364`. Reads the editor text, gathers recent user turns, calls the
  session API, then mounts a confirm panel.
- `components/dialogs/prompt-optimize-panel.ts` — the accept/discard panel, rendered as a diff against
  the original draft.

**Offline harness — `scripts/prompt-optimizer/`**

A separate, `private` package (`scripts/prompt-optimizer/package.json`) with `bench` / `prune` / `ab` /
`probe` commands. It does **not** use the feature above: it optimizes the *system prompt* file
`packages/agent-core-v2/src/app/agentProfileCatalog/system.md` (`src/config.ts:12-14`) by running
benchmark cases and A/B experiments against the API. Same name, different problem, no shared code.

## How the runtime path works

1. **Flag check and empty-draft guard** (`promptOptimizerService.ts:40-49`). Disabled flag throws
   `PROMPT_OPTIMIZER_DISABLED`; a draft that trims to nothing throws `PROMPT_OPTIMIZER_EMPTY_DRAFT`.
2. **Fork a child agent** (55–66). The main agent is looked up by `MAIN_AGENT_ID`, then
   `agentLifecycle.fork(...)` clones its context with `labels: { promptOptimizer: 'prompt-optimizer' }`.
   The rewrite therefore runs in a sibling agent, not in the conversation the user is in — the main
   agent keeps streaming.
3. **Constrain the child** (67–78). It gets `PROMPT_OPTIMIZER_SYSTEM_REMINDER` through the reminder
   service, and a `onBeforeExecuteTool` hook that vetoes **every** tool call with
   `PROMPT_OPTIMIZER_TOOL_DISABLED_MESSAGE`. The child cannot read files, search, or write; its only
   output is text.
4. **Run and collect** (80–90). `subagents.run(context, { kind: 'prompt', prompt }, { signal })`, then
   awaits `run.completion` and takes `completion.summary.trim()`.
5. **Cleanup** (91–96). The `finally` unlinks the abort listener and removes the child context,
   swallowing removal errors.

The prompt handed to the child is assembled by `buildOptimizerInput` (100–108): working directory,
recent conversation, then the draft — each labelled.

The reminder's rules (18–29) are the part that carries the product intent: preserve the user's intent,
scope and language; never answer or act on the draft; never add requirements the user did not imply;
use context only to resolve ambiguity the draft already leaves open; output plain text with no
preamble, quotes or code fence; return a clear draft essentially unchanged rather than padding it.

The TUI side contributes context: `recentTurns()` (`controllers/prompt-optimizer.ts:83-100`) reads
`session.getContext()`, walks history backwards, keeps up to 6 messages whose `role === 'user'` and
whose `origin.kind === 'user'` (so injected/agent-authored messages are excluded), truncates each to
400 chars, and joins them.

Accept/discard (`controllers/prompt-optimizer.ts:56-81`): the panel resolves a promise on the user's
choice; `accept` writes the text back via `editor.setText(optimized, { preservePasteRegistry: true })`,
`discard` leaves the draft alone. An unchanged or empty result short-circuits before the panel is shown
(43–46). Four analytics events: `prompt_optimize_unchanged`, `_failed`, `_accepted`, `_discarded`.

## Issues found

None of these are the translation-key defect; that is tracked separately.

> **Status, updated 2026-10-08.** Items 2, 3, 4 and 5 have since been fixed; item 1 is scheduled and
> item 6 is scheduled. Each entry below carries its current state and the commit-level evidence. The
> REST claim further down turned out to be false and is corrected there.

**1. The engine's `MAX_CONTEXT_TURNS` constant has no reader.** — **OPEN (fix scheduled).**
`PROMPT_OPTIMIZER_MAX_CONTEXT_TURNS = 6`
(`promptOptimizer.ts:7`) is exported but referenced nowhere. The actual limit lives in the TUI as
`MAX_RECENT_TURNS = 6` plus `MAX_RECENT_TURN_CHARS = 400`
(`controllers/prompt-optimizer.ts:9-10, 94`). The two agree today by coincidence; nothing keeps them
agreeing, and a caller other than the TUI (the flag is `surface: 'both'`) inherits no turn limit at all.

**2. The draft is silently truncated.** — **FIXED.**
`buildOptimizerInput` slices to
`PROMPT_OPTIMIZER_MAX_INPUT_LENGTH` with no notice to the caller. A
user pasting a long prompt gets a rewrite of its first 8000 characters and no indication that the tail
was dropped. The same applies to the context slice on line 104.
Both slices now go through `clamp()`, which appends `PROMPT_OPTIMIZER_TRUNCATION_MARKER`
(`…(truncated)`), matching the existing `lspTool` / `spawnTool` convention.
Covered by "marks a draft that exceeds the input limit as truncated" and "does not mark a draft that
fits as truncated" in `promptOptimizerService.test.ts`.

**3. The output is truncated to a character count, not a boundary.** — **FIXED.**
`rewritten.slice(0, PROMPT_OPTIMIZER_MAX_OUTPUT_LENGTH)` could cut a
sentence — or an instruction — mid-way, and the result is written straight into the user's editor.
`clampOutput()` now backs up to the last line break, sentence end or full stop, and the system reminder
asks the model to stay under the limit so the backstop rarely fires.
Covered by "backs the over-long rewrite up to a sentence boundary rather than cutting mid-word".

**4. Context failures are swallowed.** — **FIXED.**
`recentTurns` wrapped everything in `catch { return undefined }`. A broken `getContext()` silently
degraded the rewrite to draft-only with no log line, so there was nothing to diagnose from.
The catch now reports `prompt_optimize_context_failed` through the host's analytics channel and still
returns `undefined`, so the rewrite degrades exactly as before.

**5. The child's removal failure is swallowed.** — **FIXED.**
`agentLifecycle.remove(childContext).catch(() => {})` was defensible in a `finally`, but a leaked
optimizer agent left no trace. The catch now logs a warning through `ILogService` with the agent id.
Covered by "logs when the throwaway agent cannot be removed".

**6. Re-entrancy is guarded only in the TUI.** — **OPEN (fix scheduled).**
`PromptOptimizerController.inFlight`
(`controllers/prompt-optimizer.ts:23,29,39`) prevents a second rewrite from one keystroke pattern, but
the service itself has no guard — an SDK caller can fork concurrent optimizer agents. Nothing breaks;
the child contexts are independent. Worth knowing rather than fixing.

On the positive side, the design decisions that matter are sound: the fork keeps the rewrite off the
main conversation, the blanket tool veto makes the child's output text-only by construction rather than
by instruction, the abort signal is linked and unlinked correctly (`linkSignals`, 110–123), and the
reminder explicitly forbids inventing requirements — the failure mode that would make such a feature
harmful.

## Why the translation defect was not visible sooner

The panel's five keys resolved to nothing, but nothing exercised the panel outside tests, and those
tests mock `t()` with a table that returned whatever key they were given
(`apps/kimi-code/test/tui/controllers/prompt-optimizer.test.ts:11-16` and
`components/dialogs/prompt-optimize-panel.test.ts:8-11`). A mock keyed on the same wrong paths as
production is a test that asserts the bug. Both now use the production paths.

**Correction, 2026-10-08.** Fixing the key paths was necessary but not sufficient. The keys still
resolve to nothing at runtime for a second, independent reason: the error code never reaches the TUI.
`sdk-rpc-client-v2.ts:2899` restates any engine code missing from the SDK's `KIMI_ERROR_INFO` as
`internal`, and `prompt_optimizer.*` is one of 102 engine codes absent from that table. So even with
the correct paths, `formatLocalizedError` had no matching code to look up. See
`reports/error-code-registry-gap.md`; the optimizer's three codes still need either a registry fix or
an entry-level workaround before the translated copy becomes reachable.

## Correction: the REST claim

An earlier revision of this document, and `.changeset/prompt-optimizer-shortcut.md`, stated that the
feature is "reachable outside the TUI too: … as the `optimize-prompt` session action over REST." That
is false on this tree. `packages/kap-server/src/routes/sessions.ts:880` declares a `SessionAction`
union of `fork | compact | undo | abort | btw | restore | archive | delete` — there is no `optimize`
member, no handler, and no route. `grep -r optimize packages/kap-server` returns nothing. The SDK path
(`session.optimizePrompt`) does exist; only the REST path is missing.
