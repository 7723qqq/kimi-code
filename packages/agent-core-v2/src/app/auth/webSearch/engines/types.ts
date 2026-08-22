import type { WebSearchResult } from '#/agent/tools/web-search/web-search';

export interface SearchEngineOptions {
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

/** Every ported engine implements this signature (open-websearch's `searchXxx(query, limit)`). */
export type SearchEngineFn = (
  query: string,
  limit: number,
  options?: SearchEngineOptions,
) => Promise<WebSearchResult[]>;

/** Article fetch services (open-websearch's `fetch-<site>` commands). */
export type ArticleFetchFn = (
  url: string,
  options?: SearchEngineOptions,
) => Promise<{ content: string; title?: string } | undefined>;
