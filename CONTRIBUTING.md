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
- `packages/agent-core-v2` — the agent engine (v2, DI Scope architecture); the v1 `packages/agent-core` is deleted in this fork (see "Syncing upstream" below)
- `packages/klient`, `kap-server`, `remote-control`, `transcript`, `kosong`, `kaos`, `oauth`, `telemetry` — internal engine packages
- `docs/` — VitePress bilingual docs site

For the full project map, see [DEVELOP.md](DEVELOP.md).

## Development Setup

Prerequisites: Bun >= 1.4, Git. Node.js is no longer required for the Bun-based development workflow — the vitest suites run under the Bun runtime (`bun --bun run test`; plain `bun run test` keeps working under a local Node too). The Nix build path (`flake.nix`, `nix-build.yml`) still requires Node.js >= 24.15.0.

```sh
git clone https://github.com/7723qqq/kimi-code.git
cd kimi-code
bun install
```

> **Bun version note:** the committed `bun.lock` is lockfileVersion 3
> (required by the nested `overrides`), so Bun **>= 1.4** is mandatory —
> older Bun releases cannot read it. Also, after upgrading your local Bun,
> the first `bun install` re-applies `patches/ssh2@1.17.0.patch` once; the
> patch cache key changed from a 16 KiB hash to the full-file SHA-1. This is
> expected, not a bug.

**Syncing upstream:** this fork deletes `packages/agent-core` (the v1 engine)
while upstream keeps patching it. `.gitattributes` marks those paths
`merge=ours`, so merges auto-resolve to "kept deleted" instead of raising
modify/delete conflicts. One-time setup per clone:
`git config merge.ours.driver true`.

Useful scripts:

- `bun run dev:local` — run the CLI in dev mode from a fresh bundle (incremental, ~2s). Add `:watch` (`bun run dev:local:watch`) to rebuild and re-run on every source change. **Use this rather than `bun run dev:cli`:** that path executes `src/main.ts` directly, and Bun does not resolve the `#/*` subpath imports the packages rely on, so it aborts with `Cannot find module '#/kimi-harness'`.
- `bun --bun run test` — run tests (vitest). **This is the canonical command and what CI runs** (`.github/workflows/ci.yml`). The `--bun` flag runs vitest on the Bun runtime rather than Node, and the two produce different results: `bunx vitest` has been observed to pass while `bun --bun run test` fails on the same code. Always use `bun --bun run test` when checking whether a suite is green.
- `bun run typecheck` — TypeScript check (note: builds packages first). Covers `packages/*` plus the `kimi-code`, `kimi-inspect`, `vscode`, `vis/server`, `vis/web` and `kimi-web` apps. It does **not** cover `docs/` (VitePress content) or `packages/kimi-agent` and `packages/kimi-native-tools` (Rust/native, no `tsconfig`).
- `bun run build:docs` — build the user documentation. VitePress fails on dead internal links, so run this after editing anything under `docs/`.
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

These are inputs to the bundler and the native build, not a deployable tree; see [Deploy to local `.kimi-code` for testing](#deploy-to-local-kimi-code-for-testing) for what to do with them.

### Deploy to local `.kimi-code` for testing

There are two ways to run a local build, and they are not interchangeable.

**For iterating on code**, use `bun run dev:local` (see [Development Setup](#development-setup)). It bundles and runs in one step (~2s, incremental with `:watch`) and needs no install.

**To replace the installed `kimi` command**, build the self-contained binary and copy it over the installed one — see [Native build](#native-build-self-contained-binary) below. The published package is that single-file binary, so this is the only way to get a local build running as `kimi`.

> **Do not copy `apps/kimi-code/dist/` into `~/.kimi-code/`.** That layout cannot run: the bundle resolves the native addon and its runtime dependencies at load time, and a `dist/` copy carries neither. Copying the `.node` file into `dist/chunks/` does not fix it either — the loader needs `@moonshot-ai/kimi-native-tools` as a resolvable package, and then the next dependency (`qrcode`, `ws`, `@moonshot-ai/kimi-agent`) is missing in turn. `dist/` is build output for the bundler, not a deployable tree.

### Native build (self-contained binary)

The native build compiles the CLI into a standalone single-file executable with Bun. Requires Bun >= 1.4 (`curl -fsSL https://bun.sh/install | bash`; see [bun.sh](https://bun.sh)); the build script itself runs under Bun as well. A Rust toolchain is required because the `kimi-native-tools` `.node` binary is embedded.

Windows (x64):

```sh
cd apps/kimi-code && bun run build:native:bun:release
```

Output: `apps/kimi-code/dist-native/bin/win32-x64/kimi.exe`

Linux (x64):

```sh
cd apps/kimi-code
bun run build:native:bun
```

The `build:native:bun` script already runs the JS bundle step with the `local` profile.

Output: `apps/kimi-code/dist-native/bin/linux-x64/kimi` (~160 MB)

Deploy to local `.kimi-code`:

```bash
cp apps/kimi-code/dist-native/bin/linux-x64/kimi ~/.kimi-code/bin/kimi
```

If the running `kimi` process is already using the binary (Text file busy):

```bash
cp apps/kimi-code/dist-native/bin/linux-x64/kimi ~/.kimi-code/bin/kimi-new
mv ~/.kimi-code/bin/kimi-new ~/.kimi-code/bin/kimi
```

> **Note**: The native build requires `@moonshot-ai/kimi-native-tools` listed as a dependency in `apps/kimi-code/package.json` and registered in `apps/kimi-code/scripts/native/native-deps.mjs`. See [Common Issues](#common-issues) for known pitfalls.

`--profile=release` (`bun run build:native:bun:release`) generates the built-in catalog, signs with `APPLE_SIGNING_IDENTITY` on macOS, and runs the codesign self-check. CI builds all six targets in the `native-bundle-bun` job of `_native-build.yml` (packaged as `kimi-code-bun-<target>.zip` via `KIMI_CODE_NATIVE_ENGINE=bun`).

Output: `apps/kimi-code/dist-native/bin/<target>/kimi`.

Bun bytecode is disabled by default: it measured no startup gain on this pipeline, while bytecode adds binary size and locks the artifact to the exact Bun version that built it. Set `KIMI_CODE_BUN_ENABLE_BYTECODE=1` to embed bytecode anyway. When enabled, the compile step passes `--bytecode --format=esm`: bare `--bytecode` defaults to CommonJS output, which cannot express top-level `await`, while ESM bytecode has supported top-level `await` since Bun v1.3.9.

Runtime integration notes:

- Packaged builds resolve pi-tui's platform helper from the extracted asset cache at load time.
- Built-in URL-fetch keeps SSRF guard semantics identical by defaulting to the bundled `undici` fetch (Bun's global fetch silently ignores its pinned-DNS dispatcher option).
- Self-update is engine-aware: the native manifest carries a single Bun section, a Bun packaged binary downloads the release's matching Bun artifact, and refuses to fall back to any other engine's binary.
- `/status` reports the packaging engine and native-tools implementation (`Runtime  bun · rust`).
- Bun auto-loads `.env` files (the previous pnpm-era dev flow did not); run `bun --no-env-file` when you need the old behavior.

To measure startup cost of a build, copy it aside (it writes to `dist-native/bin/<target>/kimi`) and run:

```sh
bun scripts/native/bench-native.mjs ./dist-native/bin/linux-x64/kimi --runs 20
```

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
| `ERR_UNKNOWN_BUILTIN_MODULE: @moonshot-ai/kimi-native-tools` in the packaged binary | Native module not registered in `native-deps.mjs` | Add entry to `nativeDeps` array with `collect: 'native-files'` |
| `packages/i18n-shared` build fails with `UNRESOLVED_ENTRY` | Missing `src/index.ts` | Create `src/index.ts` re-exporting types, core, and detect modules |
| `kimi.exe` from CDN shows English despite `locale=zh` | The CDN binary includes only the bundled locale; download date determines version | Build locally or wait for next CDN release |
| Unexpected env vars appear under `bun run` | Bun auto-loads `.env` (the pnpm-era dev flow did not) | Remove or rename the file, or run `bun --no-env-file` |
| Nix build fails with `hash mismatch in fixed-output derivation '...bun-deps...'` | `bun.lock` or a `Cargo.lock` changed, so the vendored-dependencies FOD output changed | Set `outputHash` in `flake.nix` to `lib.fakeSha256`, push, then paste the `got:` hash from the failure (the nix-build bot posts it on PRs) |

## Commit Convention

All commits and PR titles must follow [Conventional Commits](https://www.conventionalcommits.org/).

| Type     | Use for                                     | Example                                   |
|----------|---------------------------------------------|-------------------------------------------|
| feat     | A new feature                               | feat(agent-core-v2): add tool dedup       |
| fix      | A bug fix                                   | fix(tui): correct status bar alignment    |
| docs     | Documentation only                          | docs: clarify install instructions        |
| chore    | Tooling / housekeeping                      | chore: bump dependencies                  |
| refactor | Internal refactor without behavior change   | refactor(kosong): extract retry helper    |
| test     | Adding or improving tests                   | test(agent-core-v2): cover skill resolver |
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

Every push to `main` runs the Release workflow, which installs dependencies, builds all workspace packages, and builds the built-in catalog. The `changesets/action@v1` step that used to open or update a **"ci: release packages"** PR (branch `changeset-release/main`) is **commented out on this fork**, so no such PR is opened and nothing is published to npm.

- Changesets are still required on PRs: they are the changelog source, and the action is re-enabled when a standalone release is needed.
- Before an intentional release, preview the user-facing changelog with the `pre-changelog` skill, then prune accumulated non-user-facing changesets from `main`.

### Publishing binaries

`release-native.yml` builds and publishes the CLI binaries for all six targets. Push a version tag (`v2.1.1` or `@moonshot-ai/kimi-code@2.1.1`) to trigger it, or run the workflow manually with an existing tag.

- The tag's version must match `apps/kimi-code/package.json`; the run fails before publishing otherwise, so bump the version and merge it before tagging.
- Release notes come from the matching section of `apps/kimi-code/CHANGELOG.md`. When that section is missing the release body falls back to a generic one instead of failing.
- Without the Apple or Azure secrets the build still succeeds and publishes unsigned binaries. See DEVELOP → "Native release".

## Pull Requests

Every PR opens with the [PR template](.github/pull_request_template.md). PR titles must follow [Conventional Commits](#commit-convention); CI runs `bun run lint`, `bun run typecheck`, and `bun --bun run test` on every PR. Update user-facing docs in `docs/` when behavior changes — use the `gen-docs` skill when working with coding agents.

## Code Style

- TypeScript across the codebase.
- Linting via `oxlint` (config in `.oxlintrc.json`).
- Auto-formatting via `bun run lint:fix`.
- Follow existing local patterns when the lint rules do not cover a style choice.

### Text and language

`DEVELOP.md` → "i18n Conventions" is the normative version; this is the short form.

Before writing a string, classify it: **UI copy** (a person reads it → `t()` in both locales),
**model asset** (the LLM reads it → English, stays English), **protocol data** (code branches on
it → a stable id, never a rendered label), or **diagnostic** (logs and internal throws → plain
English is fine).

Four things that will fail CI rather than review:

- a prose literal outside `t()` in a UI tree (`check:no-hardcoded-prose`; the ledger is
  shrink-only, so do not add an entry);
- an engine error code without `errorCodes.*` in both locales (`check-t-call-coverage`; scaffold
  with `bun scripts/gen-error-locale-skeleton.mjs`, then rewrite the wording);
- comparing message text, e.g. `reason === 'Paused after interruption'`
  (`tools/review --check=text-as-protocol` — export the constant instead);
- editing one locale and not the other (`check-locale-keys`).

A rendered label never travels on the wire: when a choice comes back from the UI it is the id
(`reject`, `revise`, `auto`), and the label is looked up where it is displayed.

## Reporting Security Issues

Found a security issue? Please see [SECURITY.md](SECURITY.md) instead of opening a public issue.

## License

By contributing to this repository, you agree that your contributions will be licensed under the [MIT License](LICENSE).
