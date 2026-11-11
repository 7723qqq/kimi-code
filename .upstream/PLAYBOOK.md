# PLAYBOOK — 上游改动翻译成 Bun

上游 `MoonshotAI/kimi-code` 用 pnpm + Node 构建，本 fork 用 Bun。**这不是排除上游功能的理由，是翻译的理由。** 每搬一条上游提交，先在这里找到对应形态，再动手。

规则：发现表中没有的形态，先补一行再改代码。改完的门槛见 `specs/upstream-sync-ledger/design.md` 的 Gate 一节。

## 工具链

| 上游形态 | 本地形态 | 怎么验 |
| --- | --- | --- |
| `pnpm-workspace.yaml` 增删成员 | 根 `package.json` → `workspaces.packages` | `bun install` |
| 同上，且影响 Nix 构建 | 同步 `flake.nix` 的 workspace 列表 | `bun run check:nix-workspace` |
| `pnpm-lock.yaml` 依赖变更 | 根 `package.json` → 改依赖后用 `bun install` 重生成 `bun.lock` | `bun install --frozen-lockfile` |
| `pnpm-lock.yaml` 里的 `catalog:` 引用 | 根 `package.json` → `workspaces.catalog` | `bun run check:catalog-versions` |
| `pnpm -r <script>` | `bun run --filter './packages/*' <script>` | 根 `package.json` scripts |
| `pnpm --filter <pkg> <script>` | `bun run --filter '<glob>' <script>` | 同上 |
| `pnpm <bin>` 一次性执行 | `bunx <bin>` | — |
| `.npmrc` 的 registry / hoist / node-linker | `bunfig.toml` 的 `[install]` 段 | `bun install` 成功 |
| `.nvmrc` / `engines.node` | 根 `package.json` → `packageManager: "bun@<ver>"` | `bun --version` |
| Node SEA 打包（`--experimental-sea-config`） | `bun build --compile`（`apps/kimi-code/scripts/native/build-bun.mjs`） | `bun run build` |
| GitHub Actions `actions/setup-node` | `oven-sh/setup-bun` | CI 不装 Node |

## 测试

| 上游形态 | 本地形态 | 怎么验 |
| --- | --- | --- |
| `vitest.config.ts` / `vitest.projects.ts` | 各包 `bunfig.toml` preload + `scripts/run-tests.mjs` | 包内测试跑通 |
| `import { describe, it, expect, vi } from 'vitest'` | `import { describe, it, expect, mock } from 'bun:test'` | `bun test --isolate <path>` |
| `vi.fn()` / `vi.spyOn()` | `mock()` / `spyOn()` | 同上 |
| `vi.useFakeTimers()` | `setSystemTime()` + `advanceTimersByTime` | 同上 |
| `test.each([...])` | `for (const c of cases) it(...)` | 同上 |
| `beforeAll/afterAll/beforeEach/afterEach` | 同名，`bun:test` 直接支持 | 同上 |
| `expect(x).toMatchSnapshot()` | 支持，但本 fork 优先写显式断言（见 `CONVENTIONS.md`） | 同上 |
| `globalSetup.ts`（vitest project 级） | 包级 `bunfig.toml` preload 或测试内 `beforeAll` | 同上 |
| `--reporter=verbose` | `bun test` 默认输出已逐条 | — |

## 运行时

| 上游形态 | 本地形态 | 怎么验 |
| --- | --- | --- |
| `node:fs` / `node:path` / `node:crypto` 等内置 | **保留**，Bun 全兼容 | `bun run check:boundaries` |
| 已有 Bun 等价 API 却仍用 `node:` | 改 `Bun.file()` / `Bun.write()` / `Bun.spawn()` 等 | `tools/review/bun-native-baseline.txt` 只能收窄不能扩大 |
| `child_process.spawn` | `Bun.spawn()` / `Bun.spawnSync()` | 同上 |
| 按名字启动 `node` | 按名字启动 `bun`，或走 `process.execPath` | `tools/review/node-launch-baseline.txt` |
| 缺 `node:` 端点，需要降级实现 | 用 `Bun.*` 等价物；确实没有的登记进 `tools/review/bun-gap-baseline.txt` | `tools/review` 的 `bun-gap` 检查 |
| `process.env.NODE_ENV` 分支 | 保留，Bun 兼容 | — |
| `import.meta.dirname` | 支持 | — |

## 构建与产物

| 上游形态 | 本地形态 | 怎么验 |
| --- | --- | --- |
| `tsc -b` / `tsup` | 各包 `bun run build`（`bun build`） | `bun run build:packages` |
| `api-extractor` 产出 `.d.ts` | 保留，是发布产物的一部分 | 见包内 `build` 脚本 |
| `dist-web` web 产物（每次同步哈希名都变） | 本地保留自己的一份，不逐个对齐 | `apps/kimi-code/scripts/check-web-assets.mjs` |
| `flake.nix` 的 Node 构建路径 | 保留，Nix 路径仍需要 Node | `bun run check:nix-workspace` |

## 明确不搬的文件本体

这些文件在上游存在，本地刻意没有，`tools/review/upstream-drift-allow.txt` 已登记：

- `pnpm-workspace.yaml`、`pnpm-lock.yaml`、`.npmrc`、`.nvmrc`
- 所有 `vitest.config.ts` / `vitest.projects.ts`
- `vitest.config.ts` 的 `globalSetup.ts`（`packages/kap-server/test/globalSetup.ts`）
- Node SEA 脚本（`02-sea-blob.mjs`、`03-inject.mjs`、`build.mjs`）
- `.husky/`（改用 `simple-git-hooks`）

**注意**：`upstream-drift` 只检查"上游有、本地整个文件都没有"。它**不检查同一文件内的内容缺口**。后者由 `.upstream/ledger.tsv` 覆盖，两者互补，缺一不可。

## 已知差异（每次都要记住）

| 差异 | 影响 | 处置 |
| --- | --- | --- |
| 本地独自 2276 条提交，远超上游 61 条未合入 | 上游改动落在本地改过的文件上时，不能照搬 | 先读本地实现，判断等价与否，再决定改哪里 |
| 本地多 `apps/kimi-inspect` | 上游 #4514 删除了它 | 已决定跟着删除（B12） |
| 本地多 `.github/workflows/codeql.yml`、`release-native.yml`；少 `canary-release.yml` | 上游 CI 改动不能整文件搬 | 只提取"检查什么"，落到本地 workflow 结构里 |
| 本 fork 有完整 i18n（中英双语），上游没有 | 任何新增用户可见字符串都要走 `t()` | 触发 i18n 三项检查 |
| `packages/agent-core-v2`、`kap-server`、`transcript` 是零注释区 | 照搬上游代码会带进注释，直接卡 gate | 搬完删注释，`bun run check:no-comments` |
| #4538 的 loop/requester/media 分层重构仍保留本仓结构；本批已落地 revision 持久化 | 不能把本批宣称为 #4538 全量分层迁移；schema 继续由本仓 pending reminder 落地 | `toolSelectOps` 承载 initial/current/changes，公告携带 disclosure，unsupported history 转为 runtime reminder；剩余分层差异记入 `d37f9ccc` 台账行 |
| 本 fork 有原生 Operation Log（jj 风格 op log + 隔离 Git plumbing），上游没有 | 不能把上游 stash、checkpoint 或文件快照恢复当成等价能力；恢复覆盖文件树与 `HEAD`/refs，不覆盖会话 wire | 由 `features/operationLog` 与 SDK/Klient operation 协议承载；`/undo` 保持 turn 语义，flag 默认关闭；这是本地新增能力，不在 `ledger.tsv` 伪造上游记录 |
| 2.5.3 发布线 #4792 的 transcript 修复未进入 `upstream/main`；#4811 的主线后像已被 #4663 删除旧服务 | 不能用 #4811 后像覆盖本仓 `transcriptService`；本仓继续保留 live overlay、undo 与 Operation Log 投影 | 以标签提交 `1b5359d0e0` 的原始 diff 移植 `turnShapeDiverges`、`healTurn` 与 reset；`packages/kap-server/test/services/transcript.test.ts` 133 用例通过 |

## 每条的落地顺序

1. `git show <sha>` 读上游改动
2. 在本表找到对应形态
3. 读本地同类实现，判断是"原样搬""需翻译"还是"已经等价"
4. 改代码，同时补测试（测试用 `bun:test`）
5. 跑 `design.md` 的 Gate
6. `bun scripts/upstream-ledger.mjs --probe <sha> <probe>` 记探针，再 `--verify` 推进判定
7. 提交并推送；本表若有新形态，先补行
