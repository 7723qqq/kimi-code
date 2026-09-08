import { afterEach, describe, expect, it } from 'vitest';

import { createKimiHarness, type KimiError } from '#/index';

import { makeTempDir, removeTempDirs, waitForSDKEvent } from './session-runtime-helpers';
import { TEST_IDENTITY } from './test-identity';

const tempDirs: string[] = [];

afterEach(async () => {
  await removeTempDirs(tempDirs);
});

describe('Session.setThinking', () => {
  it('publishes the runtime status with the new thinking effort', async () => {
    const homeDir = await makeTempDir(tempDirs, 'kimi-sdk-thinking-home-');
    const workDir = await makeTempDir(tempDirs, 'kimi-sdk-thinking-work-');
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    try {
      const session = await harness.createSession({ id: 'ses_thinking_wire', workDir });

      const statusUpdated = waitForSDKEvent(
        session,
        (event) => event.type === 'agent.status.updated',
      );
      await session.setThinking('low');

      // v2 recorded the effort change as a `config.update` wire record; the
      // native harness publishes the runtime status event instead.
      await expect(statusUpdated).resolves.toMatchObject({
        type: 'agent.status.updated',
        thinkingEffort: 'low',
      });
      await expect(session.getStatus()).resolves.toMatchObject({ thinkingEffort: 'low' });
    } finally {
      await harness.close();
    }
  });

  it('rejects empty thinking efforts', async () => {
    const homeDir = await makeTempDir(tempDirs, 'kimi-sdk-thinking-home-');
    const workDir = await makeTempDir(tempDirs, 'kimi-sdk-thinking-work-');
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    try {
      const session = await harness.createSession({ id: 'ses_thinking_empty', workDir });

      await expect(session.setThinking('   ')).rejects.toMatchObject({
        name: 'KimiError',
        code: 'session.thinking_empty',
      } satisfies Partial<KimiError>);
    } finally {
      await harness.close();
    }
  });

  it('rejects after the session is closed', async () => {
    const homeDir = await makeTempDir(tempDirs, 'kimi-sdk-thinking-home-');
    const workDir = await makeTempDir(tempDirs, 'kimi-sdk-thinking-work-');
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    try {
      const session = await harness.createSession({ id: 'ses_thinking_closed', workDir });
      await session.close();

      await expect(session.setThinking('high')).rejects.toMatchObject({
        name: 'KimiError',
        code: 'session.closed',
      } satisfies Partial<KimiError>);
    } finally {
      await harness.close();
    }
  });
});
