# Repository-level Agent Guide

Reply in the same language as the user.

This is a TypeScript monorepo built for agent-assisted development. This file is the single source of truth for project-wide knowledge. Keep it focused on the project map, hard constraints, and workflow requirements — things every task needs to know.

## Project Overview

**Kimi Code CLI** is an AI coding agent that runs in the terminal — it can read and edit code, run shell commands, search files, fetch web pages, and choose the next step based on the feedback it receives. It works out of the box with Moonshot AI's Kimi models and can also be configured to use other compatible providers.

- **Author**: Moonshot AI
- **License**: MIT
- **Homepage**: https://github.com/MoonshotAI/kimi-code
- **Version**: `@moonshot-ai/kimi-code` 2.1.1 (the main CLI app)

> **Note**: This repository is a personal experimental fork of MoonshotAI/kimi-code. Not affiliated with Moonshot AI. Use at your own risk — do not submit PRs from this fork to upstream.

### Fork-specific additions vs upstream

- **i18n / Multi-language support** — Complete Chinese-English bilingual support across TUI, CLI, and Web UI. All hardcoded English strings replaced with `t()` calls. Switch locale via the `/settings` dialog (aliased as `/config`), locale selector inside.
- **Team** — Multi-agent discussion and collaboration tool; agents can debate, cross-review, and reach consensus before output.
- **Rust Native Tools** — Performance-critical tools (grep, glob, edit, read, write, bash, token counting, output truncation) rewritten in Rust as a native Node addon, significantly faster than JS.
- **Windows launchers** — `start-native.bat` builds the native Rust tools if needed and launches the CLI in dev mode (`bun run dev:cli`, Bun executing `src/main.ts` directly); `start-desktop.bat` builds and launches a locally vendored desktop shell when `apps/kimi-desktop` is present (the shell source is not tracked in this fork).
- **Bun toolchain & packaging** — Bun is both the package manager (hoisted workspace, `bun.lock`) and the sole native-binary packaging engine (`bun build --compile` via `apps/kimi-code/scripts/native/build-bun.mjs`); the former pnpm workspace setup and the Node SEA build chain were retired. Install, build, lint, typecheck, the native build pipeline, and the vitest suites (`bun --bun run test`) all run on Bun, and no CI job installs Node; the Nix build path (`flake.nix`, `nix-build.yml`) still requires Node. Self-update remains engine-aware for legacy SEA installs.
- **DeepSeek Harness capability fusion** — Selected capabilities ported from [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) (MIT): subagent delegation-depth accounting (`session/agentLifecycle/subagentMetadata.ts`), the eval-mode code-runtime worker (`features/codeRuntime/codeWorkerSource.ts`), and the session-query record types (`features/sessionQuery/types.ts`). Ported modules carry a source note in their header; capability selection and comparison notes live in the session report.

> For a user-facing summary of these additions, see `README.md` → "What's Different in This Fork" (and its Chinese mirror `README.zh-CN.md` → "本 Fork 新增特性").

---

## Technology Stack

### Languages & Runtimes

| Layer | Technology |
|-------|-----------|
| Primary language | **TypeScript** 6.0.2 (strict mode) |
| Module system | ESM (`"type": "module"` in every package) |
| Dev runtime | **Bun** >= 1.4 — install, build, lint, typecheck, and the vitest suites (`bun --bun run test`) all run through bun |
| Published CLI runtime | **Bun** >= 1.4.0 (`engines` floor of the published package) |
| Native code | **Rust** (via napi-rs for Node addon, pure Rust CLI tools) |
| Web UI (peer) | **Vue 3** + **Vite** |
| VS Code extension | **React 19** + **TailwindCSS 4** + **shadcn/ui** |

### Package Management & Build

| Tool | Purpose |
|------|---------|
| **Bun** >= 1.4 | Package manager and script runner (hoisted workspace via root package.json; `bun.lock` is the lockfile). Also compiles the release binary (`build-bun.mjs`) |
| **tsdown** 0.22.0 | ESM bundler for TypeScript packages |
| **vite** 6.x | Web app bundler (kimi-web, vis-web, vscode webview) |
| **Cargo** | Rust build for `kimi-native-tools` and `kimi-agent` (napi-rs) |
| **Nix flake** | Reproducible builds for Linux/macOS |

### Quality Tooling

| Tool | Purpose |
|------|---------|
| **oxlint** 1.59.0 | Linter — correctness (error), suspicious (warn), pedantic (warn), perf (warn) |
| **oxfmt** | Formatter — 100 print width, single quotes, trailing commas, sorted imports |
| **vitest** 4.1.10 | Test runner (v8 coverage provider) |
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
  kimi-web/         — Vue 3 Web UI (fork addition; excluded from the root Bun workspace; standalone Bun install via its own bun.lock)
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

#### Web UI (`apps/kimi-code/dist-web` + `apps/kimi-web`)

The shipped `apps/kimi-code/dist-web` bundle is a committed, prebuilt bundle synced from the code-app repo; the fork also carries its own Vue 3 web UI source in `apps/kimi-web` (excluded from the workspace, see below). To hack on the web UI against this repo's server, run `bun run dev:server` here and point the web UI dev server at it via `KIMI_SERVER_URL`.

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
  kaos/                — Execution environment abstraction (local / ssh / login-shell)
  kap-server/          — Kimi Code local server (REST + WebSocket)
  kimi-agent/          — Rust agent engine (experimental)
  kimi-native-tools/   — Rust native Node addon (napi-rs)
  klient/              — Client SDK (contract-driven facade over agent-core-v2)
  kosong/              — LLM / provider abstraction layer
  migration-legacy/    — Data migration from kimi-cli (~/.kimi/) to kimi-code (~/.kimi-code/)
  minidb/              — Embedded JSON document store (snapshot + WAL, full-text index)
  node-sdk/            — Public TypeScript SDK (@moonshot-ai/kimi-code-sdk)
  oauth/               — Kimi OAuth and managed auth utilities
  pi-tui/              — Terminal UI framework (upstream dependency, node:test suite)
  remote-control/      — Kimi Remote Control tunnel client (relay registration + HTTP/WS forwarding)
  telemetry/           — Shared client-side telemetry infrastructure
  transcript/          — Isomorphic transcript rendering data layer
  tree-sitter-bash/    — Pure-TypeScript bash parser (deterministic budget)
```

#### Key Package Details

**`agent-core-v2`** (v0.4.3) — Next-gen agent engine with DI × Scope architecture. Service interfaces, DI containers, scope-bound session management. Consumed by `kap-server` and `klient`. Includes dependency graph analysis, domain layer linting, and contract type generation scripts.

**`kosong`** (v0.5.6) — The LLM / provider abstraction layer — the single shared home for the provider wire contract. Owns the contract types (`Message` / `ChatProvider` / `Tool` / `TokenUsage` / `ModelCapability`), the coded-error infrastructure (`Error2` + provider error taxonomy), and the pure-function layer (`generate()`, token estimation, error classification, provider wire helpers). `agent-core-v2`'s `src/kosong/` keeps the DI/trait composition machinery and imports the shared layers from here (its `contract/` directory is a thin re-export). Supports Anthropic, Google Gemini, and OpenAI-compatible providers. Uses `zod-to-json-schema` for tool schema conversion.

**`klient`** (v0.1.2) — Client SDK. A contract-driven facade over agent-core-v2 with aggregated `global.*` / `session(id).*` / `agent(id).*` methods, zod validation on every call, and transport abstraction (ipc or memory). Also hosts e2e suites.

**`kap-server`** — The Kimi Code local server. Backed by DI × Scope agent engine. Exposes sessions over REST + WebSocket (`/api/v1` + `/api/v1/ws`). Debug surface at `/api/v1/debug/*`. Bootstrapped from `src/start.ts`.

**`transcript`** (v0.0.2) — Isomorphic transcript rendering data layer. Pure TypeScript (browser-safe). Agent-granular L1 store, idempotent L2 operations, granularity-gated L3 subscriptions (`off/turn/block/delta`), framework-free L4 view registry. Owns all transcript contract types in `src/contract/`.

**`kimi-native-tools`** — Rust native addon via napi-rs. Implements: bash execution, grep, glob, read, write, edit, token counting, output truncation, web fetching (HTML rendering via scraper), image processing, SSE/eventsource streaming, SQLite (rusqlite), ULID generation, and more. Single `cdylib` crate (no Cargo workspace).


**`minidb`** (v0.2.0) — Pure-Node.js embedded key-value database. Combines Redis-style in-memory KV with SQLite-style WAL + snapshot persistence. Includes cluster support.

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
  generate-locale-json.cjs      — Generate locale JSON from translation source
  check-locale-keys.mjs         — Check locale key coverage
  check-locale-placeholders.cjs — Validate i18n placeholder consistency
  check-nix-workspace.mjs       — Validate flake.nix vs workspace membership
  check-no-comments.mjs         — Enforce no-comment policy (agent-core-v2, kap-server, transcript)
  check-service-naming.mjs      — Check service naming conventions
  check-t-call-coverage.mjs     — Check t() call coverage
  scan-hardcoded[-v2].mjs       — Scan for hardcoded strings (i18n compliance)
  prompt-optimizer/             — Prompt benchmark and optimization tools
```

### Structural review (`tools/review`)

`tools/review` is a small Zig program that reads the repository itself rather than
running the test suite. It answers questions a test cannot: whether a documented
gate is actually wired up, whether a workspace member's tests ever run, whether a
generated file drifted from its source. It runs in CI as the `review` job and takes
about 1.5 s over the whole monorepo.

```
tools/review/
  src/checks/                   — one file per check
  dangling-refs-baseline.txt    — accepted findings, one per line
  orphan-exports-baseline.txt   — accepted findings, one per line
  scripts-wiring-baseline.txt   — accepted findings, one per line
  silent-catch-baseline.txt     — accepted findings, one per line
```

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
| `upstream-drift` | A file upstream carries that this branch dropped |
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

To add a check, drop a file in `src/checks/`, export `run(ctx: *check.Context)`,
and register it in `src/checks.zig`. `zig build test` covers every module listed in
the `test` block of `src/main.zig` — add the new file there too, or its tests will
not run.

---

## Environment Requirements

- **Bun**: `>= 1.4` — required. Package manager, script runner, and dev-toolchain runtime (`bun.lock` is the lockfile, specified via `bunVersion` in `flake.nix`); build, lint, typecheck, locale checks, and the vitest suites (`bun --bun run test`) all run through bun.
- **Node.js**: not required for the Bun-based dev workflow — build, lint, typecheck, the native pipeline, and the test suites all run under Bun (pi-tui's node:test suite included), and no CI job installs Node. The Nix build path is the exception: `flake.nix` pins `minNodeVersion = "24.15.0"` and fails evaluation below it, keeps `nodejs` in the derivation's `nativeBuildInputs` and the devShell, and runs `node apps/kimi-code/scripts/check-web-assets.mjs` as a build step, so `nix-build.yml` needs Node on every PR.
- **Published package engines**: the published package declares `"bun": ">=1.4.0"` — the same floor the dev toolchain requires.
- **Rust** (optional, for native tools): Stable toolchain, MSVC on Windows.
- **Git for Windows** (Windows only): Optional; used as the POSIX shell fallback when PowerShell is unavailable. Set `KIMI_SHELL_PATH` to pin a specific shell.

---

## Build & Test Commands

### Root-level commands

```sh
bun install                   # Install all dependencies
bun run build                 # Build all workspace packages
bun run build:packages        # Build only packages/*
bun run dev:cli               # Run CLI in dev mode
cd apps/kimi-web && bun run dev # Run web UI in dev mode (standalone Bun install via apps/kimi-web/bun.lock)
bun run dev:server            # Run server in dev mode
bun run test                  # Run all tests (vitest)
bun run test:watch            # Watch mode
bun run test:coverage         # With coverage
bun run typecheck             # TypeScript check (builds packages first)
bun run lint                  # oxlint --type-aware
bun run lint:fix              # Auto-fix
bun run sherif                # Monorepo correctness check
bun run clean                 # Clean all dist directories
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
make test             # vitest
make rust-build       # cargo build --release (run from packages/kimi-agent)
make rust-check       # cargo check
make rust-test        # cargo test + kimi-agent --test
```

### Package-specific commands

```sh
# CLI app
cd apps/kimi-code && bun run build
cd apps/kimi-code && bun run dev
cd apps/kimi-code && bun run test
cd apps/kimi-code && bun run e2e     # E2E tests (sets KIMI_E2E=1)

# Native tools (Rust)
cd packages/kimi-native-tools && cargo test --lib  # cdylib crate: doc tests unsupported
cd packages/kimi-native-tools && cargo build --release
bun run build:native:bun:release  # Full release build (from apps/kimi-code)

# VS Code extension
cd apps/vscode && bun run build
cd apps/vscode && bun run test
cd apps/vscode && bun run package:platform     # Produce .vsix

# Web UI (standalone Bun install via apps/kimi-web/bun.lock)
cd apps/kimi-web && bun run build
cd apps/kimi-web && bun run dev
```

To run a local build inside `~/.kimi-code/` instead of the released binary (PowerShell on Windows, bash on Linux), see [`CONTRIBUTING.md` → "Deploy to local `.kimi-code` for testing"](CONTRIBUTING.md#deploy-to-local-kimi-code-for-testing).

### CI pipeline

GitHub Actions (`ci.yml`) runs on every PR and push to `main`. Every job installs Bun via `oven-sh/setup-bun`; no job installs Node:
1. **build** — Install, build, smoke test CLI bundle
2. **test** — `bun --bun run test` (vitest under the Bun runtime) split across 5 parallel shards on Ubuntu
3. **test-pi-tui** — `pi-tui` suite (dispatches to `bun test` under Bun, `node --test` under Node)
4. **test-minidb** — `minidb` suite, which the root vitest projects exclude
5. **test-kimi-web** — `apps/kimi-web` typecheck, tests, and style check (the app sits outside the root workspace)
6. **lint** — `bun run lint` (oxlint --type-aware), `bun run sherif`, engine boundaries (`check:deep-imports`, then `check:boundaries`), locale key parity (`check-locale-keys.mjs`), locale placeholder validity (`check-locale-placeholders.cjs`), `t()` call-site coverage (`check-t-call-coverage.mjs`), and locale JSON freshness (regenerate via `generate-locale-json.cjs` and fail on any tracked diff)
7. **typecheck** — TypeScript check across all packages (`tsgo` from `@typescript/native-preview`, run via `bunx --bun`)
8. **review** — `zig build` in `tools/review` (Zig installed via `mlugg/setup-zig`), then the structural checks described under "Structural review" above.

`ci.yml` also carries a `test-windows` job (the full suite on Windows). It is parked with `if: false` while Windows tests are stabilized, so it is not part of the pre-merge pipeline.

Two more jobs run outside `ci.yml`. **native bundle** is built by `_native-build.yml` (a `workflow_call` workflow invoked from `release.yml` and `manual-native-bundle.yml`) on a 6-target matrix (linux-x64, linux-arm64, darwin-x64, darwin-arm64, win32-x64, win32-arm64): `(cd packages/kimi-native-tools && bun run build)` (napi-rs build; no cargo test), then Bun single-file packaging (`build:native:bun`) and a native smoke test. **codeql** (`codeql.yml`) scans js/ts on pushes to `main` and on a weekly schedule; a branch ruleset requires CodeQL results (plus blocks force pushes and branch deletion) for merges into `main`.

Additional workflows: `_native-build.yml`, `codeql.yml`, `docs-deploy.yml`, `manual-native-bundle.yml`, `nix-build.yml`, `pkg-pr-new.yml`, `pr-title-checker.yml`, `release-native.yml`, `release.yml`, `vscode-publish.yml`.

### Release flow (fork)

Pushes to `main` run `release.yml`, which installs, builds all workspace packages, and builds the built-in catalog. The `changesets/action@v1` step is **commented out on this fork** (this fork follows upstream versions and never publishes to npm independently), so no "ci: release packages" PR is opened or updated and nothing is published; the `release` job's `packages_published` / `kimi_native_release` outputs are permanently empty, and the downstream jobs gated on them never run. Re-enable the step when a standalone release is needed. See CONTRIBUTING → "Release flow on this fork".

### Native release

`release-native.yml` publishes the CLI binaries. It runs on a push of a version tag (`v2.1.1` or `@moonshot-ai/kimi-code@2.1.1`), or manually via `workflow_dispatch` with an existing tag. It resolves and validates the tag, invokes `_native-build.yml` for all six targets, then aggregates the per-target `.zip`/`.sha256` artifacts into `manifest.json` and creates the GitHub Release. Publishing is gated on three checks that fail the run rather than ship a bad release: `apps/kimi-code/package.json` must match the tag's version, every archive must pass `sha256sum -c` against its own checksum file, and `manifest.json` must carry all six targets. The release body is the matching section of `apps/kimi-code/CHANGELOG.md`, falling back to a generic body when the section is absent.

The macOS and Windows signing steps degrade safely when their secrets are unset: `_native-build.yml` warns and builds the unsigned local profile. Note that its `windows-2025-vs2026` runner label is only offered on **public** repositories — if this repo is ever made private, `win32-x64` needs a label from the private-runner table.

### Nix build maintenance

`nix-build.yml` builds the CLI in a pure sandbox. Dependencies come from the `bunDeps` fixed-output derivation in `flake.nix` (hoisted `node_modules` + cargo vendor dirs for both napi packages). After changing `bun.lock` or either `Cargo.lock`, expect one hash-mismatch round: set `outputHash` to `lib.fakeSha256`, push, then paste the `got:` hash (the nix-build bot posts it on PRs). Sandbox quirks: no `/usr/bin/env` (invoke node-gyp/napi via `node <js-entry>`), and FOD outputs must not contain store paths. See CONTRIBUTING → "Nix build".

---

## Code Style & Conventions

### Formatting (oxfmt)

- 2-space indentation, spaces not tabs
- 100 print width
- Single quotes, trailing commas, LF line endings
- Import sorting: builtin → external → internal → parent/sibling/index → unknown
- For full config, see `.oxfmtrc.json`

### Linting (oxlint)

- **Plugins**: typescript, import, unicorn, promise, node
- **Key rules**:
  - `eqeqeq: error`, `no-throw-literal: off`
  - `typescript/no-misused-promises: error`, `typescript/return-await: error`
  - `import/no-cycle: error`, `import/no-self-import: error`
  - `unicorn/prefer-node-protocol: error`
  - `no-console: warn`, `no-explicit-any: warn`, `no-non-null-assertion: warn`
  - `consistent-type-imports: warn`
- Test files get relaxed rules (no-explicit-any off, no-console off, vitest plugin rules)
- `packages/kosong/src/providers/` gets relaxed unsafety rules
- For full config with all overrides, see `.oxlintrc.json`
- Ignored: `dist/`, `dist-web/`, `coverage/`, `node_modules/`, `apps/*/scripts/`, `docs/smoke-archive/`, `packages/pi-tui/`, `*.generated.ts`, `参考目录/`
- **Package publishing lint (`lint:pkg`)**: `publint` + `attw` on `@moonshot-ai/kimi-code`. Invoked only by `bun run publish` (the publish pipeline), not by the CI lint job — keep this in mind when chasing lint failures locally.

### TypeScript Config (root `tsconfig.json`)

- **target**: ES2024
- **module**: preserve (bundler mode)
- **strict**: true
- **Additional strictness**: `noUncheckedIndexedAccess`, `noImplicitOverride`, `noPropertyAccessFromIndexSignature`, `noFallthroughCasesInSwitch`, `verbatimModuleSyntax`
- **JSX**: react-jsx (React 19)
- **noEmit**: true (tsdown handles bundling)
- **skipLibCheck**: true

### General Coding Rules

- `packages/agent-core-v2`, `packages/kap-server`, and `packages/transcript` are comment-free zones: no comments of any kind — no line/block comments, no JSDoc (not even on exported symbols); the only exception is load-bearing lint-suppression directives (`oxlint-disable` / `eslint-disable`), while other tooling directives (`@ts-expect-error`, …) stay banned. `scripts/check-no-comments.mjs` reports violations over `.ts`/`.tsx`/`.mts`/`.mjs` under `src/`/`test/`/`scripts/`, and the lint job in `ci.yml` runs it on every PR.
- For optional object properties, pass `undefined` directly instead of using conditional spread.
  - YES: `{ user }`
  - NO: `{ ...(user ? { user } : undefined) }`
- Optional object properties do not need to additionally allow `undefined` in the type.
  - YES: `interface Options { user?: User }`
  - NO: `interface Options { user?: User | undefined }`
- Internal methods with only a single parameter should not be turned into options objects just for stylistic uniformity.
- Except for a package's `index.ts`, other `index.ts` files should prefer `export * from './module';`.
- Prefer importing via `import ... from '#/...'` (subpath imports), which serves the same purpose as `import ... from '@/...'`.
- Do not add too many new test files. Prefer adding tests to the existing test file of the corresponding component or module.
- When a test fails because of a user modification, default to fixing the test first; do not change the implementation to satisfy an old test unless the implementation truly has a bug.
- Do not sacrifice code quality for external compatibility unless the user explicitly asks for it.

### i18n Conventions

- All user-facing strings must use `t()` calls from the i18n framework.
- Supported locales: `en` (English), `zh` (Chinese).
- Locale JSON must be regenerated after translation changes: `bun scripts/generate-locale-json.cjs`.
- Run `bun scripts/scan-hardcoded-v2.mjs` to find hardcoded strings that should be localized.
- Run `bun scripts/check-locale-placeholders.cjs` to validate placeholder consistency.

---

## Testing Instructions

### Test Framework

- **vitest 4.1.10** for all TypeScript/JavaScript tests (root-level)
- **node:test** for `@moonshot-ai/pi-tui` (not part of vitest workspace; CI runs it with `bun --bun run test`, which dispatches to `bun test` under Bun and to `node --test` under a Node runtime)
- **cargo test** for Rust packages (`kimi-native-tools`)
- **Coverage**: v8 provider, reports in text + HTML

### Vitest Configuration

Defined in root `vitest.config.ts`. Projects:
```
packages/* (excluding packages/minidb)
apps/kimi-code
apps/kimi-inspect
apps/vis/server
apps/vis/web
apps/vscode (from apps/vscode/vitest.projects.ts)
```

Coverage includes `packages/*/src/**/*.ts` and `apps/*/src/**/*.ts`, excludes test files and dist directories.

### Running tests

```sh
bun run test                  # All vitest suites
bun run test:watch            # Watch mode
bun run test:coverage         # With coverage report
(cd packages/<package> && bun run test)  # Single package
(cd packages/<package> && bun run vitest run -- --reporter=verbose)  # Verbose mode
```

### Test file conventions

- Test files co-locate with source or in a `test/` directory under each package/app.
- Patterns: `*.test.ts`, `*.test.tsx`, `*.spec.ts`, `*.spec.tsx`, `test/**/*.ts`
- E2E tests live in `apps/kimi-code/test/e2e/` and require `KIMI_E2E=1` env.

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

Two dependencies are deliberately removed: `ssh2@1.17.0>cpu-features` and `ssh2@1.17.0>nan` are both overridden to `-` (skip installation).

### CI Security Checks

- Secret scanning via GitHub's built-in scan
- The `pkg-pr-new.yml` workflow publishes preview packages from PRs
- PR titles are enforced via `pr-title-checker.yml`

---

## Monorepo Workspace Maintenance

- **The `workspaces` field in the root `package.json`** is the source of truth for workspace membership. Globs: `packages/*`, `apps/*` (minus `!apps/kimi-web`), `apps/vis/server`, `apps/vis/web`, and `docs`.
- **`flake.nix`** also contains a hardcoded `workspacePaths` list that must be manually kept in sync.
- **Whenever you add or remove a workspace package, you MUST update both the root `package.json` and `flake.nix`** — for every package, including leaf / test / e2e packages that nothing depends on.
  - Missing a path in `flake.nix`'s `workspacePaths` silently drops files from the Nix build's `src` fileset.
- **The automated check script** (`scripts/check-nix-workspace.mjs`) only validates the transitive dependency **closure of `@moonshot-ai/kimi-code`**. A leaf package outside that closure slips through. Do not rely on the check to catch omissions.

---

## Version Management (Changesets)

- **This fork follows upstream versions.** Package `version` fields in `package.json` must stay identical to `upstream/main` — never run `bun run version` or `bun run publish` here, and never bump versions independently. When merging upstream releases, take their `package.json` version changes as-is.
- Fork-only packages that do not exist upstream (`@moonshot-ai/i18n`, `@moonshot-ai/i18n-shared`, `@moonshot-ai/kimi-native-tools`) keep their own versions; do not bump them either unless a fork-specific release is explicitly requested.
- Changesets are maintained **as a changelog source only**: keep writing them for user-facing changes so release notes stay available, but they are not consumed by a local release flow. Before merging upstream, prune accumulated non-user-facing entries (see the `gen-changesets` skill).
- Every PR affecting release artifacts should include a changeset; docs-only, test-only, or CI-only PRs may skip changesets. Generate one with `bun run changeset`.
- **Never** decide on a `major` bump on your own. When a change meets major criteria (breaking changes, incompatible user configuration, renamed/removed commands/arguments, changed behavior semantics), stop and ask the user for confirmation. Default to `minor` (fall back to `patch` if unclear).
- Base branch: `main`
- Ignored from versioning: `@moonshot-ai/vis`, `@moonshot-ai/vis-server`, `@moonshot-ai/vis-web`, `@moonshot-ai/kimi-inspect`

---

## Experimental Features

- Gate a not-yet-public feature behind an experimental flag. Register the flag from the owning domain's own module (definitions are contributed **decentrally** — each domain calls `registerFlagDefinition` at its module's top level, e.g. `packages/agent-core-v2/src/features/tower/flag.ts`; there is no central catalog to edit by hand), then check it with `flags.enabled('my-feature')`.
- Flags are env-driven; precedence is per-flag env > `[experimental]` config > master env > the flag's `default`; the `default` is chosen per flag as needed (e.g. the tower flag defaults to `false`, while `tool_select`, `wait_for`, and `xunfei_coding_plan` default to `true`):
  - `KIMI_CODE_EXPERIMENTAL_<NAME>` toggles one
  - `KIMI_CODE_EXPERIMENTAL_FLAG` enables all
- Release by flipping the flag's `default` to `true`.

---

## Commit Convention (Conventional Commits)

- Commit messages follow Conventional Commits (`feat:`, `fix:`, `chore:`, ...). PR titles are enforced by the `pr-title-checker.yml` workflow.

## Where to Update Instructions

- Hard rules that affect almost every task: update the root `DEVELOP.md`.
- Rules that only affect a specific directory: update the nearest sub-directory `DEVELOP.md`.
- Keep instruction updates focused and supported by code facts.

## Working Principles

- Think from first principles. Start from real requirements, code facts, and verification results; if the goal is unclear, discuss it with the user first.
- Treat code, not documentation, as the source of truth. Unless the user explicitly says otherwise, do not read ordinary Markdown just to understand the implementation.
- Before making code changes, read the relevant code and the most recent constraints, and follow the nearest `DEVELOP.md` in the directory tree.
- Keep changes focused. Do not slip in unrelated refactors along the way.
- When committing, do not add any co-author attribution, and do not reveal the identity of the agent in commit messages, PR descriptions, or any explanatory text.
- Push every commit to `origin` immediately after `git commit`. Never let local and remote diverge — applies to feature, fix, and experimental branches alike, so local work is never lost and the remote does not fall behind.

## Workflow Requirements

- Prefer `rg` / `rg --files` when reading code.
- When designing changes, follow existing boundaries and local patterns first.
- In public text and test data, replace real internal identifiers with neutral placeholders such as `example.com`, `example.test`, and `YOUR_API_KEY`.
- When opening a PR, fill in `PULL_REQUEST_TEMPLATE.md` — link the related issue or explain the problem, then describe what changed. Do not leave placeholder text.
- After finishing a task and before submitting a PR, you must run the `gen-changesets` skill.
- Do not commit throwaway scratch or exploratory files. Never stage: handoff documents (`HANDOVER-*.md`, `HANDOFF-*.md`, `handoff.md`), UI mockups (`*-designs.html`, `*-mockup.html`, `*-demo.html`), or any `.tmp/` content.
## Code Review Rules

These rules apply to every pull request review, automated or human. The user populations and contract files they refer to are listed in `.agents/skills/review-pr/surfaces.md`.

### Enumerate changed behavior, not just bugs

Any input that worked before the change — a config key, env var, CLI flag, provider response shape, session written by an older version, client request, or hook payload — must behave the same after it unless the PR declares the change. For every deleted or narrowed branch, condition, default, or prompt sentence, ask who reached it before and where they go now; for every new condition, ask which existing inputs now match it first. Flag a PR that calls a path "unchanged" when its branch condition moved.

### A flipped default or removed behavior needs a named loss and an escape hatch

Everyone on the old default is affected. Require the changeset to name the behavior users lose, not only the new default; a config, env, or flag escape hatch or a maintainer's explicit sign-off in the PR; and a test that pins the old behavior for the population that keeps it.

### Prompt text is behavior

Editing or deleting sentences under `packages/agent-core-v2/src/**/*.md` (system prompt, tool descriptions, reminders, overlays, built-in skills) changes agent behavior for every user who receives that prompt. "No test references the sentence" is not evidence of no impact. Require the PR to name the population that receives the text (every session, plan mode, a flag-gated feature such as Tower), what the sentence enforced, who relied on it, and what enforces it now.

### Contract files are tripwires

The manifests under `packages/agent-core-v2/docs/` (`config-manifest.toml`, `wire-manifest.d.ts`, `state-manifest.d.ts`), `packages/kap-server/test/__snapshots__/apiSurface.snapshot.test.ts.snap`, `packages/node-sdk/src/index.ts`, `packages/agent-core-v2/src/features/externalHooks/`, `packages/acp-server/`, and `apps/kimi-code/src/cli/` are consumed outside this repository: desktop and web in code-app, the VS Code extension, ACP clients such as Zed, SDK users, hook scripts, and headless-output parsers. When they change, require the PR to name the consumers and how data and clients from the previous release keep working.

### Ports and refactors carry the old path's feature inventory

When a change replaces or bypasses an existing path, require a list of what the old path did — env vars honored, fallbacks, accepted inputs — and where each item lives in the new path. A silently dropped item is a regression, not a cleanup.

### Silent failure outranks a crash

A change that makes the product silently ignore configuration, silently approve or skip an action, or silently drop data is the most severe finding: users get no signal to report.
