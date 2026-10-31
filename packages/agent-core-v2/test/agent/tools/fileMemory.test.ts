import { describe, expect, it } from 'bun:test';

import { withFileMemory } from '#/agent/tools/fileMemory';
import type { IGitMemoryService } from '#/features/gitMemory/gitMemoryService';

function service(block: string): IGitMemoryService {
  return { fileBlock: async () => block } as unknown as IGitMemoryService;
}

describe('withFileMemory', () => {
  it('appends the block at the end of a string output', async () => {
    const result = { isError: false as const, output: 'file contents' };
    const out = await withFileMemory(result, 'a.ts', service('<file-memory>x</file-memory>'));
    expect(out.output).toBe('file contents\n<file-memory>x</file-memory>');
  });

  it('appends the block to a structured output', async () => {
    const result = { isError: false as const, output: [{ type: 'text' as const, text: 'body' }] };
    const out = await withFileMemory(result, 'a.ts', service('<file-memory>x</file-memory>'));
    expect(Array.isArray(out.output)).toBe(true);
    if (Array.isArray(out.output)) {
      expect(out.output).toHaveLength(2);
      expect(out.output[1]).toEqual({ type: 'text', text: '\n<file-memory>x</file-memory>' });
    }
  });

  it('leaves the output untouched when the block is empty', async () => {
    const result = { isError: false as const, output: 'file contents' };
    const out = await withFileMemory(result, 'a.ts', service(''));
    expect(out.output).toBe('file contents');
  });

  it('does not touch an error result', async () => {
    const result = { isError: true as const, output: 'boom' };
    const out = await withFileMemory(result, 'a.ts', service('<file-memory>x</file-memory>'));
    expect(out.output).toBe('boom');
  });

  it('never lets a failing memory service break the tool result', async () => {
    const failing = {
      fileBlock: async () => {
        throw new Error('boom');
      },
    } as unknown as IGitMemoryService;
    const result = { isError: false as const, output: 'file contents' };
    const out = await withFileMemory(result, 'a.ts', failing);
    expect(out.output).toBe('file contents');
  });
});
