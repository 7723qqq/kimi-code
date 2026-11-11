import {
  createPromptFactsProjector,
  type PromptFactsProjector,
} from '../history/foldPrompts';
import {
  createWireRecordFactsProjector,
  type HistoryWireRecord,
  type WireRecordFactsProjector,
} from '../history/foldFacts';
import {
  createHistoryMessageProjector,
  withoutUserPromptSubmitHookParts,
  type HistoryMessage,
  type HistoryMessageProjector,
  type HistoryProjectionOptions,
} from '../history/groupTurns';
import type { AgentTranscriptSnapshot } from '../ops/operation';

export interface WireTranscriptContext {
  readonly entries: readonly HistoryMessage[];
  readonly times: readonly (number | undefined)[];
  readonly foldedLength: number;
}

export interface WireTranscriptContextReducer {
  add(record: HistoryWireRecord): void;
  result(): WireTranscriptContext;
}

export interface WireTranscriptProjectorOptions {
  readonly agentId: string;
  readonly createContextReducer: () => WireTranscriptContextReducer;
  readonly mapFactRecord?: (record: HistoryWireRecord) => HistoryWireRecord;
  readonly resolvePlanRevisionKey?: (key: string) => string;
}

export interface WireTranscriptProjector {
  sync(records: readonly HistoryWireRecord[]): void;
  snapshot(): AgentTranscriptSnapshot;
}

export function createWireTranscriptProjector(
  options: WireTranscriptProjectorOptions,
): WireTranscriptProjector {
  let processedRecords = 0;
  let reducer: WireTranscriptContextReducer;
  let group: HistoryMessageProjector;
  let facts: WireRecordFactsProjector;
  let prompts: PromptFactsProjector;
  let scan: ColdScanState;
  let signatures: readonly MessageSignature[];
  let projectedMessageIds: Set<string>;
  let projectedTaskIds: Set<string>;
  let cached: AgentTranscriptSnapshot | undefined;

  const reset = (): void => {
    reducer = options.createContextReducer();
    group = createHistoryMessageProjector();
    facts = createWireRecordFactsProjector({
      agentId: options.agentId,
      resolvePlanRevisionKey: options.resolvePlanRevisionKey,
    });
    prompts = createPromptFactsProjector();
    scan = emptyScanState();
    signatures = [];
    projectedMessageIds = new Set();
    projectedTaskIds = new Set();
    processedRecords = 0;
    cached = undefined;
  };

  const trackedMessage = (message: HistoryMessage): void => {
    if (message.id !== undefined) projectedMessageIds.add(message.id);
    if (message.role !== 'user') return;
    const origin = message.origin as { kind?: unknown; taskId?: unknown } | undefined;
    if (
      (origin?.kind === 'task' || origin?.kind === 'background_task') &&
      typeof origin.taskId === 'string'
    ) {
      projectedTaskIds.add(origin.taskId);
    }
  };

  const appendMessages = (from: number, entries: readonly HistoryMessage[]): void => {
    for (let index = from; index < entries.length; index++) {
      const message = entries[index]!;
      group.add(message);
      trackedMessage(message);
    }
  };

  const mapFact = (record: HistoryWireRecord): HistoryWireRecord =>
    options.mapFactRecord?.(record) ?? record;

  const rebuild = (records: readonly HistoryWireRecord[]): void => {
    reset();
    for (const record of records) {
      scanRecord(scan, record);
      reducer.add(record);
      prompts.add(record);
    }
    const context = reducer.result();
    group.syncOptions(scanOptions(scan));
    appendMessages(0, context.entries);
    signatures = signatureList(context.entries, context.times);
    facts.syncBase(group.result());
    for (const record of records) facts.add(mapFact(record));
    processedRecords = records.length;
  };

  const hasRetroactiveBoundary = (record: HistoryWireRecord): boolean => {
    if (record.type === 'turn.prompt') {
      const promptId = record['promptId'];
      if (typeof promptId === 'string' && projectedMessageIds.has(promptId)) return true;
      const origin = record['origin'] as { kind?: unknown; taskId?: unknown } | undefined;
      if (
        (origin?.kind === 'task' || origin?.kind === 'background_task') &&
        typeof origin.taskId === 'string' &&
        projectedTaskIds.has(origin.taskId)
      ) {
        return true;
      }
    }
    if (record.type === 'turn.steer') {
      const messageId = record['messageId'];
      if (typeof messageId === 'string' && projectedMessageIds.has(messageId)) return true;
    }
    return false;
  };

  const sync = (records: readonly HistoryWireRecord[]): void => {
    const appended = records.slice(processedRecords);
    if (
      processedRecords > records.length ||
      appended.some((record) => record.type === 'context.undo') ||
      appended.some(hasRetroactiveBoundary)
    ) {
      rebuild(records);
      return;
    }
    if (appended.length === 0) return;
    const previousSignatures = signatures;
    for (const record of appended) {
      scanRecord(scan, record);
      reducer.add(record);
      prompts.add(record);
    }
    const context = reducer.result();
    if (!samePrefix(previousSignatures, context.entries, context.times)) {
      rebuild(records);
      return;
    }
    group.syncOptions(scanOptions(scan));
    appendMessages(previousSignatures.length, context.entries);
    signatures = signatureList(context.entries, context.times);
    facts.syncBase(group.result());
    for (const record of appended) facts.add(mapFact(record));
    processedRecords = records.length;
    cached = undefined;
  };

  const snapshot = (): AgentTranscriptSnapshot => {
    if (cached !== undefined) return cached;
    const base = group.result();
    const folded = facts.result(base);
    const projectedPrompts = prompts.result();
    cached =
      projectedPrompts.length === 0
        ? folded
        : { ...folded, prompts: mergePrompts(base.prompts, projectedPrompts) };
    return cached;
  };

  reset();
  return { sync, snapshot };
}

interface MessageSignature {
  readonly source: HistoryMessage;
  readonly contentLength: number;
  readonly toolCallCount: number;
  readonly usage: HistoryMessage['usage'];
  readonly llmTiming: HistoryMessage['llmTiming'];
  readonly time: number | undefined;
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

function emptyScanState(): ColdScanState {
  return {
    taskOriginTurnTaskIds: new Set(),
    matchedSteers: [],
    pendingSteers: new Map(),
    turnPromptIds: new Set(),
    anchorStack: [],
    anchorFloor: 0,
    sawTurnPrompt: false,
  };
}

function signatureList(
  messages: readonly HistoryMessage[],
  times: readonly (number | undefined)[],
): readonly MessageSignature[] {
  return messages.map((message, index) => signatureOf(message, times[index]));
}

function signatureOf(message: HistoryMessage, time: number | undefined): MessageSignature {
  return {
    source: message,
    contentLength: message.content?.length ?? 0,
    toolCallCount: message.toolCalls?.length ?? 0,
    usage: message.usage,
    llmTiming: message.llmTiming,
    time,
  };
}

function samePrefix(
  signatures: readonly MessageSignature[],
  messages: readonly HistoryMessage[],
  times: readonly (number | undefined)[],
): boolean {
  if (messages.length < signatures.length) return false;
  for (let index = 0; index < signatures.length; index++) {
    const signature = signatures[index]!;
    const message = messages[index]!;
    if (
      signature.source !== message ||
      signature.contentLength !== (message.content?.length ?? 0) ||
      signature.toolCallCount !== (message.toolCalls?.length ?? 0) ||
      signature.usage !== message.usage ||
      signature.llmTiming !== message.llmTiming ||
      signature.time !== times[index]
    ) {
      return false;
    }
  }
  return true;
}

function scanRecord(scan: ColdScanState, record: HistoryWireRecord): void {
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
    const message = record['message'] as HistoryMessage | undefined;
    if (message !== undefined && isUndoAnchorMessage(message)) {
      scan.anchorStack.push({
        taskIdsSnapshot: new Set(scan.taskOriginTurnTaskIds),
        steerCount: scan.matchedSteers.length,
      });
    }
    if (message?.role === 'user') {
      const content = message.content ?? [];
      const key = JSON.stringify(withoutUserPromptSubmitHookParts(content));
      const kind =
        (message.origin as { kind?: unknown } | undefined)?.kind ?? 'user';
      const steerKind = typeof kind === 'string' ? kind : 'user';
      const pendingByKind = scan.pendingSteers.get(key);
      const remaining = pendingByKind?.get(steerKind) ?? 0;
      if (remaining > 0) {
        pendingByKind!.set(steerKind, remaining - 1);
        scan.matchedSteers.push({ key, kind: steerKind });
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
  const promptId = record['promptId'];
  if (typeof promptId === 'string') scan.turnPromptIds.add(promptId);
  const origin = record['origin'] as { kind?: unknown; taskId?: unknown } | undefined;
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

function promptIdsFromSteerRecord(record: HistoryWireRecord): readonly string[] {
  const value = record['promptIds'];
  if (!Array.isArray(value)) return [];
  return value.filter((id): id is string => typeof id === 'string' && id.length > 0);
}

function isUndoAnchorMessage(message: HistoryMessage): boolean {
  if (message.role !== 'user') return false;
  const origin = message.origin as
    | { kind?: unknown; trigger?: unknown; inTurn?: unknown }
    | undefined;
  if (origin !== undefined && origin.inTurn === true) return false;
  if (origin?.kind === undefined || origin.kind === 'user') return true;
  return (
    (origin.kind === 'skill_activation' || origin.kind === 'plugin_command') &&
    origin.trigger === 'user-slash'
  );
}

function mergePrompts(
  base: readonly AgentTranscriptSnapshot['prompts'][number][],
  projected: readonly AgentTranscriptSnapshot['prompts'][number][],
): AgentTranscriptSnapshot['prompts'] {
  if (base.length === 0) return projected;
  const merged = new Map(base.map((prompt) => [prompt.promptId, prompt]));
  for (const prompt of projected) merged.set(prompt.promptId, prompt);
  return [...merged.values()];
}
