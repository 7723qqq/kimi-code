# Requirements — Repository audit: Node-era leftovers, stale comments, stale docs

## Goal

Produce one audit report over this repository that lists, with `path:line` and a concrete
explanation, every instance of three defect classes:

1. **Node-era code that does not hold under Bun** — tooling, runtime assumptions, and configuration
   that are dead, wrong, or misleading now that Bun is the package manager, script runner, and
   published runtime.
2. **Comments that contradict the code they sit next to.**
3. **Documentation that contradicts the code it describes.**

The report is analysis only. No source file is modified.

## Audience

The repository maintainer, who decides which findings to act on. Every entry must be readable
without re-deriving the evidence: it carries the file, the line, and the reason.

## Scope decisions (confirmed with the user)

- **`node:` builtin imports are not findings.** `.oxlintrc.json` sets
  `unicorn/prefer-node-protocol: error`, so the repo *requires* the `node:` prefix, and Bun
  implements these modules. The 2487 occurrences across 959 files are reported once, in a short
  "considered and excluded" section, so the reader knows the class was examined and deliberately
  dropped.
- **In scope:** `packages/**`, `apps/**`, `scripts/**`, `plugins/**`, `tools/review/**`,
  `.github/**`, `.agents/**`, root configuration files, and every Markdown file under those trees
  plus `docs/**` — 222 Markdown files after the exclusions below.
- **Out of scope:** `specs/**` (42 historical spec documents), `apps/kimi-code/dist-web/**`
  (524 committed prebuilt bundle files), `参考目录/**` (gitignored), `node_modules/**`,
  `**/dist/**`, `**/coverage/**`.
- **Documentation depth:** every in-scope Markdown file is read in full, not sampled.

## What counts as a finding

### Class 1 — Node-era code that does not hold under Bun

A finding must be one of:

- a command, script, or CI step that invokes npm / yarn / pnpm / npx, or installs Node;
- a reference to a Node-only artifact (`.nvmrc`, `engines.node`, `package-lock.json`,
  `yarn.lock`, `.npmrc`) that is present, or referenced but absent;
- a shebang or entry point that assumes a Node interpreter;
- a runtime branch or reported value that is wrong under Bun (`process.versions.node`, a
  hardcoded `runtime: 'node'`, a `node --test` dispatch that cannot work under Bun);
- a Node-only API used where Bun has no equivalent;
- a Bun version reference that disagrees with the rest of the repo, or that pins a release older
  than the current upstream one — reported as drift, with the current release named.

Explicitly **not** a finding: `node:` imports, `@types/node`, `require()` inside native-addon
loaders, and the deliberate Node fallbacks named in the allowlist in `design.md`.

### Class 2 — Comments that contradict the code

A finding must name the comment's `path:line`, the code's `path:line`, and the specific
contradiction. Comments that are merely vague, redundant, or stylistic are not findings.
`packages/agent-core-v2`, `packages/kap-server`, and `packages/transcript` are comment-free zones
by policy (`DEVELOP.md` → "General Coding Rules"), so the audit verifies that expectation rather
than assuming it.

### Class 3 — Documentation that contradicts the code

A finding must name the document's `path:line`, the code's `path:line`, and the specific
contradiction. Both user-facing docs (`README.md`, `README.zh-CN.md`, `docs/en`, `docs/zh`,
`CONTRIBUTING.md`, `DEVELOP.md`) and prompt text under `packages/agent-core-v2/src/**/*.md` count:
a tool description that misstates the tool's behaviour is a documentation defect with behavioural
consequences, not a cosmetic one.

## Deliverable

One Markdown report at `reports/audit-2026-10-08.md`, written in Chinese, containing:

- a summary table of finding counts per class and per area;
- one section per class, each finding as `path:line` plus 说明;
- a "considered and excluded" section listing the classes that were examined and deliberately not
  reported, with the reason;
- a coverage statement naming what was read, so a reader can tell an empty result from an
  unexamined area.

## Out of scope

- Fixing anything. The report is the only artifact.
- Judging code quality, style, or architecture.
- Rust, Zig, Vue, and C sources, except where a comment or a document about them is the finding.
- Re-auditing `specs/**` and `apps/kimi-code/dist-web/**`.
