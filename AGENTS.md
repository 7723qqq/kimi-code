# kimi-code — Agent Entry Point

**Keep this file short.** Its content is injected into every session's prompt as reference data (`${agents_md}`), so every line here is a per-turn cost in a file that is read constantly. Do not grow it into a reference document.

**What lives where:**

- [`DEVELOP.md`](DEVELOP.md) — the project's single source of truth: structure, packages, commands, CI, toolchain, the `specs/` convention, and the prompt/tool ownership map. **Read it when you need to know how something works.**
- [`CONVENTIONS.md`](CONVENTIONS.md) — the rules a change must obey: coding style, i18n classification, testing rules, workflow requirements, code-review rules. **Read it before writing code.**
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — contribution policy and PR process.

**What is injected versus read on demand.** Only this file is injected into a session automatically, as `${agents_md}`. `DEVELOP.md`, `CONVENTIONS.md`, and `CONTRIBUTING.md` are **not** injected: the agent reads them on demand, and no rule here may assume otherwise. When these files disagree, `DEVELOP.md` owns project facts, `CONVENTIONS.md` owns change rules, and this file owns only the entry pointer and the hard constraints below.

The six core behavior rules that every session receives are owned by one module, not by this file: [`behaviorContract.ts`](packages/agent-core-v2/src/app/agentProfileCatalog/behaviorContract.ts). Do not restate them here; every session, including a DeepSeek one, receives them through the full system prompt's `${behavior_contract}` block.

If you need depth, go read one of those instead of expanding this file. Keep only what every single task needs.

---

## Hard Constraints

These are the ones that silently break the build or ship a regression if ignored.

- **The toolchain is Bun ≥1.4** — package manager, runtime, and packaging engine alike. There is no `pnpm-workspace.yaml`, no `.npmrc`, no `.nvmrc` in this repository. Workspace membership is the root `package.json` `workspaces` field. Node.js is needed only by the Nix build path.
- **`packages/agent-core-v2`, `packages/kap-server`, and `packages/transcript` are comment-free zones.** No comments of any kind, no JSDoc, not even on exported symbols. The only exception is load-bearing lint directives (`oxlint-disable` / `eslint-disable`); `@ts-expect-error` and friends stay banned. `bun run check:no-comments` is a **standalone gate** — a green `bun run lint` does not mean this passed.
- **Never localize a value that code compares.** If a branch keys off a string, that string is protocol data: export a constant and compare that. `tools/review`'s `text-as-protocol` check fails the build otherwise.
- **Prompt text is behavior.** Editing or deleting a sentence under `packages/agent-core-v2/src/**/*.md` changes what every user receives. That is a behavior change, not a comment cleanup.
- **Model-family adaptation is embedded in the one system prompt, not injected at runtime.** Every family — DeepSeek included — renders the full `system.md`, so all six core contract clauses arrive in `${behavior_contract}`. Family-specific guidance lives in `model-adaptations/curated/<family>.md`, is loaded by `modelAdaptations.ts`, and is carried in through the `${model_adaptation_section}` placeholder. There is no per-family prompt shape and no reminder channel for adaptation text: a new rule lands in `behaviorContract.ts` (core) or the curated file (family), and a family that merely needs different guidance does not need new delivery plumbing.
- **Do not bump versions.** This fork follows upstream versions; `bun run version` / `bun run publish` are not to be run here.
- **`specs/<id>/` is a requirements contract, not a description of current state.** Version numbers, package names, and commands inside a spec may be long expired. Read a spec to learn what was wanted and why; read the *code* to learn what is true. Do not edit a shipped spec to make it current.
- **Before committing**, run `git status` and remove throwaway scratch: handoff documents, UI mockups, anything under `.tmp/`.

Everything else — how to run the CLI, how tests are wired, what the gates check, how to review a PR — is in `DEVELOP.md` and `CONVENTIONS.md`. Read them; don't guess.

---

## Working Principles

- Think from first principles. Start from real requirements, code facts, and verification results; if the goal is unclear, discuss it with the user first.
- Treat code, not documentation, as the source of truth. Do not read Markdown just to understand an implementation.
- Before making code changes, read the relevant code, the nearest `DEVELOP.md`/`AGENTS.md` in the directory tree, and [`CONVENTIONS.md`](CONVENTIONS.md).
- Keep changes focused. No unrelated refactors slipped in along the way.
- Prefer `rg` / `rg --files` when reading code.
- When committing, do not add co-author attribution, and do not reveal the identity of the agent in commit messages, PR descriptions, or any explanatory text.
- Push every commit to `origin` immediately after `git commit`. Never let local and remote diverge.

---

## Maintaining These Files

This file, `DEVELOP.md`, and `CONVENTIONS.md` were split by responsibility on purpose: a reference document and an always-loaded rule set used to live in one file and drift together. Keep them separate.

- **One owner per fact.** Update the file that owns it, and link from the others — never keep a second copy.
- **Verify anything copied from `upstream/main` against this branch.** Upstream still describes pnpm, Node ≥24, and four `LifecycleScope` tiers; none of that is true here. `main` is the working branch and `origin/HEAD` points at it.
- `AGENTS.md` is held at this fork's version across upstream merges via `merge=ours` in `.gitattributes`. Re-apply that if the file ever comes back with pnpm in it.
