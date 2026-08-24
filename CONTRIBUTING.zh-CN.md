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

本仓库是 pnpm monorepo，最常用的入口：

- `apps/kimi-code` — CLI / TUI
- `apps/vscode` — VS Code 插件
- `apps/vis` — 会话调试可视化工具
- `packages/node-sdk` — 公开 TypeScript SDK（`@moonshot-ai/kimi-code-sdk`）
- `packages/agent-core-v2` — 当前的 agent 引擎（v2，DI Scope 架构）；`packages/agent-core` 为 v1，正在逐步废弃
- `packages/klient`、`kap-server`、`protocol`、`transcript`、`kosong`、`kaos`、`oauth`、`telemetry` — 内部引擎包
- `docs/` — VitePress 双语文档站

完整项目地图见 [AGENTS.md](AGENTS.md)。

## 开发环境

前置要求：Node.js >= 24.15.0、pnpm 10.33.0、Git。

```sh
git clone https://github.com/MoonshotAI/kimi-code.git
cd kimi-code
pnpm install
```

常用脚本：

- `pnpm dev:cli` — 开发模式运行 CLI
- `pnpm test` — 运行测试（vitest）
- `pnpm typecheck` — TypeScript 检查（注意：会先构建各包）
- `pnpm lint` — oxlint
- `pnpm lint:fix` — oxlint 自动修复
- `pnpm build` — 构建全部包

### Bun 迁移（实验性）

实验性的单文件构建方案：用 Bun 编译 CLI，替代 Node.js SEA。前置要求：Bun >= 1.4（一行安装命令 `curl -fsSL https://bun.sh/install | bash`，详见 [bun.sh](https://bun.sh)）；构建脚本本身仍由 Node.js >= 24.15 运行；Rust 工具链仍然必需，因为需要嵌入 `kimi-native-tools` 的 `.node` 二进制。

在 `apps/kimi-code` 下运行 `node scripts/native/build-bun.mjs`（或 `pnpm run build:native:bun`），然后用现有的冒烟测试验证：

```sh
node scripts/native/build-bun.mjs
pnpm run test:native:smoke
```

`--profile=release`（`pnpm run build:native:bun:release`）与 SEA 的 release profile 对齐：生成内置目录，macOS 上用 `APPLE_SIGNING_IDENTITY` 签名并运行 codesign 自检。CI 通过 `_native-build.yml` 的 `build-bun` 输入构建全部六个目标（经 `KIMI_CODE_NATIVE_ENGINE=bun` 打包为 `kimi-code-bun-<target>.zip`）。

产物输出到 `apps/kimi-code/dist-native/bin/<target>/kimi`。

Bun 字节码默认关闭：在本机 Bun 1.4.0 上实测启动零收益——只有入口垫片被字节码化，打包出的 `main.cjs` 运行时从磁盘加载，本就不在字节码图内——而字节码仍会增大产物体积，且与构建时的 Bun 版本强绑定。设置 `KIMI_CODE_BUN_ENABLE_BYTECODE=1` 可显式嵌入字节码；只有当流水线调整让真实应用代码进入字节码图时（例如直接编译真实 ESM 入口、不再从磁盘加载 bundle），它才值得开启。开启时注意模块格式：裸 `--bytecode` 默认输出 CommonJS，无法表达顶层 `await`；Bun 自 v1.3.9 起在 `--format=esm` 下支持顶层 `await`，但本流水线保持 CJS 默认值，因此编译入口必须避免顶层 `await`。

运行时集成在可能的情况下与 SEA 路径共用：

- 打包产物在加载时从提取的资产缓存解析 node-pty（含 PTY bindings）与 pi-tui 平台 helper，统一入口是 `apps/kimi-code/src/native/node-pty.ts`；原先被取代的按模块 hook 垫片（约 780 行死代码）已删除。release 冒烟测试会在 CI 运行的每个目标上 dlopen PTY binding。
- 宿主终端会话在两种运行时下均可工作，并为 Bun 适配了 UTF-8 流解码。
- 内置 URL-fetch 默认走捆绑的 `undici` fetch，保证 SSRF 防护语义跨引擎一致（Bun 的全局 fetch 会静默忽略其 pinned-DNS dispatcher 选项）。
- 自更新感知引擎：native manifest 记录引擎信息，Bun 打包的二进制会下载发布中对应的 Bun 产物，并拒绝被静默换回 Node SEA 二进制。
- `/status` 报告打包引擎与原生工具实现（`Runtime  bun · rust`）。

当前状态注意事项：该流水线是实验性的，与默认的 SEA 流水线（`build:native:sea`）并行，后者仍是发布版本的默认选择。目前仅在 linux-x64 上实测验证过；其余五个平台可在 CI 构建，但仍在验证中。交叉目标暂存需要在本地存在目标平台对应的包（否则收集器会快速失败）。两条流水线使用同一套提取/缓存层。

对比同一目标两个引擎的启动开销：把两次构建分别复制保存（两者都写到 `dist-native/bin/<target>/kimi`），然后运行：

```sh
node scripts/native/bench-native.mjs /tmp/kimi-sea /tmp/kimi-bun --runs 20
```

路线图：最终目标是让 Bun 完全取代 Node.js SEA 成为唯一发布引擎，退役 SEA 构建链。近期路径为：全平台 CI 验证 → 治理字节码/顶层 await 限制 → 切换默认引擎并退役 SEA。在此之前，发布二进制仍默认由 Node SEA 产出。

## 提交规范

所有 commit 和 PR 标题必须遵循 [Conventional Commits](https://www.conventionalcommits.org/)。

| 类型     | 用途                                     | 示例                                   |
|----------|------------------------------------------|----------------------------------------|
| feat     | 新功能                                   | feat(agent-core): add tool dedup       |
| fix      | bug 修复                                 | fix(tui): correct status bar alignment |
| docs     | 仅文档                                   | docs: clarify install instructions     |
| chore    | 工具 / 杂务                              | chore: bump dependencies               |
| refactor | 无行为变更的内部重构                     | refactor(kosong): extract retry helper |
| test     | 新增或改进测试                           | test(agent-core): cover skill resolver |
| ci       | CI / 构建流水线变更                      | ci: cache pnpm store                   |
| build    | 构建系统 / 产物变更                      | build(native): add win32-arm64 target  |
| perf     | 性能优化                                 | perf(session): batch event flushes     |
| style    | 仅格式化（无逻辑变更）                   | style: apply oxlint --fix              |

PR 标题由 `pr-title-checker` 工作流强制校验——不合规的标题会阻止合并。

## Changesets

本仓库使用 [changesets](https://github.com/changesets/changesets) 管理版本与发布。

- 每个影响发布产物（代码、行为、公开 API）的 PR **必须**包含 changeset。
- 仅文档、仅测试或仅 CI 的 PR 可以不加。
- 用 `pnpm changeset` 生成并按提示操作（涉及哪些包、什么 bump 级别）。
- 包选择与 bump 级别的仓库约定见 `.changeset/README.md`。在本仓库使用编程 agent 时，使用 `gen-changesets` 技能。

## Pull Requests

PR 会自动套用 [PR 模板](.github/pull_request_template.md)。PR 标题必须遵循 [Conventional Commits](#提交规范)；每个 PR 的 CI 会运行 `pnpm lint`、`pnpm typecheck` 和 `pnpm test`。行为变更时请同步更新 `docs/` 下的用户文档——使用编程 agent 时使用 `gen-docs` 技能。

## 代码风格

- 全仓库 TypeScript。
- 使用 `oxlint`（配置见 `.oxlintrc.json`）。
- 用 `pnpm lint:fix` 自动格式化。
- lint 规则未覆盖的风格选择，跟随周边现有写法。

## 报告安全问题

发现安全问题？请查看 [SECURITY.md](SECURITY.md)，不要开公开 issue。

## 许可证

向本仓库贡献即表示你同意你的贡献按 [MIT 许可证](LICENSE) 授权。
