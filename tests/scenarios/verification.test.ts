import { rejects } from 'node:assert/strict';

import { runFixtures } from '@moonshot-ai/testkit/bun';
import { held, say } from '@moonshot-ai/testkit/model';
import { expect, spyOn, test } from 'bun:test';

import { scenarioFixtures, type ScenarioFixtures } from './support/scenario';

test('fails a scenario that leaves a reached hold unreleased', async () => {
  await rejects(runFixtures<ScenarioFixtures>('unreleased hold', scenarioFixtures(), async ({ kap, model }) => {
    model.script(held('forgotten', say('late')));
    const session = await kap.createSession();
    await kap.prompt(session.id, 'go');
    await model.hold('forgotten').reached();
  }), /hold "forgotten" was reached by request #0 but never released, failed, or cut/);
});

test('passes the same scenario once it releases the hold', async () => {
  await runFixtures<ScenarioFixtures>('released hold', scenarioFixtures(), async ({ kap, model }) => {
    model.script(held('released', say('late')));
    const session = await kap.createSession();
    await kap.prompt(session.id, 'go');
    await model.hold('released').reached();
    model.hold('released').release();
    await kap.waitIdle(session.id);
  });
});

test('reports model requests, WebSocket frames and server logs when teardown fails', async () => {
  const write = spyOn(process.stderr, 'write').mockReturnValue(true);
  try {
    await rejects(runFixtures<ScenarioFixtures>('diagnostic failure', scenarioFixtures(), async ({ kap, model }) => {
      model.script(held('unfinished', say('later')));
      const session = await kap.createSession();
      const socket = await kap.connect();
      await socket.subscribe(session.id);
      await kap.cancel(session.id);
      await kap.prompt(session.id, 'diagnostic request');
      await model.hold('unfinished').reached();
      await socket.waitFor((frame) => frame.type === 'turn.started');
    }), /hold "unfinished"/);
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
  await runFixtures<ScenarioFixtures>('failed agent subscription', scenarioFixtures(), async ({ kap }) => {
    const socket = await kap.connect();
    const session = await kap.createSession();
    await socket.subscribe(session.id);
    await socket.subscribe(session.id);
    await rejects(socket.subscribe(session.id, { agentIds: ['main', 'missing-agent'] }), (error: unknown) => {
      expect(error).toMatchObject({
        name: 'KapCommandError',
        response: { type: 'turns.failed', session_id: session.id, agent_id: 'missing-agent', msg: 'agent not found: missing-agent' },
      });
      return true;
    });
    expect(socket.frames.filter((frame) => frame.type === 'turns')).toHaveLength(1);
  });
});
