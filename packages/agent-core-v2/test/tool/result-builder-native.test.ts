import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ToolResultBuilder } from '#/tool/result-builder';

const mocks = vi.hoisted(() => ({
  tryNativeWriteToolOutputChunk: vi.fn(),
}));

vi.mock('#/_base/native-tools', () => mocks);

describe('ToolResultBuilder native fast path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.tryNativeWriteToolOutputChunk.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('routes write through the native engine and adopts its counters', () => {
    mocks.tryNativeWriteToolOutputChunk.mockReturnValue({
      output: 'processed chunk',
      charsWritten: 15,
      newNchars: 25,
      truncated: false,
    });
    const builder = new ToolResultBuilder({ maxChars: 100 });

    const result = builder.write('raw chunk');

    expect(result).toBe(15);
    expect(builder.nChars).toBe(25);
    expect(builder.truncated).toBe(false);
    expect(mocks.tryNativeWriteToolOutputChunk).toHaveBeenCalledWith(
      'raw chunk',
      0,
      100,
      2000,
      false,
    );
    expect(builder.ok('done').output).toBe('processed chunk');
  });

  it('passes the current counters and truncation state to the native engine', () => {
    mocks.tryNativeWriteToolOutputChunk.mockImplementation(
      (text: string, currentNchars: number, _max: number, _mll: number | null, alreadyTruncated: boolean) => {
        const chars = text.length;
        return {
          output: text,
          charsWritten: chars,
          newNchars: currentNchars + chars,
          truncated: alreadyTruncated,
        };
      },
    );
    const builder = new ToolResultBuilder({ maxChars: 50 });
    builder.write('first'); // nChars → 5
    builder.write('second');

    const call = mocks.tryNativeWriteToolOutputChunk.mock.calls[1]!;
    expect(call[1]).toBe(5); // currentNchars from previous call
    expect(call[4]).toBe(false); // alreadyTruncated
  });

  it('adopts the native truncated flag cumulatively', () => {
    mocks.tryNativeWriteToolOutputChunk
      .mockReturnValueOnce({ output: 'a', charsWritten: 1, newNchars: 1, truncated: false })
      .mockReturnValueOnce({
        output: '[...truncated]',
        charsWritten: 0,
        newNchars: 16,
        truncated: true,
      });
    const builder = new ToolResultBuilder({ maxChars: 10 });

    builder.write('a');
    expect(builder.truncated).toBe(false);
    builder.write('long content');
    expect(builder.truncated).toBe(true);
    const result = builder.ok('done');
    expect(result.truncated).toBe(true);
    expect(result.output).toContain('Output is truncated to fit in the message.');
  });

  it('falls back to the TS algorithm when the native module is unavailable', () => {
    mocks.tryNativeWriteToolOutputChunk.mockReturnValue(undefined);
    const builder = new ToolResultBuilder({ maxChars: 10, maxLineLength: 20 });

    const written = builder.write('hello world');
    const result = builder.ok('done');

    // TS path truncates the oversized line and appends the marker.
    expect(result.truncated).toBe(true);
    expect(result.output).toContain('[...truncated]');
    expect(written).toBeGreaterThan(0);
  });
});
