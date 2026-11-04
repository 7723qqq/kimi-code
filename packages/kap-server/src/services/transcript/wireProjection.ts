import { join } from 'node:path';

import {
  AGENT_WIRE_RECORD_KEY,
  createContextTranscriptReducer,
  flattenChain,
  IAgentBlobService,
  IAgentContextMemoryService,
  IAgentScopeContext,
  isUndoAnchor,
  parseTree,
  type ContextMessage,
  type ContextTranscript,
  type ContextTranscriptReducer,
  type IAgentScopeHandle,
  type WireRecord,
} from '@moonshot-ai/agent-core-v2';
import {
  createHistoryMessageProjector,
  createWireRecordFactsProjector,
  withoutUserPromptSubmitHookParts,
  type AgentTranscriptSnapshot,
  type HistoryMessageProjector,
  type HistoryProjectionOptions,
  type WireRecordFactsProjector,
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

interface ColdScanState {
  readonly taskOriginTurnTaskIds: Set<string>;
  readonly matchedSteers: (
    | { messageId: string; promptIds: readonly string[] }
    | { key: string; kind: string }
  )[];
  readonly pendingSteers: Map<string, Map<string, number>>;
  readonly turnPromptIds: Set<string>;
  readonly anchorStack: { taskIdsSnapshot: Set<string>; steerCount: number }[];
  anchorFloor: number;
  sawTurnPrompt: boolean;
}

interface ActiveProjection {
  processedRecords: number;
  readonly reducer: ContextTranscriptReducer;
  readonly group: HistoryMessageProjector;
  readonly facts: WireRecordFactsProjector;
  readonly scan: ColdScanState;
  signatures: readonly MessageSignature[];
  readonly projectedMessageIds: Set<string>;
  readonly projectedTaskIds: Set<string>;
  snapshot: AgentTranscriptSnapshot | undefined;
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
        const active = this.syncActive(state);
        if (active.snapshot === undefined) {
          active.snapshot = active.facts.result(active.group.result());
        }
        return active.snapshot;
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
    if (active.processedRecords === state.activeRecords.length && active.snapshot !== undefined) {
      return active;
    }
    const appended = state.activeRecords.slice(active.processedRecords);
    if (
      active.processedRecords > state.activeRecords.length ||
      appended.some((record) => record.type === 'context.undo') ||
      hasRetroactiveBoundary(appended, active)
    ) {
      return this.rebuildActive(state);
    }
    const previousSignatures = active.signatures;
    for (const record of appended) scanRecord(active.scan, record);
    for (const record of appended) active.reducer.add(record);
    const transcript = active.reducer.result();
    if (!samePrefix(previousSignatures, transcript.entries, transcript.times)) {
      return this.rebuildActive(state);
    }
    active.group.syncOptions(scanOptions(active.scan));
    for (let index = previousSignatures.length; index < transcript.entries.length; index++) {
      const message = transcript.entries[index]!;
      active.group.add(message);
      trackMessage(active, message);
    }
    active.signatures = transcript.entries.map((message, index) =>
      signatureOf(message, transcript.times[index]),
    );
    const base = active.group.result();
    active.facts.syncBase(base);
    for (const record of appended) {
      active.facts.add(projectQuestionInteractionRecord(record, state.sessionId ?? ''));
    }
    active.processedRecords = state.activeRecords.length;
    active.snapshot = undefined;
    state.active = active;
    return active;
  }

  private rebuildActive(state: WireProjectionState): ActiveProjection {
    const active = createActiveProjection(state);
    for (const record of state.activeRecords) scanRecord(active.scan, record);
    for (const record of state.activeRecords) active.reducer.add(record);
    const transcript = active.reducer.result();
    active.group.syncOptions(scanOptions(active.scan));
    for (const message of transcript.entries) {
      active.group.add(message);
      trackMessage(active, message);
    }
    active.signatures = transcript.entries.map((message, index) =>
      signatureOf(message, transcript.times[index]),
    );
    const base = active.group.result();
    active.facts.syncBase(base);
    for (const record of state.activeRecords) {
      active.facts.add(projectQuestionInteractionRecord(record, state.sessionId ?? ''));
    }
    active.processedRecords = state.activeRecords.length;
    active.snapshot = undefined;
    state.active = active;
    return active;
  }
}

function createActiveProjection(state: WireProjectionState): ActiveProjection {
  const agentId = state.agentId ?? '';
  const sessionId = state.sessionId ?? '';
  const workspaceId = state.workspaceId ?? '';
  return {
    processedRecords: 0,
    reducer: createContextTranscriptReducer(),
    group: createHistoryMessageProjector(),
    facts: createWireRecordFactsProjector({
      agentId,
      resolvePlanRevisionKey: (key) =>
        join(SESSIONS_ROOT, workspaceId, sessionId, AGENTS_DIR, agentId, key),
    }),
    scan: {
      taskOriginTurnTaskIds: new Set(),
      matchedSteers: [],
      pendingSteers: new Map(),
      turnPromptIds: new Set(),
      anchorStack: [],
      anchorFloor: 0,
      sawTurnPrompt: false,
    },
    signatures: [],
    projectedMessageIds: new Set(),
    projectedTaskIds: new Set(),
    snapshot: undefined,
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

function samePrefix(
  signatures: readonly MessageSignature[],
  messages: readonly ContextMessage[],
  times: readonly (number | undefined)[],
): boolean {
  if (messages.length < signatures.length) return false;
  for (let index = 0; index < signatures.length; index++) {
    if (!sameMessage(signatures[index]!, messages[index]!, times[index])) return false;
  }
  return true;
}

function trackMessage(active: ActiveProjection, message: ContextMessage): void {
  if (message.id !== undefined) active.projectedMessageIds.add(message.id);
  if (message.role !== 'user') return;
  const origin = message.origin as { kind?: unknown; taskId?: unknown } | undefined;
  if (
    (origin?.kind === 'task' || origin?.kind === 'background_task') &&
    typeof origin.taskId === 'string'
  ) {
    active.projectedTaskIds.add(origin.taskId);
  }
}

function hasRetroactiveBoundary(records: readonly WireRecord[], active: ActiveProjection): boolean {
  for (const record of records) {
    if (record.type === 'turn.prompt') {
      const promptId = (record as { promptId?: unknown }).promptId;
      if (typeof promptId === 'string' && active.projectedMessageIds.has(promptId)) return true;
      const origin = (record as { origin?: { kind?: unknown; taskId?: unknown } }).origin;
      if (
        (origin?.kind === 'task' || origin?.kind === 'background_task') &&
        typeof origin.taskId === 'string' &&
        active.projectedTaskIds.has(origin.taskId)
      ) {
        return true;
      }
    }
    if (record.type === 'turn.steer') {
      const messageId = record['messageId'];
      if (typeof messageId === 'string' && active.projectedMessageIds.has(messageId)) return true;
    }
  }
  return false;
}

function scanRecord(scan: ColdScanState, record: WireRecord): void {
  if (record.type === 'context.undo') {
    const count = typeof record['count'] === 'number' ? (record['count'] as number) : 0;
    for (let i = 0; i < count && scan.anchorStack.length > scan.anchorFloor; i++) {
      const popped = scan.anchorStack.pop()!;
      scan.matchedSteers.length = popped.steerCount;
      scan.taskOriginTurnTaskIds.clear();
      for (const id of popped.taskIdsSnapshot) scan.taskOriginTurnTaskIds.add(id);
    }
    return;
  }
  if (record.type === 'context.clear') {
    scan.anchorFloor = scan.anchorStack.length;
    return;
  }
  if (record.type === 'context.append_message') {
    const message = (record as { message?: ContextMessage }).message;
    if (message !== undefined && isUndoAnchor(message)) {
      scan.anchorStack.push({
        taskIdsSnapshot: new Set(scan.taskOriginTurnTaskIds),
        steerCount: scan.matchedSteers.length,
      });
    }
    if (message?.role === 'user') {
      const key = JSON.stringify(withoutUserPromptSubmitHookParts(message.content));
      const kind = message.origin?.kind ?? 'user';
      const pendingByKind = scan.pendingSteers.get(key);
      const remaining = pendingByKind?.get(kind) ?? 0;
      if (remaining > 0) {
        pendingByKind!.set(kind, remaining - 1);
        scan.matchedSteers.push({ key, kind });
      }
    }
    return;
  }
  if (record.type === 'turn.steer') {
    const messageId = record['messageId'];
    if (typeof messageId === 'string' && messageId.length > 0) {
      scan.matchedSteers.push({ messageId, promptIds: promptIdsFromSteerRecord(record) });
      return;
    }
    const input = record['input'];
    if (Array.isArray(input)) {
      const key = JSON.stringify(input);
      const steerOrigin = (record as { origin?: { kind?: unknown } }).origin?.kind;
      const kind = typeof steerOrigin === 'string' ? steerOrigin : 'user';
      const byKind = scan.pendingSteers.get(key) ?? new Map<string, number>();
      byKind.set(kind, (byKind.get(kind) ?? 0) + 1);
      scan.pendingSteers.set(key, byKind);
    }
    return;
  }
  if (record.type !== 'turn.prompt') return;
  scan.sawTurnPrompt = true;
  const promptId = (record as { promptId?: unknown }).promptId;
  if (typeof promptId === 'string') scan.turnPromptIds.add(promptId);
  const origin = (record as { origin?: { kind?: unknown; taskId?: unknown } }).origin;
  if (origin === undefined) return;
  if (
    (origin.kind === 'task' ||
      origin.kind === 'background_task' ||
      origin.kind === 'task_notification') &&
    typeof origin.taskId === 'string'
  ) {
    scan.taskOriginTurnTaskIds.add(origin.taskId);
  }
}

function scanOptions(scan: ColdScanState): HistoryProjectionOptions | undefined {
  const steeredByMessageId = new Map<string, readonly string[]>();
  const steeredContents = new Map<string, Map<string, number>>();
  for (const steer of scan.matchedSteers) {
    if ('messageId' in steer) {
      steeredByMessageId.set(steer.messageId, steer.promptIds);
      continue;
    }
    const byKind = steeredContents.get(steer.key) ?? new Map<string, number>();
    byKind.set(steer.kind, (byKind.get(steer.kind) ?? 0) + 1);
    steeredContents.set(steer.key, byKind);
  }
  if (!scan.sawTurnPrompt && steeredContents.size === 0 && steeredByMessageId.size === 0) {
    return undefined;
  }
  return {
    taskOriginTurnTaskIds: scan.taskOriginTurnTaskIds,
    steeredContents,
    steeredByMessageId,
    turnPromptIds: scan.turnPromptIds,
  };
}

function promptIdsFromSteerRecord(record: ContextRecord): readonly string[] {
  const value = record['promptIds'];
  if (!Array.isArray(value)) return [];
  return value.filter((id): id is string => typeof id === 'string' && id.length > 0);
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
