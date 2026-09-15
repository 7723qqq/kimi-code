import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ENTITY_ID_FIELDS,
  v3ClientFrameSchema,
  v3EntityKey,
  v3HistoryQuerySchema,
  v3HistoryResponseSchema,
  v3ServerMessageSchema,
} from '../v3';

type ContractField = {
  name: string;
  kind: string;
  optional: boolean;
  nullable: boolean;
  variants?: string[];
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
    default:
      // Upstream's nested objects that discriminate themselves — `turn.origin`,
      // `tool.progress.progress` — need their key present. Everything else the
      // schemas keep opaque, so any object satisfies them.
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
    expect(v3ClientFrameSchema.safeParse({ type: 'unsubscribe', id: 2, session_id: 's1' }).success).toBe(true);
    expect(v3ClientFrameSchema.safeParse({ type: 'subscribe', session_id: 's1' }).success).toBe(
      false,
      'a subscribe without an id has no ack to correlate',
    );
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
    expect(v3ServerMessageSchema.parse({ type: 'ack', id: 7, code: 40401 }).code).toBe(40401);
    expect(v3ServerMessageSchema.parse({ type: 'error', code: 40002, msg: 'not json' }).code).toBe(
      40002,
    );
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
});
