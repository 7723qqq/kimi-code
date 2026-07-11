# Repository-level Agent Guide

Reply in the same language as the user.

This is a TypeScript monorepo for **Kimi Code** — Moonshot AI's agent-assisted coding platform. The repository contains a CLI/TUI application, a web UI, a desktop (Electron) client, a local server, a public SDK, and the internal engine packages that power them. Keep this file limited to hot-path rules: the project map, hard constraints, and workflow requirements — things every task needs to know.

## Working Principles

- Think from first principles. Start from real requirements, code facts, and verification results; if the goal is unclear, discuss it with the user first.
- Treat code, not documentation, as the source of truth. Unless the user explicitly says otherwise, do not read ordinary Markdown just to understand the implementation.
- Before making code changes, read the relevant code and the most recent constraints, and follow the nearest `AGENTS.md` in the directory tree.
- Keep changes focused. Do not slip in unrelated refactors along the way.
- When committing, do not add any co-author attribution, and do not reveal the identity of the agent in commit messages, PR descriptions, or any explanatory text.

## Project Map

### Apps

- `apps/kimi-code` (`@moonshot-ai/kimi-code`): the CLI / TUI application and the only user-facing npm package that provides the `kimi` command. It consumes core capabilities through `@moonshot-ai/kimi-code-sdk` and must not depend directly on `@moonshot-ai/agent-core`. When writing or modifying its terminal UI, use the `write-tui` skill (`.agents/skills/write-tui/SKILL.md`). See `apps/kimi-code/AGENTS.md`.
- `apps/kimi-web` (`@moonshot-ai/kimi-web`): the browser web UI, a peer to the TUI. Vue 3 + Vite 6 + vue-i18n v11; talks to the server over REST + WebSocket under `/api/v1`. It must not depend on `@moonshot-ai/agent-core` (wire types are re-implemented locally). See `apps/kimi-web/AGENTS.md`.
- `apps/kimi-desktop` (`@moonshot-ai/kimi-desktop`): an Electron shell around the Kimi web UI. Private, not published.
- `apps/vis`, `apps/vis/server`, `apps/vis/web`: visual debugging tools for sessions and replays. Private.

### Packages

- `packages/agent-core` (`@moonshot-ai/agent-core`): the unified agent engine — Agent, Session, profile, skills, tools, plan, permission, background, records, the in-process DI service layer (`src/services/`), and other core capabilities. Private.
- `packages/node-sdk` (`@moonshot-ai/kimi-code-sdk`): the public TypeScript SDK and harness. One of the two publishable packages.
- `packages/kosong` (`@moonshot-ai/kosong`): the LLM / provider abstraction layer (OpenAI, Anthropic, Google Gemini SDKs). Private.
- `packages/kaos` (`@moonshot-ai/kaos`): the execution environment and file/process abstractions (including SSH). Private.
- `packages/oauth` (`@moonshot-ai/kimi-code-oauth`): Kimi OAuth and managed auth utilities. Private.
- `packages/telemetry` (`@moonshot-ai/kimi-telemetry`): shared client-side telemetry infrastructure. Private.
- `packages/server` (`@moonshot-ai/server`): the Kimi Code server. Hosts `agent-core` sessions and exposes them over REST + WebSocket (`/api/v1`); bootstrapped from `src/start.ts` and consumed by `apps/kimi-code`. See `packages/server/AGENTS.md`.
- `packages/server-e2e` (`@moonshot-ai/server-e2e`): live e2e tests and scenarios against a running server (`KIMI_SERVER_URL`, default `http://127.0.0.1:58627`). See `packages/server-e2e/AGENTS.md`.
- `packages/protocol` (`@moonshot-ai/protocol`): shared REST + WebSocket protocol schemas (envelope, error codes, pagination, ws-control) consumed by `agent-core`, `server`, and `server-e2e`. Private.
- `packages/acp-adapter` (`@moonshot-ai/acp-adapter`): the Agent Client Protocol adapter, bridging kimi-code sessions to ACP clients; consumed by `apps/kimi-code`. Private.
- `packages/migration-legacy` (`@moonshot-ai/migration-legacy`): migrates legacy `~/.kimi/` data into `~/.kimi-code/`; consumed by `apps/kimi-code` at install time. Private.
- `packages/kimi-native-tools` (`@moonshot-ai/kimi-native-tools`): native Rust tools (via napi-rs) for bash, grep, glob, read, write, edit; consumed by `agent-core`. Targets: darwin (arm64/x64), linux (arm64/x64), win32-x64.
- `packages/pi-tui` (`@moonshot-ai/pi-tui`): vendored TUI library (forked from upstream pi-mono 0.80.2). Tests run with `node --test`, not vitest. See `packages/pi-tui/AGENTS.md`.

### Other directories

- `docs/`: VitePress bilingual (en/zh) documentation site. See `docs/AGENTS.md`.
- `plugins/`: plugin marketplace. `plugins/official/` holds bundled official plugins (e.g. `kimi-datasource`); `plugins/marketplace.json` is the registry. Plugins are versioned via their own `kimi.plugin.json`, not npm.
- `.agents/skills/`: repo-local agent skills (`gen-changesets`, `gen-docs`, `write-tui`, `sync-changelog`, `pre-changelog`, `translate-docs`).
- `build/`: shared Vite/webpack raw-text loader plugins for dev mode.
- `scripts/`: root-level maintenance scripts (`check-nix-workspace.mjs`, `check-service-naming.mjs`, `fix-node-pty-perms.mjs`).

## Environment Requirements

- **Node.js**: `>=24.15.0` (from the root `package.json` `engines`; `.nvmrc` is `24.15.0`, used by nvm / fnm / mise to pick the minimum recommended version).
- **pnpm**: `10.33.0` (from the root `package.json` `packageManager`).
- `pnpm install` will fail when the Node version is not satisfied, because `.npmrc` sets `engine-strict=true`.
- **Rust** (stable): required only for `packages/kimi-native-tools` development and native builds.
- **Nix** (optional): `flake.nix` provides a reproducible build environment and dev shell.

## Build and Test Commands

### Setup

```sh
pnpm install          # install all workspace deps
```

### Development

```sh
pnpm dev:cli          # run the CLI/TUI in dev mode
pnpm dev:web          # run the web UI in dev mode (Vite, port 5175)
pnpm dev:desktop      # run the Electron desktop app in dev mode
pnpm dev:server       # run the local server in dev mode (foreground)
pnpm vis              # run the visual debugger
pnpm dev:docs         # run the VitePress docs site
```

### Build

```sh
pnpm build            # build all packages recursively
pnpm build:packages   # build only packages/* (not apps)
```

### Quality

```sh
pnpm typecheck        # builds packages first, then tsc --noEmit across all packages/apps
pnpm lint             # oxlint --type-aware
pnpm lint:fix         # oxlint with auto-fix
pnpm lint:pkg         # publint + attw --pack (CLI package only)
pnpm sherif           # monorepo linting (dependency version consistency)
```

### Test

```sh
pnpm test             # vitest run (all workspace projects except pi-tui)
pnpm test:watch       # vitest in watch mode
pnpm test:coverage    # vitest run --coverage (v8 provider)
```

Package-level tests: `pnpm --filter <pkg-name> test`. The `pi-tui` package uses `node --test`, not vitest — run with `pnpm --filter @moonshot-ai/pi-tui test`.

E2E tests for the CLI: `pnpm --filter @moonshot-ai/kimi-code run e2e` (in-process) or `e2e:real` (real LLM smoke test).

Server e2e: `KIMI_SERVER_URL=http://127.0.0.1:58627 pnpm --filter @moonshot-ai/server-e2e test`.

### Clean

```sh
pnpm clean            # rm -rf dist in all packages
```

### Release

```sh
pnpm changeset        # create a changeset
pnpm version          # apply changesets (bump versions)
pnpm publish          # full quality gate + changeset publish
```

## Technology Stack

- **Language**: TypeScript (strict mode, `target: ES2024`, `moduleResolution: bundler`, `verbatimModuleSyntax`, `noUncheckedIndexedAccess`). TypeScript 6.0.2.
- **Module system**: ESM (`"type": "module"` everywhere). Path alias `#/*` maps to `./src/*.ts` and `./src/*/index.ts` in each package.
- **Build tool**: `tsdown` (tsup-based bundler) for packages; Vite 6 for `kimi-web`; `tsdown` + Electron for `kimi-desktop`.
- **Linter**: `oxlint` (type-aware, config in `.oxlintrc.json`). Formatter: `oxfmt` (config in `.oxfmtrc.json` — 100 char width, single quotes, trailing commas, LF, import sorting).
- **Test framework**: `vitest` 4.1.4 with v8 coverage. `pi-tui` uses `node --test` instead.
- **Monorepo**: pnpm workspaces with `catalog:` for shared dependency versioning (currently `zod: 4.3.6`).
- **Server**: Fastify 5 (REST) + `ws` (WebSocket), uniform response envelope `{ code, msg, data, request_id }`.
- **Web UI**: Vue 3 (Composition API, `<script setup lang="ts">`) + Vite 6 + vue-i18n v11. No Pinia, no client router, no path alias — relative imports only.
- **Desktop**: Electron 33 wrapping the web UI.
- **Native tools**: Rust via napi-rs 2 (regex, globset, ignore, tokio, encoding_rs, image).
- **LLM providers**: OpenAI SDK, Anthropic SDK, Google GenAI SDK (all via `kosong`).
- **Changesets**: `@changesets/cli` for versioning. NPM Trusted Publishing (OIDC) — no `NPM_TOKEN` needed.
- **Nix**: `flake.nix` for reproducible builds, pinned to `nixos-25.11` for Node.js 24.x.

## Code Style Guidelines

- For optional object properties, pass `undefined` directly instead of using conditional spread.
  - YES: `{ user }`
  - NO: `{ ...(user ? { user } : undefined) }`
- Optional object properties do not need to additionally allow `undefined` in the type.
  - YES: `interface Options { user?: User }`
  - NO: `interface Options { user?: User | undefined }`
- Internal methods with only a single parameter should not be turned into options objects just for stylistic uniformity.
- Except for a package's `index.ts`, other `index.ts` files should prefer `export * from './module';`.
- Prefer importing via `import ... from '#/...'`, which serves the same purpose as `import ... from '@/...'`.
- The `Agent` class in `packages/agent-core/src/agent` must be usable on its own. The constructor must not force the caller to create a `Session` instance, nor require an `agentId` or `session`. It may accept an optional `sessionId` as a request-config hint — for example mapped to the provider's `prompt_cache_key` — but the instance must not hold `sessionId`, and must not depend on the Session lifecycle, metadata, or parent/child relationship logic.
- Do not add too many new test files. Prefer adding tests to the existing test file of the corresponding component or module.
- When a test fails because of a user modification, default to fixing the test first; do not change the implementation to satisfy an old test unless the implementation truly has a bug.
- Do not sacrifice code quality for external compatibility unless the user explicitly asks for it. Breaking changes go through changesets and a `major` bump, gated by the rule below.
- Default to **no comments** in code. Write a comment only when the *why* is non-obvious to a reader who has the diff in front of them: a hidden constraint, a subtle invariant, a workaround. One short line max. Do not write block docstrings on internal helpers, comments that narrate the diff, or comments pointing at other files by line number.
- `apps/kimi-code` TUI: do not use chalk named colors directly — use theme tokens. Do not over-encapsulate one- or two-line functions. Constants must live in `constant/` directories. See `apps/kimi-code/AGENTS.md` for the full TUI conventions including the Kitty keyboard protocol printable-char rule.
- `apps/kimi-web`: use design-system primitives from `src/components/ui/`, CSS tokens from `src/style.css`, and `<script setup lang="ts">`. No auto-import, no path alias. See `apps/kimi-web/AGENTS.md`.

## Testing Instructions

- **Vitest** is the primary test runner. The root `vitest.config.ts` defines projects as `packages/*` and `apps/kimi-code`. Coverage uses v8, including `packages/*/src/**/*.ts` and `apps/*/src/**/*.ts`.
- **pi-tui** is the exception: its tests run with `node --test` and are not part of `vitest run`. CI runs them in a separate `test-pi-tui` job.
- **Server e2e** tests (`packages/server-e2e`) run against a live server at `KIMI_SERVER_URL` (default `http://127.0.0.1:58627`). Start the server with `pnpm dev:server` first.
- **CLI e2e** tests are in `apps/kimi-code/test/e2e/` and require `KIMI_E2E=1` to run. Real LLM smoke tests require `KIMI_E2E_REAL=1`.
- **Native tools** tests: `cargo test` in `packages/kimi-native-tools`.
- Lint overrides for test files relax `no-explicit-any`, `no-unsafe-*`, `no-non-null-assertion`, etc. — see the `overrides` section in `.oxlintrc.json`.
- Vitest rules enforced in test files: `vitest/no-focused-tests` (no `.only`), `vitest/no-identical-title`, `vitest/no-conditional-tests` are errors.

## Monorepo Workspace Maintenance

- `pnpm-workspace.yaml` is the source of truth for workspace membership, but `flake.nix` also contains **hardcoded** `workspacePaths` and `workspaceNames` lists.
- **Whenever you add or remove a workspace package, you MUST update both `pnpm-workspace.yaml` and `flake.nix` — for every package, including leaf / test / e2e packages that nothing depends on.**
  - `pnpm-workspace.yaml` uses globs (`packages/*`, `apps/*`), so most packages land there automatically; `flake.nix` is fully manual and is where omissions happen.
  - Missing a path in `flake.nix`'s `workspacePaths` will silently drop files from the Nix build's `src` fileset.
  - Missing a name in `flake.nix`'s `workspaceNames` will break `pnpmConfigHook` because dependencies for that workspace will not be fetched.
- The automated "Check flake.nix workspace sync" (`scripts/check-nix-workspace.mjs`) only validates the transitive dependency **closure of `@moonshot-ai/kimi-code`**. A leaf package outside that closure (e.g. an e2e package nobody imports) slips through even when it is missing from `flake.nix`. A green check is therefore NOT proof that `flake.nix` is fully in sync — keep it updated by hand on every add/remove, do not rely on the check to catch omissions.

## Experimental Features

- Gate a not-yet-public feature behind an experimental flag. Add the flag to the registry at `packages/agent-core/src/flags/registry.ts`, then check it with `flags.enabled('my-feature')`. Flags are env-driven and default off: `KIMI_CODE_EXPERIMENTAL_<NAME>` toggles one, `KIMI_CODE_EXPERIMENTAL_FLAG` enables all. Release by flipping the entry's `default` to `true`.
- Current flags: `tool-select` (progressive tool disclosure, default off), `native_tools` (Rust-native tool implementations, default on), `rpc_microtask` (queueMicrotask for in-process RPC, default off).

## Publishable Packages and Changesets

Only two packages are published to npm:

| Package | Directory | Description |
| --- | --- | --- |
| `@moonshot-ai/kimi-code` | `apps/kimi-code` | CLI / TUI application — provides the `kimi` command |
| `@moonshot-ai/kimi-code-sdk` | `packages/node-sdk` | Public TypeScript SDK |

All other workspace packages are private and excluded from changeset selection via `ignore` in `.changeset/config.json`. Internal dependency version bumps are set to `patch` (`updateInternalDependencies: "patch"`). When a change in an internal package affects user-visible behavior of a publishable package, add a changeset to the affected publishable package describing the user-visible change. See `.changeset/README.md` for full details and the `gen-changesets` skill (`.agents/skills/gen-changesets/SKILL.md`).

## Where to Update Instructions

- Hard rules that affect almost every task: update the root `AGENTS.md`.
- Rules that only affect a specific directory: update the nearest sub-directory `AGENTS.md`.
- Keep instruction updates focused and supported by code facts.

## Workflow Requirements

- Prefer `rg` / `rg --files` when reading code.
- When designing changes, follow existing boundaries and local patterns first.
- In public text and test data, replace real internal identifiers with neutral placeholders such as `example.com`, `example.test`, and `YOUR_API_KEY`. Before opening a PR, ask a read-only agent to audit the diff for context-specific internal identifiers.
- When creating a PR, the PR title must follow Conventional Commit style, e.g. `chore: remove legacy format commands`.
- When an AI agent opens or updates a PR, fill in `.github/pull_request_template.md` — link the related issue or explain the problem, then describe what changed. Do not leave placeholder text or submit a generic summary of the diff.
- Do not submit vague AI-generated PR text. The human author must understand the change well enough to explain the code, edge cases, and why the approach fits this repository.
- After finishing a task and before submitting a PR, you must run the `gen-changesets` skill (see `.agents/skills/gen-changesets/SKILL.md`) and generate a changeset under `.changeset/` according to its rules.
- When generating a changeset, **never** decide on a `major` bump on your own. When you judge a change to meet the major criteria (breaking changes, incompatible user configuration, renamed or removed commands/arguments, changed behavior semantics, etc.), you must stop and explain it to the user and ask for confirmation. **Only write `major` after the user has explicitly agreed.** Otherwise default to `minor` (and fall back to `patch` if `minor` is unclear). See the "Hard rule: confirm with the user before writing `major`" section in `.agents/skills/gen-changesets/SKILL.md` for details.
- Do not commit throwaway scratch or exploratory files. Never stage:
  - Agent working notes or handoff/summary documents (e.g. `HANDOVER-*.md`, `HANDOFF-*.md`, `handoff.md`).
  - Throwaway UI/UX prototypes or design mockups (e.g. `*-designs.html`, `*-mockup.html`, `*-demo(s).html`) at the repo root or under a `design/` folder. The only tracked `.html` files should be Vite `index.html` entrypoints.
  Before committing or opening a PR, run `git status` and `git diff --staged --stat` and remove anything matching these patterns. Put scratch work under `.tmp/` (gitignored) instead of the repo root or the source tree.

## CI Pipeline

CI runs on `.github/workflows/ci.yml` for every PR and push to `main`:

1. **build** — `pnpm install --frozen-lockfile` + `pnpm build` + CLI smoke test.
2. **test** — `pnpm test` (vitest).
3. **test-pi-tui** — `pnpm --filter @moonshot-ai/pi-tui test` (node --test, separate job).
4. **lint** — `pnpm lint` (oxlint) + `pnpm sherif`.
5. **typecheck** — uses `tsgo` (TypeScript native preview) for `packages/*/tsconfig.json` and `apps/kimi-code/tsconfig.json`; `vue-tsc` for kimi-web; per-package typecheck for vis.
6. **native-tools** — `cargo test` + `cargo build --release` on Windows.

Release pipeline (`.github/workflows/release.yml`) on push to `main`:

1. `changesets/action` creates or updates a release PR.
2. When the release PR is merged, packages are published via npm Trusted Publishing (OIDC, no `NPM_TOKEN`).
3. If `@moonshot-ai/kimi-code` was published, native SEA (Single Executable Application) artifacts are built for all platforms, signed (macOS), and uploaded to the GitHub Release.
4. Desktop (Electron) artifacts are built and signed similarly.
5. Docs are deployed via `docs-deploy.yml`.

## Security Considerations

- Never hardcode secrets (API keys, passwords, tokens). Use environment variables or a secret manager.
- In public text and test data, replace real internal identifiers with neutral placeholders (`example.com`, `YOUR_API_KEY`).
- The server uses a single-instance lock (`acquireLock`); a second start throws `ServerLockedError`.
- All REST responses use a uniform envelope `{ code, msg, data, request_id }` — do not leak sensitive data in error messages.
- Report security issues via `SECURITY.md`, not public issues.
