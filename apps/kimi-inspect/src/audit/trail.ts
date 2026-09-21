/**
 * Audit trail for the chat view's transcript channel.
 *
 * A pure observer: the chat pipeline (WS reset / op batches, user actions)
 * calls the `record*` methods AFTER applying each step to the real
 * `ChatStore`, passing the resulting immutable `ChatState` reference.
 * Replaying the trail is therefore free — every entry already holds the
 * exact state the store had at that point, ready for the timeline slider
 * and the structural diff.
 */

import type { AgentTranscriptSnapshot, TranscriptOpBatch } from '@moonshot-ai/transcript';

import type { ChatState } from '../transcript/store';

export const AUDIT_TRAIL_MAX_ENTRIES = 5000;

interface AuditEntryBase {
  /** Position in the trail (stable even when old entries are dropped). */
  readonly index: number;
  /** Local record time (ISO). */
  readonly at: string;
  /** Store state right after this entry was applied (immutable reference). */
  readonly state: ChatState;
  /** One-line summary for the timeline list. */
  readonly summary: string;
}

export interface OpsAuditEntry extends AuditEntryBase {
  readonly kind: 'ops';
  /** The agent whose batch this is. */
  readonly agentId: string;
  /** How the batch reached the store. */
  readonly mode: 'reset' | 'live' | 'replay';
  readonly opCount: number;
  /** The ops as applied, in order. */
  readonly ops: readonly unknown[];
}

export interface WsAuditEntry extends AuditEntryBase {
  readonly kind: 'ws';
  /** The frame as applied to the store (a reset snapshot or an op batch). */
  readonly frame:
    | { readonly type: 'reset'; readonly agentId: string; readonly snapshot: AgentTranscriptSnapshot }
    | { readonly type: 'ops'; readonly batch: TranscriptOpBatch };
}

export interface EventAuditEntry extends AuditEntryBase {
  readonly kind: 'event';
  readonly event:
    | 'ack'
    | 'ack-error'
    | 'reconnect'
    | 'gap-refresh'
    | 'protocol-error'
    | 'invalid-frame'
    | 'prompt'
    | 'cancel';
  readonly detail?: string | undefined;
}

export type AuditEntry = OpsAuditEntry | WsAuditEntry | EventAuditEntry;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** Entry payload accepted by `push` (index/at are filled in there). */
type AuditEntryInput = DistributiveOmit<AuditEntry, 'index' | 'at'>;

export class AuditTrail {
  private entryList: AuditEntry[] = [];
  private nextIndex = 0;
  private readonly listeners = new Set<() => void>();

  /** `useSyncExternalStore`-compatible subscribe. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getEntries(): readonly AuditEntry[] {
    return this.entryList;
  }

  /** One applied op batch (live traffic or a reconnect replay). */
  recordOps(
    agentId: string,
    mode: OpsAuditEntry['mode'],
    batch: TranscriptOpBatch,
    state: ChatState,
  ): void {
    this.push({
      kind: 'ops',
      agentId,
      mode,
      opCount: batch.ops.length,
      ops: batch.ops,
      state,
      summary: `${mode} ops ×${batch.ops.length} → ${agentId}`,
    });
  }

  /** One applied `transcript.reset` baseline. */
  recordReset(agentId: string, snapshot: AgentTranscriptSnapshot, state: ChatState): void {
    this.push({
      kind: 'ops',
      agentId,
      mode: 'reset',
      opCount: 1,
      ops: [{ op: 'reset', agentId }],
      state,
      summary: `reset → ${agentId} (${snapshot.items.length} items)`,
    });
  }

  recordWs(frame: WsAuditEntry['frame'], state: ChatState): void {
    this.push({
      kind: 'ws',
      frame,
      state,
      summary: summarizeFrame(frame),
    });
  }

  recordEvent(event: EventAuditEntry['event'], detail: string | undefined, state: ChatState): void {
    const label =
      event === 'ack'
        ? 'subscribe ack'
        : event === 'ack-error'
          ? 'subscribe ack error'
          : event === 'reconnect'
            ? 'socket dropped → reconnecting'
            : event === 'gap-refresh'
              ? 'op seq gap → full resubscribe'
              : event === 'protocol-error'
                ? 'protocol error frame'
                : event === 'invalid-frame'
                  ? 'invalid frame (server bug)'
                  : event === 'prompt'
                    ? 'prompt sent'
                    : event === 'cancel'
                      ? 'cancel sent'
                      : 'older-page load failed';
    this.push({
      kind: 'event',
      event,
      detail,
      state,
      summary: detail !== undefined && detail !== '' ? `${label}: ${detail}` : label,
    });
  }

  private push(entry: AuditEntryInput): void {
    const full = { ...entry, index: this.nextIndex, at: new Date().toISOString() } as AuditEntry;
    this.nextIndex += 1;
    const kept =
      this.entryList.length >= AUDIT_TRAIL_MAX_ENTRIES
        ? this.entryList.slice(this.entryList.length - AUDIT_TRAIL_MAX_ENTRIES + 1)
        : this.entryList;
    this.entryList = [...kept, full];
    for (const listener of this.listeners) listener();
  }
}

function summarizeFrame(frame: WsAuditEntry['frame']): string {
  if (frame.type === 'reset') {
    return `reset → ${frame.agentId} (${frame.snapshot.items.length} items)`;
  }
  const { batch } = frame;
  const counts = new Map<string, number>();
  for (const op of batch.ops) {
    const kind = (op as { op?: unknown }).op;
    const key = typeof kind === 'string' ? kind : 'unknown';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const parts = [...counts].map(([op, n]) => `${op}×${n}`);
  return `ops → ${batch.agentId}: ${parts.join(' ')}`;
}
