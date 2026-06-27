export interface NativeReadOptions {
  lineOffset?: number;
  nLines?: number;
}

export interface NativeReadResult {
  content: string;
  lineCount: number;
  error?: string;
}

export interface NativeWriteOptions {
  mode?: 'overwrite' | 'append';
}

export interface NativeWriteResult {
  bytesWritten: number;
  error?: string;
}

export interface NativeEditOptions {
  replaceAll?: boolean;
}

export interface NativeEditResult {
  success: boolean;
  error?: string;
  replacements: number;
}

export interface NativeGrepOptions {
  path?: string;
  glob?: string;
  fileType?: string;
  outputMode?: 'content' | 'files_with_matches' | 'count_matches';
  caseInsensitive?: boolean;
  lineNumbers?: boolean;
  afterContext?: number;
  beforeContext?: number;
  context?: number;
  headLimit?: number;
  offset?: number;
  multiline?: boolean;
  includeIgnored?: boolean;
  timeoutMs?: number;
}

export interface NativeGrepResult {
  content: string;
  error?: string;
  matchCount: number;
  fileCount: number;
  filteredSensitive: string[];
  timedOut: boolean;
}

export interface NativeGlobOptions {
  path?: string;
  includeDirs?: boolean;
}

export interface NativeGlobResult {
  files: string[];
  error?: string;
  truncated: boolean;
}

export interface NativeListDirectoryOptions {
  path?: string;
  collapseHiddenDirs?: boolean;
}

export interface NativeListDirectoryResult {
  output: string;
  error?: string;
}

export interface NativeSniffImageDimensionsResult {
  width: number;
  height: number;
}

export interface NativeBashOptions {
  cwd?: string;
  timeout?: number;
  env?: Array<[string, string]>;
}

export interface NativeBashResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  error?: string;
}

export interface GrepStructuredMatch {
  line: number;
  col: number;
  text: string;
  before: string[];
  after: string[];
}

export interface GrepStructuredFileHit {
  path: string;
  matches: GrepStructuredMatch[];
}

export interface GrepStructuredResult {
  files: GrepStructuredFileHit[];
  files_scanned: number;
  truncated: boolean;
  error?: string;
}

export interface CompactionMessageMeta {
  role: string;
  tool_calls_count: number;
  tokens: number;
}

export interface CompactionConfigMeta {
  max_size: number;
  max_recent_messages: number;
  max_recent_user_messages: number;
  max_recent_size_ratio: number;
  min_overflow_reduction_ratio: number;
}

export declare function nativeRead(path: string, options?: NativeReadOptions): NativeReadResult;
export declare function nativeWrite(path: string, content: string, options?: NativeWriteOptions): NativeWriteResult;
export declare function nativeEdit(path: string, oldString: string, newString: string, options?: NativeEditOptions): NativeEditResult;
export declare function nativeGrep(pattern: string, options?: NativeGrepOptions): Promise<NativeGrepResult>;
export declare function nativeGlob(pattern: string, options?: NativeGlobOptions): NativeGlobResult;
export declare function nativeGlobMatchesAny(globs: string[], path: string): boolean;
export declare function nativeListDirectory(options?: NativeListDirectoryOptions): NativeListDirectoryResult;
export declare function nativeSniffImageDimensions(data: Buffer | Uint8Array): NativeSniffImageDimensionsResult | null;
export declare function nativeIsSensitiveFile(path: string): boolean;
export declare function nativeEstimateTokens(text: string): number;
export declare function nativeEstimateTokensBatch(texts: string[]): number;
export declare function nativeBash(command: string, options?: NativeBashOptions): Promise<NativeBashResult>;
export declare function nativeComputeCompactCount(messages: CompactionMessageMeta[], config: CompactionConfigMeta, isManual: boolean): number;
export declare function nativeReduceCompactOnOverflow(messages: CompactionMessageMeta[], config: CompactionConfigMeta): number;
export declare function nativeResolveCompactionMaxCompletionTokens(maxContextTokens: number, maxOutputSize: number | null): number | null;
export declare const DEFAULT_COMPACTION_MAX_COMPLETION_TOKENS: number;
export declare function nativeGrepStructured(
  pattern: string,
  path: string,
  literal: boolean,
  caseInsensitive: boolean,
  includeGlobs: string[],
  excludeGlobs: string[],
  contextLines: number,
  maxFiles: number,
  maxMatchesPerFile: number,
  maxTotalMatches: number,
  timeoutMs: number,
  followGitignore: boolean,
): Promise<GrepStructuredResult>;

export declare const READ_MAX_LINES: number;
export declare const READ_MAX_LINE_LENGTH: number;
export declare const READ_MAX_BYTES: number;
export declare const GLOB_MAX_MATCHES: number;
export declare const GREP_DEFAULT_HEAD_LIMIT: number;
export declare const BASH_DEFAULT_TIMEOUT: number;
export declare const BASH_MAX_TIMEOUT: number;
