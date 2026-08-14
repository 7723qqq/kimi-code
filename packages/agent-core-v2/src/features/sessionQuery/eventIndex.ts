/**
 * `sessionQuery` domain — per-session event index over the wire journal.
 *
 * Lazily reads a session's main-agent wire records through
 * `IAppendLogStore` and caches them as detached event documents. The cache
 * is keyed to the journal's `revision()`: any append/rewrite bumps it, so a
 * reader detects "the log changed since I last read" without re-reading the
 * whole file and rebuilds on demand.
 *
 * Ported from deepseek-harness `session-query` corpus resolution semantics
 * (MIT), adapted to the wire journal as the event source. Only the main
 * agent's wire is indexed; subagent journals are out of scope for stage B.
 */

import { AGENT_WIRE_RECORD_KEY, isWireRecord, isWireMetadataRecord } from '#/wire/record';
import type { IBootstrapService } from '#/app/bootstrap/bootstrap';
import type { IAppendLogStore } from '#/persistence/interface/appendLogStore';

import { wireRecordText } from './eventText';
import type { SessionEventSearchDocument } from './events';

/** One cached event source: the journal revision the cache was folded from. */
interface CachedSession {
  readonly revision: number;
  readonly events: SessionEventSearchDocument[];
}

export class SessionEventIndex {
  private readonly cache = new Map<string, CachedSession>();

  constructor(
    private readonly bootstrap: IBootstrapService,
    private readonly log: IAppendLogStore,
  ) {}

  /**
   * The wire journal scope of a session's main agent.
   * @param workspaceId - owning workspace id.
   * @param sessionId - owning session id.
   * @returns the append-log scope for `read`/`revision`.
   */
  wireScopeOf(workspaceId: string, sessionId: string): string {
    return `${this.bootstrap.scope('sessions')}/${workspaceId}/${sessionId}/agents/main`;
  }

  /**
   * Detached event documents for one session, rebuilt when the journal
   * changed since the last read.
   * @param workspaceId - owning workspace id.
   * @param sessionId - owning session id.
   * @returns event documents in journal order.
   */
  async eventsOf(workspaceId: string, sessionId: string): Promise<SessionEventSearchDocument[]> {
    const scope = this.wireScopeOf(workspaceId, sessionId);
    const revision = this.log.revision(scope, AGENT_WIRE_RECORD_KEY);
    const cached = this.cache.get(sessionId);
    if (cached !== undefined && cached.revision === revision) return cached.events;

    const events: SessionEventSearchDocument[] = [];
    let seq = 0;
    for await (const raw of this.log.read(scope, AGENT_WIRE_RECORD_KEY)) {
      if (!isWireRecord(raw) || isWireMetadataRecord(raw)) continue;
      const text = wireRecordText(raw);
      events.push({
        sessionId,
        seq,
        type: raw.type,
        time: typeof raw['time'] === 'number' ? raw['time'] : 0,
        text,
      });
      seq += 1;
    }
    this.cache.set(sessionId, { revision, events });
    return events;
  }

  /** Drop a session's cached events (e.g. after the session is deleted). */
  invalidate(sessionId: string): void {
    this.cache.delete(sessionId);
  }
}
