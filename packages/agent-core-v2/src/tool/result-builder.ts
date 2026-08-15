/**
 * `tool` domain — buffered tool-result builder.
 *
 * Shared helper for tools that stream text into a bounded output buffer with
 * optional per-line and total-char truncation. Pure helper; no scoped
 * service.
 */

import { tryNativeWriteToolOutputChunk } from '#/_base/native-tools';
import { BugIndicatingError } from '#/errors';
import type { SpillRef } from '#/features/spill/spill';

import type { ExecutableToolErrorResult, ExecutableToolSuccessResult } from './toolContract';

const DEFAULT_MAX_CHARS = 50_000;
const DEFAULT_MAX_LINE_LENGTH = 2000;
const TRUNCATION_MARKER = '[...truncated]';
const TRUNCATION_MESSAGE = 'Output is truncated to fit in the message.';

/** Hard ceiling on the spill source buffer, so a hostile tool output cannot grow it without bound. */
const MAX_SPILL_SOURCE_CHARS = 50 * 1024 * 1024;

export interface ToolResultBuilderOptions {
  readonly maxChars?: number;
  readonly maxLineLength?: number | null;
  /**
   * Called once when the output is truncated, with the FULL untruncated text.
   * The returned {@link SpillRef} is attached to the built result as
   * `spilled`, giving the model a way to read the complete output. Absent
   * when no caller wants spill storage.
   */
  readonly onTruncated?: (fullText: string) => SpillRef | Promise<SpillRef>;
}

export type ExecutableToolResultBuilderResult = (
  | ExecutableToolErrorResult
  | ExecutableToolSuccessResult
) & {
  readonly output: string;
  readonly truncated: boolean;
  readonly brief?: string;
  /** Full-output spill reference, set when truncation happened and an `onTruncated` hook is wired. */
  readonly spilled?: SpillRef;
};

export class ToolResultBuilder {
  private readonly maxChars: number;
  private readonly maxLineLength: number | null;
  private readonly onTruncated?: (fullText: string) => SpillRef | Promise<SpillRef>;

  private readonly buffer: string[] = [];
  private nCharsValue = 0;
  private truncationHappened = false;
  private spillSource: string[] | undefined;
  private spilledRef: SpillRef | undefined;

  constructor(options: ToolResultBuilderOptions = {}) {
    this.maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
    this.maxLineLength =
      options.maxLineLength === undefined ? DEFAULT_MAX_LINE_LENGTH : options.maxLineLength;
    this.onTruncated = options.onTruncated;

    if (this.maxLineLength !== null && this.maxLineLength <= TRUNCATION_MARKER.length) {
      throw new BugIndicatingError(
        'maxLineLength must be greater than the truncation marker length.',
      );
    }
  }

  get nChars(): number {
    return this.nCharsValue;
  }

  get truncated(): boolean {
    return this.truncationHappened;
  }

  write(text: string): number {
    if (this.onTruncated !== undefined) this.recordSpillSource(text);
    // Native fast-path: the Rust write_chunk is a line-for-line port of
    // this method (UTF-16 counting, per-line truncation, marker emission).
    // Spill recording above and the ok()/error() tails below stay in TS.
    const native = tryNativeWriteToolOutputChunk(
      text,
      this.nCharsValue,
      this.maxChars,
      this.maxLineLength,
      this.truncationHappened,
    );
    if (native !== undefined) {
      if (native.output.length > 0) this.buffer.push(native.output);
      this.nCharsValue = native.newNchars;
      this.truncationHappened = native.truncated;
      return native.charsWritten;
    }
    if (this.nCharsValue >= this.maxChars) {
      if (text.length > 0 && !this.truncationHappened) {
        this.buffer.push(TRUNCATION_MARKER);
        this.nCharsValue += TRUNCATION_MARKER.length;
        this.truncationHappened = true;
      }
      return 0;
    }

    const lines = text.match(/[^\r\n]*(?:\r\n|[\n\r])|[^\r\n]+/g) ?? [];
    if (lines.length === 0) return 0;

    let charsWritten = 0;
    for (const originalLine of lines) {
      if (this.nCharsValue >= this.maxChars) {
        if (!this.truncationHappened) {
          this.buffer.push(TRUNCATION_MARKER);
          this.nCharsValue += TRUNCATION_MARKER.length;
          this.truncationHappened = true;
        }
        break;
      }

      const remainingChars = this.maxChars - this.nCharsValue;
      const limit =
        this.maxLineLength === null ? remainingChars : Math.min(remainingChars, this.maxLineLength);
      let line = originalLine;
      if (line.length > limit) {
        const lineBreak = /[\r\n]+$/.exec(line)?.[0] ?? '';
        const suffix = TRUNCATION_MARKER + lineBreak;
        const effectiveMaxLength = Math.max(limit, suffix.length);
        line = line.slice(0, effectiveMaxLength - suffix.length) + suffix;
      }
      if (line !== originalLine) {
        this.truncationHappened = true;
      }

      this.buffer.push(line);
      charsWritten += line.length;
      this.nCharsValue += line.length;
    }

    return charsWritten;
  }

  ok(message = '', options: { readonly brief?: string } = {}): ExecutableToolResultBuilderResult {
    let finalMessage = message;
    if (finalMessage.length > 0 && !finalMessage.endsWith('.')) {
      finalMessage += '.';
    }
    if (this.truncationHappened) {
      finalMessage =
        finalMessage.length === 0 ? TRUNCATION_MESSAGE : `${finalMessage} ${TRUNCATION_MESSAGE}`;
    }

    const output = this.buffer.join('');
    const shouldAppendMessage =
      finalMessage.length > 0 && (this.truncationHappened || output.length === 0);
    return {
      isError: false,
      output: shouldAppendMessage
        ? output.length === 0
          ? finalMessage
          : output.endsWith('\n')
            ? `${output}${finalMessage}`
            : `${output}\n${finalMessage}`
        : output,
      truncated: this.truncationHappened,
      brief: options.brief,
      spilled: this.spilledRef,
    };
  }

  error(
    message: string,
    options: { readonly brief?: string } = {},
  ): ExecutableToolResultBuilderResult {
    const finalMessage = this.truncationHappened
      ? message.length === 0
        ? TRUNCATION_MESSAGE
        : `${message} ${TRUNCATION_MESSAGE}`
      : message;
    const output = this.buffer.join('');
    return {
      isError: true,
      output:
        finalMessage.length === 0
          ? output
          : output.length === 0
            ? finalMessage
            : output.endsWith('\n')
              ? `${output}${finalMessage}`
              : `${output}\n${finalMessage}`,
      truncated: this.truncationHappened,
      brief: options.brief,
      spilled: this.spilledRef,
    };
  }

  /**
   * Persist the full untruncated output through the wired `onTruncated` hook
   * when truncation happened, attaching the spill reference to results built
   * afterwards. Callers await this before `ok()`/`error()` when they want the
   * result to carry the spill. A hook failure is best-effort: the inline
   * truncated result stands and no spill is attached.
   */
  async spillFullText(): Promise<SpillRef | undefined> {
    if (this.spilledRef !== undefined) return this.spilledRef;
    if (!this.truncationHappened || this.onTruncated === undefined) return undefined;
    try {
      this.spilledRef = await this.onTruncated(this.spillSourceText());
    } catch {
      this.spilledRef = undefined;
    }
    return this.spilledRef;
  }

  private recordSpillSource(text: string): void {
    if (this.spillSource === undefined) this.spillSource = [];
    const chars = this.spillSourceChars();
    if (chars >= MAX_SPILL_SOURCE_CHARS) return;
    this.spillSource.push(text.slice(0, MAX_SPILL_SOURCE_CHARS - chars));
  }

  private spillSourceChars(): number {
    return this.spillSource?.reduce((sum, part) => sum + part.length, 0) ?? 0;
  }

  private spillSourceText(): string {
    return this.spillSource?.join('') ?? this.buffer.join('');
  }
}
