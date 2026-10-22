import { createRequire } from 'node:module';

import type * as KosongModule from '@moonshot-ai/kosong';
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

import { createKimiHarness, type KimiError } from '#/index';

import { makeTempDir, removeTempDirs } from './session-runtime-helpers';
import { TEST_IDENTITY } from './test-identity';

// Read by the fake provider's `generate`, which is why it lives at module scope
// instead of inside the mock factory.
const fakeProviderState = {
  responseText: 'steer response',
};

// Bun calls the factory with no arguments and a module cannot import the
// specifier it is replacing, so the real namespace comes from `createRequire`.
void mock.module('@moonshot-ai/kosong', () => {
  const actual = createRequire(import.meta.url)('@moonshot-ai/kosong') as typeof KosongModule;
  return {
    ...actual,
    createProvider: () => ({
      name: 'fake',
      modelName: 'fake-model',
      thinkingEffort: null,
      async generate() {
        return {
          id: 'fake-response',
          usage: {
            inputOther: 0,
            output: 1,
            inputCacheRead: 0,
            inputCacheCreation: 0,
          },
          finishReason: 'completed',
          rawFinishReason: 'stop',
          async *[Symbol.asyncIterator]() {
            yield { type: 'text', text: fakeProviderState.responseText };
          },
        };
      },
      withThinking() {
        return this;
      },
    }),
  };
});

const tempDirs: string[] = [];

beforeEach(() => {
  fakeProviderState.responseText = 'steer response';
});

afterEach(async () => {
  await removeTempDirs(tempDirs);
});

describe('Session.steer', () => {
  it('launches a fresh turn off an idle steer (v1 parity)', async () => {
    const homeDir = await makeTempDir(tempDirs, 'kimi-sdk-steer-home-');
    const workDir = await makeTempDir(tempDirs, 'kimi-sdk-steer-work-');
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    try {
      const session = await harness.createSession({ id: 'ses_steer_wire', workDir });

      // v1 treats an idle steer like a prompt — it launches a fresh turn and
      // updates title/lastPrompt. v2's steer enqueues first (which itself
      // launches the turn) and converges on the same end state: the launched
      // turn is returned instead of rejecting.
      await expect(session.steer('also do this')).resolves.toBeUndefined();
      const listed = await harness.listSessions({ workDir });
      const steered = listed.find((item) => item.id === 'ses_steer_wire');
      expect(steered?.title).toBe('also do this');
      expect(steered?.lastPrompt).toBe('also do this');
    } finally {
      await harness.close();
    }
  });

  it('rejects empty steer input', async () => {
    const homeDir = await makeTempDir(tempDirs, 'kimi-sdk-steer-home-');
    const workDir = await makeTempDir(tempDirs, 'kimi-sdk-steer-work-');
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    try {
      const session = await harness.createSession({ id: 'ses_steer_empty', workDir });

      await expect(session.steer('   ')).rejects.toMatchObject({
        name: 'KimiError',
        code: 'request.prompt_input_empty',
      } satisfies Partial<KimiError>);
    } finally {
      await harness.close();
    }
  });

  it('rejects after the session is closed', async () => {
    const homeDir = await makeTempDir(tempDirs, 'kimi-sdk-steer-home-');
    const workDir = await makeTempDir(tempDirs, 'kimi-sdk-steer-work-');
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    try {
      const session = await harness.createSession({ id: 'ses_steer_closed', workDir });
      await session.close();

      await expect(session.steer('hello')).rejects.toMatchObject({
        name: 'KimiError',
        code: 'session.closed',
      } satisfies Partial<KimiError>);
    } finally {
      await harness.close();
    }
  });
});
