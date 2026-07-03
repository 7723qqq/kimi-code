/**
 * `AgentContextMemoryService.applySplice` replay contract, exercised without
 * the full agent harness: a boundary splice (`start === 0 && deleteCount > 0`,
 * i.e. compaction/clear) never touches the replay; every other splice mirrors
 * itself (removes deleted messages, pushes inserted ones).
 */

import { describe, expect, it } from 'vitest';

import {
  AgentContextMemoryService,
  type ContextMessage,
} from '#/agent/contextMemory';
import type { AgentRecord, IAgentRecordService } from '#/agent/record';
import type { AgentReplayRecordPayload } from '#/agent/replayBuilder/types';
import { stubRecord } from './stubs';

interface RecordingRecordStub {
  readonly record: IAgentRecordService;
  readonly pushed: AgentReplayRecordPayload[];
  readonly removed: ContextMessage[][];
  readonly resume: (record: AgentRecord<'context.splice'>) => void;
}

function recordingRecord(): RecordingRecordStub {
  const pushed: AgentReplayRecordPayload[] = [];
  const removed: ContextMessage[][] = [];
  let resume: ((record: AgentRecord<'context.splice'>) => void) | undefined;
  const base = stubRecord();
  const record: IAgentRecordService = {
    ...base,
    define: (type, facets) => {
      if (type === 'context.splice' && facets.resume !== undefined) {
        resume = facets.resume as unknown as (record: AgentRecord<'context.splice'>) => void;
      }
      return base.define(type, facets);
    },
    push: (payload) => {
      pushed.push(payload);
    },
    removeLastMessages: (messages) => {
      if (messages.size > 0) removed.push([...messages]);
    },
  };
  return {
    record,
    pushed,
    removed,
    resume: (spliceRecord) => {
      if (resume === undefined) throw new Error('context.splice resumer not registered');
      resume(spliceRecord);
    },
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

describe('AgentContextMemoryService splice replay contract', () => {
  it('pushes appended messages into the replay', () => {
    const stub = recordingRecord();
    const context = new AgentContextMemoryService(stub.record);

    context.splice(0, 0, [userMessage('hello')]);
    context.splice(context.get().length, 0, [userMessage('world')]);

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
    context.splice(0, 0, [userMessage('keep'), userMessage('drop')]);

    context.splice(1, 1, []);

    expect(context.get().map((m) => m.content)).toEqual([[{ type: 'text', text: 'keep' }]]);
    expect(stub.removed).toHaveLength(1);
    expect(stub.removed[0]![0]).toMatchObject({ content: [{ type: 'text', text: 'drop' }] });
  });

  it('mirrors in-place replacements (migrated step updates) into the replay', () => {
    const stub = recordingRecord();
    const context = new AgentContextMemoryService(stub.record);
    context.splice(0, 0, [userMessage('prompt'), userMessage('partial')]);
    stub.pushed.length = 0;

    context.splice(1, 1, [userMessage('final')]);

    expect(stub.removed).toHaveLength(1);
    expect(stub.removed[0]![0]).toMatchObject({ content: [{ type: 'text', text: 'partial' }] });
    expect(stub.pushed).toHaveLength(1);
    expect(stub.pushed[0]).toMatchObject({
      type: 'message',
      message: expect.objectContaining({ content: [{ type: 'text', text: 'final' }] }),
    });
  });

  it('leaves the replay untouched for boundary splices (compaction)', () => {
    const stub = recordingRecord();
    const context = new AgentContextMemoryService(stub.record);
    context.splice(0, 0, [userMessage('old 1'), userMessage('old 2')]);
    stub.pushed.length = 0;

    context.splice(0, 2, [summaryMessage('summary')]);

    expect(context.get()).toHaveLength(1);
    expect(stub.removed).toHaveLength(0);
    expect(stub.pushed).toHaveLength(0);
  });

  it('leaves the replay untouched for boundary splices (clear)', () => {
    const stub = recordingRecord();
    const context = new AgentContextMemoryService(stub.record);
    context.splice(0, 0, [userMessage('one'), userMessage('two')]);
    stub.pushed.length = 0;

    context.splice(0, context.get().length, []);

    expect(context.get()).toHaveLength(0);
    expect(stub.removed).toHaveLength(0);
    expect(stub.pushed).toHaveLength(0);
  });

  it('applies the same contract on the resume path', () => {
    const stub = recordingRecord();
    const context = new AgentContextMemoryService(stub.record);

    stub.resume({
      type: 'context.splice',
      start: 0,
      deleteCount: 0,
      messages: [userMessage('restored 1'), userMessage('restored 2')],
    });
    stub.resume({
      type: 'context.splice',
      start: 0,
      deleteCount: 2,
      messages: [summaryMessage('restored summary')],
    });

    expect(context.get()).toHaveLength(1);
    // Appends were pushed; the boundary splice neither removed nor pushed, so
    // the restored transcript keeps the pre-compaction messages and the
    // summary never appears as a plain message.
    expect(stub.pushed).toHaveLength(2);
    expect(stub.removed).toHaveLength(0);
  });
});
