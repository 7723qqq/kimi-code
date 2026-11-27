import { afterEach, describe, expect, test } from 'bun:test';

import { createUserMessage } from '@moonshot-ai/core/llm/message';
import { IAgentLoopService } from '#/agent/loop/loop';
import { runOperationRequest } from '#/agent/loop/operationRequest';
import { createTestAgent, type TestAgentContext } from '../../harness';

const agents: TestAgentContext[] = [];

afterEach(async () => {
  for (const agent of agents.splice(0)) {
    await agent.dispose();
  }
});

function newAgent(): TestAgentContext {
  const agent = createTestAgent();
  agents.push(agent);
  return agent;
}

describe('loop requester', () => {
  test('sends an operation request through the loop requester and records it as an llm call', async () => {
    const agent = newAgent();
    agent.mockNextResponse({ type: 'text', text: 'summary' });
    const loop = agent.get(IAgentLoopService);
    const outcome = await runOperationRequest(loop.requester, {
      messages: [createUserMessage('summarize the change')],
      profile: { systemPrompt: 'operation-specific system' },
      maxOutputTokens: 128,
      attributes: { kind: 'operation-test', logFields: { turnStep: '7.2' } },
    });
    expect(outcome.type).toBe('done');
    expect(agent.llmCalls).toHaveLength(1);
    expect(agent.llmCalls[0]!.systemPrompt).toBe('operation-specific system');
    expect(agent.llmCalls[0]!.history.at(-1)).toMatchObject({
      role: 'user',
      content: [{ type: 'text', text: 'summarize the change' }],
    });
  });

  test('binds the loop turn and step on a turn request', async () => {
    const agent = newAgent();
    agent.mockNextResponse({ type: 'text', text: 'hi' });
    const loop = agent.get(IAgentLoopService);
    await agent.rpc.prompt({ input: [{ type: 'text', text: 'hello' }] });
    await agent.untilTurnEnd();
    expect(agent.llmCalls).toHaveLength(1);
    expect(agent.llmCalls[0]!.history.at(-1)).toMatchObject({ role: 'user' });
    expect(loop.historyRevision()).toBe(0);
    const requestRecord = agent.allEvents.find(
      (event) => event.type === '[wire]' && event.event === 'llm.request',
    );
    expect(requestRecord?.args).toMatchObject({ turnStep: '0.1' });
  });

  test('surfaces a failed operation outcome as a thrown provider error', async () => {
    const agent = newAgent();
    const loop = agent.get(IAgentLoopService);
    const controller = new AbortController();
    controller.abort(new Error('cancelled before the request'));
    await expect(
      runOperationRequest(
        loop.requester,
        { messages: [createUserMessage('never sent')] },
        { signal: controller.signal },
      ),
    ).rejects.toThrow();
    expect(agent.llmCalls).toHaveLength(0);
  });

  test('preserves the caller signal on the generated request', async () => {
    const agent = newAgent();
    agent.mockNextResponse({ type: 'text', text: 'ok' });
    const loop = agent.get(IAgentLoopService);
    const controller = new AbortController();
    const outcome = await runOperationRequest(
      loop.requester,
      { messages: [createUserMessage('with signal')] },
      { signal: controller.signal },
    );
    expect(outcome.type).toBe('done');
    expect(controller.signal.aborted).toBe(false);
  });
});
