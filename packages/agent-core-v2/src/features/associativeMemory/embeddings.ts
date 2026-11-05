export interface EmbeddingsOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
}

export interface EmbeddingsClient {
  embed(texts: readonly string[]): Promise<readonly (readonly number[])[]>;
}

export const EMBEDDINGS_URL_ENV = 'KIMI_CODE_ASSOCIATIVE_MEMORY_EMBEDDINGS_URL';
export const EMBEDDINGS_API_KEY_ENV = 'KIMI_CODE_ASSOCIATIVE_MEMORY_EMBEDDINGS_API_KEY';
export const EMBEDDINGS_MODEL_ENV = 'KIMI_CODE_ASSOCIATIVE_MEMORY_EMBEDDINGS_MODEL';
export const DEFAULT_EMBEDDINGS_MODEL = 'text-embedding-3-small';

export function resolveEmbeddingsOptions(env: {
  getEnv(name: string): string | undefined;
}): EmbeddingsOptions | undefined {
  const baseUrl = env.getEnv(EMBEDDINGS_URL_ENV);
  const apiKey = env.getEnv(EMBEDDINGS_API_KEY_ENV);
  if (baseUrl === undefined || baseUrl.length === 0) return undefined;
  if (apiKey === undefined || apiKey.length === 0) return undefined;
  const model = env.getEnv(EMBEDDINGS_MODEL_ENV) ?? DEFAULT_EMBEDDINGS_MODEL;
  return { baseUrl: baseUrl.replace(/\/+$/, ''), apiKey, model };
}

export function createHttpEmbeddingsClient(options: EmbeddingsOptions): EmbeddingsClient {
  return {
    async embed(texts) {
      const response = await fetch(`${options.baseUrl}/embeddings`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${options.apiKey}`,
        },
        body: JSON.stringify({ model: options.model, input: texts }),
      });
      if (!response.ok) {
        throw new Error(`embeddings request failed with status ${String(response.status)}`);
      }
      const payload = (await response.json()) as {
        data?: readonly { embedding?: readonly number[] }[];
      };
      return (payload.data ?? []).map((entry) => entry.embedding ?? []);
    },
  };
}
