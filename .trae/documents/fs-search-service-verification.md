# fsSearchService 迁移验证 — 完成步骤 9（跨语言一致性测试）+ Changeset

## 摘要

Tier 1 Item 6（fsSearchService 迁移到 Rust）的全部实现工作（Part 1 glob + Part 2 structured grep）已在上一会话完成。本计划执行已批准计划的**步骤 9 验证**并生成 changeset，宣告该迁移项收尾。

## 当前状态分析

### 已完成（上一会话）

- ✅ `packages/kimi-native-tools/src/glob.rs:174` — `glob_matches_any`（GlobSet 批量匹配，case-sensitive）
- ✅ `packages/kimi-native-tools/src/grep.rs` — `GrepStructuredConfig` + `grep_search_structured`（~200 行）+ 11 个 Rust 单元测试
- ✅ `packages/kimi-native-tools/src/napi_bindings.rs:208,233` — `native_glob_matches_any` + `native_grep_structured`（`#[allow(clippy::too_many_arguments)]`，`u32` → `u64` 内部转换）
- ✅ `packages/kimi-native-tools/index.js` — `nativeGlobMatchesAny` (L230) + `nativeGrepStructured` (L252) JS 包装器
- ✅ `packages/kimi-native-tools/index.d.ts` — 类型声明 (L133, L135-173)
- ✅ `packages/agent-core/src/services/fs/fsSearchService.ts` — `matchesAnyGlob` 重构 (L630-643)、`grep()` 三层 fallback (L126-135)、`grepWithNative` (L345-409)、`globToRegExp` 保留作 TS fallback (L668-693)
- ✅ 133 个 Rust 测试通过（122 旧 + 11 新）
- ✅ `pnpm tsc --noEmit` 通过（无类型错误）
- ✅ Clippy 对新增代码零警告（确认 11 个错误均为 pre-existing）

### 阻塞已解决：`.node` 文件包含新函数

上一会话总结认为 `napi build` 后置步骤失败导致 `.node` 未更新。本次探索验证：

- `kimi-native-tools.win32-x64-msvc.node`（2,608,128 字节，2026/6/26 3:57:23）**已包含** `native_glob_matches_any` 和 `native_grep_structured` 符号（通过 ASCII 字节搜索确认）
- `target/release/kimi_native_tools.dll`（2,608,128 字节，3:58:04）同样包含新符号
- 两者大小完全一致；SHA256 不同仅因构建元数据（时间戳嵌入），导出函数相同
- **结论**：`.node` 可用，无需重新构建。napi build 在 3:57:23 成功过一次，3:58:04 的 .dll 是后续 cargo 增量编译产物（源码相同，符号不变）

### 待完成

- ❌ 步骤 9：TS 端跨语言一致性测试（已批准计划的最后一步）
- ❌ 运行 e2e 测试确认无回归
- ❌ 生成 changeset（AGENTS.md 工作流要求）

## 提议变更

### 变更 A：Smoke test — 验证 `.node` 在 Node.js 中可加载

**操作**：运行一次性 Node.js 脚本（不写入仓库）：

```bash
cd packages/kimi-native-tools
node -e "const m = require('./index.js'); console.log(typeof m.nativeGlobMatchesAny, typeof m.nativeGrepStructured)"
```

**预期输出**：`function function`

**目的**：确认 `.node` 二进制与当前 Node ABI 兼容，两个新函数可被 JS 侧调用。若失败（如 `Module did not self-register`），需重新 `napi build`。

### 变更 B：跨语言一致性测试文件

**新文件**：`packages/agent-core/test/services/fs-search-service.test.ts`

**理由**：
- 遵循已有命名约定 `packages/agent-core/test/services/<service>.test.ts`（如 `fs-git-service.test.ts`）
- 无现成 `FsSearchService` 单元测试文件（e2e 测试在 `packages/server/test/fs-search.e2e.test.ts`，测 HTTP 层）
- 该文件将成为第一个跨语言一致性测试（仓库内无先例可循）

**测试内容**：

#### B1: Glob 跨语言一致性

直接 `import { nativeGlobMatchesAny } from '@moonshot-ai/kimi-native-tools'`，同时在测试文件内**复制** `globToRegExp` 函数（来自 `fsSearchService.ts` L668-693）作为 TS 参考实现。对同一组 `{glob, path}` 用例运行两者，断言结果一致。

用例覆盖（~20 条）：
| glob | path | 期望 | 说明 |
|------|------|------|------|
| `*.ts` | `foo.ts` | true | 基本匹配 |
| `*.ts` | `foo.tsx` | false | 后缀不匹配 |
| `*.ts` | `src/foo.ts` | false | `*` 不跨目录 |
| `**/*.ts` | `src/a/b.ts` | true | `**` 跨目录 |
| `**/*.ts` | `foo.ts` | true | `**` 匹配零层 |
| `src/**` | `src/a/b.ts` | true | `**` 匹配多段 |
| `src/**` | `test/a.ts` | false | 不在 src 下 |
| `*.{ts,tsx}` | `foo.tsx` | true/差异? | brace expansion |
| `?.ts` | `a.ts` | true | `?` 单字符 |
| `?.ts` | `ab.ts` | false | `?` 仅匹配一个 |
| `src/*.ts` | `src/a.ts` | true | 前缀+通配 |
| `*.spec.ts` | `foo.spec.ts` | true | 双后缀 |
| `*.spec.ts` | `foo.test.ts` | false | 后缀不匹配 |
| `[abc].ts` | `a.ts` | true/差异? | 字符类 |
| `*` | `foo.txt` | true | 任意文件 |
| `*` | `src/foo.txt` | false | `*` 不跨目录 |
| `src/*` | `src` | false | `*` 至少匹配一个字符 |
| `**` | `anything/here` | true | `**` 匹配全部 |
| `*.ts` | `.ts` | true/差异? | 空基名 |
| `src/**/*.ts` | `src/a/b/c.ts` | true | 深层嵌套 |

**关键**：如发现 `globset`（Rust）与 `globToRegExp`（TS）语义差异（尤其 brace expansion `{a,b}` 和字符类 `[abc]`），在测试中标注 `// KNOWN DIFFERENCE: ...`，并在 `matchesAnyGlob` 处加注释。保留 TS fallback 作为兜底。

#### B2: Structured grep 行为验证

用 `os.tmpdir()` 创建临时 fixture 目录（含 2-3 个小文件），直接调用 `nativeGrepStructured`，验证返回结构：

```typescript
const result = nativeGrepStructured({
  pattern: 'TODO',
  path: tmpFixture,
  literal: true,
  caseInsensitive: false,
  contextLines: 1,
  maxFiles: 50,
  maxMatchesPerFile: 10,
  maxTotalMatches: 100,
  timeoutMs: 5000,
});
expect(result.error).toBeUndefined();
expect(result.files.length).toBeGreaterThan(0);
expect(result.files[0].matches[0].line).toBeGreaterThan(0);
expect(result.files[0].matches[0].col).toBeGreaterThan(0);
expect(result.files[0].matches[0].text).toContain('TODO');
expect(result.files[0].matches[0].before.length).toBeLessThanOrEqual(1);
expect(result.files[0].matches[0].after.length).toBeLessThanOrEqual(1);
```

测试场景（~6 条）：
1. 基本字面量匹配 — 验证 `line`/`col`/`text`
2. regex 模式 — `pattern: 'TODO|FIXME'`, `literal: false`
3. case_insensitive — 大写 pattern + 小写内容
4. context_lines=2 — 验证 before/after 行数与内容
5. include_globs — 只扫 `*.ts`，验证 `*.js` 被过滤
6. exclude_globs — 排除 `*.test.ts`

**不**做 `grepWithNode` A/B 对比 —— 它是 `protected` 方法且依赖 DI 注入的 `ISessionService`/`ILogService`。e2e 测试（变更 C）已覆盖 `rg → native → TS` 全链路。这里只验证 Rust 端输出结构正确性。

### 变更 C：运行 e2e 测试确认无回归

```bash
cd packages/server
pnpm vitest run test/fs-search.e2e.test.ts
```

该文件有 15 个 `it()` 用例，覆盖 `fs:search`（6）、`fs:grep`（6）、`rg fallback + timeout`（3）。验证 native 层插入后全链路仍正常。

### 变更 D：运行 agent-core 测试套件

```bash
cd packages/agent-core
pnpm vitest run
```

预期：除 `full.test.ts` 的 6 个 pre-existing snapshot 失败外，其余全部通过。新增的 `fs-search-service.test.ts` 应全绿。

### 变更 E：生成 Changeset

按 AGENTS.md 要求，运行 `gen-changesets` skill 生成 `.changeset/` 条目。

**变更范围**：
- `@moonshot-ai/kimi-native-tools`：新增 `nativeGlobMatchesAny` + `nativeGrepStructured` 导出（minor）
- `@moonshot-ai/agent-core`：`FsSearchService` 内部改用 Rust native + TS fallback（性能提升，行为不变，patch）

**bump 级别**：
- `kimi-native-tools`：`minor`（新增导出函数，向后兼容）
- `agent-core`：`patch`（内部实现优化，无 API 变化）
- **不涉及 major**（无 breaking change）

## 验证步骤

1. `node -e "..."` — 确认 `.node` 可加载，输出 `function function`
2. `cd packages/kimi-native-tools && cargo test` — 133 个测试通过（确认无回退）
3. `cd packages/agent-core && pnpm vitest run test/services/fs-search-service.test.ts` — 新增测试全绿
4. `cd packages/server && pnpm vitest run test/fs-search.e2e.test.ts` — 15 个 e2e 测试全绿
5. `cd packages/agent-core && pnpm vitest run` — 仅 `full.test.ts` 的 6 个 pre-existing 失败（与本次无关）
6. `gen-changesets` skill — 生成 changeset 文件

## 假设与决策

- **不重新构建 `.node`**：已验证当前 `.node` 包含新函数符号，可正常加载。若变更 A 的 smoke test 失败，再回退到 `napi build --platform --release`。
- **测试文件中复制 `globToRegExp`**：该函数未从 `fsSearchService.ts` 导出，且仅为测试参考用途。复制 ~25 行避免为测试修改源码导出。若后续需复用，可提取到 `src/services/fs/globToRegExp.ts` 共享模块（本次不做）。
- **不测试 `grepWithNode` A/B**：它是 `protected` 方法，需 DI 实例化 `FsSearchService`。e2e 测试已覆盖全链路。直接测试 `nativeGrepStructured` 输出结构已足够验证 Rust 实现正确性。
- **已知 glob 语义差异风险**：`globset`（Rust）支持 brace expansion `{a,b}` 和字符类 `[abc]`，但 TS `globToRegExp` 对 `{` `[` 当字面量处理（不转义也不特殊解析）。测试将覆盖这些边界并标注差异。
- **Changeset 不涉及 major**：纯新增导出 + 内部优化，无 breaking change。

## 风险与缓解

- **风险**：`globset` 与 `globToRegExp` 在 brace/字符类上语义不同，导致 `matchesAnyGlob` 行为变化。
  **缓解**：变更 B1 的测试覆盖这些边界。如确认差异影响 `fs:search`/`fs:grep` 结果，在 `matchesAnyGlob` 中对含 `{` 或 `[` 的 pattern 走 TS fallback。
- **风险**：e2e 测试因 native 层插入而超时或行为变化。
  **缓解**：e2e 测试在 `rg` 存在时走 `rg` 路径（native 层不触发）；仅在 `rg` 缺失时才走 native。`rg fallback` 测试用例已 mock `rg` 缺失，会触发 native 路径 —— 验证其仍返回正确结果。
