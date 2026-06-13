import { describe, expect, it } from 'vitest';
import { messagesToTurns } from '../src/composables/messagesToTurns';
import type { AppMessage, AppTask } from '../src/api/types';

const now = '2026-06-13T00:00:00.000Z';

describe('messagesToTurns agent blocks', () => {
  it('renders one subagent task as an agent block', () => {
    const messages: AppMessage[] = [
      {
        id: 'msg_1',
        sessionId: 'ses_1',
        role: 'assistant',
        promptId: 'pr_1',
        createdAt: now,
        content: [
          { type: 'text', text: 'starting review' },
          { type: 'toolUse', toolCallId: 'tc_agent', toolName: 'agent', input: { description: 'review' } },
        ],
      },
    ];
    const tasks: AppTask[] = [
      {
        id: 'agent_1',
        sessionId: 'ses_1',
        kind: 'subagent',
        description: 'Review code',
        status: 'running',
        createdAt: now,
        subagentPhase: 'working',
        subagentType: 'coder',
        parentToolCallId: 'tc_agent',
      },
    ];

    const turns = messagesToTurns(messages, [], undefined, true, tasks);
    expect(turns[0]?.blocks?.[1]).toEqual({
      kind: 'agent',
      member: expect.objectContaining({
        id: 'agent_1',
        name: 'Review code',
        phase: 'working',
        subagentType: 'coder',
      }),
    });
    expect(turns[0]?.tools).toBeUndefined();
  });

  it('renders multiple subagent tasks with the same parent tool as an agentGroup block', () => {
    const messages: AppMessage[] = [
      {
        id: 'msg_1',
        sessionId: 'ses_1',
        role: 'assistant',
        promptId: 'pr_1',
        createdAt: now,
        content: [
          { type: 'toolUse', toolCallId: 'tc_swarm', toolName: 'agent_swarm', input: { description: 'review', count: 2 } },
        ],
      },
    ];
    const tasks: AppTask[] = [
      {
        id: 'agent_b',
        sessionId: 'ses_1',
        kind: 'subagent',
        description: 'Second',
        status: 'running',
        createdAt: now,
        subagentPhase: 'queued',
        parentToolCallId: 'tc_swarm',
        swarmIndex: 2,
      },
      {
        id: 'agent_a',
        sessionId: 'ses_1',
        kind: 'subagent',
        description: 'First',
        status: 'completed',
        createdAt: now,
        subagentPhase: 'completed',
        parentToolCallId: 'tc_swarm',
        swarmIndex: 1,
      },
    ];

    const turns = messagesToTurns(messages, [], undefined, false, tasks);
    const block = turns[0]?.blocks?.[0];
    expect(block?.kind).toBe('agentGroup');
    if (block?.kind !== 'agentGroup') return;
    expect(block.members.map((member) => member.id)).toEqual(['agent_a', 'agent_b']);
    expect(block.members.map((member) => member.phase)).toEqual(['completed', 'queued']);
  });
});
