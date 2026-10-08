import type { WebSearchResult } from '#/agent/tools/web-search/web-search';

export interface SearchEngineOptions {
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export type SearchEngineFn = (
  query: string,
  limit: number,
  options?: SearchEngineOptions,
) => Promise<WebSearchResult[]>;

export type ArticleFetchFn = (
  url: string,
  options?: SearchEngineOptions,
) => Promise<{ content: string; title?: string } | undefined>;
