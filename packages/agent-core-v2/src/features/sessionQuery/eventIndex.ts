import type { IBootstrapService } from '#/app/bootstrap/bootstrap';
import type { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import type { IFileSystemStorageService } from '#/persistence/interface/storage';
import { AGENT_WIRE_RECORD_KEY, isWireRecord, isWireMetadataRecord } from '#/wire/record';

import type { SessionEventSearchDocument } from './events';
import { wireRecordText } from './eventText';

interface CachedSession {
  readonly revision: number | undefined;
  readonly events: SessionEventSearchDocument[];
}

export class SessionEventIndex {
  private readonly cache = new Map<string, CachedSession>();

  constructor(
    private readonly bootstrap: IBootstrapService,
    private readonly log: IAppendLogStore,
    private readonly storage: IFileSystemStorageService,
  ) {}

  wireScopeOf(workspaceId: string, sessionId: string): string {
    return `${this.bootstrap.scope('sessions')}/${workspaceId}/${sessionId}/agents/main`;
  }

  async eventsOf(workspaceId: string, sessionId: string): Promise<SessionEventSearchDocument[]> {
    const scope = this.wireScopeOf(workspaceId, sessionId);
    const revision = await this.storage.size(scope, AGENT_WIRE_RECORD_KEY);
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

  invalidate(sessionId: string): void {
    this.cache.delete(sessionId);
  }
}
