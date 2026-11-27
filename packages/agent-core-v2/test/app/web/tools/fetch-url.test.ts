import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { lookup } from 'node:dns/promises';

import type { FetchLike } from '#/_base/utils/fetchLike';
import { FetchURLTool } from '#/agent/tools/fetch-url/fetchUrlTool';
import { WebSearchTool } from '#/agent/tools/web-search/webSearchTool';
import { createFailoverWebSearchProvider } from '#/app/auth/webSearch/webSearchService';
import { LocalFetchURLProvider } from '#/app/web/providers/local-fetch-url';
import { type UrlFetcher, type UrlFetchResult } from '#/app/web/tools/fetch-url-types';
import {
  type ExecutableToolContext,
  type ExecutableToolResult,
  type ToolExecution,
} from '#/tool/toolContract';
import { waitUntil } from '#test/helpers/waitFor';

void mock.module('node:dns/promises', () => ({ lookup: mock() }));

beforeEach(() => {
  (lookup as unknown as ReturnType<typeof mock>).mockReset();
  (lookup as unknown as ReturnType<typeof mock>).mockResolvedValue([
    { address: '93.184.216.34', family: 4 },
  ]);
});

function isPromiseLike(
  value: ToolExecution | Promise<ToolExecution>,
): value is Promise<ToolExecution> {
  return typeof (value as Promise<ToolExecution>).then === 'function';
}

async function execute(
  tool: FetchURLTool,
  url: string,
  signal: AbortSignal,
): Promise<ExecutableToolResult> {
  const resolved = tool.resolveExecution({ url });
  const execution = isPromiseLike(resolved) ? await resolved : resolved;
  if (execution.isError === true) return execution;
  const ctx: ExecutableToolContext = { turnId: 0, toolCallId: 'call_fetch', signal };
  return execution.execute(ctx);
}

function abortError(): Error {
  const err = new Error('This operation was aborted');
  err.name = 'AbortError';
  return err;
}

describe('FetchURLTool abort signal', () => {
  it('forwards ctx.signal to the fetcher', async () => {
    const controller = new AbortController();
    const fetch = mock<UrlFetcher['fetch']>().mockResolvedValue({
      content: 'hello',
      kind: 'passthrough',
    } satisfies UrlFetchResult);
    const tool = new FetchURLTool({
      _serviceBrand: undefined,
      getUrlFetcher: () => ({ fetch }),
    });

    await execute(tool, 'https://example.com', controller.signal);

    expect(fetch).toHaveBeenCalledTimes(1);
    const [, options] = fetch.mock.calls[0]!;
    expect(options?.toolCallId).toBe('call_fetch');
    expect(options?.signal).toBe(controller.signal);
  });

  it('re-throws when the signal aborts mid-fetch', async () => {
    const controller = new AbortController();
    const fetch = mock<UrlFetcher['fetch']>().mockImplementation(async () => {
      controller.abort(new Error('Aborted by the user'));
      throw abortError();
    });
    const tool = new FetchURLTool({
      _serviceBrand: undefined,
      getUrlFetcher: () => ({ fetch }),
    });

    await expect(execute(tool, 'https://example.com', controller.signal)).rejects.toThrow();
  });

  it('returns a normal error result when fetch fails without abort', async () => {
    const controller = new AbortController();
    const fetch = mock<UrlFetcher['fetch']>().mockRejectedValue(new Error('boom'));
    const tool = new FetchURLTool({
      _serviceBrand: undefined,
      getUrlFetcher: () => ({ fetch }),
    });

    const result = await execute(tool, 'https://example.com', controller.signal);

    expect(result.isError).toBe(true);
    if (typeof result.output !== 'string') {
      throw new Error('expected string error output');
    }
    expect(result.output).toContain('boom');
  });

  it('surfaces the underlying cause of an undici network failure', async () => {
    const failure: TypeError & { cause?: unknown } = new TypeError('fetch failed');
    failure.cause = Object.assign(new Error('connect ETIMEDOUT 20.205.243.166:443'), {
      code: 'ETIMEDOUT',
    });
    const fetch = mock<UrlFetcher['fetch']>().mockRejectedValue(failure);
    const tool = new FetchURLTool({
      _serviceBrand: undefined,
      getUrlFetcher: () => ({ fetch }),
    });

    const result = await execute(tool, 'https://github.com/x', new AbortController().signal);

    expect(result.isError).toBe(true);
    if (typeof result.output !== 'string') {
      throw new Error('expected string error output');
    }
    expect(result.output).toContain('fetch failed');
    expect(result.output).toContain('ETIMEDOUT');
  });
});

describe('FetchURLTool output note', () => {
  async function runKind(kind: UrlFetchResult['kind']): Promise<string> {
    const fetch = mock<UrlFetcher['fetch']>().mockResolvedValue({
      content: 'BODY',
      kind,
    } satisfies UrlFetchResult);
    const tool = new FetchURLTool({
      _serviceBrand: undefined,
      getUrlFetcher: () => ({ fetch }),
    });
    const result = await execute(tool, 'https://example.com', new AbortController().signal);
    expect(result.isError).toBe(false);
    if (typeof result.output !== 'string') throw new Error('expected string output');
    return result.output;
  }

  it('puts the passthrough note and citation reminder at the front of output', async () => {
    const output = await runKind('passthrough');
    expect(output).toBe(
      'The returned content is the full response body, returned verbatim. ' +
        'If you use it in your answer, cite this page as a markdown link, e.g. [title](url).\n\nBODY',
    );
  });

  it('puts the extracted note and citation reminder at the front of output', async () => {
    const output = await runKind('extracted');
    expect(output).toBe(
      'The returned content is the main text extracted from the page. ' +
        'If you use it in your answer, cite this page as a markdown link, e.g. [title](url).\n\nBODY',
    );
  });
});

describe('FetchURLTool backend resolution', () => {
  it('resolves the fetcher per invocation, never at construction', async () => {
    const fetch = mock<UrlFetcher['fetch']>().mockResolvedValue({
      content: 'hello',
      kind: 'passthrough',
    } satisfies UrlFetchResult);
    const getUrlFetcher = mock(() => ({ fetch }));
    const tool = new FetchURLTool({ _serviceBrand: undefined, getUrlFetcher });

    expect(getUrlFetcher).not.toHaveBeenCalled();

    await execute(tool, 'https://example.com', new AbortController().signal);
    await execute(tool, 'https://example.com', new AbortController().signal);
    expect(getUrlFetcher).toHaveBeenCalledTimes(2);
  });
});

describe('LocalFetchURLProvider abort signal', () => {
  it('wires the caller signal into fetchImpl so aborts propagate', async () => {
    const controller = new AbortController();
    const fetchImpl = mock<FetchLike>().mockImplementation(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          (init?.signal as AbortSignal | undefined)?.addEventListener('abort', () =>
            reject(new Error('The operation was aborted.')),
          );
        }) as Promise<Response>,
    );
    const provider = new LocalFetchURLProvider({ fetchImpl });

    const pending = provider.fetch('https://example.com/test', { signal: controller.signal });
    await waitUntil(() => fetchImpl.mock.calls.length > 0);
    controller.abort();
    const outcome = await pending.then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toBe('The operation was aborted.');

    const [, init] = fetchImpl.mock.calls[0]!;
    expect((init as RequestInit | undefined)?.signal).toBeInstanceOf(AbortSignal);
  });

  it('forwards optional query, maxChars, and bypassCache options from FetchURLTool', async () => {
    const fetch = mock<UrlFetcher['fetch']>().mockResolvedValue({
      content: 'focused excerpt',
      kind: 'extracted',
    } satisfies UrlFetchResult);
    const tool = new FetchURLTool({
      _serviceBrand: undefined,
      getUrlFetcher: () => ({ fetch }),
    });
    const execution = await tool.resolveExecution({
      url: 'https://example.com/long',
      query: 'rate limits',
      maxChars: 2000,
      bypassCache: true,
    });
    if (!('execute' in execution)) throw new Error('expected execution');
    const result = await execution.execute({
      turnId: 0,
      toolCallId: 'tc_opts',
      signal: new AbortController().signal,
    });
    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('focused excerpt');
    expect(fetch).toHaveBeenCalledWith('https://example.com/long', {
      toolCallId: 'tc_opts',
      signal: expect.any(AbortSignal),
      query: 'rate limits',
      maxChars: 2000,
      bypassCache: true,
    });
  });
});

describe('WebSearchTool ask mode and scoped failover', () => {
  it('runs search plus parallel top-page fetches and returns cited ranked passages in ask mode', async () => {
    const search = mock(async () => [
      {
        title: 'Bun SQLite Guide',
        url: 'https://bun.sh/docs/api/sqlite',
        snippet: 'Built-in SQLite3 driver with FTS5.',
      },
      {
        title: 'Unrelated Page',
        url: 'https://example.com/unrelated',
        snippet: 'Nothing about databases here.',
      },
      {
        title: 'Broken Page',
        url: 'https://example.com/broken',
        snippet: 'Fallback snippet mentions SQLite WAL mode.',
      },
    ]);
    const fetch = mock<UrlFetcher['fetch']>().mockImplementation(async (url) => {
      if (url.includes('broken')) throw new Error('502 Bad Gateway');
      if (url.includes('sqlite')) {
        return {
          content: '# Bun SQLite\n\n## FTS5 Support\n\nbun:sqlite includes built-in FTS5 full-text search tables with bm25 scoring.',
          kind: 'extracted',
        };
      }
      return {
        content: '# Unrelated\n\nCompletely off topic prose.',
        kind: 'extracted',
      };
    });

    const tool = new WebSearchTool(
      {
        _serviceBrand: undefined,
        hasWebSearchProvider: () => true,
        getWebSearchProvider: () => ({ search }),
      },
      { getModel: () => 'test-model' } as never,
      {
        _serviceBrand: undefined,
        getUrlFetcher: () => ({ fetch }),
      },
    );

    const execution = await tool.resolveExecution({
      query: 'bun sqlite fts5 bm25',
      mode: 'ask',
      scope: 'docs',
      domains: ['bun.sh'],
    });
    if (!('execute' in execution)) throw new Error('expected execution');
    const result = await execution.execute({
      turnId: 1,
      toolCallId: 'tc_ask',
      signal: new AbortController().signal,
    });

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('## Key Passages');
    expect(result.output).toContain('[1] Bun SQLite Guide — FTS5 Support');
    expect(result.output).toContain('built-in FTS5 full-text search');
    expect(result.output).toContain('[1] [Bun SQLite Guide](https://bun.sh/docs/api/sqlite) (fetched)');
    expect(result.output).toContain('[3] [Broken Page](https://example.com/broken) (snippet-only)');
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('filters remote results by domains in failover provider', async () => {
    const provider = createFailoverWebSearchProvider([
      {
        async search() {
          return [
            { title: 'Skip', url: 'https://other.org/a', snippet: 'a' },
            { title: 'Keep', url: 'https://docs.bun.sh/b', snippet: 'b' },
          ];
        },
      },
    ]);
    const filtered = await provider.search('bun', { domains: ['bun.sh'] });
    expect(filtered.map((item) => item.title)).toEqual(['Keep']);
  });
});
