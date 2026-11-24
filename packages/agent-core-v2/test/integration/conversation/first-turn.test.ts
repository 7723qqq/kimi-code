import { expect, it } from 'bun:test';

import { createTestAgent } from '../../harness';

it('[L0:core.first-turn] finishes a first turn and carries the exchange into the next model request', async () => {
  const agent = createTestAgent();
  try {
    agent.mockNextResponse({ type: 'text', text: 'Hello from the agent.' });
    agent.mockNextResponse({ type: 'text', text: 'I remember.' });

    for (const question of ['Hello', 'Do you remember?']) {
      await agent.rpc.prompt({ input: [{ type: 'text', text: question }] });
      expect(await agent.untilTurnEnd()).toContainEqual(expect.objectContaining({
        event: 'turn.ended',
        args: expect.objectContaining({ reason: 'completed' }),
      }));
    }
    expect(agent.llmCalls).toHaveLength(2);
    expect(agent.llmCalls[1]?.history).toMatchObject([
      { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Hello from the agent.' }] },
      { role: 'user', content: [{ type: 'text', text: 'Do you remember?' }] },
    ]);
  } finally {
    await agent.dispose();
  }
});
