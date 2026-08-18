# coding-style: Pass undefined directly for optional properties, no conditional spread
tags: typescript, style, object
scope: packages/

For optional object properties, pass `undefined` directly instead of using conditional spread.

- YES: `{ user }`
- NO: `{ ...(user ? { user } : undefined) }`

---

# coding-style: Optional property types don't need an extra | undefined
tags: typescript, interface, style
scope: packages/

Optional properties don't need to additionally allow `undefined` in their declarations.

- YES: `interface Options { user?: User }`
- NO: `interface Options { user?: User | undefined }`

---

# coding-style: Use the #/ prefix for imports
tags: typescript, import, path-alias
scope: packages/

All internal imports use the `#/` path alias (equivalent to `@/`) instead of relative paths like `../`.

---

# coding-style: index.ts only re-exports
tags: typescript, module, export
scope: packages/

Except for a package's entry `index.ts`, other `index.ts` files should use the `export * from './module'` form.

---

# coding-style: Don't wrap single-parameter internal methods into options objects
tags: typescript, api-design
scope: packages/

Internal methods with only a single parameter should not be converted into options objects just for stylistic uniformity.

---

# architecture: apps/kimi-code must not depend directly on agent-core
tags: dependency, kimi-code, agent-core
scope: apps/kimi-code/

The CLI/TUI app consumes core capabilities through `@moonshot-ai/kimi-code-sdk` and must not depend directly on `@moonshot-ai/agent-core-v2`.

---

# architecture: apps/kimi-web must not depend on agent-core
tags: dependency, kimi-web, agent-core
scope: apps/kimi-web/

The Web UI does not depend on `@moonshot-ai/agent-core-v2`; wire types are reimplemented locally.

---

# architecture: The Agent class must be independent of Session
tags: agent-core, class-design, session
scope: packages/agent-core-v2/src/agent/

The `Agent` class constructor must not require creating a `Session` instance, nor require `agentId` or `session`. An optional `sessionId` is acceptable as a hint, but the instance must not hold a `sessionId` or depend on the Session lifecycle.

---

# workflow: Generate a changeset before committing
tags: git, changeset, pr
scope: 

Before submitting a PR for any code change, you must run the `gen-changesets` skill (`.agents/skills/gen-changesets/SKILL.md`) to generate a changeset under `.changeset/`.

---

# workflow: Never decide a major bump on your own
tags: changeset, semver, breaking-change
scope: 

When generating a changeset, **never** decide a `major` bump on your own. When a change meets the major criteria (breaking changes, incompatible configuration, removed commands, etc.), stop and explain to the user and request confirmation. Only write `major` after the user explicitly agrees.

---

# workflow: PR titles use the Conventional Commit format
tags: git, pr, naming
scope: 

PR titles must follow the Conventional Commit style, e.g. `chore: remove legacy format commands`.

---

# workflow: Push after every commit
tags: git, push, remote
scope: 

After every `git commit`, immediately run `git push` to keep local and remote in sync. Committing locally without pushing is forbidden.

---

# workflow: Don't commit scratch files
tags: git, scratch, cleanup
scope: 

Don't commit throwaway files: agent notes (`HANDOVER-*.md`), prototypes (`*-designs.html`), etc. Check `git status` before committing; put scratch files in `.tmp/`.

---

# workflow: Use neutral placeholders in public text
tags: security, placeholder, pr
scope: 

In public text and test data, replace real internal identifiers with neutral placeholders such as `example.com`, `example.test`, `YOUR_API_KEY`. Audit the diff before submitting a PR.

---

# pitfall: pnpm-workspace.yaml and flake.nix must stay in sync
tags: monorepo, nix, workspace
scope: 

When adding or removing workspace packages, update both `pnpm-workspace.yaml` and `flake.nix`. flake.nix is maintained manually; the CI check only covers kimi-code's transitive dependency closure, so omissions won't be caught automatically.

---

# pitfall: The flake.nix workspace check has blind spots
tags: nix, ci, workspace
scope: 

`scripts/check-nix-workspace.mjs` only validates the dependency closure of `@moonshot-ai/kimi-code`. Leaf packages outside the closure (e.g. e2e) won't error even if missing. Don't rely on green CI to judge whether flake.nix is complete.

---

# pitfall: pnpm install fails when the Node version is insufficient
tags: node, pnpm, environment
scope: 

Requires Node.js >= 24.15.0 and pnpm 10.33.0. `.npmrc` sets `engine-strict=true`, so `pnpm install` fails outright on a version mismatch.

---

# architecture: Gate experimental features behind flags
tags: feature-flag, experimental
scope: packages/agent-core-v2/src/app/flag/

New features are gated by registering a flag in `packages/agent-core-v2/src/app/flag/flagRegistry.ts` and checking it with `flags.enabled('my-feature')`. The `KIMI_CODE_EXPERIMENTAL_<NAME>` environment variable toggles a single flag; `KIMI_CODE_EXPERIMENTAL_FLAG` enables all.

---

# workflow: Code is the source of truth, not docs
tags: principle, documentation, code
scope: 

Unless the user explicitly asks, don't read ordinary Markdown to understand the implementation. Code is authoritative.

---

# workflow: Keep changes focused
tags: principle, diff, refactor
scope: 

Keep changes focused. Don't sneak in unrelated refactors.

---

# workflow: Read code and constraints before changing code
tags: principle, read-first
scope: 

Before changing code, read the relevant code and the most recent constraints, and follow the nearest `AGENTS.md` in the directory tree.

---

# workflow: No co-author attribution, don't reveal agent identity in commits
tags: git, commit, identity
scope: 

Don't add any co-author attribution when committing; don't reveal the agent identity in commit messages / PR descriptions.

---

# workflow: Use the write-tui skill for TUI changes
tags: tui, skill, kimi-code
scope: apps/kimi-code/

When writing or modifying the CLI/TUI terminal UI, use the `write-tui` skill (`.agents/skills/write-tui/SKILL.md`).

---

# coding-style: Prefer adding tests to existing files
tags: testing, file-organization
scope: 

Don't add too many new test files. Prefer adding tests to the existing test file of the corresponding component/module.

---

# workflow: Fix the test by default when tests fail
tags: testing, principle
scope: 

When a test fails because of a user modification, fix the test by default; don't change the implementation to accommodate an old test unless the implementation truly has a bug.
