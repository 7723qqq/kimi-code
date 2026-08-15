/**
 * `tools` domain — `ReadTool` implementation.
 *
 * Streams the file through `IHostFileSystem.readLines`, enforces the
 * line/byte budgets from the contract, normalizes line endings for display
 * (pure CRLF shown as LF, mixed or lone carriage returns made visible as
 * `\r`), refuses binary / media files up front, and composes the `<system>`
 * finish note on the `note` side channel. UTF-16 LE/BE text (with a BOM or
 * the zero-byte parity heuristic) is decoded whole via `readBytes` and
 * transcoded to UTF-8, bounded by `TRANSCODE_MAX_BYTES`. When strict UTF-8
 * streaming decoding fails mid-file, the reader falls back to whole-file
 * GBK/GB18030 transcoding, then to lenient UTF-8 (malformed bytes replaced
 * with U+FFFD) gated on the replacement ratio, before refusing the file.
 *
 * Path safety goes through the shared path access resolver used by
 * Read/Write/Edit. Read access flows through the os `hostFs` domain
 * (`IHostFileSystem`); path semantics (home expansion, path class) come from
 * the `hostEnvironment` domain; the workspace and skill roots come from
 * `ISessionWorkspaceContext` / `ISessionSkillCatalog`.
 *
 * Ported from v1. The
 * optional `scanTextFile` / `readLineRange` / `readTailLines` fast-paths are
 * intentionally dropped: `IHostFileSystem` streams through `readLines` only.
 * Bound at Agent scope; self-registers via `registerAgentToolService(...)` at module
 * load.
 */

import { t } from '@moonshot-ai/kimi-i18n';

import { unwrapErrorCause } from '#/_base/errors/errors';
import { tryNativeRead } from '#/_base/native-tools';
import {
  decodeUtf8Lenient,
  decodeUtfText,
  detectLegacyTextEncoding,
  detectTextEncoding,
  type UtfTextEncoding,
} from '#/_base/text/encoding';
import {
  makeCarriageReturnsVisible,
  splitLinesKeepingTerminator,
  type LineEndingStyle,
} from '#/_base/text/line-endings';
import { renderPrompt } from '#/_base/utils/render-prompt';
import { MEDIA_SNIFF_BYTES, detectFileType } from '#/agent/media/file-type';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { ISessionSkillCatalog } from '#/session/sessionSkillCatalog/skillCatalog';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { toInputJsonSchema } from '#/tool/input-schema';
import {
  extendWorkspaceWithSkillRoots,
  resolvePathAccessPath,
  type WorkspaceConfig,
} from '#/tool/path-access';
import { literalRulePattern, matchesPathRuleSubject } from '#/tool/rule-match';
import { ToolAccesses, type ExecutableToolResult, type ToolExecution } from '#/tool/toolContract';

import {
  IReadTool,
  MAX_BYTES,
  MAX_LINE_LENGTH,
  MAX_LINES,
  ReadInputSchema,
  TRANSCODE_MAX_BYTES,
  type ReadInput,
} from './read';
import readDescriptionTemplate from './read.md?raw';

interface LineEndingFlags {
  hasCrLf: boolean;
  hasLf: boolean;
  hasLoneCr: boolean;
}

/**
 * Encodings the Read tool can display: the UTF family from the shared
 * detector, plus the fallback encodings produced by `readWithFallbackEncoding`
 * (GBK/GB18030 transcoded whole, or UTF-8 decoded leniently with malformed
 * bytes replaced).
 */
type ReadDisplayEncoding = UtfTextEncoding | 'gbk' | 'utf-8-lenient';

/**
 * Max share of the file's bytes that may be replaced by U+FFFD in the lenient
 * UTF-8 fallback before the file is refused as binary/unknown-encoding. Must
 * stay above `MIN_GBK_UTF8_REPLACEMENT_RATIO` so files that passed the GBK
 * gate (i.e. lenient ratio below it) are always acceptable here.
 */
const MAX_LENIENT_REPLACEMENT_RATIO = 0.25;

interface ReadLineEntry {
  readonly lineNo: number;
  readonly rawContent: string;
}

interface RenderedLine {
  readonly line: string;
  readonly wasTruncated: boolean;
}

interface FinishReadResultInput {
  readonly renderedLines: readonly string[];
  readonly truncatedLineNumbers: readonly number[];
  readonly maxLinesReached: boolean;
  readonly maxBytesReached: boolean;
  readonly lineEndingStyle: LineEndingStyle;
  readonly startLine: number;
  readonly totalLines: number;
  readonly requestedLines: number;
  readonly detectedEncoding?: ReadDisplayEncoding;
}

function truncateLine(line: string, maxLength: number): string {
  if (line.length <= maxLength) return line;
  const marker = '...';
  const target = Math.max(maxLength, marker.length);
  return line.slice(0, target - marker.length) + marker;
}

function stripTrailingLf(line: string): string {
  return line.endsWith('\n') ? line.slice(0, -1) : line;
}

function updateLineEndingFlags(flags: LineEndingFlags, text: string): void {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.codePointAt(i);
    if (code === 13) {
      if (text.codePointAt(i + 1) === 10) {
        flags.hasCrLf = true;
        i += 1;
      } else {
        flags.hasLoneCr = true;
      }
    } else if (code === 10) {
      flags.hasLf = true;
    }
  }
}

function lineEndingStyleFromFlags(flags: LineEndingFlags): LineEndingStyle {
  if (flags.hasLoneCr || (flags.hasCrLf && flags.hasLf)) return 'mixed';
  if (flags.hasCrLf) return 'crlf';
  return 'lf';
}

function renderLine(entry: ReadLineEntry, lineEndingStyle: LineEndingStyle): RenderedLine {
  const modelContent =
    lineEndingStyle === 'crlf' && entry.rawContent.endsWith('\r')
      ? entry.rawContent.slice(0, -1)
      : entry.rawContent;
  const truncated = truncateLine(modelContent, MAX_LINE_LENGTH);
  const renderedContent =
    lineEndingStyle === 'mixed' ? makeCarriageReturnsVisible(truncated) : truncated;
  return {
    line: `${String(entry.lineNo)}\t${renderedContent}`,
    wasTruncated: truncated !== modelContent,
  };
}

function renderedLineBytes(renderedLine: string, isFirst: boolean): number {
  return (isFirst ? 0 : 1) + Buffer.byteLength(renderedLine, 'utf8');
}

function renderEntries(
  entries: readonly ReadLineEntry[],
  lineEndingStyle: LineEndingStyle,
): {
  renderedLines: string[];
  truncatedLineNumbers: number[];
  maxBytesReached: boolean;
} {
  const renderedLines: string[] = [];
  const truncatedLineNumbers: number[] = [];
  let bytes = 0;
  let maxBytesReached = false;

  for (const entry of entries) {
    const rendered = renderLine(entry, lineEndingStyle);
    const lineBytes = renderedLineBytes(rendered.line, renderedLines.length === 0);
    if (renderedLines.length > 0 && bytes + lineBytes > MAX_BYTES) {
      maxBytesReached = true;
      break;
    }

    if (rendered.wasTruncated) {
      truncatedLineNumbers.push(entry.lineNo);
    }
    renderedLines.push(rendered.line);
    bytes += lineBytes;
    if (bytes >= MAX_BYTES) {
      maxBytesReached = true;
      break;
    }
  }

  return { renderedLines, truncatedLineNumbers, maxBytesReached };
}

function isFileNotFoundError(error: unknown): boolean {
  const unwrapped = unwrapErrorCause(error);
  if (typeof unwrapped !== 'object' || unwrapped === null) return false;
  const code = (unwrapped as { code?: unknown })['code'];
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function isTextDecodeError(error: unknown): boolean {
  const unwrapped = unwrapErrorCause(error);
  if (typeof unwrapped !== 'object' || unwrapped === null) return false;
  const code = (unwrapped as { code?: unknown })['code'];
  if (code === 'ERR_ENCODING_INVALID_ENCODED_DATA') return true;
  if (!(unwrapped instanceof Error)) return false;
  return /encoded data was not valid|invalid.*encoding|invalid.*utf-?8/i.test(unwrapped.message);
}

function containsNulByte(text: string): boolean {
  return text.includes('\u0000');
}

function encodingDisplayName(encoding: ReadDisplayEncoding): string {
  switch (encoding) {
    case 'utf-16le':
      return 'UTF-16 LE';
    case 'utf-16be':
      return 'UTF-16 BE';
    case 'gbk':
      return 'GBK/GB18030';
    case 'utf-8-lenient':
      return 'UTF-8';
    default:
      return 'UTF-8';
  }
}

async function* decodedLines(lines: readonly string[]): AsyncGenerator<string> {
  yield* lines;
}

function notReadableFileOutput(path: string): string {
  return (
    `"${path}" is not readable as UTF-8 text. ` +
    'If it is an image or video, use ReadMediaFile. ' +
    'For other binary formats, use Bash or an MCP tool if available.'
  );
}

function notUtf8DecodableFileOutput(path: string): string {
  return (
    `"${path}" is not valid UTF-8, UTF-16, or GBK/GB18030 text. ` +
    'Only UTF-8, UTF-16 and GBK/GB18030 text files can be read; ' +
    'for other encodings, convert the file to UTF-8 first (e.g. `iconv` via Bash).'
  );
}

const READ_DESCRIPTION = renderPrompt(readDescriptionTemplate, {
  MAX_LINES,
  MAX_BYTES_KB: MAX_BYTES / 1024,
  MAX_LINE_LENGTH,
});

export class ReadTool implements IReadTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'Read' as const;
  readonly description = READ_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(ReadInputSchema);
  constructor(
    @IHostFileSystem private readonly fs: IHostFileSystem,
    @IHostEnvironment private readonly env: IHostEnvironment,
    @ISessionWorkspaceContext private readonly workspaceCtx: ISessionWorkspaceContext,
    @ISessionSkillCatalog private readonly skillCatalog?: ISessionSkillCatalog,
  ) {}

  private get workspaceConfig(): WorkspaceConfig {
    return extendWorkspaceWithSkillRoots(
      {
        workspaceDir: this.workspaceCtx.workDir,
        additionalDirs: this.workspaceCtx.additionalDirs,
      },
      this.skillCatalog?.catalog.getSkillRoots() ?? [],
      this.env.pathClass,
    );
  }

  resolveExecution(args: ReadInput): ToolExecution {
    const path = resolvePathAccessPath(args.path, {
      env: this.env,
      workspace: this.workspaceConfig,
      operation: 'read',
    });
    return {
      accesses: ToolAccesses.readFile(path),
      description: t('toolsV2.reading', { path: args.path }),
      display: { kind: 'file_io', operation: 'read', path },
      approvalRule: literalRulePattern(this.name, path),
      matchesRule: (ruleArgs) =>
        matchesPathRuleSubject(ruleArgs, path, {
          cwd: this.workspaceConfig.workspaceDir,
          pathClass: this.env.pathClass,
          homeDir: this.env.homeDir,
        }),
      execute: () => this.execution(args, path),
    };
  }

  private async execution(args: ReadInput, safePath: string): Promise<ExecutableToolResult> {
    let stat: Awaited<ReturnType<IHostFileSystem['stat']>> | undefined;
    try {
      const lineOffset = args.line_offset ?? 1;
      const requestedLines = args.n_lines ?? MAX_LINES;
      const effectiveLimit = Math.min(requestedLines, MAX_LINES);

      // ── Native fast-path ─────────────────────────────────────────────
      // The native reader owns the full capability set: line counting,
      // offsets, limits, CRLF handling, UTF-16 LE/BE transcoding, and the
      // GBK/GB18030 + lenient-UTF-8 fallback chain all run in Rust — ~5x
      // faster than the async line iterator and with no capability gap.
      // It is tried FIRST: the native reader performs every preflight
      // itself (existence, file type, media redirect, encoding detection),
      // so the TS stat + header sniff below runs only on the fallback path
      // instead of duplicating that I/O on every call. Any native error is
      // a final verdict — re-running the TS reader would only mask native
      // bugs. (Release builds bundle the native module in the SEA binary
      // and npm installs pin it as a versioned optional dependency, so a
      // loaded-but-mismatched prebuild is not a real distribution state.)
      // The TS implementation below is a fallback for hosts where the
      // native module is not loaded at all.
      const nativeResult = await tryNativeRead(safePath, {
        lineOffset: lineOffset,
        nLines: effectiveLimit,
      });
      if (nativeResult && !nativeResult.error) {
        // Split the native output: content before <system> is output,
        // the <system>...</system> block is the note. The block may be
        // preceded by a newline (normal reads) or start the content
        // directly (empty output, e.g. offset past EOF).
        const systemIdx = nativeResult.content.lastIndexOf('\n<system>');
        if (systemIdx >= 0) {
          const output = nativeResult.content.slice(0, systemIdx);
          const note = nativeResult.content.slice(systemIdx + 1); // includes <system>...</system>
          return { output, note };
        }
        if (nativeResult.content.startsWith('<system>')) {
          return { output: '', note: nativeResult.content };
        }
        // If no <system> tag (e.g. empty file), use content as-is
        return { output: nativeResult.content };
      }
      if (nativeResult && nativeResult.error) {
        return { isError: true, output: nativeResult.error };
      }
      // Native not loaded — run the TS implementation below.

      try {
        stat = await this.fs.stat(safePath);
      } catch (error) {
        if (isFileNotFoundError(error)) {
          return { isError: true, output: `"${args.path}" does not exist.` };
        }
        throw error;
      }
      if (stat === undefined || !stat.isFile) {
        return { isError: true, output: `"${args.path}" is not a file.` };
      }

      const header = await this.fs.readBytes(safePath, MEDIA_SNIFF_BYTES);
      const fileType = detectFileType(safePath, header);
      if (fileType.kind === 'image' || fileType.kind === 'video') {
        return {
          isError: true,
          output: `"${args.path}" is a ${fileType.kind} file. Use ReadMediaFile to read image or video files.`,
        };
      }

      // A BOM marks UTF-16 even when the header carries no NUL bytes (e.g.
      // CJK-only content reads as printable ASCII), so detect the encoding
      // before falling through to the strict UTF-8 text path.
      const detection = detectTextEncoding(header);
      let lines: AsyncIterable<string>;
      let detectedEncoding: UtfTextEncoding | undefined;
      if (!detection.seemsBinary && detection.encoding !== 'utf-8') {
        // UTF-16 LE/BE text (BOM or zero-byte parity heuristic): decode the
        // whole file and transcode to UTF-8 for display.
        if (stat.size > TRANSCODE_MAX_BYTES) {
          return {
            isError: true,
            output:
              `"${args.path}" is ${encodingDisplayName(detection.encoding)} text but too large to transcode ` +
              `(${String(stat.size)} bytes > ${String(TRANSCODE_MAX_BYTES)}). ` +
              'Convert it to UTF-8 first (e.g. `iconv` via Bash).',
          };
        }
        const decoded = decodeUtfText(await this.fs.readBytes(safePath), detection.encoding);
        detectedEncoding = detection.encoding;
        lines = decodedLines(splitLinesKeepingTerminator(decoded));
      } else if (fileType.kind === 'unknown') {
        return {
          isError: true,
          output: notReadableFileOutput(args.path),
        };
      } else {
        lines = this.fs.readLines(safePath, { errors: 'strict' });
      }

      if (lineOffset < 0) {
        return await this.readTail(
          args.path,
          lines,
          lineOffset,
          effectiveLimit,
          requestedLines,
          detectedEncoding,
        );
      }
      return await this.readForward(
        args.path,
        lines,
        lineOffset,
        effectiveLimit,
        requestedLines,
        detectedEncoding,
      );
    } catch (error) {
      if (isTextDecodeError(error) && stat !== undefined) {
        const fallback = await this.readWithFallbackEncoding(args, safePath, stat.size);
        if (fallback !== undefined) return fallback;
        return { isError: true, output: notUtf8DecodableFileOutput(args.path) };
      }
      return {
        isError: true,
        output: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Fallback path when strict UTF-8 streaming decoding fails mid-file. Tries
   * GBK/GB18030 (whole-file transcode, the common case for legacy Chinese
   * text), then a lenient UTF-8 decode gated on the replacement ratio, and
   * returns `undefined` when neither applies so the caller can refuse.
   */
  private async readWithFallbackEncoding(
    args: ReadInput,
    safePath: string,
    fileSize: number,
  ): Promise<ExecutableToolResult | undefined> {
    if (fileSize > TRANSCODE_MAX_BYTES) return undefined;

    const bytes = await this.fs.readBytes(safePath);
    const legacy = detectLegacyTextEncoding(bytes);
    if (legacy !== null) {
      return this.readDecodedText(
        args,
        new TextDecoder('gbk', { fatal: false }).decode(bytes),
        legacy,
      );
    }

    const lenient = decodeUtf8Lenient(bytes);
    if (bytes.length > 0 && lenient.replacedCount / bytes.length <= MAX_LENIENT_REPLACEMENT_RATIO) {
      return this.readDecodedText(args, lenient.text, 'utf-8-lenient');
    }
    return undefined;
  }

  private async readDecodedText(
    args: ReadInput,
    text: string,
    encoding: 'gbk' | 'utf-8-lenient',
  ): Promise<ExecutableToolResult> {
    const lineOffset = args.line_offset ?? 1;
    const requestedLines = args.n_lines ?? MAX_LINES;
    const effectiveLimit = Math.min(requestedLines, MAX_LINES);
    const lines = decodedLines(splitLinesKeepingTerminator(text));
    if (lineOffset < 0) {
      return this.readTail(args.path, lines, lineOffset, effectiveLimit, requestedLines, encoding);
    }
    return this.readForward(args.path, lines, lineOffset, effectiveLimit, requestedLines, encoding);
  }

  private async readForward(
    displayPath: string,
    lines: AsyncIterable<string>,
    lineOffset: number,
    effectiveLimit: number,
    requestedLines: number,
    detectedEncoding?: ReadDisplayEncoding,
  ): Promise<ExecutableToolResult> {
    const selectedEntries: ReadLineEntry[] = [];
    const flags: LineEndingFlags = { hasCrLf: false, hasLf: false, hasLoneCr: false };
    let currentLineNo = 0;
    let maxLinesReached = false;
    let collectionClosed = false;

    for await (const rawLine of lines) {
      if (containsNulByte(rawLine)) {
        return { isError: true, output: notReadableFileOutput(displayPath) };
      }
      currentLineNo += 1;
      updateLineEndingFlags(flags, rawLine);
      if (collectionClosed) {
        if (effectiveLimit >= MAX_LINES && currentLineNo >= lineOffset) {
          maxLinesReached = true;
        }
        continue;
      }
      if (currentLineNo < lineOffset) continue;
      if (selectedEntries.length >= effectiveLimit) {
        if (effectiveLimit >= MAX_LINES) {
          maxLinesReached = true;
        }
        collectionClosed = true;
        continue;
      }
      selectedEntries.push({
        lineNo: currentLineNo,
        rawContent: stripTrailingLf(rawLine),
      });
      if (selectedEntries.length >= effectiveLimit) {
        collectionClosed = true;
      }
    }

    const lineEndingStyle = lineEndingStyleFromFlags(flags);
    const rendered = renderEntries(selectedEntries, lineEndingStyle);

    return this.finishReadResult({
      renderedLines: rendered.renderedLines,
      truncatedLineNumbers: rendered.truncatedLineNumbers,
      maxLinesReached,
      maxBytesReached: rendered.maxBytesReached,
      lineEndingStyle,
      startLine: selectedEntries.length > 0 ? lineOffset : 0,
      totalLines: currentLineNo,
      requestedLines,
      detectedEncoding,
    });
  }

  private async readTail(
    displayPath: string,
    lines: AsyncIterable<string>,
    lineOffset: number,
    effectiveLimit: number,
    requestedLines: number,
    detectedEncoding?: ReadDisplayEncoding,
  ): Promise<ExecutableToolResult> {
    const tailCount = Math.abs(lineOffset);
    const entries: ReadLineEntry[] = [];
    const flags: LineEndingFlags = { hasCrLf: false, hasLf: false, hasLoneCr: false };
    let currentLineNo = 0;

    for await (const rawLine of lines) {
      if (containsNulByte(rawLine)) {
        return { isError: true, output: notReadableFileOutput(displayPath) };
      }
      currentLineNo += 1;
      updateLineEndingFlags(flags, rawLine);
      entries.push({
        lineNo: currentLineNo,
        rawContent: stripTrailingLf(rawLine),
      });
      if (entries.length > tailCount) {
        entries.shift();
      }
    }

    return this.finishTailEntries({
      entries,
      lineEndingFlags: flags,
      effectiveLimit,
      totalLines: currentLineNo,
      requestedLines,
      detectedEncoding,
    });
  }

  private finishTailEntries(input: {
    entries: readonly ReadLineEntry[];
    lineEndingFlags: LineEndingFlags;
    effectiveLimit: number;
    totalLines: number;
    requestedLines: number;
    detectedEncoding?: ReadDisplayEncoding;
  }): ExecutableToolResult {
    const lineEndingStyle = lineEndingStyleFromFlags(input.lineEndingFlags);
    let renderedCandidates = input.entries.slice(0, input.effectiveLimit).map((entry) => {
      return { entry, rendered: renderLine(entry, lineEndingStyle) };
    });

    let totalBytes = 0;
    for (const [index, candidate] of renderedCandidates.entries()) {
      totalBytes += renderedLineBytes(candidate.rendered.line, index === 0);
    }

    let maxBytesReached = false;
    if (totalBytes > MAX_BYTES) {
      maxBytesReached = true;
      const kept: typeof renderedCandidates = [];
      let bytes = 0;
      for (let i = renderedCandidates.length - 1; i >= 0; i -= 1) {
        const candidate = renderedCandidates[i];
        if (candidate === undefined) continue;
        const lineBytes = renderedLineBytes(candidate.rendered.line, kept.length === 0);
        if (bytes + lineBytes > MAX_BYTES) break;
        kept.unshift(candidate);
        bytes += lineBytes;
      }
      renderedCandidates = kept;
    }

    const renderedLines: string[] = [];
    const truncatedLineNumbers: number[] = [];
    for (const candidate of renderedCandidates) {
      renderedLines.push(candidate.rendered.line);
      if (candidate.rendered.wasTruncated) {
        truncatedLineNumbers.push(candidate.entry.lineNo);
      }
    }

    return this.finishReadResult({
      renderedLines,
      truncatedLineNumbers,
      maxLinesReached: false,
      maxBytesReached,
      lineEndingStyle,
      startLine: renderedCandidates[0]?.entry.lineNo ?? 0,
      totalLines: input.totalLines,
      requestedLines: input.requestedLines,
      detectedEncoding: input.detectedEncoding,
    });
  }

  private finishReadResult(input: FinishReadResultInput): ExecutableToolResult {
    return {
      output: input.renderedLines.join('\n'),
      note: `<system>${this.finishMessage(input)}</system>`,
    };
  }

  private finishMessage(input: FinishReadResultInput): string {
    const lineCount = input.renderedLines.length;
    const lineWord = lineCount === 1 ? 'line' : 'lines';
    const parts =
      lineCount > 0
        ? [
            `${String(lineCount)} ${lineWord} read from file starting from line ${String(input.startLine)}.`,
          ]
        : ['No lines read from file.'];

    parts.push(`Total lines in file: ${String(input.totalLines)}.`);
    if (input.maxLinesReached) {
      parts.push(`Max ${String(MAX_LINES)} lines reached.`);
    } else if (input.maxBytesReached) {
      parts.push(`Max ${String(MAX_BYTES)} bytes reached.`);
    } else if (lineCount < input.requestedLines) {
      parts.push('End of file reached.');
    }
    if (input.truncatedLineNumbers.length > 0) {
      parts.push(`Lines [${input.truncatedLineNumbers.join(', ')}] were truncated.`);
    }
    if (input.lineEndingStyle === 'mixed') {
      parts.push(
        'Mixed or lone carriage-return line endings are shown as \\r. Use exact \\r\\n or \\r escapes in Edit.old_string for those lines.',
      );
    }
    if (input.detectedEncoding === 'gbk') {
      parts.push(
        "Detected GBK/GB18030 encoding; content transcoded to UTF-8 for display. Edit and Write expect UTF-8 — convert the file's encoding first (e.g. `iconv` via Bash).",
      );
    } else if (input.detectedEncoding === 'utf-8-lenient') {
      parts.push(
        'Some bytes were not valid UTF-8 and were replaced with U+FFFD; content shown best-effort.',
      );
    } else if (input.detectedEncoding !== undefined) {
      parts.push(
        `Detected file encoding: ${encodingDisplayName(input.detectedEncoding)}; content transcoded to UTF-8 for display. Edit and Write expect UTF-8 — convert the file's encoding first (e.g. \`iconv\` via Bash).`,
      );
    }
    return parts.join(' ');
  }
}

registerAgentToolService(IReadTool, ReadTool, { name: 'Read', domain: 'os/backends' });
