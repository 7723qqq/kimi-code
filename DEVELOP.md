# Repository-level Agent Guide

Reply in the same language as the user.

This is a TypeScript monorepo built for agent-assisted development. This file is the project's reference: what it is made of and how to build, run, and navigate it. The rules a change must obey live in [`CONVENTIONS.md`](CONVENTIONS.md); the always-loaded entry point is [`AGENTS.md`](AGENTS.md). See "Keeping this documentation honest" at the end for how the three stay from drifting into each other.

## Project Overview

**Kimi Code CLI** is an AI coding agent that runs in the terminal — it can read and edit code, run shell commands, search files, fetch web pages, and choose the next step based on the feedback it receives. It works out of the box with Moonshot AI's Kimi models and can also be configured to use other compatible providers.

- **Author**: Moonshot AI
- **License**: MIT
- **Homepage**: https://github.com/MoonshotAI/kimi-code
- **Version**: `@moonshot-ai/kimi-code` 2.3.1 (the main CLI app — follows upstream)

> **Note**: This repository is a personal experimental fork of MoonshotAI/kimi-code. Not affiliated with Moonshot AI. Use at your own risk — do not submit PRs from this fork to upstream.

### Fork-specific additions vs upstream

- **i18n / Multi-language support** — Complete Chinese-English bilingual support across TUI, CLI, and Web UI. All hardcoded English strings replaced with `t()` calls. Switch locale via the `/settings` dialog (aliased as `/config`), locale selector inside.
- **Team** — Multi-agent discussion and collaboration tool; agents can debate, cross-review, and reach consensus before output.
- **Windows launchers** — `start-native.bat` runs the CLI via `bun run dev:cli` (which delegates to `apps/kimi-code/scripts/dev.mjs`, starting the local plugin-marketplace server first); `start-desktop.bat` builds and launches a locally vendored desktop shell when `apps/kimi-desktop` is present (the shell source is not tracked in this fork).
- **Bun toolchain & packaging** — Bun is both the package manager (hoisted workspace, `bun.lock`) and the sole native-binary packaging engine (`bun build --compile` via `apps/kimi-code/scripts/native/build-bun.mjs`); the former pnpm workspace setup and the Node SEA build chain were retired. Install, build, lint, typecheck, the native build pipeline, and the test suites (`bun run test`) all run on Bun, and no CI job installs Node; the Nix build path (`flake.nix`, `nix-build.yml`) still requires Node. Self-update remains engine-aware for legacy SEA installs.
- **DeepSeek Harness capability fusion** — Selected capabilities ported from [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) (MIT): subagent delegation-depth accounting (`session/agentLifecycle/subagentMetadata.ts`), the eval-mode code-runtime worker (`features/codeRuntime/codeWorkerSource.ts`), and the session-query record types (`features/sessionQuery/types.ts`). Ported modules carry a source note in their header; capability selection and comparison notes live in the session report.

> For a user-facing summary of these additions, see `README.md` → "What's Different in This Fork" (and its Chinese mirror `README.zh-CN.md` → "本 Fork 新增特性").

---

## Instruction Ownership and Precedence

Three project files carry agent guidance, and each owns one job. Only the first is injected into a session automatically.

| File | Injected automatically | Owns |
| --- | --- | --- |
| `AGENTS.md` | Yes, as `${agents_md}` | The entry pointer and the hard constraints every task needs. Keep it short — every line is a per-turn cost. |
| `DEVELOP.md` (this file) | No — read on demand | Project facts: structure, packages, commands, gates, ownership maps, and the `specs/` convention. |
| `CONVENTIONS.md` | No — read on demand | The rules a change must obey: style, i18n, testing, workflow, review. |

Precedence when they disagree: `DEVELOP.md` and `CONVENTIONS.md` describe the same repository and must not contradict each other; when a document is stale, the code wins and the document is fixed in the same change. A subdirectory `DEVELOP.md` narrows this file for its subtree; it cannot widen permissions or override the runtime system prompt.

User-level global instructions (`~/.kimi-code/AGENTS.md`) and a local `SYSTEM.md` override are separate surfaces: they belong to the user, are never committed here, and are not part of any repository fixture. The runtime composition is the authority for both — `packages/agent-core-v2/src/app/agentProfileCatalog/behaviorContract.ts` owns the six core behavior rules, and `profile-shared.ts` decides what each profile receives in the system prompt, in a reminder, or intentionally omits.

---

## Technology Stack

### Languages & Runtimes

| Layer | Technology |
|-------|-----------|
| Primary language | **TypeScript** 6.0.2 (strict mode) |
| Module system | ESM (`"type": "module"` in every package) |
| Dev runtime | **Bun** >= 1.4 — install, build, lint, typecheck, and the test suites (`bun run test`) all run through bun |
| Published CLI runtime | **Bun** >= 1.4.0 (`engines` floor of the published package) |
| Web UI (peer) | **Vue 3** + **Vite** |
| VS Code extension | **React 19** + **TailwindCSS 4** + **shadcn/ui** |

### Package Management & Build

| Tool | Purpose |
|------|---------|
| **Bun** >= 1.4 | Package manager and script runner (hoisted workspace via root package.json; `bun.lock` is the lockfile). Also compiles the release binary (`build-bun.mjs`) |
| **tsdown** 0.22.0 | ESM bundler for TypeScript packages |
| **vite** 6.x | Web app bundler (vis-web, vscode webview) |
| **Nix flake** | Reproducible builds for Linux/macOS |

### Quality Tooling

| Tool | Purpose |
|------|---------|
| **oxlint** 1.59.0 | Linter — correctness (error), suspicious (warn), pedantic (warn), perf (warn) |
| **oxfmt** | Formatter — 100 print width, single quotes, trailing commas, sorted imports |
| **bun:test** (Bun 1.4.2) | Test runner and coverage (`bun test --coverage`, lcov) |
| **simple-git-hooks** | Pre-commit hooks (runs `lint-staged`) |
| **lint-staged** | Lint staged files with `oxlint --quiet` + `oxlint --type-aware --quiet` |
| **changesets** | Version management and changelog generation |
| **sherif** 1.11.1 | Monorepo correctness checker |
| **publint** + **attw** | Package publishing lint and type-checking |
| **tsgo** (TypeScript native-preview) | CI typechecking |

---

## Project Structure

### Apps

```
apps/
  kimi-code/        — Main CLI / TUI application (entry point, incl. dist-web web bundle)
  vscode/           — VS Code extension (React 19 webview)
  kimi-inspect/     — Web inspector for kap-server /api/v1/debug RPC surface
  vis/              — Session replay & debugging visualizer
```

#### `apps/kimi-code` — CLI / TUI Application

The main application. Consumes core capabilities through `@moonshot-ai/kimi-code-sdk` and must **not** depend directly on `@moonshot-ai/agent-core-v2` outside the `cli/v2` runner. When writing or modifying its terminal UI, use the `write-tui` skill (`.agents/skills/write-tui/SKILL.md`).

**Source layout:**

```
src/
  main.ts             — Entry point
  cli/                — CLI mode (headless)
    commands.ts       — CLI command definitions
    options.ts        — CLI option parsing
    sub/              — Subcommands (acp, doctor, export, fork, install-desktop, login, provider, session, upgrade, vis, web)
    v2/               — V2 command implementation
    update/           — Self-update mechanism
  tui/                — Terminal UI mode
    kimi-tui.ts       — TUI initialization and main loop
    config.ts         — TUI configuration
    banner/           — Startup banner
    commands/         — Slash command handlers (46 commands)
    components/       — UI components (panes, messages, dialogs, editor, media)
    controllers/      — UI controllers (auth-flow, session, streaming, keyboard, etc.)
    theme/            — Theme system
    reverse-rpc/      — Reverse RPC for ACP communication
  i18n/               — Localization setup
  native/             — Native module integration
  migration/          — Data migration
  feedback/           — User feedback collection
  utils/              — Shared utilities
  constant/           — Constants
  generated/          — Generated asset references
```

**CLI subcommands:** `acp`, `doctor`, `export`, `fork`, `install-desktop`, `login`, `migrate`, `provider`, `session`, `upgrade`, `vis`, `web` (plus the hidden `install-app`, `__update_download`, and `__plugin_run_node`)

**TUI slash commands (46 built-in, see `src/tui/commands/registry.ts`):** `yolo`, `auto`, `permission`, `settings`, `plan`, `spec`, `swarm`, `team`, `workflow`, `tower`, `model`, `secondary-model`, `effort`, `provider`, `btw`, `help`, `new`, `sessions`, `tasks`, `mcp`, `plugins`, `add-dir`, `experiments`, `reload`, `reload-tui`, `compact`, `goal`, `init`, `fork`, `title`, `usage`, `status`, `feedback`, `undo`, `editor`, `theme`, `logout`, `login`, `export-md`, `export-debug-zip`, `copy`, `web`, `desktop`, `remote-control`, `exit`, `version`

**Build output:**
| Output | Path |
|--------|------|
| CLI entry (ESM) | `apps/kimi-code/dist/main.mjs` |
| Web UI assets | `apps/kimi-code/dist-web/` |
| Native prebuilds | `apps/kimi-code/native/` |
| Native binary (Bun single-file) | `apps/kimi-code/dist-native/bin/` |

#### Web UI (`apps/kimi-code/dist-web`)

The shipped `apps/kimi-code/dist-web` bundle is a committed, prebuilt bundle synced from the code-app repo. To hack on the web UI against this repo's server, run `bun run dev:server` here and point the web UI dev server at it via `KIMI_SERVER_URL`.

**Sync convention: replace, never overlay.** A Vite build emits content-hashed filenames, so copying a new bundle over the old one leaves every previous generation behind — the directory once accumulated 616 files / 44 MB across a dozen stale entry chunks, and nothing in the repo detected it because `scripts/check-web-assets.mjs` only verifies that the assets `index.html` names still exist. Delete `apps/kimi-code/dist-web/` first, then copy the fresh bundle in, then commit; the diff should show the old generation removed, not merely a new one added. To audit an existing directory, walk reachability from `index.html` (and `boot.js`) and delete what the walk cannot reach — a reference *count* is not enough, since a whole dead generation cross-references itself.

#### `apps/vscode` — VS Code Extension

Full-featured VS Code extension (`kimi-code` in marketplace). React 19 webview UI with TailwindCSS 4, communicates with the main kimi-code server over local REST/WS.

Key contributions:
- Sidebar webview panel
- Commands: `kimi.focusInput`, `kimi.insertMention`, `kimi.newConversation`, `kimi.showLogs`, etc.
- Settings: `kimi.yoloMode`, `kimi.autosave`, `kimi.editorContext`, etc.
- Packaging: vsix via `@vscode/vsce`, published to both VS Code Marketplace and OpenVSX

#### `apps/kimi-inspect` — Web Inspector

Web inspector for the kap-server `/api/v1/debug` RPC surface. Workspace/session browser, per-session chat, and Service panels. React 19 + Vite. Built on a `ProxyChannel` model similar to VS Code.

#### `apps/vis` — Session Visualizer

Debug visualization tool for kimi-code sessions. Composed of `vis/server` (backend) and `vis/web` (frontend). Sessions and replays can be inspected via a web UI.

### Packages

```
packages/
  acp-server/          — Agent Client Protocol (ACP) host over the v2 engine
  agent-core-v2/       — Agent engine v2 (DI × Scope architecture)
  i18n/                — Shared i18n infrastructure (t() with en/zh support)
  i18n-shared/         — Shared i18n core (types, locale detection, web-safe)
  kap-server/          — Kimi Code local server (REST + WebSocket)
  klient/              — Client SDK (contract-driven facade over agent-core-v2)
  kosong/              — Frozen legacy LLM / provider kernel (published SDK + oauth only)
  migration-legacy/    — Data migration from kimi-cli (~/.kimi/) to kimi-code (~/.kimi-code/)
  minidb/              — Embedded JSON document store (snapshot + WAL, full-text index)
  node-sdk/            — Public TypeScript SDK (@moonshot-ai/kimi-code-sdk)
  oauth/               — Kimi OAuth and managed auth utilities
  pi-tui/              — Terminal UI framework (upstream dependency, bun:test suite)
  remote-control/      — Kimi Remote Control tunnel client (relay registration + HTTP/WS forwarding)
  telemetry/           — Shared client-side telemetry infrastructure
  transcript/          — Isomorphic transcript rendering data layer
  tree-sitter-bash/    — Pure-TypeScript bash parser (deterministic budget)
```

#### Key Package Details

**`agent-core-v2`** (v0.4.3) — Next-gen agent engine with DI × Scope architecture. Service interfaces, DI containers, scope-bound session management. Consumed by `kap-server` and `klient`. Includes dependency graph analysis, domain layer linting, and contract type generation scripts.

  - **Three** `LifecycleScope` tiers — `App` / `Session` / `Agent` (`app/scopes.ts`, mirrored in `SCOPE_TOPOLOGY`). `Workspace` is a **directory namespace prefix** inside the engine (`app/workspaceLifecycle/`, `app/workspaceSessions/`), **not** a fourth tier: there is no `LifecycleScope.Workspace`, and adding one is not a valid change.
  - There is no App-level session lifecycle facade. Callers compose `ISessionIndex` → `IWorkspaceLifecycleService.handlerFor` → the handler.

**`kosong`** (v0.5.6) — The frozen legacy LLM / provider kernel. Owns the contract types (`Message` / `ChatProvider` / `Tool` / `TokenUsage` / `ModelCapability`), the coded-error infrastructure (`Error2` + provider error taxonomy), and the pure-function layer (`generate()`, token estimation, error classification, provider wire helpers). It is retained for the published SDK and `oauth`; `agent-core-v2` **does not import it** — provider and request code lives in `packages/agent-core-v2/src/human/llm/`, and the v2 compatibility boundary is `packages/agent-core-v2/src/llm-adapter/`. The import path is rejected outright by `packages/agent-core-v2/scripts/check-import-boundaries.mjs`; see `docs/en/llm.md` for the layering rules. Because both packages carry a copy of the wire rules, `packages/kosong/test/cache-field-parity.test.ts` is the only thing keeping the two copies honest. Supports Anthropic, Google Gemini, and OpenAI-compatible providers. Uses `zod-to-json-schema` for tool schema conversion.

**`klient`** (v0.1.2) — Client SDK. A contract-driven facade over agent-core-v2 with aggregated `global.*` / `session(id).*` / `agent(id).*` methods, zod validation on every call, and transport abstraction (ipc or memory). Also hosts e2e suites.

**`kap-server`** — The Kimi Code local server. Backed by DI × Scope agent engine. Exposes sessions over REST + WebSocket (`/api/v1` + `/api/v1/ws`). Debug surface at `/api/v1/debug/*`. Bootstrapped from `src/start.ts`.

**`transcript`** (v0.0.2) — Isomorphic transcript rendering data layer. Pure TypeScript (browser-safe). Agent-granular L1 store, idempotent L2 operations, granularity-gated L3 subscriptions (`off/turn/block/delta`), framework-free L4 view registry. Owns all transcript contract types in `src/contract/`.

**`minidb`** (v0.2.0) — Pure-Node.js embedded key-value database. Combines Redis-style in-memory KV with SQLite-style WAL + snapshot persistence. Includes cluster support.

**`node-sdk`** — Public SDK, and the one package whose `tsconfig.json` deliberately differs from what its compiler and bundler read. Its `#/*` subpath imports are resolved by Bun from `compilerOptions.paths` (Bun does not honour `package.json#imports` here), so the package tsconfig keeps them for the test run. A project-wide alias also captures the `#/*` specifiers inside the `agent-core-v2` sources this package pulls in, so both readers that see those sources use a view with an empty `paths`: `tsconfig.build.json` for `tsdown`, `tsconfig.typecheck.json` for `tsc`, and `tsconfig.dts.json` for the declaration build.

### Plugins

```
plugins/
  marketplace.json   — Plugin marketplace manifest
  official/          — Official plugins
  cdn/               — CDN-distributed plugins (gitignored)
```

### Scripts

```
scripts/
  check-locale-keys.mjs          — Check locale key coverage
  check-locale-placeholders.cjs  — Validate i18n placeholder consistency
  check-no-hardcoded-prose.mjs   — Fail on prose literals outside t() (shrink-only ledger)
  check-nix-workspace.mjs        — Validate flake.nix vs workspace membership
  check-no-comments.mjs          — Enforce no-comment policy (agent-core-v2, kap-server, transcript)
  check-service-naming.mjs       — Check service naming conventions
  no-hardcoded-prose-baseline.txt — accepted-literals ledger (path, count, digest)
  check-t-call-coverage.mjs      — Check t() call coverage and engine error-code localization
  gen-error-locale-skeleton.mjs  — Scaffold missing errorCodes.* locale entries
  measure-image-tokens.cjs       — Recalibrate the image-token formula against a live endpoint
  scan-hardcoded-v2.mjs          — Scan for hardcoded strings (i18n compliance)
  prompt-optimizer/              — Prompt benchmark and optimization tools
```

Each of these has a root script, and the root script names are the `check:*` form
(`check:t-coverage`, `check:locale-keys`, …). `check:no-comments`,
`check:locale-placeholders`, `check:no-hardcoded-prose`, `check:t-coverage`,
`check:locale-keys`, `check:status-surface-i18n`, `check:service-naming` and
`tools/review/check-catalog-versions.mjs` run in CI's `lint` job; `check:nix-workspace`
runs in the Nix workflow. By hand: `scan:hardcoded` (finds a source literal that already
exists in a locale file) and `measure:image-tokens` (needs a live endpoint).

### Structural review (`tools/review`)

`tools/review` is a small Zig program that reads the repository itself rather than
running the test suite. It answers questions a test cannot: whether a documented
gate is actually wired up, whether a workspace member's tests ever run, whether a
generated file drifted from its source. It runs in CI as the `review` job and takes
about 7 s over the whole monorepo.

```
tools/review/
  src/checks/                   — one file per check
  src/paths.zig                 — the shared directory and file classification
  dangling-refs-baseline.txt    — accepted findings, one per line
  orphan-exports-baseline.txt   — accepted findings, one per line
  scripts-wiring-baseline.txt   — accepted findings, one per line
  silent-catch-baseline.txt     — accepted findings, one per line
  text-as-protocol-baseline.txt — accepted text matches, one `path  count` per file
  upstream-drift-allow.txt      — deliberate deletions relative to upstream/main
```

`tools/review/check-strict-request-bodies.mjs` is the gate for "an unknown input must
produce a signal" at the HTTP boundary: a route `body` schema that is not `.strict()`
silently strips an unrecognized key, so a client's typo comes back as `code: 0`. It walks
`packages/kap-server/src/routes` for `body: <Schema>` references and checks the declared
schema (brace-counted, so a nested `.superRefine` block does not end the match early). It
runs in CI's `lint` job.

`tools/review/check-catalog-versions.mjs` is the one gate that lives beside the Zig
sources rather than in `scripts/`: it reports a package that repeats a range the workspace
catalog already pins instead of writing `catalog:`. It runs in CI's `lint` job.

`text-as-protocol` is the check that keeps the i18n rules enforceable: it fails on
`value === 'Sentence-shaped text'` comparisons, which are how message copy silently
becomes an interface between layers (and the first thing to break under translation).
That form ships with zero accepted findings — a new comparison is a design decision,
not debt, so it has no baseline entries. The second form it reports,
`value.startsWith('Sentence here')` and its `includes`/`endsWith`/`indexOf` siblings,
is a warning against `text-as-protocol-baseline.txt`: a few of those legitimately match
text this repository does not author (git's `HEAD (no branch)`, ripgrep's `os error 11`,
an HTTP `Bearer ` prefix), and suppressing them by name keeps the ones that do cross a
layer boundary visible.

```bash
cd tools/review && zig build          # needs Zig 0.17 (the devShell provides it)
./tools/review/zig-out/bin/review     # run every check; exits 1 on any error
./tools/review/zig-out/bin/review --list
./tools/review/zig-out/bin/review --check=orphan-exports
./tools/review/zig-out/bin/review --json
```

| Check | Reports |
| --- | --- |
| `gate-wiring` | A doc claims a script runs under a runner that does not invoke it; a hook directory nothing executes |
| `ci-coverage` | A workspace member whose tests or typecheck no CI job runs |
| `stale-artifacts` | A committed generated file the generator rewrites |
| `upstream-drift` | A file upstream carries that this branch dropped; listed deletions go in `upstream-drift-allow.txt` |
| `orphan-exports` | An exported function only its own test calls |
| `silent-catch` | A file with more bare `catch {}` blocks than its baseline allows |
| `workflow-triggers` | A CI job the docs list that no pull request ever runs |
| `dangling-refs` | A tool name in a `*TOOLS` list that no tool registers |
| `scripts-wiring` | A package script nothing invokes |

Findings at `error` severity fail the run; `warn` and `info` do not. The four
baseline ledgers (`dangling-refs-`, `orphan-exports-`, `scripts-wiring-`,
`silent-catch-baseline.txt`) record findings someone has already looked at: a
finding listed there is suppressed, and an entry that stops matching anything is
reported so the ledger cannot rot. Regenerate one with `--check=<name> --json`.

### A check that cannot run says so

A check whose input is missing reports what it could not do instead of returning
quietly. An unrun gate and a passing gate look identical otherwise, which is the
failure this tool exists to catch, so a checkout with no `upstream` remote, a tree
that is not a git repository, or a `package.json` that cannot be read each produce
an `info` finding naming the reason and the fix. These never fail CI — but they are
never absent from the report either.

To add a check, drop a file in `src/checks/`, export `run(ctx: *check.Context)`,
and register it in `src/checks.zig`. `zig build test` covers every module listed in
the `test` block of `src/main.zig` — add the new file there too, or its tests will
not run. Reach for `src/paths.zig` rather than writing another copy of the
vendor-directory list or a file classifier: the checks ask subtly different
questions ("is this production source", "does this count as a test"), and the
predicates live there so the difference is named instead of accidental.

`stale-artifacts` runs each generator and diffs `git status` before and after, so it
reports only the files that generator rewrote. Adding a generator means giving it
the `cwd` its script expects — `bun run` resolves relative to the package — and a
`marker` that names its output's exact path.

---

## Environment Requirements

- **Bun**: `>= 1.4` — required. Package manager, script runner, and dev-toolchain runtime (`bun.lock` is the lockfile, specified via `bunVersion` in `flake.nix`); build, lint, typecheck, locale checks, and the test suites (`bun run test`) all run through bun.
- **Node.js**: not required for the Bun-based dev workflow — build, lint, typecheck, the native pipeline, and the test suites all run under Bun (pi-tui's bun:test suite included), and no CI job installs Node. The Nix build path is the exception: `flake.nix` pins `minNodeVersion = "24.15.0"` and fails evaluation below it, keeps `nodejs` in the derivation's `nativeBuildInputs` and the devShell, and runs `node apps/kimi-code/scripts/check-web-assets.mjs` as a build step, so `nix-build.yml` needs Node on every PR.
- **Published package engines**: the published package declares `"bun": ">=1.4.0"` — the same floor the dev toolchain requires.
- **Git for Windows** (Windows only): Optional; used as the POSIX shell fallback when PowerShell is unavailable. Set `KIMI_SHELL_PATH` to pin a specific shell.

---

## Build & Test Commands

### Root-level commands

```sh
bun install                   # Install all dependencies
bun run build                 # Build all workspace packages
bun run build:packages        # Build only packages/*
bun run dev:cli               # Run the CLI in dev mode; delegates to
                              # apps/kimi-code/scripts/dev.mjs (starts a local plugin
                              # marketplace server, then runs the CLI). This is the
                              # path `start-native.bat` uses.
bun run dev:local              # Run the CLI from a fresh bundle (works; incremental, ~2s)
bun run dev:local:watch       # Same, rebuilding and re-running on every source change
bun run dev:server            # Run server in dev mode
bun run test                  # Every package suite (CI scope; see Testing Rules)
bun run test:watch            # Watch mode
bun run test:coverage         # With coverage
bun run typecheck             # TypeScript check (builds packages first)
bun run lint                  # oxlint --type-aware
bun run lint:fix              # Auto-fix
bun run sherif                # Monorepo correctness check
bun run clean                 # Clean all dist directories
bun run gen:manifests         # Regenerate the agent-core-v2 config/wire/state manifests
bun run check:deep-imports    # Engine import-boundary checks
bun run check:boundaries      # Engine import boundaries + deep-import lint
bun run changeset             # Generate a changeset
bun run version               # Apply changesets (bump versions)
bun run publish               # Full publish pipeline
```

### Makefile targets

```sh
make prepare          # bun install
make build            # bun run build
make typecheck        # Full typecheck
make lint             # oxlint
make test             # bun test --isolate in every package
```

### Package-specific commands

```sh
# CLI app
cd apps/kimi-code && bun run build
cd apps/kimi-code && bun run dev
bun test --isolate test/cli                 # CLI tests only
cd apps/kimi-code && bun run e2e     # E2E tests (sets KIMI_E2E=1)
# `cd apps/kimi-code && bun run test` is not scoped: it builds every package
# (`build:packages`) and then runs the whole workspace suite.

# Native binary packaging
bun run build:native:bun:release  # Full release build (from apps/kimi-code)

# VS Code extension
cd apps/vscode && bun run build
cd apps/vscode && bun run test
cd apps/vscode && bun run package:platform     # Produce .vsix
```

To run a local build inside `~/.kimi-code/` instead of the released binary (PowerShell on Windows, bash on Linux), see [`CONTRIBUTING.md` → "Deploy to local `.kimi-code` for testing"](CONTRIBUTING.md#deploy-to-local-kimi-code-for-testing).

### CI pipeline

GitHub Actions (`ci.yml`) runs on every PR and push to `main`. Every job installs Bun via `oven-sh/setup-bun`; no job installs Node:
1. **build** — Install, build, smoke test CLI bundle
2. **test** — `bun run test --shard=N/5` split across 5 parallel Ubuntu shards; Bun's native `--shard` is forwarded to every package suite, and no job installs Node
3. **lint** — `bun run lint` (oxlint --type-aware), `bun run sherif`, engine boundaries (`check:deep-imports`, then `check:boundaries`), locale key parity (`check-locale-keys.mjs`), locale placeholder validity (`check-locale-placeholders.cjs`), and `t()` call-site coverage (`check-t-call-coverage.mjs`)
4. **typecheck** — TypeScript check across all packages (`tsgo` from `@typescript/native-preview`, run via `bunx --bun`)
5. **review** — `zig build` and `zig build test` in `tools/review` (Zig installed via
   `mlugg/setup-zig`), then the structural checks described under "Structural review" above

`ci.yml` also carries a `test-windows` job (the full suite on Windows). It is parked with `if: false` while Windows tests are stabilized, so it is not part of the pre-merge pipeline.

One more job runs outside `ci.yml`. **native bundle** is built by `_native-build.yml` (a `workflow_call` workflow invoked from `release.yml` and `manual-native-bundle.yml`) on a 6-target matrix (linux-x64, linux-arm64, darwin-x64, darwin-arm64, win32-x64, win32-arm64): Bun single-file packaging (`build:native:bun`) followed by a native smoke test. **codeql** (`codeql.yml`) scans js/ts on pushes to `main` and on a weekly schedule; a branch ruleset requires CodeQL results (plus blocks force pushes and branch deletion) for merges into `main`.

Additional workflows: `_native-build.yml`, `codeql.yml`, `docs-deploy.yml`, `manual-native-bundle.yml`, `nix-build.yml`, `pkg-pr-new.yml`, `pr-title-checker.yml`, `release-native.yml`, `release.yml`, `vscode-publish.yml`.

### Release flow (fork)

Pushes to `main` run `release.yml`, which installs, builds all workspace packages, and builds the built-in catalog. The `changesets/action@v1` step is **commented out on this fork** (this fork follows upstream versions and never publishes to npm independently), so no "ci: release packages" PR is opened or updated and nothing is published; the `release` job's `packages_published` / `kimi_native_release` outputs are permanently empty, and the downstream jobs gated on them never run. Re-enable the step when a standalone release is needed. See CONTRIBUTING → "Release flow on this fork".

### Native release

`release-native.yml` publishes the CLI binaries. It runs on a push of a version tag (`v2.1.1` or `@moonshot-ai/kimi-code@2.1.1`), or manually via `workflow_dispatch` with an existing tag. It resolves and validates the tag, invokes `_native-build.yml` for all six targets, then aggregates the per-target `.zip`/`.sha256` artifacts into `manifest.json` and creates the GitHub Release. Publishing is gated on three checks that fail the run rather than ship a bad release: `apps/kimi-code/package.json` must match the tag's version, every archive must pass `sha256sum -c` against its own checksum file, and `manifest.json` must carry all six targets. The release body is the matching section of `apps/kimi-code/CHANGELOG.md`, falling back to a generic body when the section is absent.

The macOS and Windows signing steps degrade safely when their secrets are unset: `_native-build.yml` warns and builds the unsigned local profile. Note that its `windows-2025-vs2026` runner label is only offered on **public** repositories — if this repo is ever made private, `win32-x64` needs a label from the private-runner table.

### Nix build maintenance

`nix-build.yml` builds the CLI in a pure sandbox. Dependencies come from the `bunDeps` fixed-output derivation in `flake.nix` (the hoisted `node_modules` tree). After changing `bun.lock`, expect one hash-mismatch round: set `outputHash` to `lib.fakeSha256`, push, then paste the `got:` hash (the nix-build bot posts it on PRs). Sandbox quirks: no `/usr/bin/env` (invoke a package's JS entry through `node <js-entry>` instead of its bin shim), and FOD outputs must not contain store paths. See CONTRIBUTING → "Nix build".

---

## Testing Instructions

> Rules that govern *how* tests are written live in [`CONVENTIONS.md` → Testing Rules](CONVENTIONS.md#testing-rules). This section covers how to run them.

### Test Framework

- **`bun:test`** for every TypeScript/JavaScript suite in the workspace, run through each package's own `bun test`. Bun 1.4.2 is both the runtime and the runner; the repository no longer contains a vitest dependency or config.
- Each package's `bunfig.toml` supplies `[test] preload` (setup modules) and `pathIgnorePatterns` (the heavy/e2e set). A CLI `--path-ignore-patterns` overrides the file, which is how the heavy scripts opt back in.
- Every package `test` script passes `--isolate`: each test file gets a fresh global and module registry, which is what keeps `mock.module` registrations from leaking into the next file.
- **`--timeout` is the only knob that reaches hooks.** Bun 1.4.2 applies `bunfig.toml`'s `[test] timeout` to test bodies only; a `beforeEach` that builds a real `git` fixture still dies at the built-in 5s. Every package script therefore passes a CLI `--timeout` (30s in `agent-core-v2`/`kimi-code`/`minidb`, 15s in `kap-server`). On a Windows host the first external spawn in a process also costs a one-off ~3s, which lands inside whichever hook spawns first.
- **Platform gates are runtime probes, not platform branches.** A case that needs a capability the host may lack — creating a symlink (`EPERM` on Windows without Developer Mode), executing a `#!/usr/bin/env` fixture — probes the capability and skips visibly instead of failing, so the case still runs on a host that has it. Cases that pin a byte-for-byte POSIX prompt (the `fullCompaction` golden) are gated to Linux, because the expected bytes contain POSIX paths and `ls` output. One case — `mcpCore/oauth/service-lifecycle.test.ts` → "detaches a joined caller…" — is gated to non-Windows because Bun 1.4.2 segfaults on Windows when it follows the single-flight refresh case; every case in that file passes when run alone, so the fault is in the runtime, not the fixture.
- **Coverage**: `bun test --coverage` (lcov reporter), per package.

### Test layout

There is no root test config. `scripts/run-tests.mjs` walks `packages/*`, `apps/*` and `apps/vis/*` and, for every package that declares a `test` script, runs `bun run test` **inside that package** so the package's own `bunfig.toml` applies. `--shard`, `--timeout`, `--coverage*`, `--bail`, `--test-name-pattern` and `--randomize` are forwarded to every package; `--include-heavy` adds `--path-ignore-patterns=**/node_modules/**` so the heavy/e2e sets run too.

### Running tests

Pick the narrowest scope that can catch a regression from the change; the rule that
decides when to widen it lives in [`CONVENTIONS.md` → Testing Rules](CONVENTIONS.md#testing-rules).

```sh
# Default: the change lives in one package
(cd packages/<package> && bun test --isolate <test-file…>)       # Only the affected files
(cd packages/<package> && bun run test)                          # That package's own suite
(cd packages/<package> && bun test --test-name-pattern <regex>)  # One test by name

# Escalated: every package suite — this is the CI scope
bun run test                  # All package suites, one package at a time
bun run test:watch            # Every package's watcher, concurrently
bun run test:coverage         # With an lcov coverage report per package
bun run test:minidb           # minidb only — see below
bun run test:heavy            # Includes the heavy/e2e sets (KIMI_TEST_HEAVY=1, KIMI_E2E=1)
```

`minidb`'s `bunfig.toml` ignores `test/e2e/**`, `test/cluster/**` and `test/bench-json.test.ts` for
speed; `bun run test:heavy` — or `bun test --isolate --path-ignore-patterns='**/node_modules/**'`
inside the package — runs them.

`agent-core-v2` ignores its real-I/O suites the same way: the four tower suites
(`test/features/tower/store.test.ts`, `towerService.test.ts`,
`tools/towerTools.test.ts`, `tools/spawnTool.test.ts` — each case drives a real
`git init`/`worktree`/`merge` subprocess; measured at 2-way, 94–119 s per file)
and `test/app/git/gitService.test.ts` (a `git` subprocess per assertion — 198 cases
measured at 214s) and `test/mcpCore/{connection-manager,client-stdio}.test.ts`
(a spawned runtime and a connection timeout per case). A process spawn costs ~65ms
warm and up to ~3s cold on Windows, so any suite whose cases each drive git or a
child process belongs in the heavy set rather than in the default run. The CI
`test-heavy` job covers all of them.

### Test file conventions

- Test files co-locate with source or in a `test/` directory under each package/app.
- Patterns: `*.test.ts`, `*.test.tsx`, `*.spec.ts`, `*.spec.tsx`, `test/**/*.ts`
- E2E tests live in `apps/kimi-code/test/e2e/` and require `KIMI_E2E=1` env.

---

## Prompt Assets and the Prompt Optimizer

### Ownership

A prompt rule has exactly one owner; templates and project files reference it instead of restating it.

| Concern | Owner |
| --- | --- |
| The six core behavior rules (`authority_and_untrusted_content`, `act_and_verify`, `tools_and_repository_context`, `safety_and_scope`, `failure_and_partial_progress`, `communication`) | `packages/agent-core-v2/src/app/agentProfileCatalog/behaviorContract.ts` |
| Full-profile expression (all six clauses plus runtime sections) | `packages/agent-core-v2/src/app/agentProfileCatalog/system.md` |
| Minimal-profile expression (persona, cwd, the two core clauses, a stable handoff marker) | `packages/agent-core-v2/src/app/agentProfileCatalog/system.minimal.md` |
| Profile selection, delivery metadata (`system` / `reminder` / `intentionally_omitted`), unresolved-variable warnings | `packages/agent-core-v2/src/app/agentProfileCatalog/profile-shared.ts` |
| DeepSeek reminder content (delegated clauses, curated body, provenance) | `packages/agent-core-v2/src/app/agentProfileCatalog/model-adaptations/curated/deepseek.md` through `modelAdaptations.ts` |
| Delivery lifecycle (family gate, cache, one reminder per live context, post-compaction reinjection) | `packages/agent-core-v2/src/features/deepseekAdaptation/deepseekAdaptationService.ts` |
| Project instruction entry (injected) versus on-demand project docs | `AGENTS.md` versus `DEVELOP.md` / `CONVENTIONS.md` |

`bun run check:prompt-ownership` fails when `AGENTS.md` stops linking `DEVELOP.md`, claims the latter is injected, or a core contract id disappears from the module.

### Offline render check

The renderer is pure: it takes an explicit fixture, starts no DI runtime, and reads no user home file.

```sh
cd scripts/prompt-optimizer
bun src/render-fixture.ts --profile full --model kimi-k3-1
bun src/render-fixture.ts --profile deepseek-adapted --model deepseek-v4-pro
```

Both print the profile, the source hash, the contract channels, the token counts and any renderer warning; the DeepSeek profile also prints the reminder size and the contract ids it carries. A non-empty `warnings` list means a `${...}` placeholder survived rendering — fix the fixture or the template, do not treat it as a successful render.

### Optimizer

```sh
cd scripts/prompt-optimizer
bun test                                                    # Offline unit tests, no network
bun src/cli.ts bench --dry-run --profile full --model kimi-k3-1
bun src/cli.ts bench --profile deepseek-adapted --model deepseek-v4-pro   # Real call, needs credentials
```

- The default benchmark input is the **production-rendered** profile, not `system.md`'s raw template. `--compare` with prune variants is the only raw-template experiment, and it is labelled as such.
- `--profile` must match the model: `full` for a full-shape family, `deepseek-adapted` for a minimal-shape family with a curated adaptation. A mismatch is a named error, never a silent template fallback.
- `--dry-run`, renderer warnings, missing credentials and provider failures all produce `effectivenessVerdict: "unavailable"` in the report. Only a completed real run may report an effect.
- Sending the user's own global instructions is opt-in: `--actual-global C:/Users/Administrator/.kimi-code/AGENTS.md` accepts that one path and fails closed for any other. The content is sent only to the configured provider, never written to reports, logs, or the repository.

Personal global prompt changes (`~/.kimi-code/AGENTS.md`) are local to the machine: they are never committed, never copied into a fixture, and never part of a report.

---

## Security Considerations

### Security Policy (see `SECURITY.md`)

- Only the latest released version receives security support.
- Report vulnerabilities via GitHub Security Advisories or email `code@moonshot.ai` with `[security]` in subject.
- Do not open public issues for security vulnerabilities.

### Hardened Dependencies

The monorepo enforces safe minimum versions for known-vulnerable packages via `overrides` in the root `package.json`:
- `undici >= 7.28.0`, `shell-quote >= 1.8.4`, `dompurify >= 3.4.12`
- `tar >= 7.5.22`, `fast-uri >= 3.1.1`, `serialize-javascript >= 7.0.3`
- `hono >= 4.12.18`, `body-parser >= 2.3.0`, `ws >= 8.21.0`
- `js-yaml >= 4.2.0`, `vite >= 6.4.3`, `postcss >= 8.5.18`

### CI Security Checks

- Secret scanning via GitHub's built-in scan
- The `pkg-pr-new.yml` workflow publishes preview packages from PRs
- PR titles are enforced via `pr-title-checker.yml`

---

## Monorepo Workspace Maintenance

- **The `workspaces` field in the root `package.json`** is the source of truth for workspace membership. Globs: `packages/*`, `apps/*`, `apps/vis/server`, `apps/vis/web`, and `docs`.
- **`flake.nix`** also contains a hardcoded `workspacePaths` list that must be manually kept in sync.
- **Whenever you add or remove a workspace package, you MUST update both the root `package.json` and `flake.nix`** — for every package, including leaf / test / e2e packages that nothing depends on.
  - Missing a path in `flake.nix`'s `workspacePaths` silently drops files from the Nix build's `src` fileset.
- **The automated check script** (`scripts/check-nix-workspace.mjs`) only validates the transitive dependency **closure of `@moonshot-ai/kimi-code`**. A leaf package outside that closure slips through. Do not rely on the check to catch omissions.

---

## Version Management (Changesets)

- **This fork follows upstream versions.** Package `version` fields in `package.json` must stay identical to `upstream/main` — never run `bun run version` or `bun run publish` here, and never bump versions independently. When merging upstream releases, take their `package.json` version changes as-is.
- Fork-only packages that do not exist upstream (`@moonshot-ai/i18n`, `@moonshot-ai/i18n-shared`) keep their own versions; do not bump them either unless a fork-specific release is explicitly requested.
- Changesets are maintained **as a changelog source only**: keep writing them for user-facing changes so release notes stay available, but they are not consumed by a local release flow. Before merging upstream, prune accumulated non-user-facing entries (see the `gen-changesets` skill).
- Every PR affecting release artifacts should include a changeset; docs-only, test-only, or CI-only PRs may skip changesets. Generate one with `bun run changeset`.
- **Never** decide on a `major` bump on your own. When a change meets major criteria (breaking changes, incompatible user configuration, renamed/removed commands/arguments, changed behavior semantics), stop and ask the user for confirmation. Default to `minor` (fall back to `patch` if unclear).
- Base branch: `main`
- Ignored from versioning: `@moonshot-ai/vis`, `@moonshot-ai/vis-server`, `@moonshot-ai/vis-web`, `@moonshot-ai/kimi-inspect`

---

## `specs/` — Spec Mode Output

`specs/<id>/` holds the documents **Spec mode** writes (`docs/en/reference/tools.md` → Tools). Spec mode agrees a written contract before any code changes; unlike a plan, which is a per-session scratch file, a spec is committed with the code and read back by later sessions and teammates. This directory does not exist upstream — it is fork-only.

- **A spec is a requirements contract, not a description of current state.** Read it to learn what was wanted and why a decision was made. To judge whether the implementation satisfies it, read the code — never trust a spec's account of the state.
- Version numbers, package names, script names, and commands inside a spec describe a tree that may no longer exist. They are evidence of a past decision, not instructions to follow.
- Lint and the docs gates reach into `specs/`, so prose written there can affect tooling results. Do not put anything in a spec that would fail a repo-wide check.
- Do not edit a shipped spec to make it "current" — it is a record. Write a new one.

---

## Keeping this documentation honest

This file is duplicated from upstream and this fork has diverged from it for thousands of commits, so drifted instructions are a recurring failure mode here rather than an exception. Two things prevent the next round.

### One owner per fact

Every fact lives in exactly one place. Other files link to it; they never restate a second copy. When you change something, update its owner — and only its owner.

| Fact | Owner |
| --- | --- |
| Project structure, packages, scripts, commands, CI, toolchain | this file |
| Coding rules, i18n rules, review rules, changeset rules | [`CONVENTIONS.md`](CONVENTIONS.md) |
| Always-loaded agent instructions | [`AGENTS.md`](AGENTS.md) — a thin pointer, nothing more |
| Contribution policy, PR process | [`CONTRIBUTING.md`](CONTRIBUTING.md) + `CONTRIBUTING.zh-CN.md` |
| User-facing behavior and terminology | `docs/en/` + `docs/zh/`, per [`docs/DEVELOP.md`](docs/DEVELOP.md) |
| Goal-mode internal design | [`GOAL.md`](GOAL.md) |
| Per-package detail | that package's own `DEVELOP.md` / `AGENTS.md` |

### Verify before copying from upstream

When syncing anything from `upstream/main`, re-check every copied fact against **this** branch. The package manager, the package inventory, the script names, the lifecycle tiers, and which packages exist at all all differ here. "Upstream says so" is not a reason to keep it — several instructions in this repo were upstream's and were wrong on arrival. `tools/review`'s `upstream-drift` check watches for *files* deleted relative to upstream; it does not watch for *sentences* that went stale, which is why this section exists.

---
