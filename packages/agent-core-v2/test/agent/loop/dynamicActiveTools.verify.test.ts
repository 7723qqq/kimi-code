import { afterEach, describe, expect, test } from 'bun:test';

import { createUserMessage } from '@moonshot-ai/core/llm/message';
import { contextFromHistoryEntry, historyFromContext } from '#/agent/loop/history';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { IAgentUserToolService } from '#/agent/userTool/userTool';
import type { ExecutableTool } from '#/tool/toolContract';

import { createTestAgent, type GenerateCall, type TestAgentContext } from '../../harness';

const agents: TestAgentContext[] = [];

function newAgent(): TestAgentContext {
  const agent = createTestAgent();
  agents.push(agent);
  return agent;
}

afterEach(async () => {
  for (const agent of agents.splice(0)) {
    await agent.dispose();
  }
});

function executableTool(name: string): ExecutableTool<Record<string, unknown>> {
  return {
    name,
    description: `${name} verification tool.`,
    parameters: { type: 'object', properties: {} },
    resolveExecution: () => ({
      description: `${name} verification tool.`,
      approvalRule: name,
      execute: async () => ({ output: 'ok' }),
    }),
  };
}

function toolNames(request: GenerateCall): string[] {
  return request.tools.map((tool) => tool.name);
}

function stripWallTime(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.startsWith('Wall time: ') ? value.slice(value.indexOf('\n') + 1) : value;
  }
  if (Array.isArray(value)) return value.map(stripWallTime);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, stripWallTime(entry)]));
  }
  return value;
}

describe('dynamic active tools', () => {
  test('keeps turn and operation request tools frozen at the loop-start baseline', async () => {
    const agent = newAgent();
    const loop = agent.get(IAgentLoopService);
    const registry = agent.get(IAgentToolRegistryService);
    const userTools = agent.get(IAgentUserToolService);

    agent.mockNextResponse({ type: 'text', text: 'turn one' });
    agent.mockNextResponse({ type: 'text', text: 'turn two' });
    agent.mockNextResponse({ type: 'text', text: 'turn three' });
    agent.mockNextResponse({ type: 'text', text: 'operation done' });

    await agent.rpc.prompt({ input: [{ type: 'text', text: 'first' }] });
    await agent.untilTurnEnd();
    const first = toolNames(agent.llmCalls[0]!);
    expect(first).toContain('Read');

    loop.update({ activeToolNames: [...first] });
    registry.register(executableTool('TowerMid'));
    loop.addActiveTool('TowerMid');
    userTools.register({
      name: 'UserMid',
      description: 'UserMid tool.',
      parameters: { type: 'object', properties: {} },
    });
    expect(loop.getActiveToolNames()).toContain('TowerMid');
    expect(userTools.list().map((tool) => tool.name)).toContain('UserMid');

    await agent.rpc.prompt({ input: [{ type: 'text', text: 'second' }] });
    await agent.untilTurnEnd();
    expect(toolNames(agent.llmCalls[1]!)).toEqual(first);

    loop.removeActiveTool('Read');
    expect(loop.getActiveToolNames()).not.toContain('Read');

    await agent.rpc.prompt({ input: [{ type: 'text', text: 'third' }] });
    await agent.untilTurnEnd();
    expect(toolNames(agent.llmCalls[2]!)).toEqual(first);

    userTools.unregister('UserMid');
    const signal = new AbortController().signal;
    const requester = await loop.requester.prepareOperation(
      { source: () => ({ type: 'operation', requestKind: 'verify_active_tools' }) },
      signal,
    );
    await requester.generate(
      { content: { messages: [{ role: 'user', content: [{ type: 'text', text: 'summarize' }] }] }, profile: {} },
      { signal },
    );
    expect(agent.llmCalls).toHaveLength(4);
    expect(toolNames(agent.llmCalls[3]!)).toEqual(first);
  });

  test('keeps the compaction-style operation request prefix-aligned with the turn request', async () => {
    const agent = newAgent();
    const loop = agent.get(IAgentLoopService);
    const lookupTool: ExecutableTool<{ query: string }> = {
      name: 'Lookup',
      description: 'Look up a short test value.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
        additionalProperties: false,
      },
      resolveExecution: () => ({
        approvalRule: 'Lookup',
        execute: async () => ({ output: 'lookup-result' }),
      }),
    };
    agent.get(IAgentToolRegistryService).register(lookupTool);

    agent.mockNextResponse(
      { type: 'text', text: 'I will look it up.' },
      { type: 'function', id: 'call_1', name: 'Lookup', arguments: '{"query":"moon"}' },
    );
    agent.mockNextResponse({ type: 'text', text: 'The lookup result is lookup-result.' });
    agent.mockNextResponse({ type: 'text', text: 'summary' });

    await agent.rpc.prompt({ input: [{ type: 'text', text: 'Look up moon' }] });
    await agent.untilApproval(true);
    await agent.untilTurnEnd();
    expect(agent.llmCalls).toHaveLength(2);
    const turn = agent.llmCalls[1]!;

    loop.update({ activeToolNames: [...toolNames(turn), 'Lookup'] });
    loop.removeActiveTool('Read');
    expect(loop.getActiveToolNames()).not.toContain('Read');

    const instruction = createUserMessage('Compact the conversation.');
    const messages = historyFromContext([...loop.history(), contextFromHistoryEntry(instruction)]);
    const signal = new AbortController().signal;
    const requester = await loop.requester.prepareOperation(
      { source: () => ({ type: 'operation', requestKind: 'full_compaction' }) },
      signal,
    );
    await requester.generate({ content: { messages }, profile: {} }, { signal });

    expect(agent.llmCalls).toHaveLength(3);
    const operation = agent.llmCalls[2]!;
    expect(operation.systemPrompt).toBe(turn.systemPrompt);
    expect(operation.tools).toEqual(turn.tools);
    expect(operation.history.length).toBe(turn.history.length + 2);
    expect(stripWallTime(operation.history.slice(0, turn.history.length))).toEqual(stripWallTime(turn.history));
  });
});
