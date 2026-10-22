import { describe, expect, it } from 'bun:test';

import { createMcpOAuthStore } from '#/app/mcpConfig/oauthStore';
import type { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';

describe('createMcpOAuthStore', () => {
  it('encrypts JSON data at rest with a random IV and a ciphertext that is not the plaintext', async () => {
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
    expect(blob.iv).toMatch(/^[0-9a-f]{24}$/);
    expect(blob.tag).toMatch(/^[0-9a-f]{32}$/);
    const plaintext = Buffer.from(JSON.stringify({ token: 'abc' }), 'utf8');
    const ciphertext = Buffer.from(blob.data, 'hex');
    expect(ciphertext).toHaveLength(plaintext.length);
    expect(ciphertext.equals(plaintext)).toBe(false);

    docs.get = async (scope, key) => {
      calls.push({ op: 'get', scope, key });
      return blob as never;
    };
    await expect(store.read('foo.json')).resolves.toEqual({ token: 'abc' });

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
