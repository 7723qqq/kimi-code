import { describe, expect, it } from 'bun:test';

import {
  applyCacheBreakpoints,
  CACHE_CONTROL,
  type CacheBreakpointBlock,
  type CacheBreakpointContent,
} from '#/cache-breakpoints';

interface TextBlock extends CacheBreakpointBlock {
  text: string;
}

function text(label: string): TextBlock {
  return { type: 'text', text: label };
}

function conversation(count: number): CacheBreakpointContent[] {
  return Array.from({ length: count }, (_, i) => [text(`m${i}`)]);
}

function markedIndexes(contents: readonly CacheBreakpointContent[]): number[] {
  const out: number[] = [];
  contents.forEach((content, index) => {
    if (content?.some((block) => block.cache_control !== undefined) === true) out.push(index);
  });
  return out;
}

describe('applyCacheBreakpoints', () => {
  it('marks nothing for an empty conversation', () => {
    const contents: CacheBreakpointContent[] = [];
    applyCacheBreakpoints(contents);
    expect(markedIndexes(contents)).toEqual([]);
  });

  it.each([
    [1, [0]],
    [2, [1]],
    [3, [2]],
    [4, [1, 3]],
    [5, [2, 4]],
    [6, [3, 5]],
    [10, [7, 9]],
  ])('marks the tail plus the stable history at length %i', (count, expected) => {
    const contents = conversation(count);
    applyCacheBreakpoints(contents);
    expect(markedIndexes(contents)).toEqual(expected);
  });

  it('keeps the stable breakpoint exactly where the previous tail landed at a two-message gap', () => {
    const first = conversation(5);
    applyCacheBreakpoints(first);
    const previousTail = markedIndexes(first).at(-1)!;

    const next = conversation(7);
    applyCacheBreakpoints(next);
    expect(markedIndexes(next)[0]).toBe(previousTail);
  });

  it('leaves one message of margin when the gap shrinks to one', () => {
    const first = conversation(5);
    applyCacheBreakpoints(first);
    const previousTail = markedIndexes(first).at(-1)!;

    const next = conversation(6);
    applyCacheBreakpoints(next);
    expect(markedIndexes(next)[0]).toBe(previousTail - 1);
  });

  it('skips a message whose content is not a block array', () => {
    const contents: CacheBreakpointContent[] = [undefined, undefined, undefined, [text('d')]];
    applyCacheBreakpoints(contents);
    expect(markedIndexes(contents)).toEqual([3]);
  });

  it('skips a non-cacheable tail instead of marking the message before it', () => {
    const contents: CacheBreakpointContent[] = [
      [text('a')],
      [{ type: 'notCacheable' } as CacheBreakpointBlock],
    ];
    applyCacheBreakpoints(contents);
    expect(markedIndexes(contents)).toEqual([]);
  });

  it('keeps an existing stable mark and rewrites the tail', () => {
    const contents: CacheBreakpointContent[] = [
      [text('a')],
      [{ ...text('b'), cache_control: CACHE_CONTROL }],
      [text('c')],
      [text('d')],
    ];
    applyCacheBreakpoints(contents);
    expect(contents[1]?.[0]?.cache_control).toEqual(CACHE_CONTROL);
    expect(contents[3]?.[0]?.cache_control).toEqual(CACHE_CONTROL);
    expect(contents[2]?.[0]?.cache_control).toBeUndefined();
  });

  it('honours a custom history gap', () => {
    const contents = conversation(6);
    applyCacheBreakpoints(contents, 3);
    expect(markedIndexes(contents)).toEqual([2, 5]);
  });
});
