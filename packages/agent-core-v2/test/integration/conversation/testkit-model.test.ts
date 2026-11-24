import { afterEach, expect, test } from 'bun:test';

import { createTestAgent, type TestAgentContext } from '../../harness';

interface ModelMessage {
  readonly role: string;
  readonly text: string;
}

interface ModelRequest {
  readonly state: string;
  readonly view: { readonly messages: readonly ModelMessage[] };
  texts(role: string): readonly string[];
}

interface FakeModel {
  readonly baseUrl: string;
  script(...steps: readonly unknown[]): unknown;
  hold(name: string): {
    reached(options?: { readonly timeoutMs?: number }): Promise<void>;
    release(): void;
  };
  requests(lane?: string): readonly ModelRequest[];
  verify(): void;
  close(): Promise<void>;
}

interface TestkitModelModule {
  startFakeModel(): Promise<FakeModel>;
  say(text: string | readonly string[]): unknown;
  held(name: string, step: unknown, beforeUnit?: number): unknown;
}

const testkit = (await import('@moonshot-ai/testkit/model' as string)) as TestkitModelModule;
const { held, say, startFakeModel } = testkit;

const agents: TestAgentContext[] = [];
const models: FakeModel[] = [];

afterEach(async () => {
  for (const agent of agents.splice(0)) await agent.dispose();
  for (const model of models.splice(0)) await model.close();
});

async function testkitAgent(): Promise<{ agent: TestAgentContext; model: FakeModel }> {
  const model = await startFakeModel();
  models.push(model);
  const agent = createTestAgent({
    model: { baseUrl: model.baseUrl, apiKey: 'test-key', model: 'testkit-model' },
  });
  agents.push(agent);
  return { agent, model };
}

const completed = expect.objectContaining({
  event: 'turn.ended',
  args: expect.objectContaining({ reason: 'completed' }),
});

test('drives the engine from the shared testkit script and reads the request the provider sent', async () => {
  const { agent, model } = await testkitAgent();
  model.script(say('Hello from the agent.'), say('I remember.'));
  for (const question of ['Hello', 'Do you remember?']) {
    await agent.rpc.prompt({ input: [{ type: 'text', text: question }] });
    expect(await agent.untilTurnEnd()).toContainEqual(completed);
  }
  const requests = model.requests('main');
  expect(requests).toHaveLength(2);
  expect(requests[1]!.view.messages.map(({ role, text }) => ({ role, text }))).toEqual([
    { role: 'user', text: 'Hello' },
    { role: 'assistant', text: 'Hello from the agent.' },
    { role: 'user', text: 'Do you remember?' },
  ]);
  model.verify();
});

test('holds the provider stream at a named point until the test releases it', async () => {
  const { agent, model } = await testkitAgent();
  model.script(held('after-first-chunk', say(['Hel', 'lo']), 1), say('Still here.'));
  await agent.rpc.prompt({ input: [{ type: 'text', text: 'Hi' }] });
  await model.hold('after-first-chunk').reached();
  expect(model.requests('main')[0]!.state).toBe('held');
  model.hold('after-first-chunk').release();
  expect(await agent.untilTurnEnd()).toContainEqual(completed);
  await agent.rpc.prompt({ input: [{ type: 'text', text: 'Again' }] });
  expect(await agent.untilTurnEnd()).toContainEqual(completed);
  expect(model.requests('main')[1]!.texts('assistant')).toEqual(['Hello']);
  model.verify();
});

test('refuses the built-in mock API on an agent driven by the testkit model', async () => {
  const { agent } = await testkitAgent();
  const refused = /belongs to the built-in harness model, but this agent uses the testkit model/;
  expect(() => agent.mockNextResponse({ type: 'text', text: 'ignored' })).toThrow(refused);
  expect(() => agent.llmCalls).toThrow(refused);
  expect(() => agent.lastLlmInput()).toThrow(refused);
  expect(() => agent.llmInputs()).toThrow(refused);
});

test('fails an engine test that leaves a scripted reply unused', async () => {
  const { model } = await testkitAgent();
  model.script(say('never requested'));
  expect(() => model.verify()).toThrow(/lane "main" has 1 unused step\(s\)/);
});

test('fails an engine test that leaves a reached hold unreleased', async () => {
  const { agent, model } = await testkitAgent();
  model.script(held('forgotten', say('late')));
  await agent.rpc.prompt({ input: [{ type: 'text', text: 'go' }] });
  await model.hold('forgotten').reached();
  expect(() => model.verify()).toThrow(/hold "forgotten" was reached by request #0 but never released, failed, or cut/);
});
