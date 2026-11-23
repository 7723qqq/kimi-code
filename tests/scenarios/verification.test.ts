import { expect, spyOn, test } from 'bun:test';
import { createFixtureContext } from '@moonshot-ai/testkit/bun';
import { held, say } from '@moonshot-ai/testkit/model';

import { scenarioFixtures } from './support/scenario';

test('fails a scenario that leaves a reached hold unreleased', async () => {
  const fixtures = scenarioFixtures();
  const { context } = createFixtureContext('fails a scenario that leaves a reached hold unreleased');
  const run = fixtures.model(context, async (model) => {
    await fixtures.kap({ model }, async (kap) => {
      model.script(held('forgotten', say('late')));
      const session = await kap.createSession();
      await kap.prompt(session.id, 'go');
      await model.hold('forgotten').reached();
    });
  });
  await rejects(run, /hold "forgotten" was reached by request #0 but never released, failed, or cut/);
});

test('passes the same scenario once it releases the hold', async () => {
  const fixtures = scenarioFixtures();
  const { context } = createFixtureContext('passes the same scenario once it releases the hold');
  const run = fixtures.model(context, async (model) => {
    await fixtures.kap({ model }, async (kap) => {
      model.script(held('released', say('late')));
      const session = await kap.createSession();
      await kap.prompt(session.id, 'go');
      await model.hold('released').reached();
      model.hold('released').release();
      await kap.waitIdle(session.id);
    });
  });
  expect(await run).toBeUndefined();
});

test('reports model requests, WebSocket frames and server logs when teardown fails', async () => {
  const fixtures = scenarioFixtures();
  const { context } = createFixtureContext(
    'reports model requests, WebSocket frames and server logs when teardown fails',
  );
  const failureHooks: Parameters<typeof context.onTestFailed>[0][] = [];
  const run = fixtures.model({ ...context, onTestFailed: (hook) => { failureHooks.push(hook); } }, async (model) => {
    await fixtures.kap({ model }, async (kap) => {
      model.script(held('unfinished', say('later')));
      const session = await kap.createSession();
      const socket = await kap.connect();
      await socket.subscribe(session.id);
      await kap.cancel(session.id);
      await kap.prompt(session.id, 'diagnostic request');
      await model.hold('unfinished').reached();
      await socket.waitFor((frame) => frame.type === 'turn.started');
    });
  });
  await rejects(run, /hold "unfinished"/);
  const write = spyOn(process.stderr, 'write').mockReturnValue(true);
  try {
    for (const hook of failureHooks) await hook(context);
    const output = write.mock.calls.map(([message]) => String(message)).join('');
    expect(output).toContain('diagnostic request');
    expect(output).toContain('openai held');
    expect(output).toContain('turn.started');
    expect(output).toContain('session action completed');
    expect(output).not.toContain('authorization');
  } finally {
    write.mockRestore();
  }
});

test('subscribes to an existing KAP session twice and reports which requested agent failed', async () => {
  const fixtures = scenarioFixtures();
  const { context } = createFixtureContext(
    'subscribes to an existing KAP session twice and reports which requested agent failed',
  );
  await fixtures.model(context, async (model) => {
    await fixtures.kap({ model }, async (kap) => {
      const socket = await kap.connect();
      const session = await kap.createSession();
      await socket.subscribe(session.id);
      await socket.subscribe(session.id);
      await rejects(socket.subscribe(session.id, { agentIds: ['main', 'missing-agent'] }), {
        name: 'KapCommandError',
        response: { type: 'turns.failed', session_id: session.id, agent_id: 'missing-agent', msg: 'agent not found: missing-agent' },
      });
      expect(socket.frames.filter((frame) => frame.type === 'turns')).toHaveLength(1);
    });
  });
});

async function rejects(promise: Promise<unknown>, expected: RegExp | Record<string, unknown>): Promise<void> {
  let failure: unknown;
  try {
    await promise;
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeDefined();
  if (expected instanceof RegExp) {
    expect(String(failure)).toMatch(expected);
  } else {
    expect(failure).toMatchObject(expected);
  }
}
