/**
 * `AgentContextMemoryService` operation replay contract, exercised without
 * the full agent harness. Each operation's `apply` mutates the in-memory
 * history and its `replay` projection feeds the replay read model. Boundary
 * resets (`start === 0 && deleteCount > 0`, e.g. compaction/clear) cut the
 * replay segment instead of pushing/removing individual messages.
 */

import { describe, expect, it } from 'vitest';

import {
  AgentContextMemoryService,
  type ContextMessage,
  type ContextReplayWriter,
  type ContextSplice,
} from '#/agent/contextMemory';
import type { IAgentRecordService } from '#/agent/record';
import type { AgentReplayRecordPayload } from '#/agent/replayBuilder/types';
import { stubRecord } from './stubs';

interface RecordingRecordStub {
  readonly record: IAgentRecordService;
  readonly pushed: AgentReplayRecordPayload[];
  readonly removed: string[][];
}

function recordingRecord(): RecordingRecordStub {
  const pushed: AgentReplayRecordPayload[] = [];
  const removed: string[][] = [];
  const base = stubRecord();
  const record: IAgentRecordService = {
    ...base,
    push: (payload) => {
      pushed.push(payload);
    },
    removeMessages: (messages) => {
      if (messages.size > 0) removed.push([...messages]);
    },
  };
  return {
    record,
    pushed,
    removed,
  };
}

function userMessage(text: string): ContextMessage {
  return { role: 'user', content: [{ type: 'text', text }], toolCalls: [] };
}

function summaryMessage(text: string): ContextMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    toolCalls: [],
    origin: { kind: 'compaction_summary' },
  };
}

function defineAppend(
  context: AgentContextMemoryService,
): (messages: readonly ContextMessage[]) => void {
  return context.defineOperation<readonly [messages: readonly ContextMessage[]]>({
    type: 'append',
    apply: (splice: ContextSplice, messages) => {
      splice(Number.POSITIVE_INFINITY, 0, messages);
    },
    replay: (replay: ContextReplayWriter, messages) => {
      for (const message of messages) {
        replay.push({ type: 'message', message });
      }
    },
  });
}

function defineRemove(
  context: AgentContextMemoryService,
): (index: number, messageId: string) => void {
  return context.defineOperation<readonly [index: number, messageId: string]>({
    type: 'remove',
    apply: (splice: ContextSplice, index) => {
      splice(index, 1, []);
    },
    replay: (replay: ContextReplayWriter, _index, messageId) => {
      replay.removeMessages(new Set([messageId]));
    },
  });
}

function defineReplace(
  context: AgentContextMemoryService,
): (index: number, message: ContextMessage, oldMessageId: string) => void {
  return context.defineOperation<readonly [index: number, message: ContextMessage, oldMessageId: string]>({
    type: 'replace',
    apply: (splice: ContextSplice, index, message) => {
      splice(index, 1, [message]);
    },
    replay: (replay: ContextReplayWriter, _index, message, oldMessageId) => {
      replay.removeMessages(new Set([oldMessageId]));
      replay.push({ type: 'message', message });
    },
  });
}

function defineCompact(
  context: AgentContextMemoryService,
): (deleteCount: number, summary: ContextMessage) => void {
  return context.defineOperation<readonly [deleteCount: number, summary: ContextMessage]>({
    type: 'compact',
    apply: (splice: ContextSplice, deleteCount, summary) => {
      splice(0, deleteCount, [summary]);
    },
    replay: (replay: ContextReplayWriter) => {
      replay.cut();
    },
  });
}

function defineClear(context: AgentContextMemoryService): () => void {
  return context.defineOperation<readonly []>({
    type: 'clear',
    apply: (splice: ContextSplice) => {
      splice(0, Number.POSITIVE_INFINITY, []);
    },
    replay: (replay: ContextReplayWriter) => {
      replay.cut();
    },
  });
}

describe('AgentContextMemoryService operation replay contract', () => {
  it('pushes appended messages into the replay', () => {
    const stub = recordingRecord();
    const context = new AgentContextMemoryService(stub.record);
    const append = defineAppend(context);

    append([userMessage('hello')]);
    append([userMessage('world')]);

    expect(stub.pushed).toHaveLength(2);
    expect(stub.pushed[1]).toMatchObject({
      type: 'message',
      message: expect.objectContaining({ content: [{ type: 'text', text: 'world' }] }),
    });
    expect(stub.removed).toHaveLength(0);
  });

  it('mirrors mid-history removals (undo-shaped splices) into the replay', () => {
    const stub = recordingRecord();
    const context = new AgentContextMemoryService(stub.record);
    const append = defineAppend(context);
    const remove = defineRemove(context);

    append([userMessage('keep'), userMessage('drop')]);
    const droppedId = context.get()[1]!.id!;
    remove(1, droppedId);

    expect(context.get().map((m) => m.content)).toEqual([[{ type: 'text', text: 'keep' }]]);
    expect(stub.removed).toHaveLength(1);
    expect(stub.removed[0]).toEqual([droppedId]);
  });

  it('mirrors in-place replacements (migrated step updates) into the replay', () => {
    const stub = recordingRecord();
    const context = new AgentContextMemoryService(stub.record);
    const append = defineAppend(context);
    const replace = defineReplace(context);

    append([userMessage('prompt'), userMessage('partial')]);
    stub.pushed.length = 0;
    const partialId = context.get()[1]!.id!;

    replace(1, userMessage('final'), partialId);

    expect(stub.removed).toHaveLength(1);
    expect(stub.removed[0]).toEqual([partialId]);
    expect(stub.pushed).toHaveLength(1);
    expect(stub.pushed[0]).toMatchObject({
      type: 'message',
      message: expect.objectContaining({ content: [{ type: 'text', text: 'final' }] }),
    });
  });

  it('leaves the replay untouched for boundary splices (compaction)', () => {
    const stub = recordingRecord();
    const context = new AgentContextMemoryService(stub.record);
    const append = defineAppend(context);
    const compact = defineCompact(context);

    append([userMessage('old 1'), userMessage('old 2')]);
    stub.pushed.length = 0;

    compact(2, summaryMessage('summary'));

    expect(context.get()).toHaveLength(1);
    expect(stub.removed).toHaveLength(0);
    expect(stub.pushed).toHaveLength(0);
  });

  it('leaves the replay untouched for boundary splices (clear)', () => {
    const stub = recordingRecord();
    const context = new AgentContextMemoryService(stub.record);
    const append = defineAppend(context);
    const clear = defineClear(context);

    append([userMessage('one'), userMessage('two')]);
    stub.pushed.length = 0;

    clear();

    expect(context.get()).toHaveLength(0);
    expect(stub.removed).toHaveLength(0);
    expect(stub.pushed).toHaveLength(0);
  });

  it('applies the same contract on the resume path', () => {
    const stub = recordingRecord();
    const context = new AgentContextMemoryService(stub.record);
    const append = defineAppend(context);
    const compact = defineCompact(context);

    append([userMessage('restored 1'), userMessage('restored 2')]);
    compact(2, summaryMessage('restored summary'));

    expect(context.get()).toHaveLength(1);
    expect(stub.pushed).toHaveLength(2);
    expect(stub.removed).toHaveLength(0);
  });
});
