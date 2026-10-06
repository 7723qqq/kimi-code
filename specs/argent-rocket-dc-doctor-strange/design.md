# Design — Correct the mis-pathed TUI keys and close the coverage gap

## Approach

Two edits, in this order: fix the call sites, then extend the existing coverage check to the directory
that was outside its scope.

### 1. Call sites — Groups A and B (16 keys)

Replace the key literal at each site. No new API, no indirection, no constant table — the strings are
already correct in both locale files and the surrounding dialogs use the `tui.dialogs.*` form.

| File | Line | From | To |
|---|---|---|---|
| `apps/kimi-code/src/tui/components/dialogs/prompt-optimize-panel.ts` | 64 | `tui.promptOptimize.title` | `tui.dialogs.promptOptimize.title` |
| same | 65 | `tui.promptOptimize.hint` | `tui.dialogs.promptOptimize.hint` |
| same | 85 | `tui.promptOptimize.accept` / `.discard` | `tui.dialogs.promptOptimize.accept` / `.discard` |
| `apps/kimi-code/src/tui/controllers/prompt-optimizer.ts` | 35 | `tui.promptOptimize.noSession` | `tui.dialogs.promptOptimize.noSession` |
| same | 50 | `tui.promptOptimize.failed` | `tui.dialogs.promptOptimize.failed` |
| `apps/kimi-code/src/tui/components/dialogs/msys2-prompt.ts` | 26, 27, 31, 32, 36, 37 | `tui.msys2Prompt.{install,installDescription,skip,skipDescription,title,hint}` | prefix each with `dialogs.` |
| `apps/kimi-code/src/tui/kimi-tui.ts` | 2742, 2746, 2748, 2752, 2753, 2754 | `tui.msys2Prompt.{installing,installSuccess,restartHint,installSuccessNoSwitch,installFailed,manualInstallHint}` | prefix each with `dialogs.` |
| `apps/kimi-code/src/tui/components/messages/tool-call.ts` | 2054 | `tui.messages.toolCall.failed` | `tui.dialogs.toolCall.failed` |

Why this direction and not the reverse: `tui.dialogs` holds every panel that mounts over the editor
(`helpPanel`, `choicePicker`, `compaction`, `btwPanel`, and the two blocks here), the text is already
correct there in `en.ts` and `zh.ts`, and Group A/B is exactly the set of call sites that a
`tui.dialogs` migration missed. Moving the blocks back to `tui.*` would move 16 keys in two locale
files to accommodate three stale references.

### 2. `tui.slashCommands.spec` — Group C (1 key)

Add one entry to each locale file, next to the existing `plan` entry in the `tui.slashCommands` block
(`apps/kimi-code/src/i18n/locales/en.ts`, `zh.ts`), then regenerate the JSON pair with
`bun run generate:locale-json` rather than editing `en.json` / `zh.json` by hand — CI asserts the JSON
matches a fresh generation (`.github/workflows/ci.yml:183`).

Wording mirrors the sibling `plan` entry, which describes the matching `/plan` command:

- `en`: `spec: 'Write a spec for the change before implementing it.'` — same sentence as
  `cli.optionDescriptions.spec`, which is fine as *text*; the two entries stay separate because one
  describes a flag and one a slash command, and they can diverge later.
- `zh`: the same Chinese sentence already used for `cli.optionDescriptions.spec`'s counterpart
  (`zh.ts`), so the flag and the slash command read alike in Chinese.

The `registry.ts:223` call site does not change.

### 3. Test mocks

`apps/kimi-code/test/tui/controllers/prompt-optimizer.test.ts:11-16` and
`apps/kimi-code/test/tui/components/dialogs/prompt-optimize-panel.test.ts:8-11` key their `t()` mocks
with the unqualified paths. Update the six mock entries in each to `tui.dialogs.promptOptimize.*`.
Without this the mocks stop matching the call sites and the tests fail; with it they keep asserting the
same rendered text. Mocking the exact production key path is what makes a future path mistake fail the
test.

### 4. Coverage check

Extend `scripts/check-t-call-coverage.mjs`: it currently loads one locale file and scans three
`packages/*/src` directories. Generalise it to a list of `{ name, sourceDirs, localeFile }` pairs —
the existing three packages keep their entry unchanged, and `apps/kimi-code` gains
`{ name: 'kimi-code', sourceDirs: ['apps/kimi-code/src'], localeFile: 'apps/kimi-code/src/i18n/locales/en.ts' }`.
Report per source, keeping the existing output shape (`key` + up to five files), and exit 1 if any
source has a miss.

Two properties this preserves: the check still reads keys from the `en.ts` module rather than the
generated JSON (the JSON is a build artifact and would let a stale generation mask a miss), and the
guard at line 80, `(?<![a-zA-Z0-9_$.])t\(`, already skips member calls like `foo.t(` so no new
false positives come from the app's larger surface.

The check must also scan the locale file it validates against *its own* source tree's parity — that is
already covered by AC3 (`check-locale-keys.mjs`), so no duplication is needed.

Wiring: `package.json:50` defines `check:locale-keys`, but CI calls the locale scripts by inline path
rather than through a package script (`.github/workflows/ci.yml:181-183`). Add the coverage check as a
new CI step next to them, and add a matching `check:t-coverage` script to `package.json` so it is
runnable locally — the same shape the existing locale scripts use.

Baseline note: the check must go green on the current tree, which is why tasks 1–3 land before the CI
step. Landing the check first would red the pipeline with 20 pre-existing violations.

## Constraints

- **The Rust engine's miss behaviour is load-bearing.** Returning the key
  (`translation.rs:103-105`) is documented and is what makes a miss visible; the fix must not add a
  silent fallback anywhere on the JS side either.
- **`en.ts` is the runtime source of truth**, not `en.json` (`i18n/index.ts:104` stringifies the module
  object). The JSON is a separate static input for the Rust engine, and CI already guards its freshness.
- **Two locale files must stay in sync.** `check-locale-keys.mjs` enforces en/zh parity; Group C's
  addition therefore has to land in both files in the same change.
- **`type TranslationKey` is derived from `typeof en`** (`i18n/index.ts:29`), but `t()`'s signature
  accepts `TranslationKey | (string & {})` (line 157) — a width deliberately wide enough for dynamic
  keys. The type checker therefore cannot catch a bad literal; only the runtime scan can. Do not
  narrow the signature as part of this work.
- The repo's comment policy (`scripts/check-no-comments.mjs`) applies to any comment added to the
  coverage script.

## Alternatives rejected

**Move the locale blocks from `tui.dialogs.*` back to `tui.*`.** Deletes no call sites and touches 16
keys across `en.ts`, `zh.ts`, and both JSON files, contradicting the convention every other panel
follows. Rejected as the default; available to the user as an explicit choice.

**Make `t()` fall back through several namespaces** (e.g. retry `tui.<rest>` when `tui.dialogs.<rest>`
misses). Turns a one-line-per-site fix into permanent ambiguity: a genuine typo would silently resolve
to some other namespace's string, and the coverage check could never tell the difference. Rejected.

**Replace the literal keys with a typed key constant map.** Larger diff than the defect warrants and
duplicates machinery the derived `TranslationKey` type already provides for static keys. Rejected as
out of proportion.

**Widen `check-locale-keys.mjs` instead of extending the coverage check.** It compares two trees of the
same locale; it has no notion of a call site, so it structurally cannot catch a mis-pathed reference.
Rejected as the wrong tool.

**Fix only the two keys the report named.** Leaves 18 identical defects in place, including the MSYS2
install dialog's title and both option labels. Rejected.

## Risks

- **The scan's key extraction is regex-based.** `t()` called with a non-literal argument, or a key built
  by concatenation, is invisible to it. The scan therefore proves "no *statically visible* call site
  misses" — a weaker property than AC1 states. Mitigation: the regex already exists and is used in CI
  for three packages, so the check's blind spots are pre-existing and known; the change does not widen
  them.
- **`kimi-tui.ts` is a large file.** Its six MSYS2 strings sit in the install-progress path
  (`kimi-tui.ts:2742-2754`), reachable only on Windows with MSYS2 absent. AC7's grep covers the
  call sites; the runtime path is verified by inspection rather than by running it on this host.
- **The JSON regeneration diff can be noisy** if the tree is not already fresh. AC5 catches that as a
  failure rather than letting it merge.
