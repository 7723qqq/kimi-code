# Tasks

Approach from `design.md`: three passes, each producing candidates that are verified before they
enter the report. Run the repo's own commands per `DEVELOP.md` where a check exists; do not invent
ad-hoc scripts for anything the repo already checks.

Every task below is analysis only — no file outside `reports/audit-2026-10-08.md` is written.

## T1 — Freeze the in-scope inventory

Enumerate the files the audit will cover: `packages/**`, `apps/**`, `scripts/**`, `plugins/**`,
`tools/review/**`, `.github/**`, `.agents/**`, root configuration, and Markdown under those trees
plus `docs/**`, minus `specs/**`, `apps/kimi-code/dist-web/**`, `参考目录/**`, `node_modules/**`,
`**/dist/**`, `**/coverage/**`.

**Acceptance:** the Markdown count is 222 and the list is written into the report's coverage
section. Any file added or removed between this task and T13 is noted.

## T2 — Pass 1 sweep: package managers and CI

Sweep for npm / yarn / pnpm / npx invocations, `npm_config_*`, `setup-node`, `node-version-file`,
and Node-only artifacts (`.nvmrc`, `engines.node`, `package-lock.json`, `yarn.lock`, `.npmrc`).
Classify each hit per the `design.md` table.

**Acceptance:** every hit is either a finding with `path:line`, or listed in the allowlist with the
reason it is not one. No hit is left unclassified. A referenced-but-absent artifact (for example a
`node-version-file` pointing at a file that does not exist) is confirmed by checking the path.

## T3 — Pass 1 sweep: runtime assumptions and entry points

Sweep for `process.versions.node`, hardcoded `runtime: 'node'`, `node --test` / `node:test`
dispatch, Node shebangs, and `__dirname` / `__filename` / `createRequire` / `require(`.

**Acceptance:** each hit is classified. For every `require(` or `createRequire` hit kept as a
finding, the report states what breaks under Bun; for every one allowlisted, the report names the
allowlist entry it matches.

## T3b — Pass 1: Bun version references and the research artifact's leads

Check every Bun version reference — `packageManager` in `package.json`, `bunVersion` in
`flake.nix`, `bun-version:` in `.github/workflows/*.yml`, `engines.bun` in each package, and the
version floors stated in `DEVELOP.md` — for internal agreement and against the current upstream
release. Then work the named leads in `design.md`: `build-bun.mjs:154`, `bun-entry.ts`, the two
telemetry sites, and the `node:sea` dead-branch requirement.

**Acceptance:** the report states the current upstream release with its source, and lists every
version reference with its value, so a reader can see whether they agree. Each named lead is
resolved to either a finding with `path:line` or an explicit "checked, still correct" entry. The
`node:sea` lead is resolved by showing the search that found no reference, not by assertion.

## T4 — Pass 1: re-verify the allowlist

Read each allowlist entry in `design.md` and confirm the code still matches the stated reason.

**Acceptance:** each entry is marked "still valid" or promoted to a finding, with the `path:line`
that changed the verdict. An entry whose reason no longer holds appears in the report as a finding,
not silently dropped.

## T5 — Pass 2: comment-free zones

Run `bun scripts/check-no-comments.mjs`.

**Acceptance:** the run's exit status and output are recorded. A clean run lets T6 skip
`packages/agent-core-v2`, `packages/kap-server`, and `packages/transcript`; a dirty run lists the
violations as findings.

## T6 — Pass 2: comments in the remaining source

Sweep the non-excluded source for comments making checkable claims (commands, paths, counts,
defaults, versions, symbol names, described control flow) and verify each against the code it
describes.

**Acceptance:** every finding names the comment's `path:line`, the code's `path:line`, and the
contradiction. Comments that are merely vague or stylistic are recorded as examined-and-dropped,
not reported.

## T7 — Pass 3: root and user-facing docs

Read in full: `README.md`, `README.zh-CN.md`, `CONTRIBUTING.md`, `CONTRIBUTING.zh-CN.md`,
`DEVELOP.md`, `SECURITY.md`, `GOAL.md`, `docs/index.md`, `docs/DEVELOP.md`.

**Acceptance:** every checkable claim is verified against code. Claims already known to be
suspect — the CI job list, the "CI installs no Node" statement, the workspace-member list, the
slash-command count, referenced script paths — are each explicitly confirmed or refuted with a
`path:line` on both sides.

## T8 — Pass 3: `docs/en` and `docs/zh`

Read all 56 files in full, and check the two trees against each other as well as against code.

**Acceptance:** every finding names the document `path:line` and the code `path:line`. A claim
corrected on one language side but not the other is reported as a divergence finding even when
both sides are individually plausible.

## T9 — Pass 3: package-level docs

Read in full every `packages/*/README.md`, `packages/*/DEVELOP.md`, `apps/*/README.md`, and
`apps/*/DEVELOP.md`.

**Acceptance:** every documented build, test, and typecheck command is checked against the
package's `package.json` scripts. A documented command that does not exist, or that names a
different runner than the script uses, is a finding.

## T10 — Pass 3: prompt text under `packages/agent-core-v2`

Read all 105 Markdown files in full — system prompts, tool descriptions, built-in skills.

**Acceptance:** a tool description that misstates the tool's parameters or behaviour is reported as
a finding with the tool's implementation `path:line`. Prose that merely uses a Node-era command as
an illustrative example is reported separately as a judgement call, not as a hard defect.

## T11 — Pass 3: remaining Markdown

Read in full the Markdown under `plugins/**`, `.agents/**`, `scripts/**`, `tools/review/**`, and
`apps/kimi-inspect`, `apps/vscode`, `apps/kimi-web`.

**Acceptance:** every file in the T1 inventory is accounted for as read. Any file that could not be
read is named in the coverage statement with the reason.

## T12 — Verify every finding

For each candidate that survived T2–T11, re-open the named file at the named line and confirm the
quoted content is there.

**Acceptance:** every finding in the report reproduces with `sed -n '<line>p' <path>` showing the
content the report quotes. Any candidate that fails this check is dropped, and the drop count is
recorded.

## T13 — Write the report

Write `reports/audit-2026-10-08.md` in Chinese, per the format in `design.md`: summary table, one
section per class, the "considered and excluded" section, and the coverage statement.

**Acceptance:** the report contains no finding without a `path:line`; the summary table's counts
match the number of entries in each section; the excluded-classes section names `node:` imports
with the reason they are excluded.

## T14 — Confirm nothing else changed

`reports/` is gitignored (`.gitignore:31`), so the report does not appear in `git status`. Confirm
the audit touched nothing else by running `git status --porcelain` and
`ls -l reports/audit-2026-10-08.md`.

**Acceptance:** `git status --porcelain` lists no entry other than `specs/power-girl-echo-creeper/`
(the spec documents themselves), and the report file exists with a non-zero size. Any other entry
means the audit modified something it should not have, and is reported as a failure of this task
rather than quietly reverted.
