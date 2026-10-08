# Design — how the audit is run

## Shape

Three passes, one per defect class. Each pass produces a candidate list; every candidate is then
verified against the file it names before it may enter the report. Verification is the load-bearing
step — a candidate that cannot be reproduced as a concrete `path:line` pair is dropped, not
softened.

The passes are independent and can run in parallel. Pass 3 is the long pole: 222 Markdown files
read in full.

## Evidence base for "does this hold under Bun?"

Claims about Bun's behaviour are checked against the current release, not against memory. As of
2026-10-08 the current release is **bun-v1.4.2** (published 2026-09-05, per the GitHub releases
API); the repo pins **1.4.0** in `package.json:129`, `flake.nix:54`, and sixteen `bun-version:`
lines across `.github/workflows/`.

`参考目录/bun/bun-specs-1.4.0-2026-08-24.md` is the repo's own Bun research artifact and is the
starting point for capability questions — it documents `node:sea` as unimplemented, the
`/$bunfs` path semantics, `Bun.spawn` stdio defaults that differ from `node:child_process`, and
`worker_threads` gaps. It is a **lead source, not an authority**: it is dated 2026-08-24, its §0
("最新稳定版就是 1.4.0") is already false, and several of its recommendations have since been
implemented — `CONTRIBUTING.md:187` already carries the corrected bytecode wording, and
`apps/kimi-code/scripts/native/build-bun.mjs:166` already passes
`--no-compile-autoload-dotenv --no-compile-autoload-bunfig`. Every claim taken from it is
re-verified against the current release and the current code before it becomes a finding.

The artifact is itself out of finding scope, per the scope decision above. The alternative —
treating it as an in-scope document, so that its stale §0 version claim and its stale §3.1
`node:sea` claim become findings — is offered as a choice at approval time.

## Pass 1 — Node-era leftovers

Detection is a pattern sweep followed by classification. The sweep is cheap; the classification is
where the judgement lives, because the repo legitimately contains Node-compatible code.

| Pattern | Catches | Classification rule |
|---|---|---|
| `\bnpm (run\|install\|ci\|exec\|publish\|test)\b`, `\bnpx \b`, `\byarn \b`, `\bpnpm \b`, `npm_config_` | package-manager invocations | Finding when the command is meant to be run in this repo. Not a finding when it is a user-facing install instruction for the published package, or a deliberate multi-PM helper |
| `^#!.*\bnode\b` | Node shebangs | Finding unless the file is a test fixture |
| `setup-node`, `node-version-file`, `node-version:` | CI installing Node | Finding |
| `.nvmrc`, `engines.*node`, `package-lock.json`, `yarn.lock`, `.npmrc` | Node-only artifacts | Finding when present, or referenced but absent |
| `process\.versions\.node`, `runtime: 'node'` | runtime reporting that is wrong under Bun | Finding |
| `node --test`, `node:test` | Node test runner | Finding unless allowlisted |
| `bun-version`, `packageManager.*bun`, `bunVersion`, `engines.*bun` | Bun version pins | Finding when the pins disagree with each other, or when they name a release older than the current upstream one — drift, not a defect |
| `__dirname`, `__filename`, `createRequire`, `require(` | CJS / Node module idioms | Finding when it breaks under Bun or duplicates a Bun-native facility. `__dirname` / `__filename` used for resource location is a finding: in a compiled Bun binary they resolve to the build machine's source path, not the runtime machine's. Native-addon loaders are allowlisted |

### Named leads carried over from the repo's own Bun research

These are checked explicitly rather than left to the sweep:

- `apps/kimi-code/scripts/native/build-bun.mjs:154` — a comment dated "Re-verified on Bun 1.4.0";
  confirm the claim still holds on the current release.
- `apps/kimi-code/scripts/native/bun-entry.ts` — the research artifact flagged a stale
  top-level-await comment here; confirm whether it was updated.
- `packages/telemetry/src/sink.ts:116-119` and
  `packages/agent-core-v2/src/app/telemetry/cloudAppender.ts:180-183` — `runtime: 'node'` and
  `process.versions.node`; under Bun the first is simply wrong and the second reports Bun's
  emulated Node version.
- The `node:sea` dead-branch requirement: the research artifact named
  `apps/kimi-code/src/cli/update/source.ts` and `apps/kimi-code/src/native/native-assets.ts` as
  SEA reference points, but `node:sea` no longer appears anywhere in the repo. Confirm the
  requirement is satisfied, and record that the artifact is stale on this point.

### Allowlist — examined, deliberately not reported

Each entry is re-verified during the audit; if the code has drifted from the reason, it becomes a
finding.

- `packages/pi-tui/scripts/test.mjs` — dispatches `bun test` under Bun and `node --test` under
  Node. The Node branch is the documented fallback, not a leftover.
- `packages/pi-tui/vitest.config.ts` — points vitest at no files because the suite is
  `node:test`-style. (Its *comment* is a separate matter — see Pass 2.)
- `apps/kimi-code/scripts/postinstall/reach.mjs` — must speak npm / yarn / pnpm because users
  install the published package through those managers.
- `packages/kimi-native-tools/index.js`, `packages/kosong/native/index.js` — generated napi-rs
  loaders.
- `apps/kimi-code/src/native/native-require.ts`, `apps/kimi-code/src/i18n/index.ts` — native addon
  loading, documented in-file.
- `apps/kimi-code/src/cli/sub/plugin-run-node.ts` — the hidden `__plugin_run_node` entry point,
  by design.
- `node:` imports, `@types/node` — required by the repo's own lint rule and implemented by Bun.

## Pass 2 — stale comments

The comment-free zones are checked first, by running the repo's own
`bun scripts/check-no-comments.mjs`. A clean run confirms the zones are empty and the pass can
skip them; a dirty run is itself a finding.

For the remaining source, the sweep targets comments that make a *checkable claim*, because those
are the ones that can be falsified:

- a command or script name (`node --test`, `npm run x`, `bun run y`);
- a path or filename;
- a count, default, limit, or version;
- a named symbol, flag, or config key;
- a described control-flow claim ("falls back to X", "only runs when Y", "is called before Z").

Each candidate is then verified by reading the code the comment describes. A comment that restates
what the code plainly does is not a finding even if the wording is loose; a comment whose claim is
false is.

## Pass 3 — stale docs

Every in-scope Markdown file is read in full. Claims are classified the same way as comments —
commands, paths, counts, defaults, versions, flag and command names, described behaviour — and each
is checked against the code.

Three sub-populations need different treatment:

- **Root and user-facing docs** (`README.md`, `README.zh-CN.md`, `CONTRIBUTING.md`,
  `CONTRIBUTING.zh-CN.md`, `DEVELOP.md`, `SECURITY.md`, `GOAL.md`, `docs/en/**`, `docs/zh/**`).
  These make the most checkable claims: file paths, command names, CI job lists, counts such as
  the 46 slash commands, and version floors.
- **Package-level docs** (`packages/*/README.md`, `packages/*/DEVELOP.md`, `apps/*/README.md`).
  These drift fastest after a toolchain change, because they document build and test commands.
- **Prompt text** (`packages/agent-core-v2/src/**/*.md`, 105 files). These are system prompts, tool
  descriptions, and built-in skills. A tool description that misstates the tool's parameters or
  behaviour is a finding; a prompt that merely uses `npm test` as an illustrative example in prose
  about writing goals is a judgement call and is reported as such, not as a hard defect.

The bilingual pair `docs/en` and `docs/zh` is checked for divergence as well as for accuracy: a
claim corrected on one side but not the other is a finding.

## Report format

`reports/audit-2026-10-08.md`, in Chinese. `.gitignore:31` ignores `reports/`, so the report is a
local artifact the user reads directly rather than something to commit — which is why T14 checks
for it with `ls` instead of `git status`. Per finding:

```
- `path/to/file.ts:42` — 说明：注释/文档声称 X，代码实际是 Y（依据：`path/to/other.ts:88`）。
```

Findings are grouped by class, then by area, and ordered by severity within each group. Severity is
one of:

- **高** — the code or document is actively wrong in a way a user or CI run will hit (a broken CI
  reference, a wrong runtime value, a command that does not exist).
- **中** — misleading but not immediately breaking (a stale command in a README, a comment naming
  the wrong script).
- **低** — cosmetic drift with no behavioural consequence.

## Rejected alternatives

- **Treat every `node:` import as a finding.** Rejected: the repo's own lint rule mandates the
  `node:` protocol, and Bun implements the modules. It would produce roughly 2500 findings, almost
  all false positives, and bury the real ones. The user confirmed this exclusion.
- **Audit `specs/**` and `apps/kimi-code/dist-web/**`.** Rejected: `specs/**` are historical
  documents about work already done, and `dist-web/**` is a minified prebuilt bundle where neither
  comments nor prose survive. The user confirmed the exclusion.
- **Sample the Markdown instead of reading it all.** Rejected by the user, who chose full
  coverage. The cost is accepted; the coverage statement in the report makes the coverage
  auditable.
- **Report findings as they are found, without a verification pass.** Rejected: the sweep patterns
  are deliberately broad, and an unverified candidate list would be dominated by the allowlisted
  cases above.
