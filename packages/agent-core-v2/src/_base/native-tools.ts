import { createRequire } from 'node:module';

const requireNative = createRequire(import.meta.url);

let nativeModule: Record<string, unknown> | null | undefined;

function reportNativeFailure(name: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  try {
    process.stderr.write(`[native-tools] native ${name} threw: ${message}\n`);
  } catch {}
}

function getNativeModule(): Record<string, unknown> | undefined {
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

export function tryNativeEscapeXml(input: string): string | undefined {
  return callNativeSync<string>('nativeEscapeXml', [input]);
}
export function tryNativeEscapeXmlAttr(input: string): string | undefined {
  return callNativeSync<string>('nativeEscapeXmlAttr', [input]);
}
export function tryNativeEscapeXmlTags(input: string): string | undefined {
  return callNativeSync<string>('nativeEscapeXmlTags', [input]);
}

export interface NativeReadResult {
  readonly content: string;
  readonly lineCount: number;
  readonly error?: string;
  readonly errorKind?: string;
}

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

export interface NativeWriteResult {
  readonly bytesWritten: number;
  readonly error?: string;
  readonly errorKind?: string;
}

export function tryNativeWrite(
  path: string,
  content: string,
  mode?: 'overwrite' | 'append',
  atomic?: boolean,
): Promise<NativeWriteResult | undefined> {
  return callNativeAsync<NativeWriteResult>(
    'nativeWrite',
    [path, content, { mode: mode ?? null, atomic: atomic ?? null }],
    (message) => ({
      bytesWritten: 0,
      error: `native write failed: ${message}`,
      errorKind: 'native_error',
    }),
  );
}

export function tryNativeSanitizeMcpNamePart(part: string): string | undefined {
  return callNativeSync<string>('nativeSanitizeMcpNamePart', [part]);
}
export function tryNativeQualifyMcpToolName(
  serverName: string,
  toolName: string,
): string | undefined {
  return callNativeSync<string>('nativeQualifyMcpToolName', [serverName, toolName]);
}

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

export function tryNativeGlobMatchesAny(
  globs: readonly string[],
  path: string,
): boolean | undefined {
  return callNativeSync<boolean>('nativeGlobMatchesAny', [[...globs], path]);
}

export interface NativeCompactionMessageMeta {
  readonly role: string;
  readonly toolCallsCount: number;
  readonly tokens: number;
}

export interface NativeCompactionConfigMeta {
  readonly maxSize: number;
  readonly maxRecentMessages: number;
  readonly maxRecentUserMessages: number;
  readonly maxRecentSizeRatio: number;
  readonly minOverflowReductionRatio: number;
}

export function tryNativeComputeCompactCount(
  messages: readonly NativeCompactionMessageMeta[],
  config: NativeCompactionConfigMeta,
  isManual: boolean,
): number | undefined {
  return callNativeSync<number>('nativeComputeCompactCount', [[...messages], config, isManual]);
}

export function tryNativeReduceCompactOnOverflow(
  messages: readonly NativeCompactionMessageMeta[],
  config: NativeCompactionConfigMeta,
): number | undefined {
  return callNativeSync<number>('nativeReduceCompactOnOverflow', [[...messages], config]);
}

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

export function tryNativeGoalValidateObjective(objective: string): string | undefined {
  return callNativeSync<string>('nativeGoalValidateObjective', [objective]);
}

export function tryNativeGoalApplyUpdate(
  goalJson: string,
  updateJson: string,
): { ok: boolean; goal?: Record<string, unknown>; error?: string } | undefined {
  return callNativeSync('nativeGoalApplyUpdate', [goalJson, updateJson]);
}

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

export interface NativeFetchUrlResult {
  readonly content: string;
  readonly kind: 'passthrough' | 'extracted';
  readonly status: number;
  readonly error?: string;
}

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

export interface NativeBashSpawnConfig {
  readonly argv: string[];
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly env?: Record<string, string>;
}

export interface NativeBashEvent {
  readonly id: number;
  readonly kind: 'stdout' | 'stderr' | 'exit' | 'error';
  readonly data?: string;
  readonly exitCode?: number;
  readonly error?: string;
}

export interface NativeSpawnResult {
  readonly id: number;
  readonly pid: number;
}

export interface NativeBashExit {
  readonly exitCode: number;
  readonly timedOut: boolean;
  readonly error?: string;
}

export function tryNativeBashSpawn(
  config: NativeBashSpawnConfig,
  onEvent: (event: NativeBashEvent) => void,
): NativeSpawnResult | undefined {
  return callNativeSync<NativeSpawnResult>(
    'nativeBashSpawn',
    [
      {
        argv: [...config.argv],
        cwd: config.cwd,
        timeoutMs: config.timeoutMs,
        env: config.env === undefined ? undefined : Object.entries(config.env),
      },
      (err: unknown, event: NativeBashEvent | undefined) => {
        if (err !== null && err !== undefined) {
          const message =
            err instanceof Error
              ? err.message
              : typeof err === 'string'
                ? err
                : JSON.stringify(err);
          onEvent({ id: 0, kind: 'error', error: message });
          return;
        }
        if (event !== undefined) onEvent(event);
      },
    ],
    (message) => {
      onEvent({ id: 0, kind: 'error', error: `native bash spawn failed: ${message}` });
      return undefined;
    },
  );
}

export async function tryNativeBashWait(id: number): Promise<NativeBashExit | undefined> {
  return callNativeAsync<NativeBashExit>('nativeBashWait', [id]);
}

export function tryNativeBashKill(id: number): boolean | undefined {
  return callNativeSync<boolean>('nativeBashKill', [id]);
}

export function tryNativeBashDispose(id: number): boolean | undefined {
  return callNativeSync<boolean>('nativeBashDispose', [id]);
}

export interface NativeGrepResult {
  readonly content: string;
  readonly error?: string;
  readonly matchCount: number;
  readonly fileCount: number;
  readonly filteredSensitive: string[];
  readonly timedOut: boolean;
}

export interface NativeGrepOptions {
  readonly glob?: string;
  readonly fileType?: string;
  readonly outputMode?: 'content' | 'files_with_matches' | 'count_matches';
  readonly caseInsensitive?: boolean;
  readonly lineNumbers?: boolean;
  readonly afterContext?: number;
  readonly beforeContext?: number;
  readonly context?: number;
  readonly multiline?: boolean;
  readonly includeIgnored?: boolean;
  readonly timeoutMs?: number;
}

export function tryNativeGrep(
  pattern: string,
  path: string,
  options?: NativeGrepOptions,
): Promise<NativeGrepResult | undefined> {
  return callNativeAsync<NativeGrepResult>(
    'nativeGrep',
    [
      pattern,
      {
        path,
        glob: options?.glob,
        fileType: options?.fileType,
        outputMode: options?.outputMode,
        caseInsensitive: options?.caseInsensitive,
        lineNumbers: options?.lineNumbers,
        afterContext: options?.afterContext,
        beforeContext: options?.beforeContext,
        context: options?.context,
        headLimit: 0,
        offset: 0,
        multiline: options?.multiline,
        includeIgnored: options?.includeIgnored,
        timeoutMs: options?.timeoutMs,
      },
    ],
    (message) => ({
      content: '',
      error: `native grep failed: ${message}`,
      matchCount: 0,
      fileCount: 0,
      filteredSensitive: [],
      timedOut: false,
    }),
  );
}

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
export interface NativeEditResult {
  readonly success: boolean;
  readonly error?: string;
  readonly replacements: number;
}

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

export function tryNativeIsSensitiveFile(path: string): boolean | undefined {
  return callNativeSync<boolean>('nativeIsSensitiveFile', [path]);
}

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
    return undefined;
  } catch {
    return undefined;
  }
}

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

export function tryNativeTruncateTextToTokensFromEnd(
  text: string,
  maxTokens: number,
): string | undefined {
  return callNativeSync<string>('nativeTruncateTextToTokensFromEnd', [text, maxTokens]);
}

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
      operation: a.operation,
      path: a.path,
      recursive: a.recursive,
    })),
    right.map((a) => ({
      kind: a.kind,
      operation: a.operation,
      path: a.path,
      recursive: a.recursive,
    })),
  ]);
}
