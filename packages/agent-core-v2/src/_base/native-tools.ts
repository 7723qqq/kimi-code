/**
 * Lazy-loaded bindings to the Rust native tools (`@moonshot-ai/kimi-native-tools`).
 *
 * This mirrors the pattern in `@moonshot-ai/agent-core`
 * (`tools/builtin/native-tools.ts`) but is adapted for this package's ESM
 * context: instead of a top-level `require`, we derive a CommonJS `require`
 * via `module.createRequire` so the native module can be loaded
 * synchronously — the leaf helpers below (escape / tokens / name sanitize)
 * are intentionally synchronous to keep their call sites unchanged.
 *
 * Everything here is best-effort with three distinct failure classes:
 *
 *   1. **Module unavailable** — the addon is not built / fails to load /
 *      the function is missing (version skew). Wrappers return `undefined`
 *      and the caller's TypeScript fallback runs. This is the designed
 *      degradation path (e.g. dev checkouts without a built addon).
 *   2. **Native call threw** — the napi boundary itself errored (argument
 *      serialization, unexpected throw from Rust). These are *not* treated
 *      as "module missing": the failure is reported to stderr, and the
 *      tool-shaped wrappers (read/write/edit/grep/fetch/search/list-dir)
 *      return an error verdict that is final, so a native bug is never
 *      silently re-run through the TS implementation.
 *   3. **Native returned an error field** — a normal native error result;
 *      the caller owns the verdict (same convention as class 2).
 *
 * When the module IS built, napi-rs exposes the Rust `snake_case` functions
 * as `camelCase` JS identifiers (e.g. `native_escape_xml` → `nativeEscapeXml`).
 */
import { createRequire } from 'node:module';

const requireNative = createRequire(import.meta.url);

// Three-state cache: undefined = not tried, null = tried & failed, object = loaded.
let nativeModule: Record<string, unknown> | null | undefined;

/** Report a native call that threw at the napi boundary (never silent). */
function reportNativeFailure(name: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  try {
    process.stderr.write(`[native-tools] native ${name} threw: ${message}\n`);
  } catch {
    // stderr itself failed — nothing sensible left to do.
  }
}

function getNativeModule(): Record<string, unknown> | undefined {
  // Test switch: force the TypeScript fallback path for every wrapper. Lets
  // parity suites (native vs TS on the same inputs) and golden-vector runs
  // exercise both implementations, and gives developers a way to compare
  // behavior without uninstalling the addon.
  if (process.env['KIMI_NATIVE_TOOLS_FORCE_JS']) return undefined;
  if (nativeModule === null) return undefined;
  if (nativeModule !== undefined) return nativeModule;
  try {
    nativeModule = requireNative('@moonshot-ai/kimi-native-tools') as Record<string, unknown>;
    return nativeModule ?? undefined;
  } catch {
    nativeModule = null;
    return undefined;
  }
}

function getNativeFn(name: string): ((...args: unknown[]) => unknown) | undefined {
  const mod = getNativeModule();
  if (!mod) return undefined;
  const fn = mod[name];
  return typeof fn === 'function' ? (fn as (...args: unknown[]) => unknown) : undefined;
}

/**
 * Call a synchronous native function.
 *
 * Returns `undefined` when the module is unavailable (designed fallback).
 * When the call itself throws, the failure is reported to stderr and
 * `onThrown` (when provided) builds the caller's error verdict — a thrown
 * native call is never silently treated as "module missing".
 */
function callNativeSync<T>(
  name: string,
  args: unknown[],
  onThrown?: (message: string) => T | undefined,
): T | undefined {
  const fn = getNativeFn(name);
  if (fn === undefined) return undefined;
  try {
    const result = fn(...args);
    return (result as T) ?? undefined;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    reportNativeFailure(name, error);
    return onThrown ? onThrown(message) : undefined;
  }
}

/**
 * Call an async native function.
 *
 * Same failure-class semantics as `callNativeSync`.
 */
async function callNativeAsync<T>(
  name: string,
  args: unknown[],
  onThrown?: (message: string) => T | undefined,
): Promise<T | undefined> {
  const fn = getNativeFn(name);
  if (fn === undefined) return undefined;
  try {
    const result = await (fn(...args) as Promise<T> | T);
    return result ?? undefined;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    reportNativeFailure(name, error);
    return onThrown ? onThrown(message) : undefined;
  }
}

// ── XML / HTML escaping ─────────────────────────────────────────────
export function tryNativeEscapeXml(input: string): string | undefined {
  return callNativeSync<string>('nativeEscapeXml', [input]);
}
export function tryNativeEscapeXmlAttr(input: string): string | undefined {
  return callNativeSync<string>('nativeEscapeXmlAttr', [input]);
}
export function tryNativeEscapeXmlTags(input: string): string | undefined {
  return callNativeSync<string>('nativeEscapeXmlTags', [input]);
}

// ── Token estimation / truncation ───────────────────────────────────
export function tryNativeEstimateTokens(text: string): number | undefined {
  return callNativeSync<number>('nativeEstimateTokens', [text]);
}

// ── File Read (native fast-path) ─────────────────────────────────────

export interface NativeReadResult {
  readonly content: string;
  readonly lineCount: number;
  readonly error?: string;
  /**
   * Machine-readable error class — `not_found` / `not_a_file` / `media` /
   * `binary` / `invalid_utf8` / `io` / `panic` / `native_error`.
   * Observability metadata only: every native error is a final verdict
   * regardless of whether the kind is present.
   */
  readonly errorKind?: string;
}

/**
 * Try the Rust native file read. Returns `undefined` when the native
 * module is unavailable, letting the caller fall through to the TS path.
 * A native call that throws is a final error verdict (never re-run in TS).
 */
export function tryNativeRead(
  path: string,
  options?: { lineOffset?: number; nLines?: number },
): Promise<NativeReadResult | undefined> {
  return callNativeAsync<NativeReadResult>('nativeRead', [path, options ?? {}], (message) => ({
    content: '',
    lineCount: 0,
    error: `native read failed: ${message}`,
    errorKind: 'native_error',
  }));
}

// ── File Write (native fast-path) ────────────────────────────────────

export interface NativeWriteResult {
  readonly bytesWritten: number;
  readonly error?: string;
  /**
   * Machine-readable error class — `io` / `parent_not_dir` / `panic`.
   * Observability metadata only: every native error is a final verdict
   * regardless of whether the kind is present.
   */
  readonly errorKind?: string;
}

/**
 * Try the Rust native file write. Creates parent dirs automatically.
 * The write is a plain truncating pass (or `O_APPEND`), matching the TS
 * writeText semantics — not a temp-file-and-rename atomic write.
 * Returns `undefined` when the native module is unavailable.
 * A native call that throws is a final error verdict (never re-run in TS).
 */
export function tryNativeWrite(
  path: string,
  content: string,
  mode?: 'overwrite' | 'append',
): Promise<NativeWriteResult | undefined> {
  return callNativeAsync<NativeWriteResult>(
    'nativeWrite',
    [path, content, { mode: mode ?? null }],
    (message) => ({
      bytesWritten: 0,
      error: `native write failed: ${message}`,
      errorKind: 'native_error',
    }),
  );
}
export function tryNativeEstimateTokensBatch(texts: readonly string[]): number | undefined {
  return callNativeSync<number>('nativeEstimateTokensBatch', [[...texts]]);
}
export function tryNativeTruncateTextToTokens(text: string, maxTokens: number): string | undefined {
  return callNativeSync<string>('nativeTruncateTextToTokens', [text, maxTokens]);
}

// ── MCP tool-name sanitization ──────────────────────────────────────
export function tryNativeSanitizeMcpNamePart(part: string): string | undefined {
  return callNativeSync<string>('nativeSanitizeMcpNamePart', [part]);
}
export function tryNativeQualifyMcpToolName(
  serverName: string,
  toolName: string,
): string | undefined {
  return callNativeSync<string>('nativeQualifyMcpToolName', [serverName, toolName]);
}

// ── Image compression (async; wired into image-compress.ts) ────────
// The Rust codec in `kimi-native-tools` (`image_compress.rs`) applies EXIF
// orientation on decode (see `decode_with_orientation`), so its reported
// dimensions and crop regions live in the same display (EXIF-rotated) space as
// jimp. It is the primary codec in `image-compress.ts`; when it is unavailable
// the caller falls back to the jimp pipeline (which mirrors the `image` crate's
// strategy: PNG ladder first for lossless inputs, then a JPEG quality ladder
// with the same fallback edges).
// See rust-migration-analysis.md §6.5.
export interface NativeCompressImageConfig {
  readonly maxEdge: number;
  readonly byteBudget: number;
  readonly fallbackEdges: readonly number[];
  readonly jpegQualitySteps: readonly number[];
}

export interface NativeCompressImageResult {
  readonly data: Uint8Array;
  readonly mimeType: string;
  readonly width: number;
  readonly height: number;
  readonly originalWidth: number;
  readonly originalHeight: number;
  readonly changed: boolean;
  readonly originalByteLength: number;
  readonly finalByteLength: number;
}

/**
 * Try the Rust native image compression codec. Returns `undefined` when the
 * native module is unavailable, the call fails, or the result is `null`
 * (unsupported format / passthrough). The caller falls back to the jimp
 * pipeline.
 */
export async function tryNativeCompressImage(
  data: Uint8Array,
  mimeType: string,
  config: NativeCompressImageConfig,
): Promise<NativeCompressImageResult | undefined> {
  const result = await callNativeAsync<NativeCompressImageResult | null>('nativeCompressImage', [
    data,
    mimeType,
    {
      maxEdge: config.maxEdge,
      byteBudget: config.byteBudget,
      fallbackEdges: [...config.fallbackEdges],
      jpegQualitySteps: [...config.jpegQualitySteps],
    },
  ]);
  return result ?? undefined;
}

// ── Glob matching (sync; reused by sessionFs fsSearch) ────────────
/**
 * Try the Rust native glob-set matcher. Returns `undefined` when the native
 * module is unavailable or the call fails, so the caller's `globToRegExp`
 * fallback runs. Case-sensitive, matching the TS `matchesAnyGlob` fallback
 * (no `i` flag).
 */
export function tryNativeGlobMatchesAny(
  globs: readonly string[],
  path: string,
): boolean | undefined {
  return callNativeSync<boolean>('nativeGlobMatchesAny', [[...globs], path]);
}

// ── Compaction (sync; wired into strategy.ts) ───────────────────────
// The Rust `compaction.rs` is a line-for-line port of the TS
// `DefaultCompactionStrategy.computeCompactCount` /
// `reduceCompactOnOverflow`. Both sides use the same token estimator
// (`nativeEstimateTokens`, wired above), and the split-safety guards
// (`canSplitAfter` / `prefixEndsWithOpenToolExchange`) are identical.
//
// napi-rs serialises Rust struct fields as camelCase (e.g.
// `tool_calls_count` → `toolCallsCount`, `max_size` → `maxSize`).

/** Lightweight projection of a Message for the compaction algorithm. */
export interface NativeCompactionMessageMeta {
  readonly role: string;
  /** napi-rs: `tool_calls_count` → camelCase */
  readonly toolCallsCount: number;
  readonly tokens: number;
}

/** Knobs for the compaction algorithm (mirrors CompactionConfig). */
export interface NativeCompactionConfigMeta {
  /** napi-rs: `max_size` → camelCase */
  readonly maxSize: number;
  /** napi-rs: `max_recent_messages` → camelCase */
  readonly maxRecentMessages: number;
  /** napi-rs: `max_recent_user_messages` → camelCase */
  readonly maxRecentUserMessages: number;
  /** napi-rs: `max_recent_size_ratio` */
  readonly maxRecentSizeRatio: number;
  /** napi-rs: `min_overflow_reduction_ratio` */
  readonly minOverflowReductionRatio: number;
}

/**
 * Try the Rust native compaction count. Returns `undefined` when the
 * native module is unavailable or the call fails; the caller falls back
 * to the TS implementation.
 *
 * Returns N where `messages[0..N]` is compacted and `messages[N..]` is
 * preserved. 0 means no compaction possible (no valid split point).
 */
export function tryNativeComputeCompactCount(
  messages: readonly NativeCompactionMessageMeta[],
  config: NativeCompactionConfigMeta,
  isManual: boolean,
): number | undefined {
  return callNativeSync<number>('nativeComputeCompactCount', [[...messages], config, isManual]);
}

/**
 * Try the Rust native overflow reduction. Returns `undefined` when the
 * native module is unavailable or the call fails; the caller falls back
 * to the TS implementation.
 *
 * Returns a split index — the number of messages to keep in the tail
 * after reducing the compacted prefix.
 */
export function tryNativeReduceCompactOnOverflow(
  messages: readonly NativeCompactionMessageMeta[],
  config: NativeCompactionConfigMeta,
): number | undefined {
  return callNativeSync<number>('nativeReduceCompactOnOverflow', [[...messages], config]);
}

// ── Image cropping (async; reused by image-compress.ts) ─────────────
export interface NativeCropImageConfig {
  readonly maxEdge: number;
  readonly byteBudget: number;
  readonly skipResize: boolean;
  readonly fallbackEdges: readonly number[];
  readonly jpegQualitySteps: readonly number[];
}

export interface NativeCropImageOutcome {
  readonly ok: boolean;
  readonly error: string;
  readonly errorKind: string;
  readonly data: Uint8Array;
  readonly mimeType: string;
  readonly width: number;
  readonly height: number;
  readonly originalWidth: number;
  readonly originalHeight: number;
  readonly regionX: number;
  readonly regionY: number;
  readonly regionWidth: number;
  readonly regionHeight: number;
  readonly resized: boolean;
  readonly originalByteLength: number;
  readonly finalByteLength: number;
}

/**
 * Try the Rust native image-crop codec. Returns `undefined` when the native
 * module is unavailable or the call fails; the caller falls back to the jimp
 * pipeline. When present, napi-rs exposes the Rust struct fields as
 * `camelCase` (e.g. `region_x` → `regionX`).
 */
export async function tryNativeCropImage(
  data: Uint8Array,
  mimeType: string,
  region: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  },
  config: NativeCropImageConfig,
): Promise<NativeCropImageOutcome | undefined> {
  const result = await callNativeAsync<NativeCropImageOutcome | null>('nativeCropImage', [
    data,
    mimeType,
    region.x,
    region.y,
    region.width,
    region.height,
    {
      maxEdge: config.maxEdge,
      byteBudget: config.byteBudget,
      skipResize: config.skipResize,
      fallbackEdges: [...config.fallbackEdges],
      jpegQualitySteps: [...config.jpegQualitySteps],
    },
  ]);
  return result ?? undefined;
}

export interface NativeImageDimensions {
  readonly width: number;
  readonly height: number;
  readonly transposed: boolean;
}

export function tryNativeSniffImageDimensions(data: Uint8Array): NativeImageDimensions | undefined {
  const m = getNativeModule();
  const sniff = m?.['nativeSniffImageDimensions'] as
    | ((data: Uint8Array) => NativeImageDimensions | null)
    | undefined;
  if (sniff) {
    try {
      return sniff(new Uint8Array(data)) ?? undefined;
    } catch (error) {
      reportNativeFailure('nativeSniffImageDimensions', error);
      return undefined;
    }
  }
  return undefined;
}

export interface NativeFileTypeResult {
  readonly kind: 'text' | 'image' | 'video' | 'unknown';
  readonly mimeType: string;
}

export function tryNativeDetectFileType(
  path: string,
  header: Uint8Array,
): NativeFileTypeResult | undefined {
  const m = getNativeModule();
  const detect = m?.['nativeDetectFileType'] as
    | ((
        path: string,
        header: Uint8Array,
      ) => { kind: string; mimeType?: string; mime_type?: string } | null)
    | undefined;
  if (detect) {
    try {
      const r = detect(path, new Uint8Array(header));
      return r
        ? {
            kind: r.kind as NativeFileTypeResult['kind'],
            mimeType: r.mimeType ?? r.mime_type ?? '',
          }
        : undefined;
    } catch (error) {
      reportNativeFailure('nativeDetectFileType', error);
      return undefined;
    }
  }
  return undefined;
}

// ============================================================================
// Goal — state machine, accounting, steering
// ============================================================================

/** Validate a goal objective. Returns error message on failure, or empty string on success. */
export function tryNativeGoalValidateObjective(objective: string): string | undefined {
  return callNativeSync<string>('nativeGoalValidateObjective', [objective]);
}

/** Apply a goal state update. Returns updated goal object or error. */
export function tryNativeGoalApplyUpdate(
  goalJson: string,
  updateJson: string,
): { ok: boolean; goal?: Record<string, unknown>; error?: string } | undefined {
  return callNativeSync('nativeGoalApplyUpdate', [goalJson, updateJson]);
}

/** Compute the chargeable token delta between two usage snapshots. */
export function tryNativeGoalComputeTokenDelta(
  prevInput: number,
  prevCached: number,
  prevOutput: number,
  currInput: number,
  currCached: number,
  currOutput: number,
): number | undefined {
  return callNativeSync<number>('nativeGoalComputeTokenDelta', [
    prevInput,
    prevCached,
    prevOutput,
    currInput,
    currCached,
    currOutput,
  ]);
}

/** Render the continuation steering prompt. */
export function tryNativeGoalRenderContinuation(
  objective: string,
  tokensUsed: number,
  tokenBudget: number | null,
): string | undefined {
  return callNativeSync<string>('nativeGoalRenderContinuation', [
    objective,
    tokensUsed,
    tokenBudget,
  ]);
}

/** Render the budget-limit wrap-up prompt. */
export function tryNativeGoalRenderBudgetLimit(
  objective: string,
  tokensUsed: number,
  tokenBudget: number | null,
  timeUsedSeconds: number,
): string | undefined {
  return callNativeSync<string>('nativeGoalRenderBudgetLimit', [
    objective,
    tokensUsed,
    tokenBudget,
    timeUsedSeconds,
  ]);
}

/** Render the objective-updated prompt. */
export function tryNativeGoalRenderObjectiveUpdated(
  objective: string,
  tokensUsed: number,
  tokenBudget: number | null,
): string | undefined {
  return callNativeSync<string>('nativeGoalRenderObjectiveUpdated', [
    objective,
    tokensUsed,
    tokenBudget,
  ]);
}

// ============================================================================
// FetchUrl — HTTP fetch with SSRF protection and HTML extraction
// ============================================================================

export interface NativeFetchUrlResult {
  readonly content: string;
  readonly kind: 'passthrough' | 'extracted';
  readonly status: number;
  readonly error?: string;
}

/**
 * Fetch a URL via Rust native HTTP client with SSRF protection and HTML
 * extraction. Returns `undefined` when the native module is unavailable.
 * A native call that throws is a final error verdict (never re-run in TS).
 */
export function tryNativeFetchUrl(
  url: string,
  options?: { userAgent?: string; maxBytes?: number; allowPrivate?: boolean; timeoutMs?: number },
): Promise<NativeFetchUrlResult | undefined> {
  return callNativeAsync<NativeFetchUrlResult>(
    'nativeFetchUrl',
    [url, options ?? {}],
    (message) => ({
      content: '',
      kind: 'passthrough',
      status: 0,
      error: `native fetch failed: ${message}`,
    }),
  );
}

// ============================================================================
// WebSearch — DuckDuckGo HTML scraping
// ============================================================================

export interface NativeWebSearchEntry {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
  readonly siteName?: string;
}

export interface NativeWebSearchResult {
  readonly results: NativeWebSearchEntry[];
  readonly error?: string;
}

/**
 * Search DuckDuckGo via Rust native HTTP + HTML scraping.
 * Returns `undefined` when the native module is unavailable.
 * A native call that throws is a final error verdict (never re-run in TS).
 */
export function tryNativeWebSearch(
  query: string,
  options?: { timeoutMs?: number; maxResults?: number },
): Promise<NativeWebSearchResult | undefined> {
  return callNativeAsync<NativeWebSearchResult>(
    'nativeWebSearch',
    [query, options ?? {}],
    (message) => ({ results: [], error: `native search failed: ${message}` }),
  );
}

// ============================================================================
// Structured Grep — native fallback when ripgrep is not on PATH
// ============================================================================

export interface NativeGrepStructuredMatch {
  readonly line: number;
  readonly col: number;
  readonly text: string;
  readonly before: string[];
  readonly after: string[];
}

export interface NativeGrepStructuredFile {
  readonly path: string;
  readonly matches: NativeGrepStructuredMatch[];
}

export interface NativeGrepStructuredResult {
  readonly files: NativeGrepStructuredFile[];
  readonly filesScanned: number;
  readonly truncated: boolean;
  readonly error?: string;
}

/**
 * Structured grep via Rust native directory walker + regex engine.
 * Use as a fallback when ripgrep is not available on PATH.
 * Returns `undefined` when the native module is unavailable.
 */
export function tryNativeGrepStructured(
  pattern: string,
  path: string,
  options?: {
    literal?: boolean;
    caseInsensitive?: boolean;
    includeGlobs?: string[];
    excludeGlobs?: string[];
    contextLines?: number;
    maxFiles?: number;
    maxMatchesPerFile?: number;
    maxTotalMatches?: number;
    timeoutMs?: number;
    followGitignore?: boolean;
  },
): Promise<NativeGrepStructuredResult | undefined> {
  const opts = options ?? {};
  return callNativeAsync<NativeGrepStructuredResult>(
    'nativeGrepStructured',
    [
      pattern,
      path,
      opts.literal ?? false,
      opts.caseInsensitive ?? false,
      opts.includeGlobs ?? [],
      opts.excludeGlobs ?? [],
      opts.contextLines ?? 0,
      opts.maxFiles ?? 5000,
      opts.maxMatchesPerFile ?? 100,
      opts.maxTotalMatches ?? 500,
      opts.timeoutMs ?? 20000,
      opts.followGitignore ?? true,
    ],
    (message) => ({
      files: [],
      filesScanned: 0,
      truncated: false,
      error: `native grep failed: ${message}`,
    }),
  );
}
// ============================================================================
// Edit (native fast-path)
// ============================================================================

export interface NativeEditResult {
  readonly success: boolean;
  readonly error?: string;
  readonly replacements: number;
}

/**
 * Try the Rust native file edit. Returns `undefined` when the native module
 * is unavailable, letting the caller fall through to the TS edit path.
 * A native call that throws is a final error verdict (never re-run in TS).
 * `replaceAll` defaults to false (exactly one occurrence).
 */
export function tryNativeEdit(
  path: string,
  oldString: string,
  newString: string,
  replaceAll?: boolean,
): Promise<NativeEditResult | undefined> {
  return callNativeAsync<NativeEditResult>(
    'nativeEdit',
    [path, oldString, newString, { replaceAll: replaceAll ?? false }],
    (message) => ({ success: false, replacements: 0, error: `native edit failed: ${message}` }),
  );
}

// ============================================================================
// Path access (native fast-path)
// ============================================================================

export type NativePathClass = 'posix' | 'win32';

export function tryNativePathNormalizeUserPath(
  path: string,
  pathClass: NativePathClass,
): string | undefined {
  return callNativeSync<string>('nativePathNormalizeUserPath', [path, pathClass]);
}

export function tryNativePathExpandUserPath(
  path: string,
  homeDir: string,
  pathClass: NativePathClass,
): string | undefined {
  return callNativeSync<string>('nativePathExpandUserPath', [path, homeDir, pathClass]);
}

export function tryNativePathCanonicalize(
  path: string,
  cwd: string,
  pathClass: NativePathClass,
): string | undefined {
  return callNativeSync<string>('nativePathCanonicalize', [path, cwd, pathClass]);
}

export function tryNativePathIsWithinDirectory(
  candidate: string,
  base: string,
  pathClass: NativePathClass,
): boolean | undefined {
  return callNativeSync<boolean>('nativePathIsWithinDirectory', [candidate, base, pathClass]);
}

export function tryNativePathIsWithinWorkspace(
  candidate: string,
  roots: readonly string[],
  pathClass: NativePathClass,
): boolean | undefined {
  return callNativeSync<boolean>('nativePathIsWithinWorkspace', [candidate, [...roots], pathClass]);
}

// ============================================================================
// Sensitive file detection (native fast-path)
// ============================================================================

export function tryNativeIsSensitiveFile(path: string): boolean | undefined {
  return callNativeSync<boolean>('nativeIsSensitiveFile', [path]);
}

// ============================================================================
// Permission pattern parsing (native fast-path)
// ============================================================================

export interface NativePermissionPattern {
  readonly toolName: string;
  readonly argPattern: string | null;
}

export function tryNativeParsePermissionPattern(
  pattern: string,
): NativePermissionPattern | undefined {
  const result = callNativeSync<string>('nativeParsePermissionPattern', [pattern]);
  if (result === undefined) return undefined;
  try {
    const parsed = JSON.parse(result) as { toolName?: string; argPattern?: string | null };
    if (typeof parsed.toolName === 'string') {
      return { toolName: parsed.toolName, argPattern: parsed.argPattern ?? null };
    }
    return undefined; // "ERROR: ..." string — caller falls back to TS
  } catch {
    return undefined;
  }
}

// ============================================================================
// Compaction — split safety + user message selection
// ============================================================================

export interface NativeCompactionUserMessageMeta {
  readonly role: string;
  readonly text: string;
  readonly tokens: number;
}

export interface NativeCompactionUserSelection {
  readonly headIndices: number[];
  readonly tailIndices: number[];
  readonly headTruncateChars: number | null;
  readonly tailTruncateChars: number | null;
  readonly elided: boolean;
  readonly omittedTokens: number;
}

export function tryNativeSelectCompactionUserMessages(
  messages: readonly NativeCompactionUserMessageMeta[],
  maxTokens: number,
  headTokens: number,
): NativeCompactionUserSelection | undefined {
  return callNativeSync<NativeCompactionUserSelection>('nativeSelectCompactionUserMessages', [
    messages.map((m) => ({ role: m.role, text: m.text, tokens: m.tokens })),
    maxTokens,
    headTokens,
  ]);
}

// ============================================================================
// Token truncation from end
// ============================================================================

export function tryNativeTruncateTextToTokensFromEnd(
  text: string,
  maxTokens: number,
): string | undefined {
  return callNativeSync<string>('nativeTruncateTextToTokensFromEnd', [text, maxTokens]);
}

// ============================================================================
// Tool output truncation (ToolResultBuilder.write core)
// ============================================================================

export interface NativeToolOutputChunkResult {
  readonly output: string;
  readonly charsWritten: number;
  readonly newNchars: number;
  readonly truncated: boolean;
}

export function tryNativeWriteToolOutputChunk(
  text: string,
  currentNchars: number,
  maxChars: number,
  maxLineLength: number | null,
  alreadyTruncated: boolean,
): NativeToolOutputChunkResult | undefined {
  // The TS path treats non-finite budgets as "no limit" (Infinity never
  // truncates). napi u32 cannot represent them, so fall back to TS instead
  // of corrupting the budget at the boundary.
  if (!Number.isFinite(maxChars)) return undefined;
  if (maxLineLength !== null && !Number.isFinite(maxLineLength)) return undefined;
  return callNativeSync<NativeToolOutputChunkResult>('nativeWriteToolOutputChunk', [
    text,
    currentNchars,
    maxChars,
    maxLineLength,
    alreadyTruncated,
  ]);
}

// ============================================================================
// List directory (native fast-path)
// ============================================================================

export interface NativeListDirectoryOptions {
  readonly path?: string;
  readonly collapseHiddenDirs?: boolean;
}

export interface NativeListDirectoryResult {
  readonly output: string;
  readonly error?: string;
}

export function tryNativeListDirectory(
  options?: NativeListDirectoryOptions,
): NativeListDirectoryResult | undefined {
  return callNativeSync<NativeListDirectoryResult>(
    'nativeListDirectory',
    [{ path: options?.path ?? null, collapseHiddenDirs: options?.collapseHiddenDirs ?? null }],
    (message) => ({ output: '', error: `native list-directory failed: ${message}` }),
  );
}

// ============================================================================
// Tool access conflict detection
// ============================================================================

export interface NativeToolAccessMeta {
  readonly kind: string;
  readonly operation?: string;
  readonly path?: string;
  readonly recursive?: boolean;
}

export function tryNativeIsMcpToolName(name: string): boolean | undefined {
  return callNativeSync<boolean>('nativeIsMcpToolName', [name]);
}

export function tryNativeToolAccessesConflict(
  left: readonly NativeToolAccessMeta[],
  right: readonly NativeToolAccessMeta[],
): boolean | undefined {
  return callNativeSync<boolean>('nativeToolAccessesConflict', [
    left.map((a) => ({
      kind: a.kind,
      operation: a.operation ?? null,
      path: a.path ?? null,
      recursive: a.recursive ?? null,
    })),
    right.map((a) => ({
      kind: a.kind,
      operation: a.operation ?? null,
      path: a.path ?? null,
      recursive: a.recursive ?? null,
    })),
  ]);
}
