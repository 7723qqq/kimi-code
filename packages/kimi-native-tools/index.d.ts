/// TypeScript type declarations for kimi-native-tools.

export interface ReadResult {
  content: string;
  lineCount: number;
  error?: string;
}

export interface WriteResult {
  bytesWritten: number;
  error?: string;
}

export interface EditResult {
  success: boolean;
  error?: string;
  replacements: number;
}

export interface GrepResult {
  content: string;
  error?: string;
  matchCount: number;
  fileCount: number;
}

export interface GlobResult {
  files: string[];
  error?: string;
  truncated: boolean;
}

export interface BashResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  error?: string;
}

export interface ReadOptions {
  lineOffset?: number;
  nLines?: number;
}

export interface WriteOptions {
  mode?: 'overwrite' | 'append';
}

export interface EditOptions {
  replaceAll?: boolean;
}

export interface GrepOptions {
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
}

export interface GlobOptions {
  path?: string;
  includeDirs?: boolean;
}

export interface BashOptions {
  cwd?: string;
  timeout?: number;
  env?: [string, string][];
}

export declare function nativeRead(path: string, options?: ReadOptions): ReadResult;
export declare function nativeWrite(path: string, content: string, options?: WriteOptions): WriteResult;
export declare function nativeEdit(path: string, oldString: string, newString: string, options?: EditOptions): EditResult;
export declare function nativeGrep(pattern: string, options?: GrepOptions): GrepResult;
export declare function nativeGlob(pattern: string, options?: GlobOptions): GlobResult;
export declare function nativeBash(command: string, options?: BashOptions): BashResult;

export declare const READ_MAX_LINES: number;
export declare const READ_MAX_LINE_LENGTH: number;
export declare const READ_MAX_BYTES: number;
export declare const GLOB_MAX_MATCHES: number;
export declare const GREP_DEFAULT_HEAD_LIMIT: number;
export declare const BASH_DEFAULT_TIMEOUT: number;
export declare const BASH_MAX_TIMEOUT: number;
