import { describe, expect, it } from 'vitest';

import { Error2, ErrorCodes } from '#/errors';
import { LspTool, renderResult } from '#/features/lsp/tools/lsp/lspTool';
import { LspInputSchema } from '#/features/lsp/tools/lsp/lsp';
import type { ILspService } from '#/features/lsp/lsp';
import type { ISessionContext } from '#/session/sessionContext/sessionContext';
import { executeTool } from '../../../../tools/fixtures/execute-tool';

function stubLsp(result: Parameters<ILspService['query']>[0] extends never ? never : unknown): ILspService {
  return {
    _serviceBrand: undefined,
    registerProvider: () => ({ dispose: () => undefined }),
    query: async () => result,
  } as unknown as ILspService;
}

function stubSession(cwd: string): ISessionContext {
  return {
    _serviceBrand: undefined,
    sessionId: 's1',
    workspaceId: 'w1',
    sessionDir: '/sessions/s1',
    metaScope: 'sessions/s1',
    cwd,
    scope: () => 'sessions/s1',
  };
}

const BASE_CONTEXT = {
  turnId: 1,
  toolCallId: 'call_1',
  signal: new AbortController().signal,
};

describe('LspInputSchema', () => {
  it('accepts a valid input', () => {
    const parsed = LspInputSchema.safeParse({
      operation: 'goToDefinition',
      file_path: '/ws/a.ts',
      line: 3,
      character: 5,
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects unknown keys and invalid positions', () => {
    expect(
      LspInputSchema.safeParse({ operation: 'goToDefinition', file_path: '/a.ts', line: 0, character: 1 }).success,
    ).toBe(false);
    expect(
      LspInputSchema.safeParse({
        operation: 'goToDefinition',
        file_path: '/a.ts',
        line: 1,
        character: 1,
        extra: true,
      }).success,
    ).toBe(false);
    expect(
      LspInputSchema.safeParse({ operation: 'bogus', file_path: '/a.ts', line: 1, character: 1 }).success,
    ).toBe(false);
  });
});

describe('LspTool', () => {
  it('queries the service with a zero-based position and renders locations', async () => {
    let seen: Parameters<ILspService['query']>[0] | undefined;
    const lsp: ILspService = {
      _serviceBrand: undefined,
      registerProvider: () => ({ dispose: () => undefined }),
      query: async (request) => {
        seen = request;
        return {
          kind: 'locations',
          locations: [
            { uri: 'file:///ws/def.ts', range: { start: { line: 2, character: 4 }, end: { line: 2, character: 9 } } },
          ],
        };
      },
    };
    const tool = new LspTool(lsp, stubSession('/ws'));
    const result = await executeTool(tool, {
      ...BASE_CONTEXT,
      args: { operation: 'goToDefinition', file_path: '/ws/a.ts', line: 3, character: 5 },
    });
    expect(seen).toEqual({
      operation: 'goToDefinition',
      filePath: '/ws/a.ts',
      position: { line: 2, character: 4 },
      workspaceRoot: '/ws',
    });
    expect(result.isError).toBe(false);
    expect((result as { output: string }).output).toContain('def.ts:3:5');
  });

  it('renders hover text', async () => {
    const tool = new LspTool(
      stubLsp({ kind: 'hover', hover: { contents: { kind: 'markdown', value: '**type**: string' } } }),
      stubSession('/ws'),
    );
    const result = await executeTool(tool, {
      ...BASE_CONTEXT,
      args: { operation: 'hover', file_path: '/ws/a.ts', line: 1, character: 1 },
    });
    expect(result).toEqual({ isError: false, output: '**type**: string' });
  });

  it('renders an empty hover', async () => {
    const tool = new LspTool(stubLsp({ kind: 'hover', hover: null }), stubSession('/ws'));
    const result = await executeTool(tool, {
      ...BASE_CONTEXT,
      args: { operation: 'hover', file_path: '/ws/a.ts', line: 1, character: 1 },
    });
    expect(result).toEqual({ isError: false, output: 'No hover information available at this position.' });
  });

  it('renders an empty location list', async () => {
    const tool = new LspTool(stubLsp({ kind: 'locations', locations: [] }), stubSession('/ws'));
    const result = await executeTool(tool, {
      ...BASE_CONTEXT,
      args: { operation: 'findReferences', file_path: '/ws/a.ts', line: 1, character: 1 },
    });
    expect(result).toEqual({ isError: false, output: 'No locations found.' });
  });

  it('fails loud when the session has no workspace root', async () => {
    const tool = new LspTool(stubLsp({ kind: 'hover', hover: null }), stubSession(''));
    const result = await executeTool(tool, {
      ...BASE_CONTEXT,
      args: { operation: 'hover', file_path: '/ws/a.ts', line: 1, character: 1 },
    });
    expect(result.isError).toBe(true);
    expect((result as { output: string }).output).toContain('workspace');
  });

  it('reports LSP_UNAVAILABLE from the service as an error result', async () => {
    const lsp: ILspService = {
      _serviceBrand: undefined,
      registerProvider: () => ({ dispose: () => undefined }),
      query: async () => {
        throw new Error2(ErrorCodes.LSP_UNAVAILABLE, 'no LSP provider is configured for extension "ts"');
      },
    };
    const tool = new LspTool(lsp, stubSession('/ws'));
    const result = await executeTool(tool, {
      ...BASE_CONTEXT,
      args: { operation: 'hover', file_path: '/ws/a.ts', line: 1, character: 1 },
    });
    expect(result.isError).toBe(true);
    expect((result as { output: string }).output).toContain('no LSP provider');
  });
});

describe('renderResult', () => {
  it('groups locations by file and caps the count', () => {
    const locations = Array.from({ length: 150 }, (_, index) => ({
      uri: `file:///ws/f${index % 2}.ts`,
      range: { start: { line: index, character: 0 }, end: { line: index, character: 1 } },
    }));
    const output = renderResult({ kind: 'locations', locations });
    expect(output).toContain('… 50 more locations omitted');
    expect(output).toContain('/ws/f0.ts:');
    expect(output).toContain('/ws/f1.ts:');
  });

  it('truncates very long hover output', () => {
    const output = renderResult({
      kind: 'hover',
      hover: { contents: { kind: 'plaintext', value: 'x'.repeat(20000) } },
    });
    expect(output).toContain('output truncated');
    expect(output.length).toBeLessThan(17000);
  });
});
