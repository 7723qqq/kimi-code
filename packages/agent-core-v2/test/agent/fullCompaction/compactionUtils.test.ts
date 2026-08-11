import { describe, expect, it } from 'vitest';

import type { ContextMessage } from '#/agent/contextMemory/types';
import {
  SNIPPED_TOOL_RESULT_MARKER,
  snipLargeToolResults,
} from '#/agent/fullCompaction/compactionUtils';
import { createToolMessage } from '#/kosong/contract/message';

function toolMessage(text: string): ContextMessage {
  return createToolMessage('call_1', text);
}

function bigOutput(lines: number, line = 'line of output content'): string {
  return Array.from({ length: lines }, (_, i) => `${line} ${i}`).join('\n');
}

describe('snipLargeToolResults', () => {
  it('leaves small tool results untouched', () => {
    const small = toolMessage('short output');
    const messages = [small];
    const result = snipLargeToolResults(messages);
    expect(result).toEqual(messages); // deep-equal copy when nothing changed
  });

  it('leaves non-tool messages untouched', () => {
    const user = { role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] };
    const result = snipLargeToolResults([user]);
    expect(result).toEqual([user]);
  });

  it('keeps head and tail of a large tool result and marks it', () => {
    const big = toolMessage(bigOutput(200));
    const [result] = snipLargeToolResults([big], { minBytes: 10, headLines: 5, tailLines: 3 });
    const text = result!.content[0] as { type: 'text'; text: string };
    expect(text.text.startsWith(SNIPPED_TOOL_RESULT_MARKER)).toBe(true);
    expect(text.text).toContain('line of output content 0'); // head kept
    expect(text.text).toContain('line of output content 199'); // tail kept
    expect(text.text).toContain('192 lines omitted'); // 200 - 5 - 3
  });

  it('is idempotent (already-snipped results are not re-snipped)', () => {
    const big = toolMessage(bigOutput(200));
    const [once] = snipLargeToolResults([big], { minBytes: 10, headLines: 5, tailLines: 3 });
    const twice = snipLargeToolResults([once!]);
    expect(twice[0]).toBe(once); // untouched — marker guard held
  });

  it('does not touch results that are long but few-line (single huge line)', () => {
    const singleLine = toolMessage('x'.repeat(10_000));
    const result = snipLargeToolResults([singleLine], { minBytes: 100, headLines: 40, tailLines: 40 });
    expect(result).toEqual([singleLine]);
    expect((result[0]!.content[0] as { text: string }).text.length).toBe(10_000);
  });

  it('only rewrites the returned copy, never the input messages', () => {
    const big = toolMessage(bigOutput(200));
    const input = [big];
    snipLargeToolResults(input, { minBytes: 10, headLines: 5, tailLines: 3 });
    expect((input[0]!.content[0] as { text: string }).text).toBe(
      (big.content[0] as { text: string }).text,
    );
  });
});
