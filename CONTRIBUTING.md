# Contributing to kimi-code

[中文版](CONTRIBUTING.zh-CN.md)

Thanks for taking the time to contribute! This project moves quickly, and thoughtful contributions from the community are what keep it sharp. The guide below walks you through how we work so your PR has the best chance of landing smoothly.

## Before You Start

Kimi Code already has opinions on CLI/TUI behavior, agent workflows, and public APIs. If your change shifts that direction, open an issue first so we can align before you invest time in a PR.

We hold AI-assisted contributions to the same standard as hand-written ones. **You should understand what you submit** — what changed, how it behaves at the edges, and why it fits this codebase. If you cannot explain that, the PR is not ready for review.

We only merge PRs aligned with the roadmap. Drive-by refactors without context are unlikely to land.

**External PRs are accepted for approved bug fixes only.** Open an issue first and wait for a maintainer to approve it with an `/approve` comment, then link that issue in your PR. PRs without an approved linked issue may be closed without review; once the issue is approved, ask a maintainer to reopen your PR.

**Discuss first** — open an issue before coding:

- Bug fixes, including small or typo-level ones: open a bug issue and wait for a maintainer's `/approve` before opening the PR
- New features or user-visible behavior changes (regardless of size): external feature PRs are not accepted — features are discussed and decided in issues, and accepted features are implemented by the team or by explicit maintainer invitation
- Refactors or other changes larger than ~100 lines
- Public API or compatibility changes

## Project Layout

This is a Bun monorepo. The most relevant entry points are:

- `apps/kimi-code` — CLI / TUI
- `apps/vscode` — VS Code extension
- `apps/vis` — session debug visualizer
- `packages/node-sdk` — public TypeScript SDK (`@moonshot-ai/kimi-code-sdk`)
- `packages/agent-core-v2` — the agent engine (v2, DI Scope architecture); `packages/agent-core` is v1 and being phased out
- `packages/klient`, `kap-server`, `protocol`, `transcript`, `kosong`, `kaos`, `oauth`, `telemetry` — internal engine packages
- `docs/` — VitePress bilingual docs site

For the full project map, see [AGENTS.md](AGENTS.md).

## Development Setup

Prerequisites: Node.js >= 24.15.0, Bun >= 1.4, Git.

```sh
git clone https://github.com/7723qqq/kimi-code.git
cd kimi-code
bun install
```

Useful scripts:

- `bun run dev:cli` — run the CLI in dev mode
- `bun run test` — run tests (vitest)
- `bun run typecheck` — TypeScript check (note: builds packages first)
- `bun run lint` — oxlint
- `bun run lint:fix` — oxlint with auto-fix
- `bun run build` — build all packages

## Build & Local Deploy

After making changes, build the full project:

```sh
bun run build
```

If you only changed code under `apps/kimi-code`, you can build just that package:

```sh
cd apps/kimi-code && bun run build
```

This produces:

| Output | Path |
|--------|------|
| CLI entry (ESM) | `apps/kimi-code/dist/main.mjs` |
| Web UI assets | `apps/kimi-code/dist-web/` |
| Native prebuilds | `apps/kimi-code/native/` |

### Deploy to local `.kimi-code` for testing

To run your local build instead of the released binary:

1. **Sync dist files** to the Kimi Code home directory:

```powershell
# Remove old dist
Remove-Item -Recurse -Force "$env:USERPROFILE\.kimi-code\dist" -ErrorAction SilentlyContinue
# Create fresh directory and copy contents
New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.kimi-code\dist"
Copy-Item -Recurse -Force apps/kimi-code/dist/* "$env:USERPROFILE\.kimi-code\dist\"

# Sync web assets
Remove-Item -Recurse -Force "$env:USERPROFILE\.kimi-code\dist-web" -ErrorAction SilentlyContinue
Copy-Item -Recurse -Force apps/kimi-code/dist-web "$env:USERPROFILE\.kimi-code\dist-web"
```

2. **Copy native `.node` files** into `dist/chunks/` (the ESM bundle resolves relative requires from chunk files):

```powershell
Copy-Item -Force packages/kimi-native-tools/kimi-native-tools.win32-x64-msvc.node `
    "$env:USERPROFILE\.kimi-code\dist\chunks\"
```

3. **Run with locale** (set `KIMI_LANG=zh` for Chinese interface):

```powershell
$env:KIMI_LANG="zh"
node $env:USERPROFILE\.kimi-code\dist\main.mjs
```

To make `kimi` command use the local build, rename the CDN binary and create a launcher:

```powershell
Rename-Item "$env:USERPROFILE\.kimi-code\bin\kimi.exe" "kimi.cdn.exe"
```

Create `$env:USERPROFILE\.kimi-code\bin\kimi.cmd`:

```bat
@echo off
setlocal
if "%KIMI_LANG%"=="" (
    for /f "tokens=2 delims== " %%a in (
        'type "%USERPROFILE%\.kimi-code\tui.toml" 2^>nul ^| findstr /r "^locale"'
    ) do set KIMI_LANG=%%~a
)
set KIMI_CODE_HOME=%USERPROFILE%\.kimi-code
node "%KIMI_CODE_HOME%\dist\main.mjs" %*
```

### Native SEA build (self-contained `.exe`)

The native build produces a standalone executable using Node.js Single Executable Applications. Requires Rust toolchain (MSVC on Windows).

```sh
cd apps/kimi-code && bun run build:native:release
```

Output: `apps/kimi-code/dist-native/bin/win32-x64/kimi.exe`

#### Linux (x64)

```sh
cd apps/kimi-code
bun run build:native:js
bun run build:native:sea
```

The `build:native:sea` script already runs the JS bundle step with the `local` profile.

Output: `apps/kimi-code/dist-native/bin/linux-x64/kimi` (~166 MB)

Deploy to local `.kimi-code`:

```bash
cp apps/kimi-code/dist-native/bin/linux-x64/kimi ~/.kimi-code/bin/kimi
```

If the running `kimi` process is already using the binary (Text file busy):

```bash
cp apps/kimi-code/dist-native/bin/linux-x64/kimi ~/.kimi-code/bin/kimi-new
mv ~/.kimi-code/bin/kimi-new ~/.kimi-code/bin/kimi
```

> **Note**: The SEA build currently requires `@moonshot-ai/kimi-native-tools` listed as a dependency in `apps/kimi-code/package.json` and registered in `apps/kimi-code/scripts/native/native-deps.mjs`. See [Common Issues](#common-issues) for known pitfalls.

### Bun migration (experimental)

An experimental single-file build compiles the CLI with Bun instead of Node.js SEA. Requires Bun >= 1.4 (`curl -fsSL https://bun.sh/install | bash`; see [bun.sh](https://bun.sh)). Node.js >= 24.15 still runs the build script itself, and a Rust toolchain is required because the `kimi-native-tools` `.node` binary is embedded.

From `apps/kimi-code`, run `node scripts/native/build-bun.mjs` (or `bun run build:native:bun`), then verify with the existing smoke test:

```sh
node scripts/native/build-bun.mjs
bun run test:native:smoke
```

`--profile=release` (`bun run build:native:bun:release`) mirrors the SEA release profile: it generates the built-in catalog, signs with `APPLE_SIGNING_IDENTITY` on macOS, and runs the codesign self-check. CI builds all six targets behind the `build-bun` input of `_native-build.yml` (packaged as `kimi-code-bun-<target>.zip` via `KIMI_CODE_NATIVE_ENGINE=bun`).

Output: `apps/kimi-code/dist-native/bin/<target>/kimi`.

Bun bytecode is disabled by default: it measured no startup gain on this pipeline, while bytecode adds binary size and locks the artifact to the exact Bun version that built it. Set `KIMI_CODE_BUN_ENABLE_BYTECODE=1` to embed bytecode anyway. Note the module format when enabling: bare `--bytecode` defaults to CommonJS output, which cannot express top-level `await`; Bun has supported top-level `await` in bytecode since v1.3.9 under `--format=esm`, but this pipeline keeps the CJS default, so the compile entry must stay free of top-level `await`.

Runtime integration stays shared with the SEA path where possible:

- Packaged builds resolve node-pty (with its PTY bindings) and pi-tui's platform helper from the extracted asset cache at load time, through the unified loader in `apps/kimi-code/src/native/node-pty.ts`; the superseded per-module hook shims (~780 lines of dead code) were removed. The release smoke dlopens the PTY binding on every target CI runs.
- Host terminal sessions work on both runtimes, with UTF-8 stream decoding adapted for Bun.
- Built-in URL-fetch keeps SSRF guard semantics identical across engines by defaulting to the bundled `undici` fetch (Bun's global fetch silently ignores its pinned-DNS dispatcher option).
- Self-update is engine-aware: the native manifest records the engine, a Bun packaged binary downloads the release's matching Bun artifact, and refuses to silently swap itself back to the Node SEA binary.
- `/status` reports the packaging engine and native-tools implementation (`Runtime  bun · rust`).

Status caveats: this pipeline is experimental and parallel to the default SEA pipeline (`build:native:sea`), which remains the release default. It has been validated hands-on on linux-x64 only; the other five targets build in CI but are still under verification. Cross-target staging requires that target's platform packages to be present locally (the collector fails fast otherwise). Both pipelines feed the same extraction/cache layer.

To compare startup cost between the two engines of one target, copy each build aside (both write to `dist-native/bin/<target>/kimi`) and run:

```sh
node scripts/native/bench-native.mjs /tmp/kimi-sea /tmp/kimi-bun --runs 20
```

Roadmap: the end goal is for Bun to fully replace Node.js SEA as the sole release engine, retiring the SEA build chain. The near-term path is full-platform CI verification → governing the bytecode / top-level-await limitations → flipping the default engine and retiring SEA. Until then, released binaries keep shipping from Node SEA by default.

### Nix build

`nix-build.yml` builds the CLI in a pure sandbox. Dependencies come from one fixed-output derivation (`bunDeps` in `flake.nix`) that materializes the hoisted `node_modules` tree plus cargo vendor directories for both napi packages (`kimi-native-tools`, `kimi-agent`); the main derivation then compiles offline. Sandbox quirks to know when editing `flake.nix` or native build steps:

- There is no `/usr/bin/env` in the sandbox — invoke `node-gyp` and the napi CLI through `node <js-entry>` instead of their bin shims.
- FOD outputs must not contain `/nix/store/...` strings: never let `cargo vendor` write its suggested config into the output, and never interpolate store paths into the install script.
- After changing `bun.lock` or either `Cargo.lock`, expect one hash-mismatch round: paste the `got:` hash (the nix-build bot posts it on PRs) into `outputHash`.

### Common Issues

| Symptom | Cause | Fix |
|---------|-------|-----|
| `Cannot find module '@moonshot-ai/i18n-shared'` | Workspace link broken; `bun install` hasn't re-linked after adding packages | Run `bun install` |
| `ERR_MODULE_NOT_FOUND` pointing to `src/index.ts` in `.kimi-code/node_modules` | Deployed package.json exports still point to source files | Edit exports to point to `dist/*.mjs` |
| `Failed to load kimi-native-tools binding` | `.node` files missing from `dist/chunks/` (the ESM bundle resolves from chunk directory) | Copy `.node` files directly into `dist/chunks/` |
| `ERR_UNKNOWN_BUILTIN_MODULE: @moonshot-ai/kimi-native-tools` in SEA binary | Native module not registered in `native-deps.mjs` | Add entry to `nativeDeps` array with `collect: 'native-files'` |
| `packages/i18n-shared` build fails with `UNRESOLVED_ENTRY` | Missing `src/index.ts` | Create `src/index.ts` re-exporting types, core, and detect modules |
| `kimi.exe` from CDN shows English despite `locale=zh` | The CDN binary includes only the bundled locale; download date determines version | Build locally or wait for next CDN release |
| Unexpected env vars appear under `bun run` | Bun auto-loads `.env` (the pnpm-era dev flow did not) | Remove or rename the file, or run `bun --no-env-file` |
| Nix build fails with `hash mismatch in fixed-output derivation '...bun-deps...'` | `bun.lock` or a `Cargo.lock` changed, so the vendored-dependencies FOD output changed | Set `outputHash` in `flake.nix` to `lib.fakeSha256`, push, then paste the `got:` hash from the failure (the nix-build bot posts it on PRs) |

## Commit Convention

All commits and PR titles must follow [Conventional Commits](https://www.conventionalcommits.org/).

| Type     | Use for                                     | Example                                   |
|----------|---------------------------------------------|-------------------------------------------|
| feat     | A new feature                               | feat(agent-core): add tool dedup          |
| fix      | A bug fix                                   | fix(tui): correct status bar alignment    |
| docs     | Documentation only                          | docs: clarify install instructions        |
| chore    | Tooling / housekeeping                      | chore: bump dependencies                  |
| refactor | Internal refactor without behavior change   | refactor(kosong): extract retry helper    |
| test     | Adding or improving tests                   | test(agent-core): cover skill resolver    |
| ci       | CI / build pipeline changes                 | ci: cache the bun package cache           |
| build    | Build system / artifact changes             | build(native): add win32-arm64 target     |
| perf     | Performance improvement                     | perf(session): batch event flushes        |
| style    | Formatting only (no logic)                  | style: apply oxlint --fix                 |

PR titles are enforced by the `pr-title-checker` workflow — a non-conforming title will block merge.

## Changesets

This repo uses [changesets](https://github.com/changesets/changesets) to manage versioning and releases.

- Every PR that affects release artifacts (code, behavior, public API) **must** include a changeset.
- Docs-only, test-only, or CI-only PRs may skip changesets.
- Generate one with `bun run changeset` and follow the prompts (which packages are touched, which bump level).
- For repo-specific conventions on package selection and bump levels, see `.changeset/README.md`. When working in this repo with coding agents, use the `gen-changesets` skill.

### Release flow on this fork

Every push to `main` runs the Release workflow: the changesets action opens or updates a **"ci: release packages"** PR (branch `changeset-release/main`) that bumps package versions and assembles the changelog.

- **Never merge that PR.** This fork follows upstream versions — package version fields must stay identical to upstream, and the release flow is kept only as a changelog source. Close the PR instead; the changelog preview in its description remains viewable after closing.
- The workflow requires the repo setting **Actions → General → "Allow GitHub Actions to create and approve pull requests"** to be enabled. If Release fails with `GitHub Actions is not permitted to create or approve pull requests`, flip that toggle (or via API: `PUT /repos/{owner}/{repo}/actions/permissions/workflow` with `can_approve_pull_request_reviews: true`).
- Before an intentional release, preview the user-facing changelog with the `pre-changelog` skill, then prune accumulated non-user-facing changesets from `main`.

## Pull Requests

Every PR opens with the [PR template](.github/pull_request_template.md). PR titles must follow [Conventional Commits](#commit-convention); CI runs `bun run lint`, `bun run typecheck`, and `bun run test` on every PR. Update user-facing docs in `docs/` when behavior changes — use the `gen-docs` skill when working with coding agents.

## Code Style

- TypeScript across the codebase.
- Linting via `oxlint` (config in `.oxlintrc.json`).
- Auto-formatting via `bun run lint:fix`.
- Follow existing local patterns when the lint rules do not cover a style choice.

## Reporting Security Issues

Found a security issue? Please see [SECURITY.md](SECURITY.md) instead of opening a public issue.

## License

By contributing to this repository, you agree that your contributions will be licensed under the [MIT License](LICENSE).
