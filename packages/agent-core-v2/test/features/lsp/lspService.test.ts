import { describe, expect, it } from 'vitest';

import { Error2, ErrorCodes } from '#/errors';
import { finalExtension, LspService } from '#/features/lsp/lspService';
import type { LspProvider, LspQueryResult } from '#/features/lsp/lsp';

function stubProvider(
  id: string,
  extensionToLanguage: Record<string, string>,
  result: LspQueryResult = { kind: 'locations', locations: [] },
): LspProvider {
  return {
    id,
    extensionToLanguage,
    query: async () => result,
  };
}

describe('finalExtension', () => {
  it('returns the extension without the dot, lowercased', () => {
    expect(finalExtension('src/foo.TS')).toBe('ts');
    expect(finalExtension('src/foo.ts')).toBe('ts');
    expect(finalExtension('src/foo.d.ts')).toBe('ts');
  });

  it('returns an empty string for files without an extension', () => {
    expect(finalExtension('src/Makefile')).toBe('');
    expect(finalExtension('src/foo')).toBe('');
  });
});

describe('LspService', () => {
  it('routes a query to the provider covering the file extension', async () => {
    const service = new LspService();
    const calls: string[] = [];
    service.registerProvider(
      stubProvider('typescript', { ts: 'typescript', tsx: 'typescript' }, {
        kind: 'locations',
        locations: [{ uri: 'file:///a.ts', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }],
      }),
    );
    service.registerProvider(
      stubProvider('python', { py: 'python' }, { kind: 'hover', hover: null }),
    );

    const result = await service.query({
      operation: 'goToDefinition',
      filePath: '/ws/src/a.ts',
      position: { line: 1, character: 2 },
      workspaceRoot: '/ws',
    });
    expect(result.kind).toBe('locations');
    expect(result).toEqual({
      kind: 'locations',
      locations: [{ uri: 'file:///a.ts', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }],
    });
    expect(calls).toEqual([]);
  });

  it('passes the languageId resolved from the extension map', async () => {
    const service = new LspService();
    let seenLanguageId: string | undefined;
    service.registerProvider({
      id: 'typescript',
      extensionToLanguage: { ts: 'typescript' },
      query: async (request) => {
        seenLanguageId = request.languageId;
        return { kind: 'hover', hover: null };
      },
    });
    await service.query({
      operation: 'hover',
      filePath: '/ws/a.ts',
      position: { line: 0, character: 0 },
      workspaceRoot: '/ws',
    });
    expect(seenLanguageId).toBe('typescript');
  });

  it('fails loud when no provider covers the extension', async () => {
    const service = new LspService();
    service.registerProvider(stubProvider('python', { py: 'python' }));
    await expect(
      service.query({
        operation: 'hover',
        filePath: '/ws/a.ts',
        position: { line: 0, character: 0 },
        workspaceRoot: '/ws',
      }),
    ).rejects.toMatchObject({ code: ErrorCodes.LSP_UNAVAILABLE });
  });

  it('rejects a provider whose id is already registered', () => {
    const service = new LspService();
    service.registerProvider(stubProvider('typescript', { ts: 'typescript' }));
    let caught: unknown;
    try {
      service.registerProvider(stubProvider('typescript', { tsx: 'typescript' }));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error2);
    expect((caught as Error2).code).toBe(ErrorCodes.LSP_CONFLICT);
  });

  it('rejects a provider whose extension is already covered, atomically', async () => {
    const service = new LspService();
    service.registerProvider(stubProvider('typescript', { ts: 'typescript' }));
    const conflicting = stubProvider('python', { ts: 'typescript', py: 'python' });
    let caught: unknown;
    try {
      service.registerProvider(conflicting);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error2);
    expect((caught as Error2).code).toBe(ErrorCodes.LSP_CONFLICT);
    // The rejected registration must not have landed any extension.
    await expect(
      service.query({
        operation: 'hover',
        filePath: '/ws/a.py',
        position: { line: 0, character: 0 },
        workspaceRoot: '/ws',
      }),
    ).rejects.toMatchObject({ code: ErrorCodes.LSP_UNAVAILABLE });
  });

  it('withdraws id and extensions when the disposer runs', async () => {
    const service = new LspService();
    const disposable = service.registerProvider(stubProvider('typescript', { ts: 'typescript' }));
    disposable.dispose();
    await expect(
      service.query({
        operation: 'hover',
        filePath: '/ws/a.ts',
        position: { line: 0, character: 0 },
        workspaceRoot: '/ws',
      }),
    ).rejects.toMatchObject({ code: ErrorCodes.LSP_UNAVAILABLE });
    // The id is free again.
    expect(() => service.registerProvider(stubProvider('typescript', { ts: 'typescript' }))).not.toThrow();
  });

  it('forwards the abort signal to the provider', async () => {
    const service = new LspService();
    const controller = new AbortController();
    let seenSignal: AbortSignal | undefined;
    service.registerProvider({
      id: 'typescript',
      extensionToLanguage: { ts: 'typescript' },
      query: async (_request, signal) => {
        seenSignal = signal;
        return { kind: 'hover', hover: null };
      },
    });
    await service.query(
      {
        operation: 'hover',
        filePath: '/ws/a.ts',
        position: { line: 0, character: 0 },
        workspaceRoot: '/ws',
      },
      controller.signal,
    );
    expect(seenSignal).toBe(controller.signal);
  });
});
