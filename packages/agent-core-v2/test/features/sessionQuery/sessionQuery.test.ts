import { describe, expect, it } from 'vitest';

import type { IBootstrapService } from '#/app/bootstrap/bootstrap';
import {
  PARENT_SESSION_ID_KEY,
  type ISessionIndex,
  type SessionSummary,
} from '#/app/sessionIndex/sessionIndex';
import type { IWorkspaceLifecycleService } from '#/app/workspaceLifecycle/workspaceLifecycle';
import {
  filterSessionResults,
  materializeSessionResultFilters,
} from '#/features/sessionQuery/filters';
import { traceLineage } from '#/features/sessionQuery/lineage';
import { SessionQueryService } from '#/features/sessionQuery/sessionQueryService';
import type { SessionLineageNode, SessionRecord } from '#/features/sessionQuery/types';
import type { IAppendLogStore } from '#/persistence/interface/appendLogStore';

function record(id: string, overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id,
    workspaceId: 'ws',
    createdAt: 1000,
    live: false,
    persisted: true,
    ...overrides,
  };
}

function summary(id: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id,
    workspaceId: 'ws',
    createdAt: 1000,
    updatedAt: 1000,
    archived: false,
    ...overrides,
  } as SessionSummary;
}

describe('filterSessionResults', () => {
  const records: SessionRecord[] = [
    record('a', { cwd: '/work/a', createdAt: 100, parentSessionId: 'root', live: true }),
    record('b', { cwd: '/work/b', createdAt: 200, parentSessionId: 'a', live: false }),
    record('c', { cwd: '/work/a', createdAt: 300, persisted: false }),
  ];

  it('ANDs clauses and ORs values within a clause', () => {
    const result = filterSessionResults(records, [
      { kind: 'cwd', values: ['/work/a', '/work/b'] },
      { kind: 'availability', values: ['live'] },
    ]);
    expect(result.map((r) => r.id)).toEqual(['a']);
  });

  it('filters by id', () => {
    expect(filterSessionResults(records, [{ kind: 'id', values: ['b'] }]).map((r) => r.id)).toEqual(
      ['b'],
    );
  });

  it('filters by created-at range inclusively', () => {
    const result = filterSessionResults(records, [{ kind: 'created-at', from: 150, to: 300 }]);
    expect(result.map((r) => r.id)).toEqual(['b', 'c']);
  });

  it('filters by parent including null (root sessions)', () => {
    const roots = filterSessionResults(records, [{ kind: 'parent', values: [null] }]);
    expect(roots.map((r) => r.id)).toEqual(['c']);
    const children = filterSessionResults(records, [{ kind: 'parent', values: ['a'] }]);
    expect(children.map((r) => r.id)).toEqual(['b']);
  });

  it('preserves input order and accepts an empty filter list', () => {
    expect(filterSessionResults(records)).toHaveLength(3);
  });
});

describe('materializeSessionResultFilters', () => {
  it('rejects unknown filter kinds', () => {
    expect(() =>
      materializeSessionResultFilters([{ kind: 'bogus', values: [] } as never]),
    ).toThrowError(/unknown filter kind/);
  });

  it('rejects unknown availability values', () => {
    expect(() =>
      materializeSessionResultFilters([{ kind: 'availability', values: ['cloud'] } as never]),
    ).toThrowError(/unknown value/);
  });

  it('rejects an inverted range', () => {
    expect(() =>
      materializeSessionResultFilters([{ kind: 'created-at', from: 5, to: 1 }]),
    ).toThrowError(/from must be less than or equal to to/);
  });

  it('detaches validated clauses', () => {
    const values = ['a'];
    const [clause] = materializeSessionResultFilters([{ kind: 'id', values }]);
    values.push('mutated');
    expect(clause).toEqual({ kind: 'id', values: ['a'] });
  });
});

describe('traceLineage', () => {
  const corpus: SessionRecord[] = [
    record('root', { createdAt: 1 }),
    record('mid', { createdAt: 2, parentSessionId: 'root' }),
    record('leaf', { createdAt: 3, parentSessionId: 'mid' }),
    record('sibling', { createdAt: 4, parentSessionId: 'root' }),
  ];

  it('walks the ancestor chain and descendant trees', () => {
    const trace = traceLineage(corpus, 'leaf');
    expect(trace.ancestors.map((r) => r.id)).toEqual(['mid', 'root']);
    expect(trace.complete).toBe(true);
    if (trace.complete) expect(trace.root.id).toBe('root');
    expect(trace.descendants).toEqual([]);
  });

  it('builds complete descendant trees from the direct children', () => {
    const trace = traceLineage(corpus, 'root');
    expect(trace.ancestors).toEqual([]);
    const ids = (nodes: readonly SessionLineageNode[]): string[] =>
      nodes.flatMap((node) => [node.session.id, ...ids(node.descendants)]);
    expect(ids(trace.descendants).toSorted()).toEqual(['leaf', 'mid', 'sibling']);
  });

  it('reports an unresolved parent chain as incomplete', () => {
    const corpusWithGap: SessionRecord[] = [
      record('mid', { createdAt: 2, parentSessionId: 'gone' }),
      record('leaf', { createdAt: 3, parentSessionId: 'mid' }),
    ];
    const trace = traceLineage(corpusWithGap, 'leaf');
    expect(trace.complete).toBe(false);
    if (!trace.complete) expect(trace.unresolvedParentId).toBe('gone');
  });

  it('treats a target with no parents as its own root', () => {
    const trace = traceLineage(corpus, 'root');
    expect(trace.complete).toBe(true);
    if (trace.complete) expect(trace.root.id).toBe('root');
  });

  it('throws for a target absent from the corpus', () => {
    expect(() => traceLineage(corpus, 'ghost')).toThrowError(/not found/);
  });
});

describe('SessionQueryService', () => {
  function makeService(sessions: SessionSummary[], liveIds: string[]): SessionQueryService {
    const indexStub = {
      _serviceBrand: undefined,
      status: () => ({ state: 'ready' as const }),
      prepare: () => Promise.resolve({ state: 'ready' as const }),
      listRecent: ({ before }: { before?: string }) => {
        const sorted = [...sessions].toSorted((a, b) => b.createdAt - a.createdAt);
        const start = before === undefined ? 0 : sorted.findIndex((s) => s.id === before) + 1;
        const items = sorted.slice(start, start + 2);
        const hasMore = start + 2 < sorted.length;
        return Promise.resolve({ items, nextCursor: hasMore ? items.at(-1)?.id : undefined });
      },
    } as unknown as ISessionIndex;
    const lifecycleStub = {
      _serviceBrand: undefined,
      handlers: { list: () => [{ id: 'ws' }] },
      sessions: { list: () => liveIds },
    } as unknown as IWorkspaceLifecycleService;
    const bootstrapStub = { scope: () => 'sessions' } as unknown as IBootstrapService;
    const logStub = {
      _serviceBrand: undefined,
      revision: () => 0,
      read: () => (async function* () {})(),
    } as unknown as IAppendLogStore;
    return new SessionQueryService(indexStub, lifecycleStub, bootstrapStub, logStub, {
      size: () => 0,
    } as never);
  }

  it('lists the corpus newest-first with live/persisted availability', async () => {
    const service = makeService(
      [
        summary('a', { createdAt: 100 }),
        summary('b', { createdAt: 200 }),
        summary('c', { createdAt: 300 }),
      ],
      ['b'],
    );
    const records = await service.listSessions();
    expect(records.map((r) => r.id)).toEqual(['c', 'b', 'a']);
    expect(records.find((r) => r.id === 'b')?.live).toBe(true);
    expect(records.find((r) => r.id === 'a')?.live).toBe(false);
    expect(records.every((r) => r.persisted)).toBe(true);
  });

  it('applies filters through the service', async () => {
    const service = makeService(
      [summary('a', { createdAt: 100, cwd: '/x' }), summary('b', { createdAt: 200, cwd: '/y' })],
      [],
    );
    const records = await service.listSessions([{ kind: 'cwd', values: ['/x'] }]);
    expect(records.map((r) => r.id)).toEqual(['a']);
  });

  it('derives parent session ids from custom.parent_session_id', async () => {
    const service = makeService(
      [summary('child', { custom: { [PARENT_SESSION_ID_KEY]: 'parent' } }), summary('parent', {})],
      [],
    );
    const record = await service.getSession('child');
    expect(record.parentSessionId).toBe('parent');
  });

  it('traces lineage through the service', async () => {
    const service = makeService(
      [
        summary('root', { createdAt: 1 }),
        summary('leaf', { createdAt: 2, custom: { [PARENT_SESSION_ID_KEY]: 'root' } }),
      ],
      [],
    );
    const trace = await service.traceLineage('leaf');
    expect(trace.ancestors.map((r) => r.id)).toEqual(['root']);
    expect(trace.complete).toBe(true);
  });

  it('rejects an unknown session id', async () => {
    const service = makeService([], []);
    await expect(service.getSession('ghost')).rejects.toThrowError(/not found/);
  });
});
