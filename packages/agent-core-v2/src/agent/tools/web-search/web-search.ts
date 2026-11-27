import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { type AgentTool } from '#/tool/toolContract';

export const WEB_SEARCH_SCOPES = [
  'web',
  'academic',
  'code',
  'docs',
  'reference',
  'package',
  'news',
] as const;

export type WebSearchScope = (typeof WEB_SEARCH_SCOPES)[number];

export const WEB_SEARCH_FRESHNESS = ['day', 'week', 'month', 'year', 'any'] as const;

export type WebSearchFreshness = (typeof WEB_SEARCH_FRESHNESS)[number];

export const WEB_SEARCH_MODES = ['search', 'ask'] as const;

export type WebSearchMode = (typeof WEB_SEARCH_MODES)[number];

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  date?: string;
  siteName?: string;
  engines?: readonly string[];
  score?: number;
}

export interface WebSearchOptions {
  toolCallId?: string;
  signal?: AbortSignal;
  scope?: WebSearchScope;
  freshness?: WebSearchFreshness;
  domains?: readonly string[];
  limit?: number;
}

export interface WebSearchProvider {
  search(query: string, options?: WebSearchOptions): Promise<WebSearchResult[]>;
}

export const WebSearchInputSchema = z.object({
  query: z.string().describe('The query text to search for.'),
  scope: z
    .enum(WEB_SEARCH_SCOPES)
    .optional()
    .describe(
      'Optional vertical focus: web (default), academic (arXiv/OpenAlex/Semantic Scholar/Crossref), code (GitHub/code search), docs, reference (Wikipedia), package (npm/PyPI), or news.',
    ),
  freshness: z
    .enum(WEB_SEARCH_FRESHNESS)
    .optional()
    .describe('Optional recency preference: day, week, month, year, or any.'),
  domains: z
    .array(z.string())
    .optional()
    .describe('Optional list of domain suffixes to restrict results to (e.g. ["bun.sh", "github.com"]).'),
  mode: z
    .enum(WEB_SEARCH_MODES)
    .optional()
    .describe(
      'Optional execution mode: search (default ranked links and snippets) or ask (parallel-fetch top results and extract cited query-matched passages).',
    ),
  maxResults: z
    .number()
    .int()
    .min(1)
    .max(20)
    .optional()
    .describe('Optional maximum number of search results to return (1-20).'),
});

export type WebSearchInput = z.infer<typeof WebSearchInputSchema>;

export interface IWebSearchTool extends AgentTool<WebSearchInput> {
  readonly _serviceBrand: undefined;
}
export const IWebSearchTool = createDecorator<IWebSearchTool>('webSearchTool');
