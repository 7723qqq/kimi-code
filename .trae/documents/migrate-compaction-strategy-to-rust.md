# Migrate compaction strategy to Rust

## Context

`packages/agent-core/src/agent/compaction/strategy.ts` is the pure-compute decision layer for context compaction: given a message history, it decides (1) when to trigger compaction, (2) how many leading messages to compact, and (3) where to split on context overflow. It is fully synchronous, side-effect free, and currently has no Rust counterpart — the only external call is `estimateTokensForMessage`, which already has a Rust binding (`packages/kimi-native-tools/src/tokens.rs`).

This migration moves the core windowing algorithm to Rust, mirroring the "Rust primary + TS fallback" pattern already established by [tokens.ts](file:///d:/shujuku/kimi-code/packages/agent-core/src/utils/tokens.ts) and [glob.ts](file:///d:/shujuku/kimi-code/packages/agent-core/src/tools/builtin/file/glob.ts). Goals:
- Single source of truth for the compaction windowing algorithm (eliminates drift risk if a future Rust-side component ever needs the same logic).
- Direct performance win: Rust iterates the message metadata and does split-safety checks at native speed; per-message token counts are pre-computed once in TS via the cached `estimateTokensForMessage` (WeakMap) and passed as plain `u32`.
- Keep TS semantics intact: `Message` stays the source of truth in TS; Rust only sees a lightweight projection.

## What stays in TS

- `shouldCompact(usedSize)` / `shouldBlock(usedSize)` — 3-line threshold math each. Not worth a napi call.
- `checkAfterStep` / `maxCompactionPerTurn` getters — single field reads.
- `CompactionConfig` and `DEFAULT_COMPACTION_CONFIG` — kept as the public TS API; copied across the boundary per call.
- `DefaultCompactionStrategy` class — kept as the public TS surface; methods become thin wrappers that build `CompactionMessageMeta[]` and delegate to Rust.

## What moves to Rust

Five functions currently in `strategy.ts`:
1. `computeCompactCount(messages, source)` — main entry; walks the tail accumulating token counts and tracking recent user messages.
2. `reduceCompactOnOverflow(messages)` — overflow-reduction split search.
3. `fitCompactCountToWindow(messages, n)` — private; fits compact count to the context window.
4. `canSplitAfter(messages, index)` — private; split-safety check.
5. `prefixEndsWithOpenToolExchange(messages, index)` — private; checks for unresolved tool exchanges.

Only the first two are exposed as napi bindings; the rest stay private to the Rust module.

## Data shapes

Rust-side napi structs (new file `packages/kimi-native-tools/src/compaction.rs`):

```rust
#[napi(object)]
pub struct CompactionMessageMeta {
    pub role: String,           // "user" | "assistant" | "tool" | "system" | ...
    pub tool_calls_count: u32,  // m.toolCalls.length
    pub tokens: u32,            // estimateTokensForMessage(m), pre-computed in TS
}

#[napi(object)]
pub struct CompactionConfigMeta {
    pub max_size: u32,
    pub max_recent_messages: u32,
    pub max_recent_user_messages: u32,  // Infinity → u32::MAX
    pub max_recent_size_ratio: f64,
    pub min_overflow_reduction_ratio: f64,
}

// CompactionSource encoded as bool: is_manual
```

Boundary cost: one napi call per compaction decision (very low frequency — fires only when context fills). No threshold needed.

## Implementation steps

### Step 1: Add Rust module `compaction.rs`

Create `packages/kimi-native-tools/src/compaction.rs` mirroring the TS algorithm exactly:

- `pub fn compute_compact_count(messages: &[CompactionMessageMeta], config: &CompactionConfigMeta, is_manual: bool) -> u32`
- `pub fn reduce_compact_on_overflow(messages: &[CompactionMessageMeta], config: &CompactionConfigMeta) -> u32`
- private `fn fit_compact_count_to_window(...)`, `fn can_split_after(...)`, `fn prefix_ends_with_open_tool_exchange(...)`

Port the logic verbatim from [strategy.ts:67-220](file:///d:/shujuku/kimi-code/packages/agent-core/src/agent/compaction/strategy.ts#L67-L220). Watch edge cases:
- `messages[index + 1]?.role === 'tool'` → `messages.get(index + 1).map(|m| m.role == "tool").unwrap_or(false)`
- `m.toolCalls.length > 0` → `m.tool_calls_count > 0`
- `Math.ceil`, `Math.max` → Rust `.ceil()`, `.max()`
- TS `Infinity` → `u32::MAX` for `max_recent_user_messages` (default in `DEFAULT_COMPACTION_CONFIG`)
- `maxCompactionPerTurn: Infinity` stays in TS (not used by the algorithm)

### Step 2: Add unit tests in Rust

Add a `#[cfg(test)] mod tests` block at the bottom of `compaction.rs` with cases mirroring [strategy.test.ts](file:///d:/shujuku/kimi-code/packages/agent-core/test/agent/compaction/strategy.test.ts):
- Trailing oversized user message
- Consecutive trailing user messages
- Oversized trailing exchange
- Overflow reduction ratio
- Manual vs auto source
- `canSplitAfter` rejects user/asst-with-tool-calls/trailing-tool-result/open-tool-exchange

Aim for ~10-15 tests covering the algorithm. Reuse the `maxSize=1000` fixture from the TS tests.

### Step 3: Wire napi bindings

In [napi_bindings.rs](file:///d:/shujuku/kimi-code/packages/kimi-native-tools/src/napi_bindings.rs):

```rust
#[napi]
pub fn native_compute_compact_count(
    messages: Vec<CompactionMessageMeta>,
    config: CompactionConfigMeta,
    is_manual: bool,
) -> u32 {
    compaction::compute_compact_count(&messages, &config, is_manual)
}

#[napi]
pub fn native_reduce_compact_on_overflow(
    messages: Vec<CompactionMessageMeta>,
    config: CompactionConfigMeta,
) -> u32 {
    compaction::reduce_compact_on_overflow(&messages, &config)
}
```

Add `mod compaction;` to [lib.rs](file:///d:/shujuku/kimi-code/packages/kimi-native-tools/src/lib.rs).

### Step 4: Add JS wrappers + types

In [index.js](file:///d:/shujuku/kimi-code/packages/kimi-native-tools/index.js):
- `nativeComputeCompactCount(messages, config, isManual)` — pass-through
- `nativeReduceCompactOnOverflow(messages, config)` — pass-through
- Export both in `module.exports`

In [index.d.ts](file:///d:/shujuku/kimi-code/packages/kimi-native-tools/index.d.ts):
- `CompactionMessageMeta` and `CompactionConfigMeta` interfaces
- Function declarations

### Step 5: Refactor TS strategy.ts

In [strategy.ts](file:///d:/shujuku/kimi-code/packages/agent-core/src/agent/compaction/strategy.ts):
- Add lazy native loader (`getNativeComputeCompactCount()` / `getNativeReduceCompactOnOverflow()`) following the [tokens.ts](file:///d:/shujuku/kimi-code/packages/agent-core/src/utils/tokens.ts) pattern.
- Add a `buildMessageMeta(messages)` helper that does one pass to produce `CompactionMessageMeta[]` (uses cached `estimateTokensForMessage`).
- Rename existing TS algorithm functions to `tsComputeCompactCount` / `tsReduceCompactOnOverflow` (private).
- `computeCompactCount` and `reduceCompactOnOverflow` methods become:
  ```ts
  computeCompactCount(messages, source) {
    const meta = buildMessageMeta(messages);
    const configMeta = toConfigMeta(this.config, this.maxSize);
    const fn = getNativeComputeCompactCount();
    if (fn !== undefined) return fn(meta, configMeta, source === 'manual');
    return tsComputeCompactCount(messages, source, this.config, this.maxSize);
  }
  ```
- Keep `canSplitAfter` and `prefixEndsWithOpenToolExchange` as TS fallback helpers (private).

### Step 6: Cross-verify

Write a one-off Node script (delete after verification) that runs the existing [strategy.test.ts](file:///d:/shujuku/kimi-code/packages/agent-core/test/agent/compaction/strategy.test.ts) inputs through both the Rust binding and the TS fallback — confirm identical outputs across all fixtures.

## Verification

1. `cargo test --lib compaction` — new Rust tests pass.
2. `cargo build --release` — module compiles cleanly.
3. `pnpm run build` (in `packages/kimi-native-tools`) — `.node` artifact produced.
4. `pnpm vitest run test/agent/compaction/strategy.test.ts` (in `packages/agent-core`) — existing 5 tests pass with Rust primary path.
5. `pnpm tsc --noEmit` — TS typecheck clean.
6. Cross-verify script: all fixtures produce identical Rust vs TS outputs.

## Out of scope

- `micro.ts` — separate Tier 1 item, will reuse the same `CompactionMessageMeta` projection.
- `full.ts` — heavy I/O (LLM calls, retries, telemetry), stays in TS.
- `render-messages.ts` — pure serializer for the LLM prompt, low ROI to migrate.
- `shouldCompact` / `shouldBlock` / getters — too small to justify napi call overhead.
