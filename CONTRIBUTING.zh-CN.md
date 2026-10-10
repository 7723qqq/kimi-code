# 为 kimi-code 贡献代码

[English version](CONTRIBUTING.md)

感谢你花时间参与贡献！这个项目迭代很快，离不开社区认真的贡献。下面的指南介绍我们的工作方式，帮助你的 PR 顺利合入。

## 开始之前

Kimi Code 对 CLI/TUI 行为、agent 工作流和公开 API 已有自己的主张。如果你的改动会改变这些方向，请先开 issue 对齐，再投入时间写 PR。

我们对 AI 辅助贡献与手写代码一视同仁。**你应该理解自己提交的内容**——改了什么、边界情况下表现如何、为什么适合这个代码库。如果你解释不清楚，这个 PR 就还没准备好接受评审。

我们只合入与路线图一致的 PR。缺乏上下文背景的顺手重构很难被接受。

**外部 PR 仅接受获批准的 bug 修复。** 先开 issue，等待维护者以 `/approve` 评论明确批准，然后在 PR 中链接该 issue。没有已批准关联 issue 的 PR 可能会不经评审直接关闭；issue 获批后，可联系维护者重开你的 PR。

**先讨论**——写代码前先开 issue：

- bug 修复（包括小的、错别字级别的）：先开 bug issue，等待维护者 `/approve` 后再提 PR
- 新功能或用户可见的行为变更（无论大小）：不接受外部 feature PR——功能在 issue 中讨论和决定，被接受的功能由团队实现，或由维护者明确邀请你贡献
- 重构或其他超过约 100 行的改动
- 公开 API 或兼容性变更

## 项目结构

本仓库是 Bun monorepo，最常用的入口：

- `apps/kimi-code` — CLI / TUI
- `apps/vscode` — VS Code 插件
- `apps/vis` — 会话调试可视化工具
- `packages/node-sdk` — 公开 TypeScript SDK（`@moonshot-ai/kimi-code-sdk`）
- `packages/agent-core-v2` — 当前的 agent 引擎（v2，DI Scope 架构）；v1 的 `packages/agent-core` 在本 fork 中已整体删除（见下文「同步上游须知」）
- `packages/klient`、`kap-server`、`remote-control`、`transcript`、`kosong`、`kaos`、`oauth`、`telemetry` — 内部引擎包
- `docs/` — VitePress 双语文档站

完整项目地图见 [DEVELOP.md](DEVELOP.md)。

## 开发环境

前置要求：Bun >= 1.4、Git。Bun 开发流程不再需要 Node.js——vitest 测试套件在 Bun 运行时下执行（`bun --bun run test`；本机装有 Node 时，普通 `bun run test` 依旧可用）。Nix 构建路径（`flake.nix`、`nix-build.yml`）仍要求 Node.js >= 24.15.0。

```sh
git clone https://github.com/7723qqq/kimi-code.git
cd kimi-code
bun install
```

> **Bun 版本须知**：仓库提交的 `bun.lock` 是 lockfileVersion 3（由嵌套
> `overrides` 触发），必须使用 **Bun >= 1.4** —— 更旧的 Bun 无法读取。
> 另外，本机升级 Bun 后的第一次 `bun install` 会把
> `patches/ssh2@1.17.0.patch` 重新打一次：补丁缓存键已从「前 16KiB 哈希」
> 改为整文件 SHA-1，属预期行为而非故障。

**同步上游须知**：本 fork 已整体删除 `packages/agent-core`（v1 引擎），
而上游仍在持续修补它。`.gitattributes` 已将这些路径标记为
`merge=ours`，合并时自动保持删除态，不再产生 modify/delete 冲突。
每个克隆需一次性执行：`git config merge.ours.driver true`。

常用脚本：

- `bun run dev:local` — 从全新 bundle 以开发模式运行 CLI（增量，约 2 秒）。加 `:watch`（`bun run dev:local:watch`）可在源码变化时自动重建并重跑。**请用它而不是 `bun run dev:cli`**：后者直接执行 `src/main.ts`，而 Bun 不解析各包依赖的 `#/*` 子路径导入，会在启动时报 `Cannot find module '#/kimi-harness'`。
- `bun run test` — 运行测试（vitest）
- `bun --bun run test` — 运行测试（vitest）。**这是规范命令，也是 CI 使用的命令**（`.github/workflows/ci.yml`）。`--bun` 让 vitest 跑在 Bun 运行时而非 Node 上，两者结果会不同：实测出现过 `bunx vitest` 通过、而 `bun --bun run test` 在同一份代码上失败的情况。判断测试是否变绿时请一律使用 `bun --bun run test`。
- `bun run typecheck` — TypeScript 检查（注意：会先构建各包）。覆盖 `packages/*` 与 `kimi-code`、`kimi-inspect`、`vscode`、`vis/server`、`vis/web`、`kimi-web` 六个 app；**不覆盖** `docs/`（VitePress 内容）以及 `packages/kimi-agent`、`packages/kimi-native-tools`（Rust/原生，无 tsconfig）。
- `bun run build:docs` — 构建用户文档。VitePress 遇到失效的内部链接会直接失败，因此改动 `docs/` 下任何内容后请运行它。
- `bun run lint` — oxlint
- `bun run lint:fix` — oxlint 自动修复
- `bun run build` — 构建全部包

## 构建与本地部署

改动完成后，构建整个项目：

```sh
bun run build
```

如果只改了 `apps/kimi-code` 下的代码，也可以只构建该包：

```sh
cd apps/kimi-code && bun run build
```

构建产物如下：

| 产物 | 路径 |
|--------|------|
| CLI 入口（ESM） | `apps/kimi-code/dist/main.mjs` |
| Web UI 资源 | `apps/kimi-code/dist-web/` |
| 原生预编译产物 | `apps/kimi-code/native/` |

### 部署到本地 `.kimi-code` 进行测试

想用本地构建代替已发布的二进制：

1. **同步 dist 文件**到 Kimi Code home 目录：

```powershell
# 删除旧的 dist
Remove-Item -Recurse -Force "$env:USERPROFILE\.kimi-code\dist" -ErrorAction SilentlyContinue
# 新建目录并复制内容
New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.kimi-code\dist"
Copy-Item -Recurse -Force apps/kimi-code/dist/* "$env:USERPROFILE\.kimi-code\dist\"

# 同步 web 资源
Remove-Item -Recurse -Force "$env:USERPROFILE\.kimi-code\dist-web" -ErrorAction SilentlyContinue
Copy-Item -Recurse -Force apps/kimi-code/dist-web "$env:USERPROFILE\.kimi-code\dist-web"
```

2. **复制原生 `.node` 文件**到 `dist/chunks/`（ESM bundle 会从 chunk 文件所在目录解析相对 require）：

```powershell
Copy-Item -Force packages/kimi-native-tools/kimi-native-tools.win32-x64-msvc.node `
    "$env:USERPROFILE\.kimi-code\dist\chunks\"
```

3. **带语言设置运行**（设 `KIMI_LANG=zh` 使用中文界面）：

```powershell
$env:KIMI_LANG="zh"
bun $env:USERPROFILE\.kimi-code\dist\main.mjs
```

要让 `kimi` 命令使用本地构建，先把 CDN 二进制改名，再创建一个启动器：

```powershell
Rename-Item "$env:USERPROFILE\.kimi-code\bin\kimi.exe" "kimi.cdn.exe"
```

创建 `$env:USERPROFILE\.kimi-code\bin\kimi.cmd`：

```bat
@echo off
setlocal
if "%KIMI_LANG%"=="" (
    for /f "tokens=2 delims== " %%a in (
        'type "%USERPROFILE%\.kimi-code\tui.toml" 2^>nul ^| findstr /r "^locale"'
    ) do set KIMI_LANG=%%~a
)
set KIMI_CODE_HOME=%USERPROFILE%\.kimi-code
bun "%KIMI_CODE_HOME%\dist\main.mjs" %*
```

### 原生构建（自包含二进制）

原生构建用 Bun 把 CLI 编译为单文件可执行文件。需要 Bun >= 1.4（`curl -fsSL https://bun.sh/install | bash`；详见 [bun.sh](https://bun.sh)），构建脚本本身也运行在 Bun 上；Rust 工具链必需，因为要嵌入 `kimi-native-tools` 的 `.node` 二进制。

Windows（x64）：

```sh
cd apps/kimi-code && bun run build:native:bun:release
```

产物：`apps/kimi-code/dist-native/bin/win32-x64/kimi.exe`

Linux（x64）：

```sh
cd apps/kimi-code
bun run build:native:bun
```

`build:native:bun` 脚本已经用 `local` profile 跑过 JS bundle 步骤。

产物：`apps/kimi-code/dist-native/bin/linux-x64/kimi`（约 160 MB）

部署到本地 `.kimi-code`：

```bash
cp apps/kimi-code/dist-native/bin/linux-x64/kimi ~/.kimi-code/bin/kimi
```

如果正在运行的 `kimi` 进程已占用该二进制（Text file busy）：

```bash
cp apps/kimi-code/dist-native/bin/linux-x64/kimi ~/.kimi-code/bin/kimi-new
mv ~/.kimi-code/bin/kimi-new ~/.kimi-code/bin/kimi
```

> **注意**：原生构建要求 `@moonshot-ai/kimi-native-tools` 出现在 `apps/kimi-code/package.json` 的依赖中，并在 `apps/kimi-code/scripts/native/native-deps.mjs` 中登记。已知坑见[常见问题](#常见问题)。

`--profile=release`（`bun run build:native:bun:release`）会生成内置目录，macOS 上用 `APPLE_SIGNING_IDENTITY` 签名并运行 codesign 自检。CI 通过 `_native-build.yml` 的 `native-bundle-bun` job 构建全部六个目标（经 `KIMI_CODE_NATIVE_ENGINE=bun` 打包为 `kimi-code-bun-<target>.zip`）。

产物输出到 `apps/kimi-code/dist-native/bin/<target>/kimi`。

Bun 字节码默认关闭：在本流水线上实测启动无收益，而字节码会增大产物体积，且与构建时的 Bun 版本强绑定。设置 `KIMI_CODE_BUN_ENABLE_BYTECODE=1` 可显式嵌入字节码。开启时编译步骤会同时传入 `--bytecode --format=esm`：裸 `--bytecode` 默认输出 CommonJS，无法表达顶层 `await`；ESM 字节码自 Bun v1.3.9 起支持顶层 `await`。

运行时集成说明：

- 与 pnpm 时代的一个开发行为差异：Bun 会自动加载 `.env`（pnpm 不会）。需要旧行为时给 `bun` 加 `--no-env-file`。
- 打包产物在加载时从提取的资产缓存解析 pi-tui 平台 helper。
- 内置 URL-fetch 默认走捆绑的 `undici` fetch，保证 SSRF 防护语义一致。
- 自更新感知引擎：native manifest 只携带 Bun 段，Bun 打包的二进制下载发布中对应的 Bun 产物，拒绝回退到任何其他引擎的二进制。
- `/status` 报告打包引擎与原生工具实现（`Runtime  bun · rust`）。

测量一次构建的启动开销：先把产物复制另存（构建会写入 `dist-native/bin/<target>/kimi`），然后运行：

```sh
bun scripts/native/bench-native.mjs ./dist-native/bin/linux-x64/kimi --runs 20
```

### Nix 构建

`nix-build.yml` 在纯净沙箱中构建 CLI。依赖来自一个固定输出派生（`flake.nix` 中的 `bunDeps`）：它物化 hoisted 的 `node_modules` 树，以及两个 napi 包（`kimi-native-tools`、`kimi-agent`）的 cargo vendor 目录；主派生随后离线编译。编辑 `flake.nix` 或原生构建步骤时需要知道的沙箱特性：

- 沙箱中没有 `/usr/bin/env`——请用 `node <js入口>` 调用 node-gyp 和 napi CLI，不要用它们的 bin 启动器。
- FOD 输出不得包含 `/nix/store/...` 字符串：绝不让 `cargo vendor` 把它建议的配置写进输出，也不要把 store 路径插值进安装脚本。
- 改动 `bun.lock` 或任一 `Cargo.lock` 后，会有一次哈希不匹配轮次：把失败日志中的 `got:` 哈希（PR 上由 nix-build bot 自动贴出）填回 `flake.nix` 的 `outputHash`。

### 常见问题

| 现象 | 原因 | 处理 |
|---------|-------|-----|
| `Cannot find module '@moonshot-ai/i18n-shared'` | workspace 链接失效；新增包后 `bun install` 尚未重新链接 | 运行 `bun install` |
| `ERR_MODULE_NOT_FOUND` 指向 `.kimi-code/node_modules` 里的 `src/index.ts` | 部署后的 package.json exports 仍指向源码文件 | 把 exports 改为指向 `dist/*.mjs` |
| `Failed to load kimi-native-tools binding` | `dist/chunks/` 里缺 `.node` 文件（ESM bundle 从 chunk 目录解析） | 把 `.node` 文件直接复制进 `dist/chunks/` |
| 打包产物报 `ERR_UNKNOWN_BUILTIN_MODULE: @moonshot-ai/kimi-native-tools` | 原生模块未在 `native-deps.mjs` 中登记 | 在 `nativeDeps` 数组里加一条，`collect: 'native-files'` |
| `packages/i18n-shared` 构建报 `UNRESOLVED_ENTRY` | 缺 `src/index.ts` | 新建 `src/index.ts`，重新导出 types、core 与 detect 模块 |
| CDN 下载的 `kimi.exe` 在 `locale=zh` 下仍显示英文 | CDN 二进制只包含打包时的语言；下载日期决定版本 | 本地构建，或等下一次 CDN 发布 |
| `bun run` 下出现意料之外的环境变量 | Bun 会自动加载 `.env`（pnpm 时代的开发流程不会） | 删除或重命名该文件，或用 `bun --no-env-file` 运行 |
| Nix 构建报 `hash mismatch in fixed-output derivation '...bun-deps...'` | `bun.lock` 或某个 `Cargo.lock` 变了，vendored 依赖的 FOD 输出随之改变 | 把 `flake.nix` 的 `outputHash` 设为 `lib.fakeSha256`，推送后把失败日志里的 `got:` 哈希填回去（PR 上由 nix-build bot 自动贴出） |

## 提交规范

所有 commit 和 PR 标题必须遵循 [Conventional Commits](https://www.conventionalcommits.org/)。

| 类型     | 用途                                     | 示例                                   |
|----------|------------------------------------------|----------------------------------------|
| feat     | 新功能                                   | feat(agent-core-v2): add tool dedup       |
| fix      | bug 修复                                 | fix(tui): correct status bar alignment |
| docs     | 仅文档                                   | docs: clarify install instructions     |
| chore    | 工具 / 杂务                              | chore: bump dependencies               |
| refactor | 无行为变更的内部重构                     | refactor(kosong): extract retry helper |
| test     | 新增或改进测试                           | test(agent-core-v2): cover skill resolver |
| ci       | CI / 构建流水线变更                      | ci: cache the bun package cache           |
| build    | 构建系统 / 产物变更                      | build(native): add win32-arm64 target  |
| perf     | 性能优化                                 | perf(session): batch event flushes     |
| style    | 仅格式化（无逻辑变更）                   | style: apply oxlint --fix              |

PR 标题由 `pr-title-checker` 工作流强制校验——不合规的标题会阻止合并。

## Changesets

本仓库使用 [changesets](https://github.com/changesets/changesets) 管理版本与发布。

- 每个影响发布产物（代码、行为、公开 API）的 PR **必须**包含 changeset。
- 仅文档、仅测试或仅 CI 的 PR 可以不加。
- 用 `bun run changeset` 生成并按提示操作（涉及哪些包、什么 bump 级别）。
- 包选择与 bump 级别的仓库约定见 `.changeset/README.md`。在本仓库使用编程 agent 时，使用 `gen-changesets` 技能。

### 本 fork 的发版流程

每次向 `main` 推送都会运行 Release 工作流：安装依赖、构建全部 workspace 包，并构建内置目录。此前用于打开或更新 **「ci: release packages」** PR（分支 `changeset-release/main`）的 `changesets/action@v1` 步骤在本 fork 上**已被注释停用**，因此不会再打开该 PR，也不会向 npm 发布任何内容。

- changeset 仍然是 PR 的必备项：它是 changelog 的来源，将来需要独立发版时会重新启用该 action。
- 有意发版前，用 `pre-changelog` 技能预览面向用户的 changelog，并从 `main` 清理掉累积的非用户向 changesets。

### 发布二进制

`release-native.yml` 为全部六个目标构建并发布 CLI 二进制。推送版本 tag（`v2.1.1` 或 `@moonshot-ai/kimi-code@2.1.1`）即可触发，也可以用已有 tag 手动运行该工作流。

- tag 的版本必须与 `apps/kimi-code/package.json` 一致；不一致时会在发布前直接失败，因此请先升版本并合入，再打 tag。
- 发布说明取自 `apps/kimi-code/CHANGELOG.md` 中对应版本的小节。该小节缺失时，发布正文会回退为通用文案，而不是报错失败。
- 未配置 Apple 或 Azure 密钥时构建仍会成功，只是发布未签名的二进制。参见 DEVELOP → "Native release"。

## Pull Requests

PR 会自动套用 [PR 模板](.github/pull_request_template.md)。PR 标题必须遵循 [Conventional Commits](#提交规范)；每个 PR 的 CI 会运行 `bun run lint`、`bun run typecheck` 和 `bun --bun run test`。行为变更时请同步更新 `docs/` 下的用户文档——使用编程 agent 时使用 `gen-docs` 技能。

## 代码风格

- 全仓库 TypeScript。
- 使用 `oxlint`（配置见 `.oxlintrc.json`）。
- 用 `bun run lint:fix` 自动格式化。
- lint 规则未覆盖的风格选择，跟随周边现有写法。

## 报告安全问题

发现安全问题？请查看 [SECURITY.md](SECURITY.md)，不要开公开 issue。

## 许可证

向本仓库贡献即表示你同意你的贡献按 [MIT 许可证](LICENSE) 授权。
