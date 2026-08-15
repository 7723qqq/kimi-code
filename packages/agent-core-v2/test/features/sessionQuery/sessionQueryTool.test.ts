/**
 * Scenario: the `session_query` tool — model-facing search and lineage.
 *
 * Exercises the per-operation argument validation, filter construction, the
 * three operations against a stubbed query service, and the text rendering.
 */

import { describe, expect, it, vi } from 'vitest';

import type { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { SessionSearchCursor } from '#/features/sessionQuery/cursor';
import type { SessionEventSearchHit, SessionSearchHit } from '#/features/sessionQuery/events';
import type { ISessionQueryService } from '#/features/sessionQuery/sessionQueryService';
import { SessionQueryTool } from '#/features/sessionQuery/sessionQueryTool';
import {
  buildEventFilters,
  buildSessionFilters,
  normalizeQuery,
  sessionSearchInputSchema,
} from '#/features/sessionQuery/toolInput';
import {
  formatEventSearch,
  formatSessionSearch,
  formatSessionTrace,
} from '#/features/sessionQuery/toolPresentation';
import type { SessionLineageTrace, SessionRecord } from '#/features/sessionQuery/types';
import type { ISessionContext } from '#/session/sessionContext/sessionContext';
import type { ExecutableToolContext } from '#/tool/toolContract';

function sessionContextStub(): ISessionContext {
  return {
    _serviceBrand: undefined,
    sessionId: 'sess-current',
    workspaceId: 'ws',
    cwd: '/work',
  } as unknown as ISessionContext;
}

function scopeStub(): IAgentScopeContext {
  return { _serviceBrand: undefined, agentId: 'main' } as unknown as IAgentScopeContext;
}

function makeTool(query: Partial<ISessionQueryService>): SessionQueryTool {
  return new SessionQueryTool(
    {
      _serviceBrand: undefined,
      listSessions: async () => [],
      getSession: async () => {
        throw new Error('not stubbed');
      },
      traceLineage: async () => {
        throw new Error('not stubbed');
      },
      filterEvents: async () => [],
      searchEvents: async () => ({ sessionId: 's', items: [] }),
      searchSessions: async () => ({ items: [] }),
      ...query,
    } as ISessionQueryService,
    sessionContextStub(),
    scopeStub(),
  );
}

function hit(id: string, overrides: Partial<SessionSearchHit> = {}): SessionSearchHit {
  return {
    id,
    workspaceId: 'ws',
    cwd: '/work',
    createdAt: 1000,
    live: true,
    persisted: true,
    bestMatch: {
      sessionId: id,
      seq: 1,
      type: 'context.append_message',
      time: 900,
      snippet: 'token match here',
    },
    ...overrides,
  };
}

async function execute(
  tool: SessionQueryTool,
  operation: string,
  operationArgs: Record<string, unknown> = {},
): Promise<{ isError: boolean; output: string }> {
  const execution = tool.resolveExecution({ operation, operationArgs } as never);
  if (execution.isError === true) return execution as { isError: boolean; output: string };
  const ctx: ExecutableToolContext = {
    turnId: 0,
    toolCallId: 'call_sq',
    signal: new AbortController().signal,
  };
  return execution.execute(ctx) as Promise<{ isError: boolean; output: string }>;
}

describe('toolInput', () => {
  it('builds session filters from args', () => {
    const filters = buildSessionFilters({
      query: 'x',
      session_ids: ['a', 'b'],
      availability: ['live'],
      include_root_sessions: true,
    });
    expect(filters).toContainEqual({ kind: 'id', values: ['a', 'b'] });
    expect(filters).toContainEqual({ kind: 'availability', values: ['live'] });
    expect(filters).toContainEqual({ kind: 'parent', values: [null] });
  });

  it('rejects empty filter arrays', () => {
    expect(() => buildSessionFilters({ query: 'x', session_ids: [] })).toThrowError(
      /at least one value/,
    );
  });

  it('builds event filters with inclusive ranges', () => {
    const filters = buildEventFilters({ seqFrom: 1, seqTo: 5, eventTypes: ['a'] });
    expect(filters).toContainEqual({ kind: 'seq', from: 1, to: 5 });
    expect(filters).toContainEqual({ kind: 'type', values: ['a'] });
  });

  it('parses ISO timestamps and rejects inverted ranges', () => {
    const filters = buildEventFilters({
      timeFrom: '2026-08-01T00:00:00Z',
      timeTo: '2026-08-02T00:00:00Z',
    });
    expect(filters).toContainEqual({
      kind: 'time',
      from: Date.parse('2026-08-01T00:00:00Z'),
      to: Date.parse('2026-08-02T00:00:00Z'),
    });
    expect(() =>
      buildEventFilters({ timeFrom: '2026-08-02T00:00:00Z', timeTo: '2026-08-01T00:00:00Z' }),
    ).toThrowError(/less than or equal to/);
    expect(() => buildEventFilters({ timeFrom: 'not-a-date' })).toThrowError(/ISO 8601/);
  });

  it('normalizes queries and rejects empties and NUL', () => {
    expect(normalizeQuery('  hello   world  ')).toBe('hello world');
    expect(() => normalizeQuery('   ')).toThrowError(/non-whitespace/);
    expect(() => normalizeQuery('a\u0000b')).toThrowError(/NUL/);
  });

  it('validates the session-search schema', () => {
    expect(sessionSearchInputSchema.safeParse({ query: 'x', session_ids: ['a'] }).success).toBe(
      true,
    );
    expect(sessionSearchInputSchema.safeParse({ query: 'x', unknown_arg: 1 }).success).toBe(false);
  });
});

describe('SessionQueryTool session_search', () => {
  it('searches the workspace and renders hits', async () => {
    const searchSessions = vi.fn(async () => ({
      items: [
        hit('sess-a'),
        hit('sess-b', {
          live: false,
          bestMatch: {
            sessionId: 'sess-b',
            seq: 3,
            type: 'llm.request',
            time: 800,
            snippet: 'second match',
          },
        }),
      ],
      nextCursor: undefined,
    }));
    const tool = makeTool({ searchSessions });
    const result = await execute(tool, 'session_search', { query: 'token' });

    expect(result.isError).toBe(false);
    expect(result.output).toContain('Session search results (2):');
    expect(result.output).toContain('sess-a');
    expect(result.output).toContain('Snippet: token match here');
    // The caller's cwd is enforced.
    const calls = searchSessions.mock.calls as unknown as [unknown?][];
    const request = calls[0]?.[0] as
      | { sessionFilters: readonly { kind: string; values: readonly (string | null)[] }[] }
      | undefined;
    expect(request?.sessionFilters).toContainEqual({ kind: 'cwd', values: ['/work'] });
  });

  it('renders an empty search', async () => {
    const tool = makeTool({});
    const result = await execute(tool, 'session_search', { query: 'zzz' });
    expect(result.isError).toBe(false);
    expect(result.output).toContain('No matching sessions');
  });

  it('rejects invalid arguments', async () => {
    const tool = makeTool({});
    const result = await execute(tool, 'session_search', {});
    expect(result.isError).toBe(true);
    expect(result.output).toContain('Invalid arguments');
  });
});

describe('SessionQueryTool event_search', () => {
  it('searches the current session by default', async () => {
    const searchEvents = vi.fn(async () => ({
      sessionId: 'sess-current',
      items: [
        {
          sessionId: 'sess-current',
          seq: 4,
          type: 'context.append_message',
          time: 500,
          snippet: 'found it',
        },
      ],
      nextCursor: undefined,
    }));
    const tool = makeTool({ searchEvents });
    const result = await execute(tool, 'event_search', { query: 'found' });

    expect(result.isError).toBe(false);
    expect(result.output).toContain('Event search results for session sess-current');
    expect(result.output).toContain('seq 4');
    const calls = searchEvents.mock.calls as unknown as [unknown?][];
    const request = calls[0]?.[0] as { sessionId: string } | undefined;
    expect(request?.sessionId).toBe('sess-current');
  });

  it('targets an explicit session id', async () => {
    const searchEvents = vi.fn(async () => ({
      sessionId: 'sess-x',
      items: [],
      nextCursor: undefined,
    }));
    const tool = makeTool({ searchEvents });
    await execute(tool, 'event_search', { query: 'q', session_id: 'sess-x' });
    const calls = searchEvents.mock.calls as unknown as [unknown?][];
    const request = calls[0]?.[0] as { sessionId: string } | undefined;
    expect(request?.sessionId).toBe('sess-x');
  });
});

describe('SessionQueryTool session_trace', () => {
  it('traces lineage of the current session', async () => {
    const trace: SessionLineageTrace = {
      target: hit('sess-current'),
      ancestors: [hit('sess-parent')],
      descendants: [{ session: hit('sess-child'), descendants: [] }],
      complete: true,
      root: hit('sess-root'),
    };
    const traceLineage = vi.fn(async () => trace);
    const tool = makeTool({ traceLineage });
    const result = await execute(tool, 'session_trace', {});

    expect(result.isError).toBe(false);
    expect(result.output).toContain('Session sess-current:');
    expect(result.output).toContain('sess-parent → sess-root');
    expect(result.output).toContain('sess-child');
    expect(traceLineage).toHaveBeenCalledWith('sess-current');
  });
});

describe('presentation', () => {
  it('renders session search with cap notice', () => {
    const output = formatSessionSearch([hit('s')], true);
    expect(output).toContain('Result cap reached');
  });

  it('renders event search', () => {
    const item: SessionEventSearchHit = {
      sessionId: 's',
      seq: 1,
      type: 't',
      time: 1,
      snippet: 'snip',
    };
    const output = formatEventSearch('s', [item], false);
    expect(output).toContain('seq 1 | t');
  });

  it('renders an incomplete trace with the unresolved parent', () => {
    const trace: SessionLineageTrace = {
      target: hit('s'),
      ancestors: [],
      descendants: [],
      complete: false,
      unresolvedParentId: 'gone',
    };
    const output = formatSessionTrace(trace);
    expect(output).toContain('gone');
    expect(output).toContain('incomplete');
  });
});
