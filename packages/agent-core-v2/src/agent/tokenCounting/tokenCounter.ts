import { estimateTokens } from '#/llm-adapter/contract/tokens';

export type TokenCounterSource = 'heuristic' | 'wasm' | 'sidecar' | 'http';

export interface TokenCounter {
  readonly source: TokenCounterSource;
  count(text: string): number;
}

export interface AsyncTokenCounter {
  readonly source: TokenCounterSource;
  countAsync(text: string): Promise<number>;
}

export class TokenCounterUnavailableError extends Error {}

export const HEURISTIC_TOKEN_COUNTER: TokenCounter = Object.freeze({
  source: 'heuristic',
  count: estimateTokens,
});

export interface TokenCounterCandidate {
  readonly source: TokenCounterSource;
  create(): TokenCounter;
}

export interface WasmTokenizerModule {
  encode(text: string): readonly number[];
}

export interface AsyncTokenizerBackend {
  countAsync(text: string): Promise<number>;
}

const PROBE = 'token counter probe';

function usable(counter: TokenCounter): boolean {
  const value = counter.count(PROBE);
  return Number.isFinite(value) && value > 0;
}

export function createTokenCounter(
  candidates: readonly TokenCounterCandidate[] = defaultTokenCounterChain(),
  fallback: TokenCounter = HEURISTIC_TOKEN_COUNTER,
): TokenCounter {
  for (const candidate of candidates) {
    try {
      const counter = candidate.create();
      if (usable(counter)) return counter;
    } catch {
      continue;
    }
  }
  return fallback;
}

export function createWasmTokenCounter(load: () => WasmTokenizerModule): TokenCounter {
  let module: WasmTokenizerModule | undefined;
  return {
    source: 'wasm',
    count(text: string): number {
      module ??= load();
      return module.encode(text).length;
    },
  };
}

export function createAsyncTokenCounter(
  source: 'sidecar' | 'http',
  backend: AsyncTokenizerBackend,
): AsyncTokenCounter {
  return { source, countAsync: (text: string) => backend.countAsync(text) };
}

export function asyncTierCandidate(
  source: 'sidecar' | 'http',
  backend: AsyncTokenizerBackend,
): TokenCounterCandidate {
  return {
    source,
    create: (): TokenCounter => {
      void backend;
      throw new TokenCounterUnavailableError(
        `${source} token counters run outside the synchronous request path`,
      );
    },
  };
}

export function wasmTierCandidate(load: () => WasmTokenizerModule): TokenCounterCandidate {
  return { source: 'wasm', create: () => createWasmTokenCounter(load) };
}

export function defaultTokenCounterChain(
  options: {
    readonly wasm?: () => WasmTokenizerModule;
    readonly sidecar?: AsyncTokenizerBackend;
    readonly http?: AsyncTokenizerBackend;
  } = {},
): readonly TokenCounterCandidate[] {
  const unavailable = (source: 'sidecar' | 'http'): AsyncTokenizerBackend => ({
    countAsync: async () => {
      throw new TokenCounterUnavailableError(`${source} token counter backend is not configured`);
    },
  });
  return [
    wasmTierCandidate(
      options.wasm ??
        (() => {
          throw new TokenCounterUnavailableError('no wasm tokenizer module is bundled');
        }),
    ),
    asyncTierCandidate('sidecar', options.sidecar ?? unavailable('sidecar')),
    asyncTierCandidate('http', options.http ?? unavailable('http')),
  ];
}

export interface SidecarTokenizerTransport {
  request(text: string): Promise<number>;
}

export function createSidecarTokenCounter(
  transport: SidecarTokenizerTransport,
): AsyncTokenCounter {
  return createAsyncTokenCounter('sidecar', { countAsync: (text) => transport.request(text) });
}

export function createHttpTokenCounter(transport: SidecarTokenizerTransport): AsyncTokenCounter {
  return createAsyncTokenCounter('http', { countAsync: (text) => transport.request(text) });
}
