/**
 * `sessionQuery` domain — `SessionQueryService`: logical-corpus resolution
 * over the session index and the live workspace session registry.
 *
 * Lists the complete logical corpus with live precedence (live ids stamp
 * `live: true`, index-known ids stamp `persisted: true`), applies validated
 * filters, and traces lineage through `custom.parent_session_id` fork
 * provenance. Bound at App scope so cross-session reads need no session
 * context.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { Service } from '#/_base/di/service';
import { Error2 } from '#/errors';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { ISessionIndex, PARENT_SESSION_ID_KEY, type SessionSummary } from '#/app/sessionIndex/sessionIndex';
import { IWorkspaceLifecycleService } from '#/app/workspaceLifecycle/workspaceLifecycle';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';

import { SessionQueryErrors } from './errors';
import { filterSessionResults, materializeSessionResultFilters } from './filters';
import { traceLineage } from './lineage';
import { SessionEventIndex } from './eventIndex';
import { filterSessionEvents, searchEventDocuments } from './search';
import { SessionSearchCursor } from './cursor';
import type {
  SessionEventSearchDocument,
  SessionEventResultFilter,
  SessionEventSearchPage,
  SessionEventSearchRequest,
  SessionLineageTrace,
  SessionRecord,
  SessionResultFilter,
  SessionSearchHit,
  SessionSearchPage,
  SessionSearchRequest,
} from './types';

export interface ISessionQueryService {
  readonly _serviceBrand: undefined;

  /**
   * List the complete logical corpus, newest first.
   * @param filters - ANDed logical-session predicates applied after listing.
   * @returns detached session records.
   */
  listSessions(filters?: readonly SessionResultFilter[]): Promise<SessionRecord[]>;

  /**
   * Resolve one session's record.
   * @param sessionId - session to resolve.
   * @returns the detached record.
   */
  getSession(sessionId: string): Promise<SessionRecord>;

  /**
   * Trace one session's known ancestry and complete descendant trees.
   * @param sessionId - session to trace.
   * @returns the lineage trace.
   */
  traceLineage(sessionId: string): Promise<SessionLineageTrace>;

  /**
   * Filter one session's events by metadata/literal-text predicates.
   * @param sessionId - session whose main-agent journal is scanned.
   * @param filters - ANDed event predicates.
   * @returns matching events in journal order.
   */
  filterEvents(
    sessionId: string,
    filters?: readonly SessionEventResultFilter[],
  ): Promise<readonly SessionEventSearchDocument[]>;

  /**
   * Full-text search within one session's events.
   * @param request - session, query, optional metadata filters, page size and cursor.
   * @returns the ranked page with an opaque continuation cursor.
   */
  searchEvents(
    request: SessionEventSearchRequest,
  ): Promise<SessionEventSearchPage>;

  /**
   * Cross-session full-text search. The corpus is narrowed by
   * `sessionFilters`; with none given, only live sessions are searched
   * (bounded work — persisted archives are covered by the session-scoped
   * `searchEvents`).
   * @param request - query, optional session/event filters, page size and cursor.
   * @returns one hit per matching session, ranked by the strongest event.
   */
  searchSessions(request: SessionSearchRequest): Promise<SessionSearchPage<SessionSearchHit>>;
}

export const ISessionQueryService: ServiceIdentifier<ISessionQueryService> =
  createDecorator<ISessionQueryService>('sessionQueryService');

export class SessionQueryService extends Service implements ISessionQueryService {
  declare readonly _serviceBrand: undefined;

  private readonly events: SessionEventIndex;

  constructor(
    @ISessionIndex private readonly index: ISessionIndex,
    @IWorkspaceLifecycleService private readonly lifecycle: IWorkspaceLifecycleService,
    @IBootstrapService bootstrap: IBootstrapService,
    @IAppendLogStore log: IAppendLogStore,
  ) {
    super();
    this.events = new SessionEventIndex(bootstrap, log);
  }

  async listSessions(filters: readonly SessionResultFilter[] = []): Promise<SessionRecord[]> {
    const records = await this.listCorpus();
    return filterSessionResults(records, materializeSessionResultFilters(filters));
  }

  async getSession(sessionId: string): Promise<SessionRecord> {
    const records = await this.listCorpus();
    const record = records.find((candidate) => candidate.id === sessionId);
    if (record === undefined) {
      throw new Error2(
        SessionQueryErrors.codes.SESSION_QUERY_SESSION_NOT_FOUND,
        `session "${sessionId}" not found`,
      );
    }
    return record;
  }

  async traceLineage(sessionId: string): Promise<SessionLineageTrace> {
    const records = await this.listCorpus();
    if (!records.some((record) => record.id === sessionId)) {
      throw new Error2(
        SessionQueryErrors.codes.SESSION_QUERY_SESSION_NOT_FOUND,
        `session "${sessionId}" not found`,
      );
    }
    return traceLineage(records, sessionId);
  }

  async filterEvents(
    sessionId: string,
    filters: readonly SessionEventResultFilter[] = [],
  ): Promise<readonly SessionEventSearchDocument[]> {
    const documents = await this.eventDocumentsOf(sessionId);
    return filterSessionEvents(documents, filters);
  }

  async searchEvents(
    request: SessionEventSearchRequest,
  ): Promise<SessionEventSearchPage> {
    const documents = await this.eventDocumentsOf(request.sessionId);
    const filtered = filterSessionEvents(documents, request.filters ?? []);
    const { items, nextCursor } = searchEventDocuments(
      filtered,
      request.query,
      request.limit,
      request.cursor,
    );
    return { sessionId: request.sessionId, items, nextCursor };
  }

  async searchSessions(
    request: SessionSearchRequest,
  ): Promise<SessionSearchPage<SessionSearchHit>> {
    const records = await this.listSessions(request.sessionFilters);
    const candidates =
      request.sessionFilters === undefined || request.sessionFilters.length === 0
        ? records.filter((record) => record.live)
        : records;
    const hits: SessionSearchHit[] = [];
    for (const record of candidates) {
      const events = await this.eventDocumentsOf(record.id);
      const filtered = filterSessionEvents(events, request.eventFilters ?? []);
      const { items } = searchEventDocuments(filtered, request.query, 1);
      const bestMatch = items[0];
      if (bestMatch !== undefined) {
        hits.push({ ...record, bestMatch });
      }
    }
    hits.sort((a, b) => b.bestMatch.time - a.bestMatch.time);
    const limit = Math.min(Math.max(1, Math.trunc(request.limit ?? 10)), 100);
    const offset = request.cursor?.offset ?? 0;
    const page = hits.slice(offset, offset + limit);
    const nextCursor =
      offset + limit < hits.length ? SessionSearchCursor(offset + limit) : undefined;
    return { items: page, nextCursor };
  }

  private async eventDocumentsOf(sessionId: string): Promise<SessionEventSearchDocument[]> {
    const record = await this.getSession(sessionId);
    return this.events.eventsOf(record.workspaceId, sessionId);
  }

  private async listCorpus(): Promise<SessionRecord[]> {
    const status = this.index.status();
    if (status.state !== 'ready') {
      await this.index.prepare({ deadlineMs: 10_000 });
    }
    const summaries = await this.listAllSummaries();
    const liveIds = new Set<string>();
    for (const handle of this.lifecycle.handlers.list()) {
      for (const sessionId of this.lifecycle.sessions.list(handle.id)) {
        liveIds.add(sessionId);
      }
    }
    const byId = new Map<string, SessionSummary>();
    for (const summary of summaries) byId.set(summary.id, summary);
    return [...byId.values()]
      .map((summary) => toSessionRecord(summary, liveIds.has(summary.id)))
      .toSorted(compareRecords);
  }

  private async listAllSummaries(): Promise<SessionSummary[]> {
    const out: SessionSummary[] = [];
    let before: string | undefined;
    for (;;) {
      const page = await this.index.listRecent({ before, includeArchived: true });
      out.push(...page.items);
      if (page.nextCursor === undefined) return out;
      before = page.nextCursor;
    }
  }
}

function toSessionRecord(summary: SessionSummary, live: boolean): SessionRecord {
  return {
    id: summary.id,
    workspaceId: summary.workspaceId,
    cwd: summary.cwd,
    createdAt: summary.createdAt,
    parentSessionId: parentSessionIdOf(summary),
    live,
    persisted: true,
  };
}

function parentSessionIdOf(summary: SessionSummary): string | undefined {
  const raw = summary.custom?.[PARENT_SESSION_ID_KEY];
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

function compareRecords(a: SessionRecord, b: SessionRecord): number {
  return b.createdAt - a.createdAt || a.id.localeCompare(b.id);
}
