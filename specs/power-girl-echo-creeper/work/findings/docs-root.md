# 根级与用户文档审计（README / CONTRIBUTING / DEVELOP / SECURITY / GOAL / docs）

范围：`README.md`、`README.zh-CN.md`、`CONTRIBUTING.md`、`CONTRIBUTING.zh-CN.md`、`DEVELOP.md`、`SECURITY.md`、`GOAL.md`、`docs/index.md`、`docs/DEVELOP.md`。
方法：逐条把文档里的可验证断言（命令、路径、文件名、数量、默认值、版本号、flag/命令名、CI 作业清单、workspace 成员、斜杠命令数量）与代码对照。

## 发现

- `DEVELOP.md:358` — 类别 3 · 中 — 文档声称推送 `main` 后 changesets action 会打开/更新 **"ci: release packages"** PR 并汇总 changelog；实际 `.github/workflows/release.yml:60-72` 已把 `changesets/action@v1` 整段注释掉（同文件 `release.yml:16-17` 注释写明 "Dormant on this fork: the changesets and kimi-release steps below are commented out, so these outputs are permanently empty and downstream jobs gated on them never run"），`release` job 的 `packages_published` 输出恒为空，`deploy-docs`/`native-artifacts` 永不运行。同一声明另见 `CONTRIBUTING.md:254`、`CONTRIBUTING.zh-CN.md:253`（依据：`.github/workflows/release.yml:60`）。
- `DEVELOP.md:268` — 类别 3 · 中 — 文档声称「Node.js 不再为任何开发流程所需……CI 不安装 Node」；实际 `flake.nix:31` 硬性要求 `minNodeVersion = "24.15.0"`，`flake.nix:35-47` 在 nixpkgs 提供的 Node 低于该版本时直接 `throw`，`flake.nix:309` 把 `nodejs` 放进 `kimi-code` 的 `nativeBuildInputs`，`flake.nix:378` 用 `node apps/kimi-code/scripts/check-web-assets.mjs` 执行构建步骤，devShell（`flake.nix:429`）也包含 `nodejs`；而 `nix-build.yml` 在每次 PR 与 push 到 `main` 时运行。同一说法另见 `DEVELOP.md:24`、`README.md:112`、`README.zh-CN.md:115`、`CONTRIBUTING.md:40`、`CONTRIBUTING.zh-CN.md:40`（依据：`flake.nix:31`）。
- `CONTRIBUTING.md:122` — 类别 1 · 中 — 文档让贡献者用 `node $env:USERPROFILE\.kimi-code\dist\main.mjs` 运行本地构建，`CONTRIBUTING.md:142` 生成的 `kimi.cmd` 启动器同样用 `node "%KIMI_CODE_HOME%\dist\main.mjs"`；实际该产物由 `apps/kimi-code/tsdown.config.ts:19` 注入 `#!/usr/bin/env bun` shebang，仓库自己的运行方式是 `apps/kimi-code/package.json:73` 的 `"dev:prod": "bun dist/main.mjs"`，且同一文档 `CONTRIBUTING.md:40` 声称不再需要 Node。中文版同：`CONTRIBUTING.zh-CN.md:121`、`CONTRIBUTING.zh-CN.md:141`（依据：`apps/kimi-code/tsdown.config.ts:19`）。
- `DEVELOP.md:180` — 类别 3 · 低 — 文档称 `agent-core-v2` 为 v0.4.1；实际 `packages/agent-core-v2/package.json:3` 是 `"version": "0.4.3"`（依据：`packages/agent-core-v2/package.json:3`）。
- `DEVELOP.md:182` — 类别 3 · 低 — 文档称 `kosong` 为 v0.5.5；实际 `packages/kosong/package.json:3` 是 `"version": "0.5.6"`（依据：`packages/kosong/package.json:3`）。
- `DEVELOP.md:188` — 类别 3 · 低 — 文档称 `transcript` 为 v0.0.1；实际 `packages/transcript/package.json:3` 是 `"version": "0.0.2"`（依据：`packages/transcript/package.json:3`）。
- `DEVELOP.md:253` — 类别 3 · 低 — 文档称 "The three baseline files are ledgers of findings someone has already looked at"；实际 `tools/review/` 下有 4 个 baseline 文件，分别由 `tools/review/src/checks/dangling_refs.zig:23`、`orphan_exports.zig:17`、`scripts_wiring.zig:32`、`silent_catch.zig:17` 加载（另有 `upstream-drift-allow.txt` 由 `upstream_drift.zig:12` 加载），`DEVELOP.md:228-233` 的目录树也只列了 3 个（依据：`tools/review/src/checks/scripts_wiring.zig:32`）。
- `DEVELOP.md:307` — 类别 3 · 低 — 文档注释称 `make rust-build` 执行 `cargo build --release -p kimi-agent`；实际 `Makefile:66-67` 是 `cd packages/kimi-agent && cargo build --release`，仓库根没有 Cargo workspace（无根 `Cargo.toml`），`-p kimi-agent` 从未被传入（依据：`Makefile:67`）。

## 已核对为真（不构成发现）

- `DEVELOP.md:119` 的 46 个斜杠命令与 `apps/kimi-code/src/tui/commands/registry.ts` 的 `BUILTIN_SLASH_COMMANDS` 逐项一致，数量正好 46；`DEVELOP.md:103` 的 "46 commands" 亦一致。
- `DEVELOP.md:117` 的 CLI 子命令（含隐藏的 `install-app`、`__update_download`、`__plugin_run_node`）与 `apps/kimi-code/src/cli/commands.ts`、`src/cli/sub/install-desktop.ts:19` 一致。
- `DEVELOP.md:340-354` 的 CI 作业清单与 `.github/workflows/ci.yml` 一致：build / test（5 分片）/ test-pi-tui / test-minidb / test-kimi-web / lint / typecheck / review，`test-windows` 确为 `if: false`（`ci.yml:130`），全部作业用 `oven-sh/setup-bun`，`ci.yml` 内无 Node 安装；`DEVELOP.md:354` 列出的 10 个附加 workflow 全部存在。
- `DEVELOP.md:503` 的 workspace globs 与根 `package.json` 的 `workspaces.packages` 完全一致；`flake.nix` 的 `workspacePaths` 26 项与 `packages/*` + `apps/*`（除 kimi-web）+ `apps/vis/server` + `apps/vis/web` + `docs` 一致。
- `DEVELOP.md:201` 的 `plugins/cdn/` 目录当前不存在，但 `.gitignore:17` 忽略它、由 `apps/kimi-code/scripts/build-plugin-marketplace-cdn.mjs:14` 生成，文档已标注 "(gitignored)"，属预期。
- `DEVELOP.md:526` 的 flag 默认值（tower=false、tool_select/wait_for/xunfei_coding_plan=true）与 `packages/agent-core-v2/src/features/tower/flag.ts:14`、`src/agent/toolSelect/flag.ts:12`、`src/agent/tools/task/task-wait/flag.ts:12`、`src/features/astron/flag.ts:12` 一致；`DEVELOP.md:526` 的优先级链与 `src/app/flag/flagService.ts:78-83` 一致。
- `DEVELOP.md:400-406` 的 tsconfig 选项、`DEVELOP.md:384-395` 的 oxlint 规则与忽略项、`DEVELOP.md:485-491` 的 overrides、`DEVELOP.md:519` 的 changesets ignore 列表、`DEVELOP.md:445-453` 的 vitest projects、`DEVELOP.md:562`/`578` 的 skill 与契约文件路径，均与代码一致。
- `README.md:43` 的 Windows shell 探测顺序（PowerShell 7 → Windows PowerShell → Git Bash）实现在 `packages/kimi-native-tools/src/bash.rs:256-257`，属实。
- `CONTRIBUTING.md:64` 的 `bun --bun run test` 为 CI 实际命令（`ci.yml:62`）；`CONTRIBUTING.md:65` 的 typecheck 覆盖范围与根 `package.json` 的 `typecheck` 脚本一致（`packages/kimi-agent`、`packages/kimi-native-tools` 无 `typecheck` 脚本、无 `tsconfig.json`）。
