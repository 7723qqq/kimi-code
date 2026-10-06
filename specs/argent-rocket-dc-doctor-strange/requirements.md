# Requirements — TUI translation keys that resolve to nothing

## Goal

Two user-visible TUI strings render as raw key literals today: the prompt-optimizer panel shows
`tui.promptOptimize.title` / `tui.promptOptimize.hint` instead of a title and a hint, and eleven
`tui.msys2Prompt.*` strings do the same in the MSYS2 install dialog and the install progress spinner.
A repo-wide scan found **20 such keys**, all in `apps/kimi-code`. This spec fixes every one of them and
adds the check that would have caught them, so the class of bug cannot come back silently.

The prompt optimizer itself is *not* the defect — it is only where the defect became visible. Its
implementation is recorded here as context because the review asked for it; no optimizer behaviour
changes.

## Audience

- **Users** running the TUI in any locale: they currently see `tui.msys2Prompt.title` in a dialog and
  `tui.promptOptimize.hint` above the accept/discard choices.
- **Maintainers** adding TUI strings: they need a check that fails at CI time instead of a bug report.

## The defect, with evidence

`t()` delegates to the Rust engine (`apps/kimi-code/src/i18n/index.ts:157-165`), which resolves in
three steps and **returns the key itself when both miss**
(`packages/kimi-native-tools/src/translation.rs:103-105`):

```rust
let raw = resolve(&locale_data, key)
    .or_else(|| resolve(&fallback_data, key))
    .unwrap_or(key);
```

Both lookups receive the *whole* `en.ts` / `zh.ts` object (`index.ts:104`, `index.ts:154`), so the
generated `*.json` files are irrelevant to this bug — they are only the Rust i18n engine's static
input, and CI already asserts they are fresh.

A scan of all 371 non-test `.ts` files under `apps/kimi-code/src` against the 1700 leaf keys of
`apps/kimi-code/src/i18n/locales/en.ts` (1587 `t()` calls) yields 20 unmatched keys in three groups:

**Group A — the key exists one level deeper, under `tui.dialogs` (15 keys).** Every dialog that
mounts over the editor lives in the `tui.dialogs.*` block; these two panels were referenced without
the `dialogs.` segment.

| Referenced | Actually defined at | Defined in |
|---|---|---|
| `tui.promptOptimize.title/hint/accept/discard` | `tui.dialogs.promptOptimize.*` | `en.ts:520`, `zh.ts` |
| `tui.promptOptimize.failed/noSession` | `tui.dialogs.promptOptimize.*` | same block |
| `tui.msys2Prompt.title/hint/install/installDescription/skip/skipDescription` | `tui.dialogs.msys2Prompt.*` | `en.ts` (~26600) |
| `tui.msys2Prompt.installing/installSuccess/installFailed/restartHint/installSuccessNoSwitch/manualInstallHint` | `tui.dialogs.msys2Prompt.*` | same block |

References: `apps/kimi-code/src/tui/components/dialogs/prompt-optimize-panel.ts:64,65,85`,
`apps/kimi-code/src/tui/controllers/prompt-optimizer.ts:35,50`,
`apps/kimi-code/src/tui/components/dialogs/msys2-prompt.ts:26,27,31,32,36,37`,
`apps/kimi-code/src/tui/kimi-tui.ts:2742,2746,2748,2752,2753,2754`.

**Group B — the key exists at a different namespace (1 key).**
`tui.messages.toolCall.failed` (`apps/kimi-code/src/tui/components/messages/tool-call.ts:2054`) —
`tui.messages` has no `toolCall` child; `tui.dialogs.toolCall.failed` does exist and is referenced
from nowhere else.

**Group C — the key genuinely does not exist (1 key).**
`tui.slashCommands.spec` (`apps/kimi-code/src/tui/commands/registry.ts:223`) has no counterpart in
either locale file; `en.ts`'s `slashCommands` block has 49 keys and none is `spec`.

History explains both shapes:

- Group A/B: a refactor moved the blocks under `dialogs` and updated the locale tree but not these
  call sites.
- Group C: `9997e27d23` ("feat(spec): add the /spec command") inserted
  `spec: 'Write a spec for the change before implementing it.'` into the **`cli.optionDescriptions`**
  block (`en.ts:43`) — the `--spec` CLI flag's help text, which is *not* the same string the `/spec`
  TUI command needs — while `registry.ts` reads `tui.slashCommands.spec`. The CLI option is fine; the
  TUI description has been broken since that commit. `cli.optionDescriptions.spec` must **not** be
  reused as a shortcut: it describes a command-line flag, not a slash command.

Two details that hid the bug:

- Unit tests mock `t()` with the *unqualified* key
  (`apps/kimi-code/test/tui/controllers/prompt-optimizer.test.ts:11-16`,
  `apps/kimi-code/test/tui/components/dialogs/prompt-optimize-panel.test.ts:8-11`). A mock returns the
  string it was given, so the tests pass while production misses. Any fix to the call sites must
  update these mocks in the same change or the suite will fail for the wrong reason.
- The only locale check that looks at call sites,
  `scripts/check-t-call-coverage.mjs:20-24`, scans `packages/agent-core-v2/src`,
  `packages/kap-server/src` and `packages/klient/src`, and validates against
  `packages/i18n/src/locales/en.ts`. It never looks at `apps/kimi-code/src` or at the app's own locale
  file, so it cannot see any of the 20. `scripts/check-locale-keys.mjs` and
  `scripts/check-locale-placeholders.cjs` only compare `en` against `zh` within one file and are blind
  to whether a key is referenced at all. CI runs all three (`.github/workflows/ci.yml:181-183`) and
  all three pass.

One dead key found alongside: `cli.msys2Prompt.notice` (`en.ts:114`) has no consumer anywhere in the
repo — no `t()` call, no Rust reference.

## Requirements

**R1 — every `t()` call in `apps/kimi-code/src` resolves to a real value.** After the change, a scan of
all non-test `.ts` under `apps/kimi-code/src` against the leaf keys of
`apps/kimi-code/src/i18n/locales/en.ts` reports zero unmatched keys.

**R2 — the fix is applied where the mistake is, per group.** Group A and B call sites are corrected to
the `tui.dialogs.*` paths that already hold the translated text in both locales. Group C gains a real
`tui.slashCommands.spec` entry in `apps/kimi-code/src/i18n/locales/en.ts` and `zh.ts`, describing the
`/spec` slash command, plus the regenerated `en.json` / `zh.json`.

**R3 — the user-visible strings render in both locales.** Running the TUI in `en` and in `zh`, the
prompt-optimizer panel shows its title and hint, the MSYS2 dialog shows its title, hint and both
option labels, and neither shows a string beginning with `tui.`.

**R4 — the unit tests stop hiding the defect.** The `t()` mocks in the prompt-optimizer tests use the
same key paths as the production call sites, so a future path mistake fails the test instead of
passing it.

**R5 — CI catches this class of bug for `apps/kimi-code`.** The call-site coverage check covers
`apps/kimi-code/src` against `apps/kimi-code/src/i18n/locales/en.ts`, and reports a missing key by name
and file with exit code 1. The check must be wired into a command CI already runs.

**R6 — no unrelated locale churn.** The only entries added or removed in the locale trees are the
`tui.slashCommands.spec` pair and, if the chosen scope includes it, the orphan `cli.msys2Prompt.notice`
pair. Everything else that changes is a call-site key path or a test mock.

## Acceptance criteria

| # | Check | Passes when |
|---|---|---|
| AC1 | Run the coverage scan over `apps/kimi-code/src` against `en.ts` leaf keys | reports `MISSING keys: 0` |
| AC2 | Run the same scan against `apps/kimi-code/src/i18n/locales/zh.ts` | reports `MISSING keys: 0` (proves Group C was added to both locales, not just `en`) |
| AC3 | `bun scripts/check-locale-keys.mjs` | exit 0, all sources report `keys match` |
| AC4 | `bun scripts/check-locale-placeholders.cjs` | exit 0 |
| AC5 | `bun scripts/generate-locale-json.cjs && git diff --exit-code -- '**/locales/*.json'` | exit 0 (JSON is regenerated and committed, not hand-edited) |
| AC6 | `bun vitest run apps/kimi-code/test/tui/controllers/prompt-optimizer.test.ts apps/kimi-code/test/tui/components/dialogs/prompt-optimize-panel.test.ts` | passes |
| AC7 | `grep -rn "tui\.promptOptimize\.\|tui\.msys2Prompt\.\|tui\.messages\.toolCall\.failed" apps/kimi-code/src --include=*.ts` | only `tui.dialogs.…` paths are printed |
| AC8 | Node REPL against `apps/kimi-code/src/i18n/index.ts` (or the native `translate` with the `en.ts` JSON) for key `tui.slashCommands.spec` in both locales | returns a sentence, not the key string; the en and zh strings differ |
| AC9 | After R5, temporarily rename one key in a call site and run the CI-wired check | exits 1 and names the key and file |
| AC10 | `git diff --stat` on the locale `*.ts` files | shows additions only for `slashCommands.spec` (+ optionally `cli.msys2Prompt.notice` removal); no other keys touched |

AC7 and AC10 are the two that need reading the diff rather than a command's exit code; the rest are
mechanical.

## Boundaries

**In scope**

- The 20 call-site/key mismatches listed above.
- The `tui.slashCommands.spec` locale entry in `en.ts` and `zh.ts`, plus regenerated JSON.
- The prompt-optimizer test mocks.
- Extending the call-site coverage check to `apps/kimi-code/src`.

**Out of scope**

- The prompt-optimizer implementation. No change to
  `packages/agent-core-v2/src/features/promptOptimizer/*`, the controller, or the panel's behaviour.
  The review of that feature is a written finding in this spec, not a code change.
- Reusing or deleting `cli.optionDescriptions.spec` — it is a correct CLI flag description.
- The orphan `cli.msys2Prompt.notice`: removing it is offered as an explicit choice, not assumed.
  See Open decisions.
- Any change to the Rust translation engine's miss behaviour. Returning the key is deliberate
  (`translation.rs:82-88` documents it) and is the reason the bug is visible at all; changing it to a
  silent empty string would make this class of bug *harder* to find.
- Translation quality of any existing string. Text that is present and correct in one locale but
  poorly worded stays as it is.
- The `tui.dialogs.*` vs `tui.*` naming question at large: no other namespace is reorganised.

## Open decisions

1. **Orphan key `cli.msys2Prompt.notice`.** It has no consumer. Either delete it from both locales, or
   leave it. Deleting is a small cleanup; leaving keeps this change strictly to the reported defect.
2. **Fix direction for Groups A/B.** Correcting the ~20 call sites is the reading that matches the
   `tui.dialogs.*` convention every other panel follows. The alternative — moving the blocks back to
   `tui.*` — moves 16 keys across two locale files and contradicts the surrounding structure. The
   design recommends the call-site fix; the choice is presented at ExitSpecMode.
