# Repository-level Agent Guide

Reply in the same language as the user.

This is a TypeScript monorepo built for agent-assisted development. This file is the single source of truth for project-wide knowledge. Keep it focused on the project map, hard constraints, and workflow requirements — things every task needs to know.

> **Merging, porting, or triaging upstream changes? Read `## Upstream Merge Policy` before judging
> anything.** `packages/kimi-agent` is a **port of v2 (`agent-core-v2`)**, not an independent
> implementation, so an upstream change under `packages/agent-core-v2/**` is a **behavior spec the
> Rust engine must follow** — *even though those files no longer exist in this fork*. The judgement
> criterion is the v2 → Rust module mapping, **never** "the path is absent from `HEAD`, so it is
> irrelevant": deleting `packages/agent-core-v2/**` erased upstream's diff carrier, so `git log` /
> `git blame` show no link at all. There is a mechanical gate for exactly this: run
> **`bun run check:upstream-v2-delta`** (allowlist `scripts/upstream-v2-delta-allowlist.json`,
> verdicts recorded in `packages/kimi-agent/ROADMAP.md` §6). **Refresh the ref before you trust
> it** — a stale `refs/remotes/upstream/main` silently narrows the range and reports a green
> "all triaged": `git fetch upstream main:refs/remotes/upstream/main --force`.
> (This pointer sits near the top on purpose — tooling truncates this file when it is injected as
> project context, so it would otherwise not reach an agent that only reads the injected copy.)

## Project Overview

**Kimi Code CLI** is an AI coding agent that runs in the terminal — it can read and edit code, run shell commands, search files, fetch web pages, and choose the next step based on the feedback it receives. It works out of the box with Moonshot AI's Kimi models and can also be configured to use other compatible providers.

- **Author**: Moonshot AI
- **License**: MIT
- **Homepage**: https://github.com/MoonshotAI/kimi-code
- **Version**: follows `upstream/main` — see `apps/kimi-code/package.json` (do not hardcode here)

> **Note**: This repository is a personal experimental fork of MoonshotAI/kimi-code. Not affiliated with Moonshot AI. Use at your own risk — do not submit PRs from this fork to upstream.

### Fork-specific additions vs upstream

- **i18n / Multi-language support** — Complete Chinese-English bilingual support across TUI, CLI, and Web UI. All hardcoded English strings replaced with `t()` calls. Switch locale via the `/settings` dialog (aliased as `/config`), locale selector inside.
- **Team** — Multi-agent discussion and collaboration tool; agents can debate, cross-review, and reach consensus before output.
- **Rust Native Tools** — Performance-critical tools (grep, glob, edit, read, write, bash, token counting, output truncation) rewritten in Rust as a native Node addon, significantly faster than JS.
- **Windows launchers** — `start-native.bat` builds the native Rust tools if needed and launches the CLI in dev mode (supports `--web` to launch the Web UI powered by native Rust server); `start-web-native.bat` provides one-click launch for the native Web UI; `start-desktop.bat` builds and launches a locally vendored desktop shell when `apps/kimi-desktop` is present (the shell source is not tracked in this fork).
- **Bun toolchain & packaging** — Bun is both the package manager (hoisted workspace, `bun.lock`) and the sole native-binary packaging engine (`bun build --compile` via `build-bun.mjs`); the former pnpm workspace setup and the Node SEA build chain were retired. Install, build, lint, typecheck, the native build pipeline, and the vitest suites (`bun --bun run test`) all run on Bun; CI installs no Node. Self-update is fully native Bun binary based.
- **DeepSeek Harness capability fusion** — Selected capabilities ported from [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) (MIT): MCP auto-reconnect with bounded exponential backoff (`mcpCore/connection-manager.ts`). Ported modules carry a source note in their header; capability selection and comparison notes live in the session report.

> For a user-facing summary of these additions, see `README.md` → "What's Different in This Fork" (and its Chinese mirror `README.zh-CN.md` → "本 Fork 新增特性").

---

## Engine-side i18n (Rust)

The TypeScript layers translate their own UI through `t()`. The **Rust engine** has a
second, separate surface: text it produces itself — permission reasons, tool-result
errors, ACP approval labels. Those are built with `LocalizedText` and resolved
in-process against the locale the host installs.

```rust
use crate::i18n::{LocalizedText, i18n_params};

// No interpolation.
LocalizedText::plain("engine.permission.reject", "Reject").render()

// With `{{param}}` interpolation.
LocalizedText::fmt(
    "engine.tools.read.notExist",
    format!("\"{path}\" does not exist."),
    i18n_params!["path" => path],
)
.render()
```

Locale keys live under `engine.*` in `apps/kimi-code/src/i18n/locales/{en,zh}.ts`
(the host installs them via `setEngineLocale`; see `packages/i18n` and
`apps/kimi-code/src/i18n`). Run `bun run check:engine-i18n` after any change — CI
gates on it.

### Hard rules

- **`plain` never interpolates.** A `{name}` in a `plain` English text reaches the
  user as literal braces. Use `fmt` + `i18n_params!`. The parity gate rejects this.
- **The `format!` placeholder names must match the locale placeholder names,
  character for character.** `format!("… {v} …")` needs `{{v}}` in the locale, not
  `{{value}}`. The gate compares the normalized templates and fails on drift.
- **`format!` placeholders must resolve to an in-scope variable.** `Path`/`PathBuf`
  do not implement `Display`, and fields/constants are not variables — use named
  arguments: `format!("… {path} …", path = path.display())`,
  `format!("… {max} …", max = MAX_BYTES)`.
- **Keep the English fallback accurate.** It is what an unwired host renders (the
  standalone REPL, unit tests, an embedder that never called `setEngineLocale`),
  and it is what the parity gate compares against.

### What not to translate

- **Model input** — system prompts (`prompt/*.md`), tool descriptions
  (`core_tool_defs.rs`), the compaction summarizer instruction. v2 shipped these in
  English and translating them changes model behaviour.
- **Tool-protocol instructions** — strings that tell the model how to drive a tool
  ("To resume reading, call Read with line_offset=…", "Use offset=… to see more").
  They are part of the tool's contract, not UI.
- **Format scaffolding** — `"<system>{}</system>"`, `"<image path=… />"`,
  `"data:{mime};base64,…"`, `"{}\t{}"`. No prose to translate.
- **Machine-readable wire tokens** — `llm http status {status}: ` and
  ` (retry-after {s}s)` in `llm/error.rs` are parsed back out by
  `llm::http::llm_http_status` and `turn_loop::retry_after_hint`; translating them
  silently breaks retry backoff and context-overflow recovery.

### Known gaps

- **`ToolExecuteResponse.note` has no napi consumer.** The engine emits it on the
  `tool.native` event, but `sdk-rpc-client-native.ts` forwards only `content` and
  `is_error`, and the ACP projection ignores it too. It is carried through
  `tool_result_truncation` unchanged and never appended to `content`. Notes are
  localized anyway (so they are correct the day a client reads them), but today
  `engine.tools.readMedia.readVideoFile` is the one converted string a user cannot
  see. Surfacing it needs a protocol change, tracked separately.
- **Informational footers are still English** — "Total lines in file: N.",
  "Showing matches X–Y of Z.", "Continue with the same search arguments…".

---

## Technology Stack

### Languages & Runtimes

| Layer | Technology |
|-------|-----------|
| Primary language | **TypeScript** 6.0.2 (strict mode) |
| Module system | ESM (`"type": "module"` in every package) |
| Dev runtime | **Bun** >= 1.4 — install, build, lint, typecheck, and the vitest suites (`bun --bun run test`) all run through bun |
| Published CLI runtime | **Bun** >= 1.4 (`engines` of the published app and native packages — `bun build --compile` single-file binaries). Upstream's `node >= 22.19.0` floor is deliberately not carried in this fork |
| Native code | **Rust** (via napi-rs for Node addon, pure Rust CLI tools) |
| Web UI (stale snapshot in `apps/kimi-web`) | **Vue 3** + **Vite** |
| VS Code extension | **React 19** + **TailwindCSS 4** + **shadcn/ui** |

### Package Management & Build

| Tool | Purpose |
|------|---------|
| **Bun** >= 1.4 | Package manager and script runner (hoisted workspace via root package.json; `bun.lock` is the lockfile). Also compiles the release binary (`build-bun.mjs`) |
| **tsdown** 0.22.0 | ESM bundler for TypeScript packages |
| **vite** 6.x | Web app bundler (kimi-web, vis-web, vscode webview) |
| **Cargo** | Rust build for `kimi-agent` (napi-rs) |
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
  kimi-inspect/     — Web inspector for kimi-agent /api/v1/debug RPC surface
  vis/              — Session replay & debugging visualizer
```

#### `apps/kimi-code` — CLI / TUI Application

The main application. Consumes core capabilities through `@moonshot-ai/kimi-code-sdk`. When writing or modifying its terminal UI, use the `write-tui` skill (`.agents/skills/write-tui/SKILL.md`).

**Source layout:**

```
src/
  main.ts             — Entry point
  cli/                — CLI mode (headless)
    commands.ts       — CLI command definitions
    options.ts        — CLI option parsing
    sub/              — Subcommands (acp, doctor, export, login, provider, upgrade, vis, web)
    update/           — Self-update mechanism
  tui/                — Terminal UI mode
    kimi-tui.ts       — TUI initialization and main loop
    config.ts         — TUI configuration
    banner/           — Startup banner
    commands/         — Slash command handlers (see `src/tui/commands/registry.ts` for the live count)
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

**CLI subcommands:** defined in `src/cli/commands.ts` — read it for the live list (the set drifts with features; do not trust a snapshot here).

**TUI slash commands:** all built-ins live in `src/tui/commands/registry.ts` — read it for the live list.

**Build output:**
| Output | Path |
|--------|------|
| CLI entry (ESM) | `apps/kimi-code/dist/main.mjs` |
| Web UI assets | `apps/kimi-code/dist-web/` |
| Native prebuilds | `apps/kimi-code/native/` |
| Native binary (Bun single-file) | `apps/kimi-code/dist-native/bin/` |

#### Web UI (`apps/kimi-code/dist-web` + `apps/kimi-web`)

The shipped `apps/kimi-code/dist-web` bundle is a committed, prebuilt bundle synced from the code-app repo; the fork also carries its own Vue 3 web UI source in `apps/kimi-web` (excluded from the workspace, see below). To hack on the web UI against this repo's server, run `bun run dev:server` here and point the web UI dev server at it via `KIMI_SERVER_URL`.

**Sync convention: replace, never overlay.** A Vite build emits content-hashed filenames, so copying a new bundle over the old one leaves every previous generation behind — the directory once accumulated 616 files / 44 MB across a dozen stale entry chunks, and nothing in the repo detected it because `apps/kimi-code/scripts/check-web-assets.mjs` only verifies that the assets `index.html` names still exist. Delete `apps/kimi-code/dist-web/` first, then copy the fresh bundle in, then commit; the diff should show the old generation removed, not merely a new one added. To audit an existing directory, walk reachability from `index.html` (and `boot.js`) and delete what the walk cannot reach — a reference *count* is not enough, since a whole dead generation cross-references itself.

**Never rebuild `dist-web` from `apps/kimi-web`.** The fork's `apps/kimi-web` source is a stale snapshot: the 0.40–0.43 web features (Plugins settings panel, the 0.43 settings restructure and About agreements, composer media rail, selection quote-to-chat, frontmatter cards, tower mode in web, …) were developed in the separate code-app repo and shipped through the committed bundle only — they do not exist in `apps/kimi-web`. A build from that source silently drops them. Treat `apps/kimi-web` as a dev-sandbox against `bun run dev:server`, and take `dist-web` solely from code-app syncs.

#### `apps/vscode` — VS Code Extension

Full-featured VS Code extension (`kimi-code` in marketplace). React 19 webview UI with TailwindCSS 4, communicates with the main kimi-code server over local REST/WS.

Key contributions:
- Sidebar webview panel
- Commands: `kimi.focusInput`, `kimi.insertMention`, `kimi.newConversation`, `kimi.showLogs`, etc.
- Settings: `kimi.yoloMode`, `kimi.autosave`, `kimi.editorContext`, etc.
- Packaging: vsix via `@vscode/vsce`, published to both VS Code Marketplace and OpenVSX

#### `apps/kimi-inspect` — Web Inspector

Web inspector for the kimi-agent `/api/v1/debug` RPC surface. Workspace/session browser, per-session chat, and Service panels. React 19 + Vite. Built on a `ProxyChannel` model similar to VS Code.

#### `apps/vis` — Session Visualizer

Debug visualization tool for kimi-code sessions. Composed of `vis/server` (backend) and `vis/web` (frontend). Sessions and replays can be inspected via a web UI.

### Packages

```
packages/
  i18n/                — Shared i18n infrastructure (t() with en/zh support)
  i18n-shared/         — Shared i18n core (types, locale detection, web-safe)
  kaos/                — Execution environment abstraction (local / ssh / login-shell)
  kimi-agent/          — Rust agent engine + native Node addon (napi-rs)
  kosong/              — LLM / provider abstraction layer
  minidb/              — Embedded JSON document store (snapshot + WAL, full-text index)
  node-sdk/            — Public TypeScript SDK (@moonshot-ai/kimi-code-sdk)
  oauth/               — Kimi OAuth and managed auth utilities
  pi-tui/              — Terminal UI framework (vendored from earendil-works/pi; see its AGENTS.md + UPSTREAM.md)
  protocol/            — Shared REST + WS protocol schemas (Zod types)
  telemetry/           — Shared client-side telemetry infrastructure
  transcript/          — Isomorphic transcript rendering data layer
  tree-sitter-bash/    — Pure-TypeScript bash parser (deterministic budget)
```

#### Key Package Details

**`kimi-agent`** — Next-generation Rust agent engine that drives the entire agent execution. Implements multi-turn execution loops, native LLM wire transport (OpenAI, Anthropic, Google Gemini), concurrent tool scheduling with conflict detection, sandboxed native filesystem/bash tools, SQLite session persistence, ACP stdio protocol, and native HTTP/1.1 + RFC 6455 WebSocket streaming with backpressure event fan-out (`EventHub`). The former `kimi-native-tools` addon (bash, grep, glob, read, write, edit, token counting, output truncation, web fetching, image processing, SSE streaming, SQLite, ULID, i18n translation) was merged into this crate under `src/native/` — one crate, one `.node` binary, one npm package. See `packages/kimi-agent/ROADMAP.md`.

**`kosong`** (v0.5.5) — The LLM / provider abstraction layer — the single shared home for the provider wire contract. Owns the contract types (`Message` / `ChatProvider` / `Tool` / `TokenUsage` / `ModelCapability`), the coded-error infrastructure (`Error2` + provider error taxonomy), and the pure-function layer (`generate()`, token estimation, error classification, provider wire helpers). Supports Anthropic, Google Gemini, and OpenAI-compatible providers. Uses `zod-to-json-schema` for tool schema conversion.

**`transcript`** (v0.0.1) — Isomorphic transcript rendering data layer. Pure TypeScript (browser-safe). Agent-granular L1 store, idempotent L2 operations, granularity-gated L3 subscriptions (`off/turn/block/delta`), framework-free L4 view registry. Owns all transcript contract types in `src/contract/`.

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
  check-no-comments.mjs         — Enforce no-comment policy (transcript)
  check-service-naming.mjs      — Check service naming conventions
  check-t-call-coverage.mjs     — Check t() call coverage
  scan-hardcoded[-v2].mjs       — Scan for hardcoded strings (i18n compliance)
  scan-parity.mjs               — Rust ↔ TS interface parity (REST / WS events / WS control / tool names / napi / config keys)
  check-engine-i18n-parity.mjs  — Rust `LocalizedText` English fallbacks vs locale entries (drift + orphan-key detection)
  check-no-legacy-engine.mjs    — Fail if a retired engine package is still referenced
  prompt-optimizer/             — Prompt benchmark and optimization tools
```

---

## Environment Requirements

- **Bun**: `>= 1.4` — required. Package manager, script runner, and dev-toolchain runtime (`bun.lock` is the lockfile, specified via `bunVersion` in `flake.nix`); build, lint, typecheck, locale checks, and the vitest suites (`bun --bun run test`) all run through bun.
- **Node.js**: no longer required for any development workflow — build, lint, typecheck, the native pipeline, and the test suites all run under Bun (pi-tui's node:test suite included). CI installs no Node.
- **Published package engines**: 发布包与 native 包的 `engines` 一律是 `bun >= 1.4`（`apps/kimi-code`、`packages/kimi-agent`、`packages/pi-tui`），全仓没有任何 Node 下限。合并上游时**不要把 Node 侧工具链内容拉回来** —— `pnpm-lock.yaml`、`engines.node`、Node-only 脚本、SEA 构建步骤、装 Node 的 CI job 一律拒绝，相关需求在 Bun 上重新表达。唯一例外：`packages/node-sdk` 是产品 SDK 的包名，不属于工具链。
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
make rust-build       # cargo build --release -p kimi-agent
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
cd packages/kimi-agent && cargo test --features cli  # lib + stdio-RPC integration tests
cd packages/kimi-agent && cargo build --release --features cli
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
3. **test-rust** — `cargo fmt --check` + `cargo clippy --all-targets --features cli -- -D warnings` (Ubuntu only), then `cargo test --no-default-features --features cli,workflow-js` on Ubuntu and Windows
4. **test-windows** — the full vitest suite on `windows-latest` (napi addon built first), so Windows-only regressions are caught
5. **test-pi-tui** — `pi-tui` suite (dispatches to `bun test` under Bun and `node --test` under Node; CI runs it via Bun)
6. **lint** — `bun run lint` (oxlint --type-aware), `bun run sherif`, `check-no-legacy-engine.mjs`, Rust ↔ TS interface parity (`scan-parity.mjs`), no-comment policy (`check-no-comments.mjs`), service naming (`check-service-naming.mjs`), `t()` coverage (`check-t-call-coverage.mjs`), engine i18n parity (`check-engine-i18n-parity.mjs`), hardcoded-string scan (`scan-hardcoded-v2.mjs`), retired-package upstream delta ratchet (`check-upstream-v2-delta.mjs`), locale key parity (`check-locale-keys.mjs`), locale placeholder validity (`check-locale-placeholders.cjs`), locale JSON freshness (regenerate via `generate-locale-json.cjs` and fail on any tracked diff)
7. **typecheck** — TypeScript check across all packages (`tsgo` from `@typescript/native-preview`, run via `bunx --bun`)
8. **native bundle** — Built by `_native-build.yml` (a `workflow_call` workflow invoked from `release.yml` and `manual-native-bundle.yml`) on a 6-target matrix (linux-x64, linux-arm64, darwin-x64, darwin-arm64, win32-x64, win32-arm64): `(cd packages/kimi-agent && bun run build)` (napi-rs build; no cargo test), then Bun single-file packaging (`build:native:bun`) and a native smoke test.
9. **codeql** — `codeql.yml` scans js/ts on PRs, pushes to `main`, and weekly. A branch ruleset requires CodeQL results (plus blocks force pushes and branch deletion) for merges into `main`.

Additional workflows: `_native-build.yml`, `codeql.yml`, `docs-deploy.yml`, `manual-native-bundle.yml`, `nix-build.yml`, `pkg-pr-new.yml`, `pr-title-checker.yml`, `release.yml`.

### Release flow (fork)

Pushes to `main` run `release.yml`: the changesets action opens/updates a **"ci: release packages"** PR that bumps versions and assembles the changelog. **Never merge it** — this fork follows upstream versions; close the PR (its description keeps the changelog preview). Requires the repo setting *Actions → General → "Allow GitHub Actions to create and approve pull requests"* to stay enabled. See CONTRIBUTING → "Release flow on this fork".

### Nix build maintenance

`nix-build.yml` builds the CLI in a pure sandbox. Dependencies come from the `bunDeps` fixed-output derivation in `flake.nix` (hoisted `node_modules` + the cargo vendor dir for the napi package, `kimi-agent`). After changing `bun.lock` or a `Cargo.lock`, expect one hash-mismatch round: set `outputHash` to `lib.fakeSha256`, push, then paste the `got:` hash (the nix-build bot posts it on PRs). Sandbox quirks: no `/usr/bin/env` (invoke node-gyp/napi via `node <js-entry>`), and FOD outputs must not contain store paths. See CONTRIBUTING → "Nix build".

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

- `packages/transcript` is a comment-free zone: no comments of any kind — no line/block comments, no JSDoc (not even on exported symbols); the only exception is load-bearing lint-suppression directives (`oxlint-disable` / `eslint-disable`), while other tooling directives (`@ts-expect-error`, …) stay banned. Enforced by `scripts/check-no-comments.mjs` over `.ts`/`.tsx`/`.mts`/`.mjs` under `src/`/`test/`/`scripts/`; the CI lint job runs it as its own step.
- For optional object properties, pass `undefined` directly instead of using conditional spread.
  - YES: `{ user }`
  - NO: `{ ...(user ? { user } : undefined) }`
- Optional object properties do not need to additionally allow `undefined` in the type.
  - YES: `interface Options { user?: User }`
  - NO: `interface Options { user?: User | undefined }`
- Internal methods with only a single parameter should not be turned into options objects just for stylistic uniformity.
- Split functions only along abstraction levels: each function reads as one level of narrative (Step-down Rule), and a wrapper that adds no new abstraction level — especially one with a single call site — is inlined instead of extracted.
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
- **node:test-style suite** for `@moonshot-ai/pi-tui` (not part of the vitest workspace; `scripts/test.mjs` dispatches to `bun test` under Bun and `node --test` under real Node — both must pass)
- **cargo test** for the Rust package (`kimi-agent`)
- **Coverage**: v8 provider, reports in text + HTML

### Vitest Configuration

Defined in root `vitest.config.ts` — read it for the live project list (it matches the workspace minus `apps/kimi-web`, which is excluded from the workspace).

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

## Upstream Merge Policy

Standing rules for every `upstream` tag merge (decided 2026-09-03). Upstream is the source of truth for product behavior; the fork keeps only four kinds of delta: i18n, the Rust engine / native-tools gate, `packages/kimi-agent`, and the Bun toolchain. Anything else in the fork's `HEAD` side of a conflict is legacy and should lose.

- **Upstream updates are merged by hand. Do not `git pull` / `git merge` against upstream** (user's standing rule, 2026-09-24; order of operations: sync `cnb` first, upstream second). `packages/kimi-agent` is a hand-port of v2, so an upstream change lands as a manual edit judged against the rules below — TS takes upstream's shape, engine behavior lands in Rust, and every behavior delta gets a verdict in `scripts/upstream-v2-delta-allowlist.json` plus a `packages/kimi-agent/ROADMAP.md` §6 entry. A direct `git merge upstream/main` also proved unsafe in practice: it hung twice on this repo (476k objects) and each time left `.git/refs/` deleted, requiring manual ref reconstruction from `.git/logs/HEAD` and a re-fetch to restore the missing objects.

- **The Rust agent is a port; inventing behavior is forbidden.** `packages/kimi-agent` reimplements existing behavior and must not be a design surface: every behavior it implements has to be traceable to a reference or to an explicit decision by the user, and anything else is a defect rather than a design choice. Two axes of reference — **do not conflate them: v1 / v3 are communication protocol versions, v2 is an engine package** (`agent-core-v2`):
  - **Engine behavior → v2** (`agent-core-v2`): the engine internals this package reimplements — turn loop, tool execution, LLM wire transport, permission, compaction, injection. The Verification Standard's "v2 is the behavioral reference" rule below applies here.
  - **v1 protocol** — REST `/api/v1` (`routes/`, prefix set in `registerApiV1Routes.ts`) and WebSocket `/api/v1/ws` (`WS_PATH` in `transport/ws/v1/registerWsV1.ts`), carried by the transport in `transport/ws/v1/` (`sessionEventBroadcaster`, `sessionEventJournal`, `wsConnectionV1`, `inFlightTurnTracker`, `subagentRosterTracker`). Its op and entity types come from `packages/transcript`; the event → op fold is `services/transcript/` (`coreEventMap`, `transcriptService`).
  - ~~**v3 protocol**~~ — **retired on both sides.** Upstream reverted it in 2.0.2 (`2502d2157`, reverting `64505e36e` from 0.43.0): it was the first half of a migration whose second half never landed, leaving two protocol stacks while v1 stayed the only surface in use. The fork followed in `packages/kimi-agent/ROADMAP.md` §8.11 (commit `86f30ecc2c`): `/api/v3/ws`, the turn-paged history route, `server/v3/`, and `packages/protocol/src/v3.ts` are gone, and kimi-inspect reads `transcript.reset` / `transcript.ops` over `/api/v1/ws`. **v1 is now the only protocol axis** — do not reintroduce a second one without the user's permission.

  A new event name, payload field, state-machine arm, policy step, route, or entity with no counterpart on its own axis requires the user's permission before implementation, and the granted delta is then recorded in `packages/kimi-agent/ROADMAP.md`. Fork-original modules already recorded there (sandbox guard, stale guard, team/memory/knowledge, mode mutex) stand as they are.
- **What counts as evidence.** Where a name or shape is defined in the TypeScript references, cite the file. A name the committed `apps/kimi-code/dist-web` bundle consumes is evidence too, even when it is defined nowhere in `upstream`'s source tree — some web-facing vocabulary exists only in that synced bundle. A name only the fork's Rust emits is not evidence, and a consumer's tolerance never justifies extending a vocabulary with names the fork invented.
- **Upstream engine behavior lands in Rust, not in TS.** Resolve the TS conflict by taking `theirs` so the TS build and tests stay faithful to upstream's shape, then register the behavior delta as a work item in `packages/kimi-agent/ROADMAP.md`. Do not re-implement new upstream engine behavior in TS — that builds the thing being retired.
- **The retired-package delta ratchet is the mechanical half of this policy.** `bun run check:upstream-v2-delta` requires every upstream commit touching a deleted package since the merge base to carry a recorded verdict in `scripts/upstream-v2-delta-allowlist.json` (`ported` / `tracked` / `not-applicable`; `pending` or absent fails). It is wired into CI, but **fetch the ref first**: it reads `refs/remotes/upstream/main`, and a stale ref silently narrows the range and prints a green "all triaged" — `git fetch upstream main:refs/remotes/upstream/main --force`. Deleting those packages is exactly why the delta is invisible to `git log`; this gate exists because 21 behavior commits once piled up unnoticed (ROADMAP §6.0).
- **Node-side toolchain content is never pulled back** — see Environment Requirements above. Audit the **auto-merged index**, not just conflicted files: git merges `package.json`, `flake.nix`, `vitest.config.ts`, and `.github/workflows` without asking, so a Node floor or a pnpm job can land silently.
- **pi-tui is a second upstream** (`earendil-works/pi`, vendored). It is outside the MoonshotAI merge policy above — sync it per `packages/pi-tui/UPSTREAM.md` (intent-card contract), not via this section.
- **Fork-only files upstream deletes stay deleted only when the fork's coupling is migrated.** A modify/delete conflict is not resolved by `git rm` alone — grep the removed module for importers first; fork-only importers (absent from both base and upstream) mean the fork built on top of it and needs a new home.
- `packages/node-sdk` is `@moonshot-ai/kimi-code-sdk`, the internal SDK seam used by `apps/kimi-code` and `apps/vscode`. Its directory name refers to its Node runtime target; it is product surface, not toolchain.

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

## Experimental Features

- Gate a not-yet-public feature behind an experimental flag. Precedence is per-flag env > `[experimental]` config > master env > the flag's `default` — an explicit `[experimental]` entry in `config.toml` overrides the `KIMI_CODE_EXPERIMENTAL_FLAG` master switch:
  - `KIMI_CODE_EXPERIMENTAL_<NAME>` toggles one
  - `KIMI_CODE_EXPERIMENTAL_FLAG` enables all
- Release by flipping the flag's `default` to `true`.

---

## Commit Convention (Conventional Commits)

- Commit messages follow Conventional Commits (`feat:`, `fix:`, `chore:`, ...). PR titles are enforced by the `pr-title-checker.yml` workflow.

## Where to Update Instructions

- Hard rules that affect almost every task: update the root `AGENTS.md`.
- Rules that only affect a specific directory: update the nearest sub-directory `AGENTS.md`.
- Keep instruction updates focused and supported by code facts.

## Working Principles

- Think from first principles. Start from real requirements, code facts, and verification results; if the goal is unclear, discuss it with the user first.
- Treat code, not documentation, as the source of truth. Unless the user explicitly says otherwise, do not read ordinary Markdown just to understand the implementation.
- Before making code changes, read the relevant code and the most recent constraints, and follow the nearest `AGENTS.md` in the directory tree.
- Keep changes focused. Do not slip in unrelated refactors along the way.
- When committing, do not add any co-author attribution, and do not reveal the identity of the agent in commit messages, PR descriptions, or any explanatory text.
- Push every commit to `origin` immediately after `git commit`. Never let local and remote diverge — applies to feature, fix, and experimental branches alike, so local work is never lost and the remote does not fall behind.

## Verification Standard (normative)

**A passing suite is a possible result, not the target result.** The target is the user's actual scenario working end to end. A green suite says only that the paths it exercises still behave as they did — when the implementation is wrong, the test encodes the wrongness and stays green.

**Before porting a behavior, diff both references first.** `.tmp/v2-ref-upstream` is a checkout of `upstream/main` (its own `git log -1` / `git remote -v` name the commit and origin); `.tmp/v2-ref` holds the retired packages as they stood before the fork deleted them at `ecad4136d9`. Today `agent-core-v2` (the v2 engine reference) is byte-identical across the two, but `kap-server` / `klient` / `acp-server` — which carry both the v1 and v3 protocol references — exist only in the retired reference, and `.tmp/v2-ref` drifts each time it is refreshed on its own — so compare the exact file you intend to cite, from the reference that actually has it. `.tmp/v2-ref-upstream` is a sparse checkout (`packages/agent-core-v2`, `kosong`, `minidb`, `oauth`, `transcript`), so it has no `kap-server` at all. A claim that a name "is not in v2" is only as good as the reference searched; searching the fork's own Rust source does not prove it. The web client living in the committed `apps/kimi-code/dist-web` bundle is a further reference: what it consumes is a contract, even when the name is defined nowhere in either tree.

- **Empirical, not plausible.** Before claiming a behavior works, drive it through the real path — the real engine, the real host seam, the real config — and observe the outcome. Reading the code and concluding "this should work" is not verification. Neither is a unit test whose inputs you constructed to match the implementation.
- **v2 is the behavioral reference.** Where the fork reimplements a v2 behavior, read v2's wiring first (`.tmp/v2-ref/`, refreshed from `upstream/main`) and compare against it — the policy order, the tool list, the event that drives the UI. Do not infer the intended behavior from the fork's own code; that only re-derives the fork's bugs.
- **Consult both v2 references, not one.** A port is not verified until both checkouts have been read: the fork's retired reference (`.tmp/v2-ref` — the packages as they stood before deletion, and the only place `kap-server` / `klient` / `acp-server` and the v1 / v3 protocol wiring exist) **and** the official upstream (`.tmp/v2-ref-upstream` — `upstream/main`). `agent-core-v2` is currently byte-identical across the two, but treat that as a fact to re-check, not to assume. When a file exists in only one, cite the one that has it; when the two disagree on a shared file, surface the difference as a finding instead of silently picking a side.
- **Reproduce before fixing.** A reported bug is not understood until it is reproduced on demand. If it cannot be reproduced, say so and ask for the exact sequence rather than fixing a guess.
- **Name what was not verified.** When a path could not be exercised, state it plainly instead of implying coverage.

## Workflow Requirements

- Prefer `rg` / `rg --files` when reading code.
- When designing changes, follow existing boundaries and local patterns first.
- In public text and test data, replace real internal identifiers with neutral placeholders such as `example.com`, `example.test`, and `YOUR_API_KEY`. Before opening a PR, ask a read-only agent to audit the diff for context-specific internal identifiers.
- When creating a PR, use the `write-pr` skill (`.agents/skills/write-pr/SKILL.md`) to write the PR description. The PR title must follow Conventional Commit style, e.g. `chore: remove legacy format commands`.
- When an AI agent opens or updates a PR, fill in `.github/pull_request_template.md` — link the related issue or explain the problem, then describe what changed. Do not leave placeholder text or submit a generic summary of the diff.
- Do not submit vague AI-generated PR text. The human author must understand the change well enough to explain the code, edge cases, and why the approach fits this repository.
- After finishing a task and before submitting a PR, you must run the `gen-changesets` skill (see `.agents/skills/gen-changesets/SKILL.md`) and generate a changeset under `.changeset/` according to its rules.
- Changesets must strictly follow the rules in `.agents/skills/gen-changesets/SKILL.md`: write one short user-facing sentence that states only what changed, and skip any change users cannot perceive.
- When generating a changeset, **never** decide on a `major` bump on your own — stop, explain, and get explicit user confirmation first; default to `minor`, fall back to `patch`. See `.agents/skills/gen-changesets/SKILL.md`.
- Prefer importing via `import ... from '#/...'`, which serves the same purpose as `import ... from '@/...'`.
- Do not commit throwaway scratch or exploratory files. Never stage:
  - Agent working notes or handoff/summary documents (e.g. `HANDOVER-*.md`, `HANDOFF-*.md`, `handoff.md`).
  - Throwaway UI/UX prototypes or design mockups (e.g. `*-designs.html`, `*-mockup.html`, `*-demo(s).html`) at the repo root or under a `design/` folder. The only tracked `.html` files should be Vite `index.html` entrypoints.
  Before committing or opening a PR, run `git status` and `git diff --staged --stat` and remove anything matching these patterns. Put scratch work under `.tmp/` (gitignored) instead of the repo root or the source tree.
