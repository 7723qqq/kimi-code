import type { FetchLike } from '#/_base/utils/fetchLike';
import type {
  WebSearchOptions,
  WebSearchProvider,
  WebSearchResult,
  WebSearchScope,
} from '#/agent/tools/web-search/web-search';
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
import { VERTICAL_ENGINE_REGISTRY, enginesForScope } from '../engines/verticals';
import { searchZhihu } from '../engines/zhihu';
import { applyQueryModifiers, fuseSearchResults, type EngineResultList } from './fusion';

export type LocalSearchEngine = string;

const DEFAULT_CONCURRENCY = 5;
const MAX_CONCURRENCY = 12;
const DEFAULT_ENGINE_TIMEOUT_MS = 12_000;

const WEB_ENGINE_REGISTRY: Record<string, SearchEngineFn> = {
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

const ENGINE_REGISTRY: Record<string, SearchEngineFn> = {
  ...WEB_ENGINE_REGISTRY,
  ...VERTICAL_ENGINE_REGISTRY,
};

const VERTICAL_ONLY_ENGINES = new Set(Object.keys(VERTICAL_ENGINE_REGISTRY));

export function resolveSearchEngines(
  env: Record<string, string | undefined> = process.env,
): readonly string[] {
  const preferred = env['KIMI_CODE_SEARCH_ENGINE']?.trim().toLowerCase();
  const allowedRaw = env['KIMI_CODE_ALLOWED_SEARCH_ENGINES'];
  const baseKeys = Object.keys(WEB_ENGINE_REGISTRY);
  const allowed =
    allowedRaw === undefined || allowedRaw.trim() === ''
      ? baseKeys
      : allowedRaw
          .split(',')
          .map((name) => name.trim().toLowerCase())
          .filter((name) => name in ENGINE_REGISTRY);
  const first =
    preferred !== undefined && preferred in ENGINE_REGISTRY ? preferred : 'bing';
  const ordered = [
    ...(allowed.includes(first) || allowedRaw === undefined || allowedRaw.trim() === ''
      ? [first]
      : []),
    ...allowed.filter((name) => name !== first),
  ];
  return ordered.length > 0 ? ordered : ['bing'];
}

export function resolveResultLimit(env: Record<string, string | undefined> = process.env): number {
  const raw = Number(env['KIMI_CODE_SEARCH_RESULTS']);
  return Number.isFinite(raw) && raw > 0 && raw <= 20 ? Math.floor(raw) : 10;
}

export function resolveSearchConcurrency(
  env: Record<string, string | undefined> = process.env,
): number {
  if (env['KIMI_CODE_SEARCH_CONCURRENT'] === '0') return 1;
  const raw = Number(env['KIMI_CODE_SEARCH_CONCURRENCY']);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_CONCURRENCY;
  return Math.min(MAX_CONCURRENCY, Math.floor(raw));
}

export interface LocalWebSearchProviderOptions {
  fetchImpl?: FetchLike;
  engine?: string;
  env?: Record<string, string | undefined>;
  concurrency?: number;
  engineTimeoutMs?: number;
}

function isAbortLike(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

export class LocalWebSearchProvider implements WebSearchProvider {
  private readonly fetchImpl: FetchLike;
  private readonly engines: readonly string[];
  private readonly explicitEngine: boolean;
  private readonly limit: number;
  private readonly concurrency: number;
  private readonly engineTimeoutMs: number;

  constructor(options: LocalWebSearchProviderOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    const env = options.env ?? process.env;
    this.explicitEngine = options.engine !== undefined;
    this.engines = options.engine !== undefined ? [options.engine] : resolveSearchEngines(env);
    this.limit = resolveResultLimit(env);
    this.concurrency =
      options.engine !== undefined
        ? 1
        : Math.max(1, options.concurrency ?? resolveSearchConcurrency(env));
    this.engineTimeoutMs = options.engineTimeoutMs ?? DEFAULT_ENGINE_TIMEOUT_MS;
  }

  async search(query: string, options?: WebSearchOptions): Promise<WebSearchResult[]> {
    const signal = options?.signal;
    if (signal?.aborted === true) {
      const abortErr = new Error('The operation was aborted.');
      abortErr.name = 'AbortError';
      throw abortErr;
    }

    const limit = Math.min(20, Math.max(1, options?.limit ?? this.limit));
    const effectiveQuery = applyQueryModifiers(query, {
      domains: options?.domains,
      freshness: options?.freshness,
      scope: options?.scope,
    });
    const selectedEngines = this.selectEngines(options?.scope);

    if (this.concurrency === 1 || selectedEngines.length <= 1) {
      return this.searchSequential(selectedEngines, query, effectiveQuery, limit, options);
    }

    return this.searchConcurrent(selectedEngines, query, effectiveQuery, limit, options);
  }

  private selectEngines(scope: WebSearchScope | undefined): readonly string[] {
    if (this.explicitEngine) return this.engines;
    const scoped = enginesForScope(scope, this.engines).filter((name) => name in ENGINE_REGISTRY);
    return scoped.slice(0, Math.max(this.concurrency, scoped.length));
  }

  private async runEngine(
    engine: string,
    rawQuery: string,
    modifiedQuery: string,
    limit: number,
    signal: AbortSignal | undefined,
  ): Promise<WebSearchResult[]> {
    const executor = ENGINE_REGISTRY[engine];
    if (executor === undefined) return [];
    const engineQuery = VERTICAL_ONLY_ENGINES.has(engine) ? rawQuery : modifiedQuery;
    const timeoutController = new AbortController();
    let timedOut = false;
    const timer = globalThis.setTimeout(() => {
      timedOut = true;
      timeoutController.abort(new Error(`Search engine "${engine}" timed out.`));
    }, this.engineTimeoutMs);

    const combinedSignal =
      signal !== undefined
        ? AbortSignal.any([signal, timeoutController.signal])
        : timeoutController.signal;

    try {
      return await executor(engineQuery, limit, {
        signal: combinedSignal,
        fetchImpl: this.fetchImpl,
      });
    } catch (error) {
      if (timedOut && signal?.aborted !== true) {
        throw new Error(`${engine} timed out after ${String(this.engineTimeoutMs)}ms`);
      }
      throw error;
    } finally {
      globalThis.clearTimeout(timer);
    }
  }

  private async searchSequential(
    engines: readonly string[],
    rawQuery: string,
    modifiedQuery: string,
    limit: number,
    options: WebSearchOptions | undefined,
  ): Promise<WebSearchResult[]> {
    const signal = options?.signal;
    const failures: string[] = [];
    for (const engine of engines) {
      try {
        const results = await this.runEngine(engine, rawQuery, modifiedQuery, limit, signal);
        if (results.length > 0) {
          return fuseSearchResults([{ engine, results }], {
            limit,
            domains: options?.domains,
          });
        }
      } catch (error) {
        if (signal?.aborted === true || isAbortLike(error)) {
          throw error;
        }
        failures.push(`${engine}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (failures.length === engines.length && failures.length > 0) {
      throw new Error2(
        ErrorCodes.WEB_FETCH_FAILED,
        `All search engines failed (${failures.join('; ')})`,
      );
    }
    return [];
  }

  private async searchConcurrent(
    engines: readonly string[],
    rawQuery: string,
    modifiedQuery: string,
    limit: number,
    options: WebSearchOptions | undefined,
  ): Promise<WebSearchResult[]> {
    const batch = engines.slice(0, this.concurrency);
    const callerSignal = options?.signal;
    const groupController = new AbortController();
    const onCallerAbort = (): void => {
      groupController.abort(callerSignal?.reason);
    };
    callerSignal?.addEventListener('abort', onCallerAbort, { once: true });

    const settled = await Promise.allSettled(
      batch.map(async (engine): Promise<EngineResultList> => {
        const results = await this.runEngine(
          engine,
          rawQuery,
          modifiedQuery,
          limit,
          groupController.signal,
        );
        return { engine, results };
      }),
    ).finally(() => {
      callerSignal?.removeEventListener('abort', onCallerAbort);
    });

    const lists: EngineResultList[] = [];
    const failures: string[] = [];
    let abortError: Error | undefined;

    for (const [index, outcome] of settled.entries()) {
      const engine = batch[index] ?? 'unknown';
      if (outcome.status === 'fulfilled') {
        if (outcome.value.results.length > 0) {
          lists.push(outcome.value);
        }
      } else {
        if (callerSignal?.aborted === true || isAbortLike(outcome.reason)) {
          abortError ??=
            outcome.reason instanceof Error
              ? outcome.reason
              : Object.assign(new Error(String(outcome.reason)), { name: 'AbortError' });
        } else {
          failures.push(
            `${engine}: ${outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)}`,
          );
        }
      }
    }

    if (callerSignal?.aborted === true && abortError !== undefined) {
      throw abortError;
    }

    if (lists.length === 0) {
      if (abortError !== undefined && failures.length === 0) {
        throw abortError;
      }
      if (failures.length === batch.length && failures.length > 0) {
        throw new Error2(
          ErrorCodes.WEB_FETCH_FAILED,
          `All search engines failed (${failures.join('; ')})`,
        );
      }
      return [];
    }

    return fuseSearchResults(lists, {
      limit,
      domains: options?.domains,
    });
  }
}
