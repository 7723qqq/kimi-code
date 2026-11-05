import { describe, expect, it } from 'bun:test';

import { codeAllowsEmbeddings } from '#/features/associativeMemory/code';
import { DEFAULT_CODE } from '#/features/associativeMemory/code/defaults';
import {
  createHttpEmbeddingsClient,
  EMBEDDINGS_API_KEY_ENV,
  EMBEDDINGS_MODEL_ENV,
  EMBEDDINGS_URL_ENV,
  resolveEmbeddingsOptions,
} from '#/features/associativeMemory/embeddings';
import type { MemoryCode } from '#/features/associativeMemory/types';
import { averageDense, cosineDense } from '#/features/associativeMemory/vector';

describe('resolveEmbeddingsOptions', () => {
  it('is undefined without a base url', () => {
    expect(resolveEmbeddingsOptions({ getEnv: () => undefined })).toBeUndefined();
  });

  it('is undefined without an api key', () => {
    const options = resolveEmbeddingsOptions({
      getEnv: (name) => (name === EMBEDDINGS_URL_ENV ? 'https://example.test/v1' : undefined),
    });
    expect(options).toBeUndefined();
  });

  it('resolves the url, key and default model', () => {
    const options = resolveEmbeddingsOptions({
      getEnv: (name) => {
        if (name === EMBEDDINGS_URL_ENV) return 'https://example.test/v1/';
        if (name === EMBEDDINGS_API_KEY_ENV) return 'key';
        return undefined;
      },
    });
    expect(options).toEqual({
      baseUrl: 'https://example.test/v1',
      apiKey: 'key',
      model: 'text-embedding-3-small',
    });
  });

  it('honours a custom model', () => {
    const options = resolveEmbeddingsOptions({
      getEnv: (name) => {
        if (name === EMBEDDINGS_URL_ENV) return 'https://example.test/v1';
        if (name === EMBEDDINGS_API_KEY_ENV) return 'key';
        if (name === EMBEDDINGS_MODEL_ENV) return 'custom-model';
        return undefined;
      },
    });
    expect(options?.model).toBe('custom-model');
  });
});

describe('createHttpEmbeddingsClient', () => {
  it('posts to the embeddings endpoint and parses the vectors', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ data: [{ embedding: [1, 2] }, { embedding: [3, 4] }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    try {
      const client = createHttpEmbeddingsClient({
        baseUrl: 'https://example.test/v1',
        apiKey: 'key',
        model: 'm',
      });
      const vectors = await client.embed(['a', 'b']);
      expect(vectors).toEqual([
        [1, 2],
        [3, 4],
      ]);
      expect(calls[0]?.url).toBe('https://example.test/v1/embeddings');
      expect(calls[0]?.init.method).toBe('POST');
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('codeAllowsEmbeddings', () => {
  it('allows embeddings unless a rule blocks them', () => {
    expect(codeAllowsEmbeddings(DEFAULT_CODE)).toBe(true);
    const blocked: MemoryCode = {
      rules: [
        {
          id: 'no-external',
          pattern: '.*',
          regex: true,
          action: 'block_embed',
          scope: 'note',
          reason: 'privacy',
        },
      ],
      guidance: '',
    };
    expect(codeAllowsEmbeddings(blocked)).toBe(false);
  });
});

describe('dense vector math', () => {
  it('averages dense vectors', () => {
    expect(averageDense([[1, 3], [3, 5]])).toEqual([2, 4]);
    expect(averageDense([])).toBeUndefined();
    expect(averageDense([[1, 2], [1, 2, 3]])).toBeUndefined();
  });

  it('computes cosine similarity', () => {
    expect(cosineDense([1, 0], [1, 0])).toBeCloseTo(1, 5);
    expect(cosineDense([1, 0], [0, 1])).toBeCloseTo(0, 5);
  });
});
