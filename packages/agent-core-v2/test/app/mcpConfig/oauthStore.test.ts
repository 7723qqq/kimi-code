import { describe, expect, it } from 'vitest';

import { createMcpOAuthStore } from '#/app/mcpConfig/oauthStore';
import type { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';

describe('createMcpOAuthStore', () => {
  it('encrypts JSON data at rest and round-trips through the credentials/mcp scope', async () => {
    const calls: Array<{ op: string; scope: string; key: string; value?: unknown }> = [];
    const docs: Pick<IAtomicDocumentStore, 'get' | 'set' | 'delete'> = {
      async get<T>(scope: string, key: string): Promise<T | undefined> {
        calls.push({ op: 'get', scope, key });
        return undefined as T;
      },
      async set(scope, key, value) {
        calls.push({ op: 'set', scope, key, value });
      },
      async delete(scope, key) {
        calls.push({ op: 'delete', scope, key });
      },
    };
    const store = createMcpOAuthStore(docs as unknown as IAtomicDocumentStore);

    await store.write('foo.json', { token: 'abc' });

    const setCall = calls[0]!;
    expect(setCall).toMatchObject({ op: 'set', scope: 'credentials/mcp', key: 'foo.json' });
    const blob = setCall.value as { iv: string; tag: string; data: string };
    expect(typeof blob.iv).toBe('string');
    expect(typeof blob.tag).toBe('string');
    expect(typeof blob.data).toBe('string');
    expect(blob.data).not.toContain('abc');

    // Reading back the encrypted blob decrypts to the original value.
    docs.get = async (scope, key) => {
      calls.push({ op: 'get', scope, key });
      return blob as never;
    };
    await expect(store.read('foo.json')).resolves.toEqual({ token: 'abc' });

    // Legacy plain-text records stay readable.
    docs.get = async (scope, key) => {
      calls.push({ op: 'get', scope, key });
      return { token: 'legacy' } as never;
    };
    await expect(store.read('foo.json')).resolves.toEqual({ token: 'legacy' });

    await store.remove('foo.json');
    expect(calls[calls.length - 1]).toEqual({
      op: 'delete',
      scope: 'credentials/mcp',
      key: 'foo.json',
    });
  });

  it('returns undefined when the underlying document store read fails', async () => {
    const store = createMcpOAuthStore({
      get: async () => {
        throw new Error('corrupt json');
      },
      set: async () => {},
      delete: async () => {},
    } as unknown as IAtomicDocumentStore);

    await expect(store.read('bad.json')).resolves.toBeUndefined();
  });
});
