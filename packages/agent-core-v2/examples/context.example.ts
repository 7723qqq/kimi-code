/**
 * Scenario: the **context** slice — event-sourced conversation memory.
 *
 * Concept taught: `IAgentContextMemoryService` is *not* a private array of
 * messages. It is an event-sourced projection over the append-log
 * (`IAgentRecordService`, backed by `IAgentWireRecordService`). Every mutation
 * goes through `splice(start, deleteCount, messages)`, which (1) stamps each
 * message with a stable local id, (2) appends a durable `context.splice` record
 * to the append-log, and (3) applies the same splice to its in-memory history.
 * Because the durable record is the source of truth, the history can be
 * rebuilt by replaying the records — the `get()` view is a projection, not the
 * state itself.
 *
 * Wiring: the real composition root (`_harness`) provides every collaborator,
 * including the real `IAgentContextMemoryService`, `IAgentRecordService`, and
 * `IAgentWireRecordService`. We do not stub context memory. We spy on the real
 * `IAgentRecordService.append` only to capture the `context.splice` records so
 * we can show the projection is reproducible from the append-log alone.
 *
 * Prerequisites: example 01 (container & scope tree),
 * example `goals-plans-todos` (append-log CRUD + spying on the record service).
 *
 * Run:
 *   pnpm --filter @moonshot-ai/agent-core-v2 example -- examples/context.example.ts
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  type ContextMessage,
  IAgentContextMemoryService,
} from '#/agent/contextMemory';
import {
  type AgentRecord,
  IAgentRecordService,
} from '#/agent/record';
import {
  IAgentWireRecordService,
  type PersistedWireRecord,
} from '#/agent/wireRecord';

import { createSliceHost, type SliceHost } from './_harness';

function userMessage(text: string): ContextMessage {
  return { role: 'user', content: [{ type: 'text', text }], toolCalls: [] };
}

function assistantMessage(text: string): ContextMessage {
  return { role: 'assistant', content: [{ type: 'text', text }], toolCalls: [] };
}

describe('context slice (event-sourced conversation memory)', () => {
  let host: SliceHost;
  afterEach(() => host?.dispose());

  function setUp() {
    host = createSliceHost({ homeDir: process.env['KIMI_CODE_HOME']! });
    // Resolve the real append-log first and instrument it; the context memory
    // service is constructed lazily and shares the same singletons.
    const records = host.agent.accessor.get(IAgentRecordService);
    const wireRecords = host.agent.accessor.get(IAgentWireRecordService);
    const appended: AgentRecord[] = [];
    const originalAppend = records.append.bind(records);
    vi.spyOn(records, 'append').mockImplementation((record) => {
      appended.push(record as AgentRecord);
      return originalAppend(record);
    });
    const context = host.agent.accessor.get(IAgentContextMemoryService);
    const spliceRecords = () =>
      appended.filter((r): r is AgentRecord<'context.splice'> => r.type === 'context.splice');
    return { context, records, wireRecords, appended, spliceRecords };
  }

  it('splices a user message into context and records a context.splice on the append-log', () => {
    const { context, wireRecords, spliceRecords } = setUp();

    context.splice(0, 0, [userMessage('hello')]);

    // The projection reflects the splice: the message is readable back, stamped
    // with a stable local id assigned on entry.
    const history = context.get();
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ role: 'user', content: [{ type: 'text', text: 'hello' }] });
    expect(history[0]?.id).toMatch(/^msg_/);

    // The mutation is durable: one context.splice record landed on the
    // append-log (the record facade and its wire-record backing agree).
    expect(spliceRecords()).toHaveLength(1);
    expect(spliceRecords()[0]).toMatchObject({ start: 0, deleteCount: 0 });
    expect(wireRecords.getRecords().some((r) => r.type === 'context.splice')).toBe(true);
  });

  it('preserves message order across a user/assistant turn', () => {
    const { context } = setUp();

    context.splice(0, 0, [userMessage('hi'), assistantMessage('hello, how can I help?')]);

    const history = context.get();
    expect(history.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(history.map((m) => m.content[0])).toEqual([
      { type: 'text', text: 'hi' },
      { type: 'text', text: 'hello, how can I help?' },
    ]);
  });

  it('replaces a message in place when splicing with a deleteCount', () => {
    const { context, spliceRecords } = setUp();

    context.splice(0, 0, [userMessage('first'), userMessage('second')]);
    expect(context.get().map((m) => m.content[0])).toEqual([
      { type: 'text', text: 'first' },
      { type: 'text', text: 'second' },
    ]);

    // Replace the message at index 1 with a new one.
    context.splice(1, 1, [assistantMessage('replacement')]);

    const history = context.get();
    expect(history).toHaveLength(2);
    expect(history.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(history.map((m) => m.content[0])).toEqual([
      { type: 'text', text: 'first' },
      { type: 'text', text: 'replacement' },
    ]);

    // Both splices were recorded; the second carries the deletion.
    const records = spliceRecords();
    expect(records).toHaveLength(2);
    expect(records[1]).toMatchObject({ start: 1, deleteCount: 1 });
  });

  it('rebuilds the same history in a fresh agent by replaying the append-log records', async () => {
    const { context, wireRecords } = setUp();

    context.splice(0, 0, [userMessage('remember this')]);
    context.splice(1, 0, [assistantMessage('noted')]);
    const original = context.get();
    expect(original).toHaveLength(2);

    // The append-log's durable records are the source of truth. Capture them in
    // the wire-record format the restore path expects.
    const persisted = wireRecords.getRecords();

    // A brand-new agent scope has an empty context. Resolve its context memory
    // first so its constructor registers the context.splice resumer, then replay
    // the persisted records — no private array is shared between the two agents.
    const freshAgent = host.newAgent('fresh');
    const freshContext = freshAgent.accessor.get(IAgentContextMemoryService);
    const freshWireRecords = freshAgent.accessor.get(IAgentWireRecordService);
    expect(freshContext.get()).toHaveLength(0);

    await freshWireRecords.restore(persisted);

    // The projection is reproducible from the append-log alone: the fresh
    // agent reconstructs the same messages, including their stable ids.
    expect(freshContext.get()).toEqual(original);
  });
});
