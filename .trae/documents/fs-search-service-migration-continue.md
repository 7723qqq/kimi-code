# fsSearchService 迁移到 Rust —— 剩余工作执行计划

## 上下文与当前状态

本计划延续上一会话已批准的 `migrate-fs-search-service-to-rust.md` 计划。该计划将 `packages/agent-core/src/services/fs/fsSearchService.ts` 中的两条 TS 热路径迁移到 `packages/kimi-native-tools` 的 Rust 实现，遵循「Rust 优先 + TS fallback」模式。

### Part 1 (globToRegExp → Rust GlobSet) 进度

- ✅ `packages/kimi-native-tools/src/glob.rs:174` — `pub fn glob_matches_any(globs: &[String], path: &str) -> bool` 已实现（用 `GlobSetBuilder` 批量编译、默认 case-sensitive，与 TS `globToRegExp` 一致；**不**复用 `build_glob_matcher`，因为后者 `.case_insensitive(true)`）
- ✅ `packages/kimi-native-tools/src/napi_bindings.rs:208-210` — `#[napi] pub fn native_glob_matches_any(globs: Vec<String>, path: String) -> bool` 已添加
- ❌ `packages/kimi-native-tools/index.js` — 缺少 `nativeGlobMatchesAny` JS 包装器与导出
- ❌ `packages/kimi-native-tools/index.d.ts` — 缺少 `nativeGlobMatchesAny` 类型声明
- ❌ `packages/agent-core/src/services/fs/fsSearchService.ts` — `matchesAnyGlob` (L525-530) 与 `globToRegExp` (L532-557) 未重构

### Part 2 (grepWithNode → Rust structured grep) 进度

- ❌ `packages/kimi-native-tools/src/grep.rs` — 缺少 structured grep 函数与 `#[napi(object)]` 输出结构体
- ❌ `packages/kimi-native-tools/src/napi_bindings.rs` — 缺少 `native_grep_structured` 绑定
- ❌ `packages/kimi-native-tools/index.js` / `index.d.ts` — 缺少 JS 包装器与 TS 类型
- ❌ `fsSearchService.ts:grepWithNode` (L331-424) — 未重构为三层 fallback 链

## 关键技术约束

1. **大小写敏感性**: `glob_matches_any` 用 `GlobBuilder::new(g).build()` 默认（case-sensitive），与 TS `globToRegExp` 一致。**不要**改成 `case_insensitive(true)`。
2. **napi 字段命名**: `#[napi(object)]` struct 的 Rust `snake_case` 字段会自动转换为 JS `camelCase`。TS 侧 interface 必须用 camelCase（参见已完成的 `CompactionMessageMeta`、`CompactionConfigMeta`）。
3. **structured grep 输出结构**（与 `packages/protocol/src/fs.ts:45-58` 完全对齐）:
   - `FsGrepMatch`: `{ line: number (1-indexed), col: number (1-indexed), text: string, before: string[], after: string[] }`
   - `FsGrepFileHit`: `{ path: string, matches: FsGrepMatch[] }`
   - `FsGrepResponse`: `{ files: FsGrepFileHit[], files_scanned: number, truncated: boolean, elapsed_ms: number }`
4. **行为一致性** (来自 `fsSearchService.ts:grepWithNode` L331-424):
   - `regex=false` 时 pattern 是固定字符串，必须 `escapeRegExp` 后再 compile（Rust 用 `regex::escape`）
   - `case_sensitive=false` 时大小写不敏感
   - `context_lines` 同时用于 before 和 after（相同行数）
   - `max_files` (默认 200) 限制扫描文件数；`max_matches_per_file` (默认 50)；`max_total_matches` (默认 5000)
   - 超时 30s：超时且 `totalMatches === 0 && filesScanned === 0` 时抛 `FsGrepTimeoutError`；超时但有结果则 `truncated=true` 返回部分结果
   - 每行只记录**第一个**匹配的 col（`re.exec(line)` 而非 `matchAll`），与 TS `grepWithNode` 一致
5. **三层 fallback 链**（`grep()` L99-132 保持不变）: `rg → nativeGrepStructured (Rust) → grepWithNode (TS fallback)`。rg 探测逻辑和 `FsGrepTimeoutError` 抛出位置不变。
6. **lazy native loader 模式**: 复用 `strategy.ts` 已验证的模式 —— 顶层 `let nativeFn: ((...) => Result) | null | undefined = undefined`，首次调用时 `try { require('@moonshot-ai/kimi-native-tools') }`，缓存结果或 `null`，失败则走 TS fallback。

## 实施步骤

### Step 1: Part 1 收尾 — JS/TS 包装器

**文件**: `packages/kimi-native-tools/index.js`

在 `nativeExpandBraces` (L218) 之后、`List Directory tool` 区块之前插入：

```js
/**
 * Check if a path matches any of the given glob patterns.
 *
 * Compiles all patterns into a single GlobSet and tests in one call.
 * Case-sensitive (mirrors `globToRegExp` in `fsSearchService.ts`).
 *
 * @param {string[]} globs - Array of glob patterns.
 * @param {string} path - Relative or absolute path to test.
 * @returns {boolean} True if `path` matches at least one pattern.
 */
function nativeGlobMatchesAny(globs, path) {
  return binding.nativeGlobMatchesAny(globs, path);
}
```

在 `module.exports` (L370) 中加入 `nativeGlobMatchesAny`（建议放在 `nativeExpandBraces` 之后）。

**文件**: `packages/kimi-native-tools/index.d.ts`

在 `nativeExpandBraces` 声明 (L132) 之后加入：

```typescript
export declare function nativeGlobMatchesAny(globs: string[], path: string): boolean;
```

**验证**: `cd packages/kimi-native-tools && cargo build` 成功；`pnpm build` 成功（如该包有 build script）。

### Step 2: Part 1 收尾 — 重构 `matchesAnyGlob`

**文件**: `packages/agent-core/src/services/fs/fsSearchService.ts`

在文件顶部 import 区（L1-22 附近）添加 lazy native loader，仿照 `strategy.ts` 的 `nativeComputeCompactCount` 模式：

```typescript
import type {} from '@moonshot-ai/kimi-native-tools';

let nativeGlobMatchesAnyFn:
  | ((globs: string[], path: string) => boolean)
  | null
  | undefined = undefined;

function tryLoadNativeGlobMatchesAny():
  | ((globs: string[], path: string) => boolean)
  | null {
  if (nativeGlobMatchesAnyFn !== undefined) return nativeGlobMatchesAnyFn;
  try {
    const native = require('@moonshot-ai/kimi-native-tools');
    nativeGlobMatchesAnyFn =
      typeof native.nativeGlobMatchesAny === 'function'
        ? (globs: string[], p: string) => native.nativeGlobMatchesAny(globs, p)
        : null;
  } catch {
    nativeGlobMatchesAnyFn = null;
  }
  return nativeGlobMatchesAnyFn;
}
```

重构 `matchesAnyGlob` (L525-530)：

```typescript
function matchesAnyGlob(rel: string, globs: readonly string[]): boolean {
  const native = tryLoadNativeGlobMatchesAny();
  if (native !== null) {
    return native(globs as string[], rel);
  }
  return tsMatchesAnyGlob(rel, globs);
}

function tsMatchesAnyGlob(rel: string, globs: readonly string[]): boolean {
  for (const g of globs) {
    if (globToRegExp(g).test(rel)) return true;
  }
  return false;
}
```

**保留** `globToRegExp` (L532-557) 作为 TS fallback 路径，**不要删除**。

**注意**: `search()` (L71, L74) 和 `grepWithNode()` (L350, L353) 调用点无需修改，函数签名不变。

### Step 3: Part 2 — Rust structured grep 输出结构体

**文件**: `packages/kimi-native-tools/src/grep.rs`

在现有 `MatchEntry` (L101) 之后新增 `#[napi(object)]` 输出结构体：

```rust
/// A single structured match for the fs:grep service.
#[derive(Debug, Clone)]
#[napi(object)]
pub struct GrepStructuredMatch {
    /// 1-indexed line number.
    pub line: u32,
    /// 1-indexed column of the first match on the line.
    pub col: u32,
    /// Full text of the matched line (no trailing newline).
    pub text: String,
    /// Context lines before the match (up to `context_lines`).
    pub before: Vec<String>,
    /// Context lines after the match (up to `context_lines`).
    pub after: Vec<String>,
}

/// A file with one or more matches.
#[derive(Debug, Clone)]
#[napi(object)]
pub struct GrepStructuredFileHit {
    /// Path relative to the search root (forward slashes).
    pub path: String,
    /// Matches in this file, in order.
    pub matches: Vec<GrepStructuredMatch>,
}

/// Structured grep result — mirrors `FsGrepResponse`.
#[derive(Debug, Clone)]
#[napi(object)]
pub struct GrepStructuredResult {
    pub files: Vec<GrepStructuredFileHit>,
    pub files_scanned: u32,
    pub truncated: bool,
    pub elapsed_ms: u32,
    pub error: Option<String>,
}
```

### Step 4: Part 2 — `GrepStructuredConfig` 与 `grep_search_structured` 函数

**文件**: `packages/kimi-native-tools/src/grep.rs`

在 `GrepConfig` 之后新增配置结构体（**不复用 `GrepConfig`**，因为字段集合不同 —— 有 include/exclude globs、max_files 等）：

```rust
/// Configuration for structured grep (fs:grep service).
pub struct GrepStructuredConfig {
    /// Search pattern (regex or literal depending on `literal`).
    pub pattern: String,
    /// Root directory to search.
    pub path: String,
    /// If true, treat `pattern` as a literal string (regex::escape applied).
    pub literal: bool,
    /// Case-insensitive search.
    pub case_insensitive: bool,
    /// Include only paths matching any of these globs (case-sensitive, GlobSet).
    pub include_globs: Vec<String>,
    /// Exclude paths matching any of these globs (case-sensitive, GlobSet).
    pub exclude_globs: Vec<String>,
    /// Respect .gitignore / .git/info/exclude. Defaults to true.
    pub follow_gitignore: bool,
    /// Context lines before AND after each match (mirrors FsGrepRequest.context_lines).
    pub context_lines: u32,
    /// Max files to scan (default 200).
    pub max_files: u32,
    /// Max matches per file (default 50).
    pub max_matches_per_file: u32,
    /// Max total matches across all files (default 5000).
    pub max_total_matches: u32,
    /// Wall-clock timeout in milliseconds (default 30000).
    pub timeout_ms: u64,
}

impl Default for GrepStructuredConfig {
    fn default() -> Self {
        Self {
            pattern: String::new(),
            path: ".".to_string(),
            literal: false,
            case_insensitive: false,
            include_globs: Vec::new(),
            exclude_globs: Vec::new(),
            follow_gitignore: true,
            context_lines: 2,
            max_files: 200,
            max_matches_per_file: 50,
            max_total_matches: 5000,
            timeout_ms: 30_000,
        }
    }
}
```

新增 `grep_search_structured` 函数（复用现有 `WalkBuilder` + `AtomicBool` + `Instant` deadline 模式，参考 `grep_search` L108-420）：

```rust
pub fn grep_search_structured(config: &GrepStructuredConfig) -> GrepStructuredResult {
    let started = Instant::now();
    let search_path = PathBuf::from(&config.path);
    // ... (validate path exists / is_dir, mirror grep_search L138-153)

    // Build regex: apply regex::escape if literal, prepend (?i) if case_insensitive.
    let pattern_str = if config.case_insensitive {
        format!("(?i){}", if config.literal { regex::escape(&config.pattern) } else { config.pattern.clone() })
    } else if config.literal {
        regex::escape(&config.pattern)
    } else {
        config.pattern.clone()
    };
    let regex = match RegexBuilder::new(&pattern_str).build() { /* ... */ };

    // Build include/exclude GlobSets (case-sensitive, mirror glob::glob_matches_any).
    let include_set = build_glob_set(&config.include_globs);
    let exclude_set = build_glob set(&config.exclude_globs);

    // WalkBuilder with follow_gitignore config (mirror grep_search L158-169).
    // Use AtomicBool + Instant deadline (mirror L210-235).
    // Per-file: open, read lines into Vec<String>, find first match per line,
    //   collect GrepStructuredMatch with before/after slices,
    //   enforce max_matches_per_file, max_total_matches, max_files,
    //   truncated flags.
    // Return GrepStructuredResult { files, files_scanned, truncated, elapsed_ms, error: None }.
}

fn build_glob_set(globs: &[String]) -> Option<globset::GlobSet> {
    if globs.is_empty() { return None; }
    let mut b = globset::GlobSetBuilder::new();
    for g in globs {
        if let Ok(glob) = globset::GlobBuilder::new(g).build() {
            b.add(glob);
        }
    }
    b.build().ok()
}
```

**关键行为细节**（必须与 TS `grepWithNode` L331-424 一致）：
- 每行只记录**第一个**匹配的 col（用 `regex.find(&line)` 而非 `find_iter`）
- `before`: `lines[i - context_lines..i]` (saturating)
- `after`: `lines[i + 1..i + 1 + context_lines]` (min with lines.len())
- `text`: 整行内容（不含 `\n`）
- 文件扫描顺序：按 walk 顺序（与 TS 一致，**不**按 mtime 排序 —— 这是 fs:grep 与 glob 工具的区别）
- 超时：deadline 到达后停止，返回已收集的 `files` + `truncated=true` + `files_scanned` 为已扫描数

### Step 5: Part 2 — napi 绑定

**文件**: `packages/kimi-native-tools/src/napi_bindings.rs`

在 `native_glob_matches_any` (L208-210) 之后添加：

```rust
/// Structured grep search — mirrors `fsSearchService.ts:grepWithNode`.
///
/// Returns structured match data (file → matches with line/col/context),
/// not a formatted string. Used as the middle tier of the
/// `rg → native → TS fallback` chain in `FsSearchService.grep()`.
#[napi]
pub fn native_grep_structured(
    pattern: String,
    path: String,
    literal: bool,
    case_insensitive: bool,
    include_globs: Vec<String>,
    exclude_globs: Vec<String>,
    follow_gitignore: bool,
    context_lines: u32,
    max_files: u32,
    max_matches_per_file: u32,
    max_total_matches: u32,
    timeout_ms: u64,
) -> grep::GrepStructuredResult {
    grep::grep_search_structured(&grep::GrepStructuredConfig {
        pattern,
        path,
        literal,
        case_insensitive,
        include_globs,
        exclude_globs,
        follow_gitignore,
        context_lines,
        max_files,
        max_matches_per_file,
        max_total_matches,
        timeout_ms,
    })
}
```

### Step 6: Part 2 — JS/TS 包装器与类型

**文件**: `packages/kimi-native-tools/index.js`

在 `nativeGlobMatchesAny` 之后添加：

```js
/**
 * Structured grep search (mirrors fsSearchService.ts:grepWithNode).
 *
 * @param {object} req - Grep request.
 * @param {string} req.pattern - Search pattern.
 * @param {string} req.path - Root directory.
 * @param {boolean} [req.literal=false] - Treat pattern as literal string.
 * @param {boolean} [req.caseInsensitive=false] - Case-insensitive.
 * @param {string[]} [req.includeGlobs=[]] - Include glob filters.
 * @param {string[]} [req.excludeGlobs=[]] - Exclude glob filters.
 * @param {boolean} [req.followGitignore=true] - Respect .gitignore.
 * @param {number} [req.contextLines=2] - Context lines before/after.
 * @param {number} [req.maxFiles=200] - Max files to scan.
 * @param {number} [req.maxMatchesPerFile=50] - Max matches per file.
 * @param {number} [req.maxTotalMatches=5000] - Max total matches.
 * @param {number} [req.timeoutMs=30000] - Timeout in ms.
 * @returns {{ files: Array<{ path: string, matches: Array<{ line: number, col: number, text: string, before: string[], after: string[] }> }>, filesScanned: number, truncated: boolean, elapsedMs: number, error?: string }}
 */
function nativeGrepStructured(req) {
  return binding.nativeGrepStructured(
    req.pattern,
    req.path,
    req.literal ?? false,
    req.caseInsensitive ?? false,
    req.includeGlobs ?? [],
    req.excludeGlobs ?? [],
    req.followGitignore ?? true,
    req.contextLines ?? 2,
    req.maxFiles ?? 200,
    req.maxMatchesPerFile ?? 50,
    req.maxTotalMatches ?? 5000,
    req.timeoutMs ?? 30000,
  );
}
```

在 `module.exports` 加入 `nativeGrepStructured`。

**文件**: `packages/kimi-native-tools/index.d.ts`

添加类型与导出（放在 `nativeGlobMatchesAny` 之后）：

```typescript
export interface NativeGrepStructuredMatch {
  line: number;
  col: number;
  text: string;
  before: string[];
  after: string[];
}

export interface NativeGrepStructuredFileHit {
  path: string;
  matches: NativeGrepStructuredMatch[];
}

export interface NativeGrepStructuredResult {
  files: NativeGrepStructuredFileHit[];
  filesScanned: number;
  truncated: boolean;
  elapsedMs: number;
  error?: string;
}

export interface NativeGrepStructuredRequest {
  pattern: string;
  path: string;
  literal?: boolean;
  caseInsensitive?: boolean;
  includeGlobs?: string[];
  excludeGlobs?: string[];
  followGitignore?: boolean;
  contextLines?: number;
  maxFiles?: number;
  maxMatchesPerFile?: number;
  maxTotalMatches?: number;
  timeoutMs?: number;
}

export declare function nativeGrepStructured(
  req: NativeGrepStructuredRequest,
): NativeGrepStructuredResult;
```

### Step 7: Part 2 — 重构 `grep()` 三层 fallback

**文件**: `packages/agent-core/src/services/fs/fsSearchService.ts`

在 `matchesAnyGlob` 的 lazy native loader 旁添加 structured grep loader：

```typescript
let nativeGrepStructuredFn:
  | ((req: NativeGrepStructuredRequest) => NativeGrepStructuredResult)
  | null
  | undefined = undefined;

function tryLoadNativeGrepStructured() {
  if (nativeGrepStructuredFn !== undefined) return nativeGrepStructuredFn;
  try {
    const native = require('@moonshot-ai/kimi-native-tools');
    nativeGrepStructuredFn =
      typeof native.nativeGrepStructured === 'function'
        ? (req) => native.nativeGrepStructured(req)
        : null;
  } catch {
    nativeGrepStructuredFn = null;
  }
  return nativeGrepStructuredFn;
}
```

在 `grep()` (L99-132) 的 `rg` fallback 路径中插入 native 层：

```typescript
const rg = await this.probeRg();
if (rg !== null) {
  return this.grepWithRg(/* ... */);
}
const native = tryLoadNativeGrepStructured();
if (native !== null) {
  return this.grepWithNative(native, realCwd, req, startedAt);
}
return this.grepWithNode(realCwd, req, abortController.signal, startedAt);
```

新增 `grepWithNative` 方法（与 `grepWithNode` 同签名，把结果映射回 `FsGrepResponse`）：

```typescript
protected async grepWithNative(
  nativeFn: (req: NativeGrepStructuredRequest) => NativeGrepStructuredResult,
  cwd: string,
  req: FsGrepRequest,
  startedAt: number,
): Promise<FsGrepResponse> {
  const result = nativeFn({
    pattern: req.pattern,
    path: cwd,
    literal: !req.regex,
    caseInsensitive: !req.case_sensitive,
    includeGlobs: req.include_globs ?? [],
    excludeGlobs: req.exclude_globs ?? [],
    followGitignore: req.follow_gitignore,
    contextLines: req.context_lines,
    maxFiles: req.max_files,
    maxMatchesPerFile: req.max_matches_per_file,
    maxTotalMatches: req.max_total_matches,
    timeoutMs: GREP_TIMEOUT_MS,
  });

  if (result.error) {
    // Fall back to TS implementation on Rust error.
    return this.grepWithNode(cwd, req, new AbortController().signal, startedAt);
  }

  return {
    files: result.files.map((f) => ({
      path: f.path,
      matches: f.matches.map((m) => ({
        line: m.line,
        col: m.col,
        text: m.text,
        before: m.before,
        after: m.after,
      })),
    })),
    files_scanned: result.filesScanned,
    truncated: result.truncated,
    elapsed_ms: result.elapsedMs,
  };
}
```

**注意**: `grepWithNative` 是同步调用（Rust 函数同步返回），但保留 `async` 签名以匹配接口。`AbortController` 在 native 路径中不生效（Rust 用自己的 `timeout_ms`），这是已知 trade-off —— 30s 超时由 Rust 内部 deadline 保证。

`grepWithNode` (L331-424) **保留不删除**，作为 TS fallback。

### Step 8: 验证 — Rust 单元测试

**文件**: `packages/kimi-native-tools/src/grep.rs` 的 `#[cfg(test)] mod tests`

新增测试（建议加到现有 `tests` 模块中，遵循 AGENTS.md「不要新增测试文件」原则）：

- `test_grep_structured_basic` — 简单 pattern 匹配，验证 line/col/text
- `test_grep_structured_literal` — `literal=true` 时 pattern 不被当 regex 解析
- `test_grep_structured_case_insensitive`
- `test_grep_structured_context_lines` — 验证 before/after 行数与内容
- `test_grep_structured_include_globs` / `test_grep_structured_exclude_globs`
- `test_grep_structured_max_files` / `max_matches_per_file` / `max_total_matches`
- `test_grep_structured_truncated` — 超出 max_total_matches 时 truncated=true
- `test_grep_structured_timeout` — timeout_ms=1 时快速返回 truncated

### Step 9: 验证 — TS 端跨语言一致性

在 `packages/agent-core` 已有测试目录中新增（或追加到现有的 `fsSearchService` 测试文件，如果有的话；否则放在 `src/services/fs/__tests__/fsSearchService.test.ts`，需先确认是否已存在 —— **执行时先 Glob 检查**）：

- 验证 `matchesAnyGlob` 在 native 加载成功时与 TS fallback 行为一致（构造一组 `{glob, path, expected}` 用例，对两种实现都跑一遍）
- 验证 `grepWithNative` 返回结构与 `grepWithNode` 一致（用一个小 fixture 目录，对相同 req 调用两者，比较 `files` / `files_scanned` / `truncated`）

## 验证步骤（最终）

1. `cd packages/kimi-native-tools && cargo build` —— 编译通过
2. `cargo test` —— 所有 Rust 测试通过（包括新增的 structured grep 测试）
3. `cargo clippy -- -D warnings` —— 无警告
4. `cd packages/agent-core && pnpm test` —— TS 测试通过（注意：full.test.ts 的 6 个 snapshot 失败是 pre-existing，与本次无关）
5. 手动 smoke test：在 `kimi-code` CLI 中触发一次 `fs:grep`（在无 rg 的环境下，验证 native 路径生效）

## 假设与决策

- **不修改** `grep_search`（原 `GrepResult` 格式化字符串接口保持不变，供其他调用方使用）
- **不修改** `grep.rs::build_glob_matcher`（保持 `.case_insensitive(true)`，供 glob 工具用）
- **不删除** `globToRegExp` / `grepWithNode`（作为 TS fallback 保留）
- `GrepStructuredConfig` 是独立结构体，不继承 `GrepConfig`（字段集合差异较大，组合更清晰）
- native 路径的 `AbortController` 不生效，由 Rust `timeout_ms` 兜底超时（已知 trade-off，可接受 —— Rust 内部 deadline 更精确）
- structured grep 的文件扫描顺序遵循 walk 顺序（与 TS `grepWithNode` 一致），**不**按 mtime 排序

## 风险与缓解

- **风险**: Rust `globset` 与 TS `globToRegExp` 的语义可能存在细微差异（如 `**` 跨目录、`?` 匹配规则）。
  **缓解**: Step 9 的跨语言一致性测试用一组覆盖 `*`, `**`, `?`, `.{a,b}` 的用例验证；如发现差异，在 `glob_matches_any` 中加注释说明，并保留 TS fallback 作为兜底。
- **风险**: `regex::Regex` 与 Node `RegExp` 的语法差异（如 lookbehind）。
  **缓解**: structured grep 的 `pattern` 来自 `FsGrepRequest`，`regex=false`（默认）时走 `regex::escape` 字面量路径，不触发复杂语法；`regex=true` 时由调用方负责，且 native 失败会 fallback 到 TS。
