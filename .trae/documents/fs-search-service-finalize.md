# fsSearchService 迁移 — 收尾验证 + Changeset

## 摘要

Tier 1 Item 6（`fsSearchService` 迁移到 Rust）的实现与跨语言一致性测试已在上一会话完成。本计划执行**最后两步**：运行 agent-core 全量测试套件确认无回归，然后生成 changeset 宣告收尾。

## 当前状态分析

### 已完成（上一会话，已验证）

- ✅ Rust 实现：`glob_matches_any`（`glob.rs`，`literal_separator(true)` 修复后）+ `grep_search_structured`（`grep.rs`）
- ✅ napi 绑定：`native_glob_matches_any` + `native_grep_structured`（`napi_bindings.rs`）
- ✅ JS/TS 包装：`index.js` + `index.d.ts`
- ✅ `fsSearchService.ts` 重构：`matchesAnyGlob`（L630-643）+ `grep()` 三层 fallback `rg → native → TS`（L126-135）+ `grepWithNative`（L345-409）
- ✅ `.node` 二进制已包含新函数符号（2,608,128 字节，2026/6/26 4:10），`literal_separator` bug 修复已编入
- ✅ 133 个 Rust 测试通过
- ✅ 跨语言一致性测试 `packages/agent-core/test/services/fs-search-service.test.ts`（41 用例）全绿
- ✅ `packages/server/test/fs-search.e2e.test.ts`：13 通过 / 2 失败（2 个为 pre-existing Windows 路径分隔符问题，位于未改动的 `grepWithRg` 路径，已确认与本次迁移无关）

### 关键 bug 修复（上一会话）

- `globset` 默认 `literal_separator(false)` 使 `*` 跨 `/`，与 TS `globToRegExp`（`*` → `[^/]*`）和 ripgrep `--glob` 语义不一致
- 修复：`glob.rs::glob_matches_any` 和 `grep.rs::build_glob_set` 均加 `.literal_separator(true)`
- 修复后 41 个跨语言测试全绿

### 待完成

- ❌ 步骤 D：agent-core 全量测试套件（`pnpm vitest run`）
- ❌ 步骤 E：生成 changeset

## 提议变更

### 变更 D：运行 agent-core 全量测试套件

**命令**：
```bash
cd packages/agent-core
pnpm vitest run
```

**预期结果**：
- 新增 `test/services/fs-search-service.test.ts`（41 用例）全绿
- `full.test.ts` 的 6 个 pre-existing snapshot 失败（与本次无关，上一会话已确认）
- 其余测试全绿

**通过判据**：失败用例数 ≤ 6，且全部位于 `full.test.ts`，且 failure message 包含 snapshot 字样。

**若出现新失败**：
- 若失败与 `fsSearchService` / `grep` / `glob` 相关 → 排查是否 native 层引入回归
- 若失败与 `compaction/strategy.ts`（Tier 1 Item 5，已在工作树但未提交）相关 → 单独评估
- 记录失败用例名与堆栈，回退分析根因

### 变更 E：生成 Changeset

按 AGENTS.md 工作流要求，调用 `gen-changesets` skill 生成 `.changeset/` 条目。

**变更范围与 bump 级别**：

| 包 | bump | 理由 |
|----|------|------|
| `@moonshot-ai/kimi-native-tools` | `minor` | 新增导出 `nativeGlobMatchesAny` + `nativeGrepStructured`，向后兼容 |
| `@moonshot-ai/agent-core` | `patch` | `FsSearchService` 内部改用 Rust native + TS fallback，性能提升，无公开 API 变化 |

**不涉及 `major`**（无 breaking change，无需向用户确认）。

**注意**：工作树还包含 Tier 1 Item 5（`compaction.rs` + `strategy.ts` 重构）的未提交改动。该工作属于另一个迁移项，changeset 应**单独**覆盖。本次 changeset 仅描述 fsSearchService 迁移。若 `gen-changesets` skill 询问是否合并，应分开生成。如果 skill 只支持一次性生成所有未提交改动的 changeset，则需明确在 changeset 文本中区分两块工作，或先为 fsSearchService 生成，再为 compaction 生成第二个 changeset 文件。

**changeset 文本要点**（英文，遵循 skill 规则）：
- 标题：`fs:grep` and `fs:search` now use native Rust glob/grep with TypeScript fallback
- 描述要点：
  - `FsSearchService` matches globs via `nativeGlobMatchesAny` (Rust `globset`, batch-compiled) with TS fallback
  - `fs:grep` adds a native tier between `rg` and pure-Node grep: `rg → nativeGrepStructured → grepWithNode`
  - Glob semantics mirror `globToRegExp` and ripgrep `--glob` (`*` does not cross `/`, `**` does)
  - Behavior unchanged for end users; native tier is transparent fallback

## 验证步骤

1. `cd packages/agent-core && pnpm vitest run` — 仅 `full.test.ts` 的 6 个 pre-existing 失败
2. `gen-changesets` skill 生成 `.changeset/*.md` — 内容正确，bump 级别为 `minor`（kimi-native-tools）+ `patch`（agent-core）
3. `git status` 确认新增 changeset 文件已落盘

## 假设与决策

- **不重新构建 `.node`**：已验证 4:10 时间戳的 `.node` 包含 `literal_separator` 修复后的符号，41 个跨语言测试全绿即证明二进制可用。
- **`full.test.ts` 6 个失败为 pre-existing**：上一会话已确认（snapshot 失败，与本次迁移无关）。本次运行若数量 > 6 或位置变化才需排查。
- **compaction 改动单独 changeset**：工作树包含 Tier 1 Item 5 的未提交改动，但本次 changeset 仅覆盖 fsSearchService 迁移，避免混合两个迁移项。
- **不提交、不推送**：仅生成 changeset 文件，不执行 `git commit`/`git push`（除非用户明确要求）。

## 风险与缓解

- **风险**：agent-core 全量套件出现非 `full.test.ts` 的新失败。
  **缓解**：先排查是否 native 层回归（禁用 native：`$env:KIMI_DISABLE_NATIVE="1"` 重跑），定位后修复或回退相关改动。
- **风险**：`gen-changesets` skill 检测到工作树混合多个迁移项改动，难以区分。
  **缓解**：手动在 changeset 文本中明确范围仅限 fsSearchService；必要时为 compaction 生成第二个 changeset。
