import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ENTITY_ID_FIELDS,
  v3ClientFrameSchema,
  v3EntityKey,
  v3HistoryMessageSchema,
  v3HistoryQuerySchema,
  v3HistoryResponseSchema,
  v3ServerMessageSchema,
  type InteractionMessage,
  type ToolCallMessage,
  type V3HistoryMessage,
} from '../v3';

type ContractField = {
  name: string;
  kind: string;
  optional: boolean;
  nullable: boolean;
  variants?: string[];
  fields?: string[];
};

type ContractVariant = { type: string; fields: ContractField[] };

const contract = JSON.parse(
  readFileSync(join(__dirname, '../../../kimi-agent/v3-message-contract.json'), 'utf8'),
) as { server: ContractVariant[]; client: ContractVariant[] };

/** A value the contract's own field description says is allowed. */
function sample(field: ContractField): unknown {
  switch (field.kind) {
    case 'string':
      return 'x';
    case 'number':
      return 1;
    case 'boolean':
      return true;
    case 'enum':
      return field.variants?.[0] ?? 'x';
    case 'array':
      return [];
    case 'object':
      // Upstream's nested objects that discriminate themselves — `turn.origin`,
      // `tool.progress.progress` — need their key present. The progress
      // payload's `kind` is a closed enum, so it gets a real member; every
      // other nested object the schemas keep opaque or string-keyed.
      return field.fields?.includes('custom_kind') === true ? { kind: 'stdout' } : { kind: 'x' };
    default:
      return { kind: 'x' };
  }
}

function instanceOf(variant: ContractVariant): Record<string, unknown> {
  const frame: Record<string, unknown> = { type: variant.type };
  for (const field of variant.fields) {
    if (field.optional) continue;
    frame[field.name] = sample(field);
  }
  return frame;
}

describe('v3 entity contract', () => {
  it('parses an instance of every variant the frozen contract declares', () => {
    for (const variant of contract.server) {
      const parsed = v3ServerMessageSchema.safeParse(instanceOf(variant));
      expect(parsed.success, `${variant.type}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true);
    }
  });

  it('declares every entity id field the server probes, in probe order', () => {
    expect([...ENTITY_ID_FIELDS]).toEqual([
      'message_id',
      'tool_call_id',
      'interaction_id',
      'task_id',
      'todo_id',
      'system_id',
      'step_id',
      'turn_id',
      'agent_id',
    ]);
  });

  it('keys an entity the way the server does', () => {
    const delta = v3ServerMessageSchema.parse({
      type: 'assistant.delta',
      session_id: 's1',
      agent_id: 'main',
      timestamp: 1,
      message_id: '2.1.assistant',
      text: 'x',
    });
    expect(v3EntityKey(delta)).toBe('main:assistant.delta:2.1.assistant');

    // A message with no id of its own is keyed by its agent, and one with no
    // agent keeps the segment empty rather than dropping it.
    const catalog = v3ServerMessageSchema.parse({ type: 'model_catalog', timestamp: 1 });
    expect(v3EntityKey(catalog)).toBe(':model_catalog:');
  });

  it('accepts the client frames and refuses anything else', () => {
    expect(
      v3ClientFrameSchema.safeParse({
        type: 'subscribe',
        id: 1,
        session_id: 's1',
        omit: ['turn'],
      }).success,
    ).toBe(true);
    expect(
      v3ClientFrameSchema.safeParse({ type: 'unsubscribe', id: 2, session_id: 's1' }).success,
    ).toBe(true);
    expect(
      v3ClientFrameSchema.safeParse({ type: 'subscribe', session_id: 's1' }).success,
      'a subscribe without an id has no ack to correlate',
    ).toBe(false);
  });

  it('parses the frames a greeting and a refusal are made of', () => {
    expect(
      v3ServerMessageSchema.parse({
        type: 'hello',
        protocol_version: '3',
        server_id: 'srv-1',
        capabilities: ['step_replay_v1'],
      }).type,
    ).toBe('hello');
    expect(v3ServerMessageSchema.parse({ type: 'ack', id: 7, code: 40401 })).toMatchObject({
      type: 'ack',
      code: 40401,
    });
    expect(
      v3ServerMessageSchema.parse({ type: 'error', code: 40002, msg: 'not json' }),
    ).toMatchObject({ type: 'error', code: 40002 });
  });

  it('reads a history query and response', () => {
    const query = v3HistoryQuerySchema.parse({ before_turn: '3', page_size: '50' });
    expect(query.page_size).toBe(50);
    expect(v3HistoryQuerySchema.safeParse({ page_size: 501 }).success).toBe(false);
    expect(v3HistoryQuerySchema.safeParse({ page_size: 0 }).success).toBe(false);

    const response = v3HistoryResponseSchema.parse({
      messages: [
        {
          type: 'turn',
          session_id: 's1',
          agent_id: 'main',
          timestamp: 1,
          turn_id: '1',
          ordinal: 1,
          status: 'completed',
          origin: { kind: 'user' },
        },
      ],
      has_more: false,
      in_flight: { turn_id: '1', step_id: '1.1' },
    });
    expect(response.messages).toHaveLength(1);
    expect(response.in_flight?.step_id).toBe('1.1');
  });

  it('keeps the history subset to persisted entities', () => {
    const base = { session_id: 's1', agent_id: 'main', timestamp: 1 };
    const persisted: V3HistoryMessage[] = [
      {
        type: 'turn',
        ...base,
        turn_id: '1',
        ordinal: 1,
        status: 'completed',
        origin: { kind: 'user' },
      },
      { type: 'step', ...base, step_id: '1.1', turn_id: '1', ordinal: 1, status: 'completed' },
      { type: 'user', ...base, message_id: 'm1', status: 'read', text: [] },
      {
        type: 'assistant',
        ...base,
        message_id: 'm2',
        turn_id: '1',
        step_id: '1.1',
        status: 'completed',
        text: 'x',
      },
      {
        type: 'thinking',
        ...base,
        message_id: 'm3',
        turn_id: '1',
        step_id: '1.1',
        status: 'completed',
        text: 'x',
      },
      {
        type: 'tool_call',
        ...base,
        tool_call_id: 'c1',
        turn_id: '1',
        step_id: '1.1',
        name: 'Bash',
        status: 'done',
      },
      { type: 'system', ...base, system_id: 'y1', subtype: 'notice' },
      { type: 'interaction', ...base, interaction_id: 'i1', status: 'pending', kind: 'approval' },
      {
        type: 'task',
        ...base,
        task_id: 'k1',
        kind: 'shell',
        status: 'running',
        detached: false,
        output_tail: '',
      },
      { type: 'todo', ...base, todo_id: 'd1', items: [] },
    ];
    for (const message of persisted) {
      expect(v3HistoryMessageSchema.safeParse(message).success, message.type).toBe(true);
    }

    // Deltas and globals are live-only: a history page carrying one is a
    // server bug, not a message to render.
    for (const liveOnly of [
      { type: 'assistant.delta', ...base, message_id: 'm', text: 'x' },
      { type: 'tool.progress', ...base, tool_call_id: 'c', progress: { kind: 'stdout' } },
      { type: 'session.state', session_id: 's1', timestamp: 1, status: 'idle' },
      { type: 'hello', protocol_version: '3', server_id: 'srv', capabilities: [] },
    ]) {
      expect(v3HistoryMessageSchema.safeParse(liveOnly).success, liveOnly.type).toBe(false);
    }
  });

  it('types the interaction request and response payloads', () => {
    const approvalFrame = v3HistoryMessageSchema.parse({
      type: 'interaction',
      session_id: 's1',
      agent_id: 'main',
      timestamp: 1,
      interaction_id: 'i1',
      status: 'pending',
      kind: 'approval',
      tool_call_id: 'c1',
      request: {
        tool_name: 'ExitPlanMode',
        action: 'review',
        tool_input_display: {
          kind: 'plan_review',
          plan: '# Plan',
          path: '/tmp/plan.md',
          options: [{ label: 'approve', description: 'go ahead' }],
        },
      },
    });
    if (approvalFrame.type !== 'interaction') throw new Error('unreachable');
    const approval: InteractionMessage = approvalFrame;
    expect(approval.kind).toBe('approval');
    if (approval.kind !== 'approval') throw new Error('unreachable');
    expect(approval.request?.tool_input_display?.kind).toBe('plan_review');

    const answeredFrame = v3HistoryMessageSchema.parse({
      type: 'interaction',
      session_id: 's1',
      agent_id: 'main',
      timestamp: 2,
      interaction_id: 'i2',
      status: 'answered',
      kind: 'question',
      request: {
        questions: [
          {
            id: 'q1',
            question: 'Which one?',
            options: [{ id: 'a', label: 'A' }],
          },
        ],
      },
      response: { answers: { q1: { kind: 'single', option_id: 'a' } }, method: 'click' },
    });
    if (answeredFrame.type !== 'interaction') throw new Error('unreachable');
    const answered: InteractionMessage = answeredFrame;
    expect(answered.kind).toBe('question');
    if (answered.kind !== 'question') throw new Error('unreachable');
    expect(answered.response?.answers['q1']).toEqual({ kind: 'single', option_id: 'a' });

    // An approval response is the shared approval schema, so a decision the
    // REST surface would reject is rejected here too.
    expect(
      v3ServerMessageSchema.safeParse({
        type: 'interaction',
        session_id: 's1',
        agent_id: 'main',
        timestamp: 3,
        interaction_id: 'i3',
        status: 'approved',
        kind: 'approval',
        response: { decision: 'maybe' },
      }).success,
    ).toBe(false);
  });

  it('types the tool call display and progress payloads', () => {
    const callFrame = v3HistoryMessageSchema.parse({
      type: 'tool_call',
      session_id: 's1',
      agent_id: 'main',
      timestamp: 1,
      tool_call_id: 'c1',
      turn_id: '1',
      step_id: '1.1',
      name: 'Bash',
      status: 'running',
      display: { kind: 'command', command: 'ls' },
      progress: { kind: 'stdout', text: 'a\n', percent: 50 },
      agent_refs: [{ agent_id: 'child-1', role: 'child' }],
    });
    if (callFrame.type !== 'tool_call') throw new Error('unreachable');
    const call: ToolCallMessage = callFrame;
    expect(call.display?.kind).toBe('command');
    expect(call.progress?.kind).toBe('stdout');

    expect(
      v3ServerMessageSchema.safeParse({
        type: 'tool.progress',
        session_id: 's1',
        agent_id: 'main',
        timestamp: 2,
        tool_call_id: 'c1',
        progress: { kind: 'nonsense' },
      }).success,
    ).toBe(false);
  });
});
