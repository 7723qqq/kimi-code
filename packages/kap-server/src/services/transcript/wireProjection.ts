import { join } from 'node:path';

import {
  AGENT_WIRE_RECORD_KEY,
  createContextTranscriptReducer,
  flattenChain,
  IAgentBlobService,
  IAgentContextMemoryService,
  IAgentScopeContext,
  parseTree,
  type ContextMessage,
  type ContextTranscript,
  type ContextTranscriptReducer,
  type IAgentScopeHandle,
  type WireRecord,
} from '@moonshot-ai/agent-core-v2';
import {
  createWireTranscriptProjector,
  type AgentTranscriptSnapshot,
  type WireTranscriptProjector,
} from '@moonshot-ai/transcript';

import type { Message } from '../../protocol/message';
import { toWireQuestion } from '../../protocol/question-wire';
import { toProtocolMessage } from '../messages/messageProjection';
import { WireRecordCache, type ContextRecord } from './wireCache';

const SESSIONS_ROOT = 'sessions';
const AGENTS_DIR = 'agents';

interface MessageSignature {
  readonly source: ContextMessage;
  readonly contentLength: number;
  readonly toolCallCount: number;
  readonly usage: ContextMessage['usage'];
  readonly llmTiming: ContextMessage['llmTiming'];
  readonly time: number | undefined;
}

interface ProtocolMessageEntry extends MessageSignature {
  readonly createdAtMs: number;
  readonly message: Message;
}

interface MessageProjection {
  readonly sessionId: string;
  readonly sessionCreatedAtMs: number;
  readonly entries: readonly ProtocolMessageEntry[];
}

interface ActiveProjection {
  readonly projector: WireTranscriptProjector;
}

interface WireProjectionState {
  readonly wirePath: string;
  sessionId: string | undefined;
  agentId: string | undefined;
  workspaceId: string | undefined;
  chain: Promise<void>;
  rawGeneration: number;
  rawRevision: number;
  rawCount: number;
  rawReducer: ContextTranscriptReducer;
  activeRecords: WireRecord[];
  pairedLegacyUndoLines: Set<number>;
  active: ActiveProjection | undefined;
  messages: MessageProjection | undefined;
}

export interface ColdProjectionQuery {
  readonly sessionId: string;
  readonly agentId: string;
  readonly workspaceId: string;
}

export class WireProjectionService {
  private readonly states = new Map<string, WireProjectionState>();
  private readonly cache: WireRecordCache;

  constructor(private readonly homeDir: string) {
    this.cache = new WireRecordCache({
      onEvict: (wirePath) => {
        this.states.delete(wirePath);
      },
    });
  }

  get size(): number {
    return this.states.size;
  }

  async readMessages(
    agent: IAgentScopeHandle,
    sessionId: string,
    sessionCreatedAtMs: number,
  ): Promise<Message[]> {
    const scope = agent.accessor.get(IAgentScopeContext).scope();
    const state = this.state(scope);
    state.sessionId = sessionId;
    return this.serialize(state, async () => {
      try {
        await this.sync(state);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        this.reset(state);
      }
      const transcript = state.rawReducer.result();
      const contextMessages = agent.accessor.get(IAgentContextMemoryService).get();
      const merged = mergeLiveTail(transcript, contextMessages);
      const previous =
        state.messages?.sessionId === sessionId &&
        state.messages.sessionCreatedAtMs === sessionCreatedAtMs
          ? state.messages.entries
          : [];
      let common = 0;
      while (
        common < previous.length &&
        common < merged.messages.length &&
        sameMessage(previous[common]!, merged.messages[common]!, merged.times[common])
      ) {
        common += 1;
      }
      const entries = previous.slice(0, common);
      let previousMs = entries.at(-1)?.createdAtMs ?? Number.NEGATIVE_INFINITY;
      const blobs = agent.accessor.get(IAgentBlobService);
      for (let index = common; index < merged.messages.length; index++) {
        const source = merged.messages[index]!;
        const content = await blobs.loadParts(source.content);
        const rehydrated =
          content === source.content ? source : { ...source, content: [...content] };
        const baseMs = merged.times[index] ?? sessionCreatedAtMs + index;
        const createdAtMs = Math.max(previousMs + 1, baseMs);
        previousMs = createdAtMs;
        entries.push({
          ...signatureOf(source, merged.times[index]),
          createdAtMs,
          message: toProtocolMessage(sessionId, index, rehydrated, sessionCreatedAtMs, createdAtMs),
        });
      }
      state.messages = { sessionId, sessionCreatedAtMs, entries };
      return entries.map((entry) => entry.message);
    });
  }

  async readColdSnapshot(query: ColdProjectionQuery): Promise<AgentTranscriptSnapshot> {
    const scope = wireScope(query);
    const state = this.state(scope);
    state.sessionId = query.sessionId;
    state.agentId = query.agentId;
    state.workspaceId = query.workspaceId;
    return this.serialize(state, async () => {
      try {
        await this.sync(state);
        return this.syncActive(state).projector.snapshot();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') this.reset(state);
        throw error;
      }
    });
  }

  dropSession(sessionId: string): void {
    for (const [wirePath, state] of this.states) {
      if (state.sessionId === sessionId) this.cache.delete(wirePath);
    }
  }

  private state(scope: string): WireProjectionState {
    const wirePath = join(this.homeDir, scope, AGENT_WIRE_RECORD_KEY);
    const existing = this.states.get(wirePath);
    if (existing !== undefined) return existing;
    const state: WireProjectionState = {
      wirePath,
      sessionId: undefined,
      agentId: undefined,
      workspaceId: undefined,
      chain: Promise.resolve(),
      rawGeneration: -1,
      rawRevision: -1,
      rawCount: 0,
      rawReducer: createContextTranscriptReducer(),
      activeRecords: [],
      pairedLegacyUndoLines: new Set(),
      active: undefined,
      messages: undefined,
    };
    this.states.set(wirePath, state);
    return state;
  }

  private serialize<T>(state: WireProjectionState, run: () => Promise<T>): Promise<T> {
    const result = state.chain.then(run);
    state.chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async sync(state: WireProjectionState): Promise<void> {
    const snapshot = await this.cache.readSnapshot(state.wirePath);
    if (snapshot.generation !== state.rawGeneration && state.rawGeneration !== -1) {
      this.reset(state);
    }
    if (
      snapshot.revision !== state.rawRevision &&
      snapshot.records.length === state.rawCount &&
      state.rawRevision !== -1
    ) {
      this.reset(state);
    }
    if (snapshot.records.length < state.rawCount) this.reset(state);
    const appended = snapshot.records.slice(state.rawCount);
    if (state.rawGeneration === -1) {
      state.rawReducer = createContextTranscriptReducer();
      state.activeRecords = flattenChain(snapshot.records);
      state.pairedLegacyUndoLines = pairedUndoLines(snapshot.records);
    } else if (appended.some((record) => record.type === 'agent.switched')) {
      state.activeRecords = flattenChain(snapshot.records);
      state.pairedLegacyUndoLines = pairedUndoLines(snapshot.records);
      state.active = undefined;
    } else {
      for (let index = state.rawCount; index < snapshot.records.length; index++) {
        const record = snapshot.records[index]!;
        if (record.type === 'context.undone') continue;
        if (record.type === 'context.undo' && state.pairedLegacyUndoLines.has(index + 1)) continue;
        state.activeRecords.push(record);
      }
    }
    for (const record of appended) state.rawReducer.add(record);
    state.rawGeneration = snapshot.generation;
    state.rawRevision = snapshot.revision;
    state.rawCount = snapshot.records.length;
  }

  private reset(state: WireProjectionState): void {
    state.rawGeneration = -1;
    state.rawRevision = -1;
    state.rawCount = 0;
    state.rawReducer = createContextTranscriptReducer();
    state.activeRecords = [];
    state.pairedLegacyUndoLines = new Set();
    state.active = undefined;
    state.messages = undefined;
  }

  private syncActive(state: WireProjectionState): ActiveProjection {
    const active = state.active ?? createActiveProjection(state);
    active.projector.sync(state.activeRecords);
    state.active = active;
    return active;
  }
}

function createActiveProjection(state: WireProjectionState): ActiveProjection {
  const agentId = state.agentId ?? '';
  const sessionId = state.sessionId ?? '';
  const workspaceId = state.workspaceId ?? '';
  return {
    projector: createWireTranscriptProjector({
      agentId,
      createContextReducer: createContextTranscriptReducer,
      mapFactRecord: (record) => projectQuestionInteractionRecord(record, sessionId),
      resolvePlanRevisionKey: (key) =>
        join(SESSIONS_ROOT, workspaceId, sessionId, AGENTS_DIR, agentId, key),
    }),
  };
}

function pairedUndoLines(records: readonly WireRecord[]): Set<number> {
  const entries = records.map((record, index) => ({ record, line: index + 1 }));
  return new Set(parseTree(entries, entries.length).pairedLegacyUndoLines);
}

function signatureOf(message: ContextMessage, time: number | undefined): MessageSignature {
  return {
    source: message,
    contentLength: message.content.length,
    toolCallCount: message.toolCalls.length,
    usage: message.usage,
    llmTiming: message.llmTiming,
    time,
  };
}

function sameMessage(
  signature: MessageSignature,
  message: ContextMessage,
  time: number | undefined,
): boolean {
  return (
    signature.source === message &&
    signature.contentLength === message.content.length &&
    signature.toolCallCount === message.toolCalls.length &&
    signature.usage === message.usage &&
    signature.llmTiming === message.llmTiming &&
    signature.time === time
  );
}

function projectQuestionInteractionRecord(record: ContextRecord, sessionId: string): ContextRecord {
  if (record.type !== 'interaction.request' || record['kind'] !== 'question') return record;
  const id = record['id'];
  const request = record['request'];
  const time = record['time'];
  if (typeof id !== 'string' || typeof time !== 'number' || !Number.isFinite(time)) return record;
  if (request === null || typeof request !== 'object') return record;
  try {
    const innerToolCallId = (request as { toolCallId?: unknown }).toolCallId;
    const toolCallId =
      typeof record['toolCallId'] === 'string'
        ? record['toolCallId']
        : typeof innerToolCallId === 'string'
          ? innerToolCallId
          : undefined;
    return {
      ...record,
      toolCallId,
      request: toWireQuestion({ id, createdAt: time, payload: request }, sessionId),
    };
  } catch {
    return record;
  }
}

function mergeLiveTail(
  transcript: ContextTranscript,
  contextMessages: readonly ContextMessage[],
): {
  readonly messages: readonly ContextMessage[];
  readonly times: readonly (number | undefined)[];
} {
  if (contextMessages.length <= transcript.foldedLength) {
    return { messages: transcript.entries, times: transcript.times };
  }
  const tail = contextMessages.slice(transcript.foldedLength);
  return {
    messages: [...transcript.entries, ...tail],
    times: [...transcript.times, ...tail.map(() => undefined)],
  };
}

function wireScope(query: ColdProjectionQuery): string {
  return `${SESSIONS_ROOT}/${query.workspaceId}/${query.sessionId}/${AGENTS_DIR}/${query.agentId}`;
}
