import { IAgentProfileService } from '#/agent/profile/profile';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';
import { normalizeResultUrl } from '#/app/auth/webSearch/providers/fusion';
import { IWebSearchProviderService } from '#/app/auth/webSearch/webSearch';
import { rankPassages, type PassageDocument } from '#/app/web/cache/webCache';
import { IWebFetchService } from '#/app/web/web';
import { toInputJsonSchema } from '#/tool/input-schema';
import { ToolOutputAccumulator } from '#/tool/output-accumulator';
import { literalRulePattern, matchesGlobRuleSubject } from '#/tool/rule-match';
import {
  RepoMutations,
  ToolAccesses,
  ToolSideEffects,
  type ExecutableToolContext,
  type ExecutableToolResult,
  type ToolExecution,
} from '#/tool/toolContract';

import {
  IWebSearchTool,
  WebSearchInputSchema,
  type WebSearchInput,
  type WebSearchResult,
} from './web-search';
import DESCRIPTION from './web-search.md?raw';

const ASK_FETCH_LIMIT = 5;
const ASK_PASSAGE_LIMIT = 8;

export class WebSearchTool implements IWebSearchTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'WebSearch' as const;
  readonly sideEffect = ToolSideEffects.read;
  readonly repoMutation = RepoMutations.none;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(WebSearchInputSchema);

  constructor(
    @IWebSearchProviderService private readonly providerService: IWebSearchProviderService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IWebFetchService private readonly webFetch: IWebFetchService,
  ) {}

  resolveExecution(args: WebSearchInput): ToolExecution {
    const preview = args.query.length > 40 ? `${args.query.slice(0, 40)}…` : args.query;
    return {
      accesses: ToolAccesses.none(),
      description: args.mode === 'ask' ? `Researching: ${preview}` : `Searching: ${preview}`,
      display: { kind: 'search', query: args.query },
      approvalRule: literalRulePattern(this.name, args.query),
      matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, args.query),
      execute: (ctx) => this.execution(args, ctx),
    };
  }

  private async execution(
    args: WebSearchInput,
    { toolCallId, signal }: ExecutableToolContext,
  ): Promise<ExecutableToolResult> {
    const provider = this.providerService.getWebSearchProvider(this.profile.getModel());
    if (provider === undefined) {
      return {
        isError: true,
        output:
          'Web search is no longer configured; the provider was removed after this session started.',
      };
    }
    try {
      const limit = args.maxResults ?? (args.mode === 'ask' ? 8 : undefined);
      const results = await provider.search(args.query, {
        toolCallId,
        signal,
        scope: args.scope,
        freshness: args.freshness,
        domains: args.domains,
        limit,
      });
      if (results.length === 0) {
        return { output: 'No search results found.', isError: false };
      }

      if (args.mode === 'ask') {
        return await this.runAskResearch(args.query, results, toolCallId, signal);
      }

      return formatSearchResults(results);
    } catch (error) {
      if (signal.aborted) throw error;
      return {
        isError: true,
        output: classifySearchError(error),
      };
    }
  }

  private async runAskResearch(
    query: string,
    results: readonly WebSearchResult[],
    toolCallId: string,
    signal: AbortSignal,
  ): Promise<ExecutableToolResult> {
    const fetcher = this.webFetch.getUrlFetcher();
    const candidates: WebSearchResult[] = [];
    const seen = new Set<string>();
    for (const item of results) {
      const norm = normalizeResultUrl(item.url);
      if (norm.length === 0 || seen.has(norm)) continue;
      seen.add(norm);
      candidates.push(item);
      if (candidates.length >= ASK_FETCH_LIMIT) break;
    }

    const fetched = await Promise.allSettled(
      candidates.map((item) =>
        fetcher.fetch(item.url, {
          toolCallId,
          signal,
          query,
          maxChars: 12_000,
        }),
      ),
    );
    if (signal.aborted) {
      const abortErr = new Error('The operation was aborted.');
      abortErr.name = 'AbortError';
      throw abortErr;
    }

    const documents: PassageDocument[] = [];
    const citationIndex = new Map<string, number>();
    const sources: Array<{ index: number; title: string; url: string; fetched: boolean }> = [];

    for (const [idx, item] of candidates.entries()) {
      const num = idx + 1;
      citationIndex.set(item.url, num);
      const outcome = fetched[idx];
      if (outcome?.status === 'fulfilled' && outcome.value.content.trim().length > 0) {
        sources.push({ index: num, title: item.title, url: item.url, fetched: true });
        documents.push({
          url: item.url,
          title: item.title,
          content: outcome.value.content,
        });
      } else {
        sources.push({ index: num, title: item.title, url: item.url, fetched: false });
        if (item.snippet.trim().length > 0) {
          documents.push({
            url: item.url,
            title: item.title,
            content: item.snippet,
          });
        }
      }
    }

    const passages = rankPassages(query, documents, ASK_PASSAGE_LIMIT);
    const builder = new ToolOutputAccumulator();
    builder.write(`Research results for "${query}" (${String(sources.filter((s) => s.fetched).length)}/${String(sources.length)} pages fetched):\n\n`);

    if (passages.length > 0) {
      builder.write('## Key Passages\n\n');
      for (const passage of passages) {
        const refNum = citationIndex.get(passage.url) ?? 0;
        const heading = passage.heading.length > 0 ? ` — ${passage.heading}` : '';
        builder.write(`[${String(refNum)}] ${passage.title}${heading}\n`);
        builder.write(`${passage.text}\n\n`);
      }
    }

    builder.write('## Sources\n\n');
    for (const src of sources) {
      const status = src.fetched ? 'fetched' : 'snippet-only';
      builder.write(`[${String(src.index)}] [${src.title}](${src.url}) (${status})\n`);
    }

    if (results.length > candidates.length) {
      builder.write('\n## Additional Search Hits\n\n');
      for (const extra of results.slice(candidates.length)) {
        builder.write(`- [${extra.title}](${extra.url}): ${extra.snippet}\n`);
      }
    }

    builder.write(
      '\nWhen you rely on any passage or source in your answer, cite it inline as a markdown link, e.g. [title](url).',
    );
    return builder.ok();
  }
}

function formatSearchResults(results: readonly WebSearchResult[]): ExecutableToolResult {
  const builder = new ToolOutputAccumulator();
  let first = true;
  for (const result of results) {
    if (!first) builder.write('---\n\n');
    first = false;

    builder.write(`Title: ${result.title}\n`);
    if (result.siteName) builder.write(`Site: ${result.siteName}\n`);
    if (result.date) builder.write(`Date: ${result.date}\n`);
    if (result.engines && result.engines.length > 0) {
      builder.write(`Engines: ${result.engines.join(', ')}\n`);
    }
    builder.write(`URL: ${result.url}\n`);
    builder.write(`Snippet: ${result.snippet}\n\n`);
  }

  builder.write(
    'When you rely on a result in your answer, cite it inline as a markdown link, e.g. [title](url).',
  );

  return builder.ok();
}

function classifySearchError(error: unknown): string {
  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();

  if (name === 'AbortError' || lower.includes('abort')) {
    return `Search cancelled: ${message}`;
  }
  if (name === 'TimeoutError' || lower.includes('timed out') || lower.includes('timeout')) {
    return `Search timed out: ${message}`;
  }
  if (lower.includes('401') || lower.includes('unauthorized') || lower.includes('auth')) {
    return `Search failed (authentication): ${message}`;
  }
  if (
    lower.includes('http ') ||
    lower.includes('network') ||
    lower.includes('fetch') ||
    name === 'TypeError'
  ) {
    return `Search failed (network): ${message}`;
  }
  return `Search failed: ${message}`;
}

registerAgentToolService(IWebSearchTool, WebSearchTool, {
  name: 'WebSearch',
  domain: 'auth',
  when: (accessor) =>
    accessor
      .get(IWebSearchProviderService)
      .hasWebSearchProvider(accessor.get(IAgentProfileService).getModel()),
});
