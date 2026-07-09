# 迁移 fsSearchService 到 Rust

## Context

`packages/agent-core/src/services/fs/fsSearchService.ts` 中有两处与现有 Rust 模块重复的 CPU 密集逻辑:

1. **`globToRegExp()`** (L532-557) — 手写 glob→正则转换,无缓存,每次 `matchesAnyGlob` 调用都重新编译。`matchesAnyGlob` 在 `search()` (L71,74) 和 `grepWithNode()` (L350,353) 两处使用。Rust 侧 `globset` crate 已实现高效的 GlobSet 批量匹配。

2. **`grepWithNode()`** (L331-424) — `rg` 不可用时的纯 Node 回退路径,约 90 行,逐文件 `fs.readFile` + 逐行 `RegExp.exec`。Rust 侧 `grep.rs` 已用 `regex` crate + `ignore::WalkBuilder` 实现了完整 grep,但返回格式化字符串而非结构化数据。`FsGrepResponse` 需要 `{ line, col, text, before, after }` 结构。

目标:消除这两处重复实现,统一到 Rust。

## 实现步骤

### Part 1: 替换 globToRegExp

**Step 1: Rust 侧新增 `glob_matches_any`**

在 `packages/kimi-native-tools/src/glob.rs` 新增:
```rust
pub fn glob_matches_any(globs: &[String], path: &str) -> bool
```
用 `GlobSetBuilder` 将所有 globs 编译为单个 `GlobSet`,一次 `is_match` 完成。

**关键约束**: 必须用 `GlobBuilder::new(p).build()`(默认大小写敏感),**不可**复用同文件 `build_glob_matcher` (L157-159) 的 `.case_insensitive(true)` — TS `globToRegExp` 是大小写敏感的(无 `i` flag),复用会引入行为漂移。

批量 GlobSet 一次性编译+匹配,消除 N 次 napi 跨界开销(当前 `matchesAnyGlob` 每个循环调一次 `globToRegExp(g).test(rel)`)。

**Step 2: 注册 napi 绑定**

在 `napi_bindings.rs` 新增:
```rust
#[napi]
pub fn native_glob_matches_any(globs: Vec<String>, path: String) -> bool
```

**Step 3: JS 包装 + TS 类型**

在 `index.js` 新增 `nativeGlobMatchesAny(globs, path)`; 在 `index.d.ts` 新增类型声明。

**Step 4: 重构 `matchesAnyGlob`**

在 `fsSearchService.ts` 照搬 `glob.ts` (L347-361) 的懒加载模式:
- 新增 `nativeGlobMatchesAnyFn` + `getNativeGlobMatchesAny()` 加载器
- `matchesAnyGlob` 优先调用 Rust,不可用时回退到现有 `globToRegExp` 循环
- 保留 `globToRegExp` 作为 TS fallback(不删除)

### Part 2: 替换 grepWithNode

采用方案 A — Rust 侧新增结构化输出。

**Step 5: Rust 侧新增结构化类型**

在 `packages/kimi-native-tools/src/grep.rs` 新增:
```rust
#[napi(object)]
pub struct GrepStructuredMatch {
    pub line: u32,       // 1-indexed
    pub col: u32,        // 1-indexed (byte offset + 1, 与 grepWithRg L256 一致)
    pub text: String,
    pub before: Vec<String>,
    pub after: Vec<String>,
}

#[napi(object)]
pub struct GrepStructuredFileHit {
    pub path: String,
    pub matches: Vec<GrepStructuredMatch>,
}

#[napi(object)]
pub struct GrepStructuredResult {
    pub files: Vec<GrepStructuredFileHit>,
    pub files_scanned: u32,
    pub truncated: bool,
    pub elapsed_ms: u32,
    pub error: Option<String>,
}
```

**Step 6: 新增 `grep_search_structured` 函数**

在 `grep.rs` 新增 `pub fn grep_search_structured(config: &GrepStructuredConfig) -> GrepStructuredResult`。

Config 字段: `pattern, path, literal, case_insensitive, include_globs, exclude_globs, follow_gitignore, max_files, max_matches_per_file, max_total_matches, context_lines, timeout_ms`。

实现要点:
- **模式编译**: `literal=true` 时用 `regex::escape(&pattern)` (对齐 TS `escapeRegExp` L565-567); `case_insensitive` 时加 `(?i)` 前缀 (复用 L109 手法)
- **目录遍历**: 复用 `WalkBuilder` + `follow_gitignore` 开关 (L158-169)
- **Glob 过滤**: include/exclude 各编译一个 `GlobSet` (默认大小写敏感,同 Part 1); walker 闭包内 strip base 后路径分隔符统一为 `/` (Windows 下 `\`→`/`)
- **逐行匹配**: `BufReader::lines()`, `regex.find(&line)` 取 `Match.start()` 作为 col; 从已读行向量切片 `[i-context..i]` 和 `[i+1..i+1+context]` 收集 before/after
- **限额**: 每文件达 `max_matches_per_file` 停; `max_total_matches` 达标后置 `truncated=true` 并 break; `max_files` 达标后同样截断
- **超时**: 复用现有 `AtomicBool` + `Instant` deadline 模式 (L210-235)

**Step 7: 注册 napi 绑定**

在 `napi_bindings.rs` 新增 `#[napi] pub fn native_grep_structured(...)` — 参数与 `GrepStructuredConfig` 字段一一对应。

**Step 8: JS 包装 + TS 类型**

在 `index.js` + `index.d.ts` 新增 `nativeGrepStructured(...)` 及相关接口类型。

**Step 9: 重构 `grepWithNode` 路径**

在 `fsSearchService.ts`:
- 新增懒加载 `getNativeGrepStructured()` + `grepWithNative()` 方法
- `grepWithNative` 调用 native,将 `GrepStructuredResult` 直接映射为 `FsGrepResponse` (字段名一一对应)
- `grep()` 的 fallback 链改为: rg → native structured → TS `grepWithNode`
- 保留 `grepWithNode` 作最终 fallback (不删除)
- 传 `GREP_TIMEOUT_MS` (L26) 作为 `timeout_ms`

**注意事项**: native 调用是同步阻塞的,在主线程执行。由于: (a) `grepWithNode` 是回退路径; (b) Rust grep 有 timeout 限制; (c) Rust 比纯 Node 快得多 — 同步阻塞可接受。

### 验证

**Step 10: Rust 单测**

在 `grep.rs` 的 `#[cfg(test)] mod tests` 新增 `grep_search_structured` 测试:
- literal vs regex 模式
- 大小写敏感/不敏感
- include/exclude globs
- context_lines 0/1/2
- max_files / max_matches_per_file / max_total_matches 限额触发
- 超时

在 `glob.rs` 新增 `glob_matches_any` 测试:
- 单 glob 匹配/不匹配
- 多 glob 任一匹配
- 大小写敏感
- `**` 跨目录、`*` 单层、`?` 单字符

**Step 11: 交叉验证**

1. `cargo test --lib glob` + `cargo test --lib grep` — Rust 测试通过
2. `cargo build --release` + `pnpm build` (kimi-native-tools) — 构建成功
3. `pnpm vitest run packages/agent-core/src/services/fs` — TS 测试通过
4. `pnpm tsc --noEmit` — 类型检查通过
5. 手动验证: mock `probeRg` 返回 null,对同一 `FsGrepRequest` 分别走 native structured 与 TS `grepWithNode` 路径,比对 `files`/`files_scanned`/`truncated` 是否一致 (允许 `elapsed_ms` 差异)

## 涉及文件

- `packages/kimi-native-tools/src/glob.rs` — 新增 `glob_matches_any`
- `packages/kimi-native-tools/src/grep.rs` — 新增结构化类型 + `grep_search_structured`
- `packages/kimi-native-tools/src/napi_bindings.rs` — 新增 `native_glob_matches_any` + `native_grep_structured`
- `packages/kimi-native-tools/index.js` — JS 包装
- `packages/kimi-native-tools/index.d.ts` — TS 类型
- `packages/agent-core/src/services/fs/fsSearchService.ts` — 重构 `matchesAnyGlob` + `grepWithNode`
