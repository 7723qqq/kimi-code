import type { WebSearchProvider, WebSearchResult } from '#/agent/tools/web-search/web-search';
import { Error2, ErrorCodes } from '#/errors';

import { searchBaidu } from '../engines/baidu';
import { searchBing } from '../engines/bing';
import { searchBrave } from '../engines/brave';
import { searchCsdn } from '../engines/csdn';
import { searchDuckDuckGo } from '../engines/duckduckgo';
import { searchExa } from '../engines/exa';
import { searchJuejin } from '../engines/juejin';
import { searchLinuxDo } from '../engines/linuxdo';
import { searchSogou } from '../engines/sogou';
import { searchStartpage } from '../engines/startpage';
import type { SearchEngineFn } from '../engines/types';
import { searchZhihu } from '../engines/zhihu';

export type LocalSearchEngine = string;

const ENGINE_REGISTRY: Record<string, SearchEngineFn> = {
  baidu: searchBaidu,
  bing: searchBing,
  brave: searchBrave,
  csdn: searchCsdn,
  duckduckgo: searchDuckDuckGo,
  exa: searchExa,
  juejin: searchJuejin,
  linuxdo: searchLinuxDo,
  sogou: searchSogou,
  startpage: searchStartpage,
  zhihu: searchZhihu,
};

export function resolveSearchEngines(
  env: Record<string, string | undefined> = process.env,
): readonly string[] {
  const preferred = env['KIMI_CODE_SEARCH_ENGINE']?.trim().toLowerCase();
  const allowedRaw = env['KIMI_CODE_ALLOWED_SEARCH_ENGINES'];
  const allowed =
    allowedRaw === undefined || allowedRaw.trim() === ''
      ? Object.keys(ENGINE_REGISTRY)
      : allowedRaw
          .split(',')
          .map((name) => name.trim().toLowerCase())
          .filter((name) => name in ENGINE_REGISTRY);
  const ordered = [
    ...(preferred !== undefined && preferred in ENGINE_REGISTRY ? [preferred] : ['duckduckgo']),
    ...allowed.filter((name) => name !== preferred && name !== 'duckduckgo'),
  ];
  return ordered.length > 0 ? ordered : ['duckduckgo'];
}

export function resolveResultLimit(env: Record<string, string | undefined> = process.env): number {
  const raw = Number(env['KIMI_CODE_SEARCH_RESULTS']);
  return Number.isFinite(raw) && raw > 0 && raw <= 20 ? Math.floor(raw) : 10;
}

export interface LocalWebSearchProviderOptions {
  fetchImpl?: typeof fetch;
  /** Engine override; defaults to `KIMI_CODE_SEARCH_ENGINE` or duckduckgo. */
  engine?: string;
  env?: Record<string, string | undefined>;
}

export class LocalWebSearchProvider implements WebSearchProvider {
  private readonly fetchImpl: typeof fetch;
  private readonly engines: readonly string[];
  private readonly limit: number;

  constructor(options: LocalWebSearchProviderOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    const env = options.env ?? process.env;
    this.engines = options.engine !== undefined ? [options.engine] : resolveSearchEngines(env);
    this.limit = resolveResultLimit(env);
  }

  async search(
    query: string,
    options?: {
      toolCallId?: string;
      signal?: AbortSignal;
    },
  ): Promise<WebSearchResult[]> {
    const signal = options?.signal;
    const failures: string[] = [];
    for (const engine of this.engines) {
      const executor = ENGINE_REGISTRY[engine];
      if (executor === undefined) continue;
      try {
        const results = await executor(query, this.limit, { signal, fetchImpl: this.fetchImpl });
        if (results.length > 0) return results;
      } catch (error) {
        if (signal?.aborted === true || (error instanceof Error && error.name === 'AbortError')) {
          throw error;
        }
        failures.push(`${engine}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (failures.length === this.engines.length) {
      throw new Error2(
        ErrorCodes.WEB_FETCH_FAILED,
        `All search engines failed (${failures.join('; ')})`,
      );
    }
    return [];
  }
}
