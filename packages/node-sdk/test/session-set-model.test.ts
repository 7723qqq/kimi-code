import { join } from 'node:path';

import { FileTokenStorage, type TokenInfo } from '@moonshot-ai/kimi-code-oauth';
import { afterEach, describe, expect, it } from 'vitest';

import { createKimiHarness, type KimiError, type KimiHarness, type Session } from '#/index';
import { makeTempDir, removeTempDirs, waitForSDKEvent } from './session-runtime-helpers';
import { TEST_IDENTITY } from './test-identity';

const tempDirs: string[] = [];

function freshToken(): TokenInfo {
  return {
    accessToken: 'oauth-access-token',
    refreshToken: 'oauth-refresh-token',
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    scope: '',
    tokenType: 'Bearer',
    expiresIn: 3600,
  };
}

afterEach(async () => {
  await removeTempDirs(tempDirs);
});

describe('Session.setModel', () => {
  it('updates the runtime model and sends config.update with the resolved model', async () => {
    const homeDir = await makeTempDir(tempDirs, 'kimi-sdk-model-home-');
    const workDir = await makeTempDir(tempDirs, 'kimi-sdk-model-work-');
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    try {
      await configureLocalProvider(harness);
      const session = await harness.createSession({
        id: 'ses_model_wire',
        workDir,
        model: 'initial-model',
      });

      const statusUpdated = waitForSDKEvent(
        session,
        (event) => event.type === 'agent.status.updated',
      );
      await session.setModel('next-model');

      await expect(session.getStatus()).resolves.toMatchObject({ model: 'next-model' });
      // v2 recorded the rebinding as a `config.update` wire record; the native
      // harness publishes the runtime status event instead.
      await expect(statusUpdated).resolves.toMatchObject({
        type: 'agent.status.updated',
        model: 'next-model',
      });
    } finally {
      await harness.close();
    }
  });

  it('resolves managed OAuth aliases before updating the runtime provider', async () => {
    const homeDir = await makeTempDir(tempDirs, 'kimi-sdk-model-home-');
    const workDir = await makeTempDir(tempDirs, 'kimi-sdk-model-work-');
    await new FileTokenStorage(join(homeDir, 'credentials')).save('kimi-code', freshToken());
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    try {
      await harness.setConfig({
        providers: {
          'managed:kimi-code': {
            type: 'kimi',
            baseUrl: 'https://api.kimi.com/coding/v1',
            apiKey: '',
            oauth: { storage: 'file', key: 'oauth/kimi-code' },
          },
        },
        models: {
          'kimi-code/initial': {
            provider: 'managed:kimi-code',
            model: 'kimi-initial',
            maxContextSize: 262144,
          },
          'kimi-code/kimi-for-coding': {
            provider: 'managed:kimi-code',
            model: 'kimi-for-coding',
            maxContextSize: 262144,
          },
        },
        defaultModel: 'kimi-code/initial',
      });
      const session = await harness.createSession({
        id: 'ses_model_oauth_wire',
        workDir,
        model: 'kimi-code/initial',
      });

      const statusUpdated = waitForSDKEvent(
        session,
        (event) => event.type === 'agent.status.updated',
      );
      await session.setModel('kimi-code/kimi-for-coding');

      await expect(session.getStatus()).resolves.toMatchObject({
        model: 'kimi-code/kimi-for-coding',
      });
      // v2 recorded the rebinding as a `config.update` wire record; the native
      // harness publishes the runtime status event instead.
      await expect(statusUpdated).resolves.toMatchObject({
        type: 'agent.status.updated',
        model: 'kimi-code/kimi-for-coding',
      });
    } finally {
      await harness.close();
    }
  });

  it('rejects empty model names', async () => {
    const homeDir = await makeTempDir(tempDirs, 'kimi-sdk-model-home-');
    const workDir = await makeTempDir(tempDirs, 'kimi-sdk-model-work-');
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    try {
      await configureLocalProvider(harness);
      const session = await harness.createSession({ id: 'ses_model_empty', workDir });

      await expect(session.setModel('   ')).rejects.toMatchObject({
        name: 'KimiError',
        code: 'session.model_empty',
      } satisfies Partial<KimiError>);
    } finally {
      await harness.close();
    }
  });

  it('rolls the model back when the rebuild fails', async () => {
    // `applyRebuiltSetting` must restore the previous field: without the
    // rollback a failed `setModel` left `meta.model` naming a model the engine
    // never switched to, so the TUI reported a change that had not happened.
    const homeDir = await makeTempDir(tempDirs, 'kimi-sdk-model-home-');
    const workDir = await makeTempDir(tempDirs, 'kimi-sdk-model-work-');
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    try {
      const session = await createSessionWithFailingRebuild(harness, workDir);

      await expect(session.setModel('no-such-model')).rejects.toThrow();

      await expect(session.getStatus()).resolves.toMatchObject({ model: 'initial-model' });
    } finally {
      await harness.close();
    }
  });

  it('keeps the session handle alive when the rebuild fails', async () => {
    // `rebuildHandle` used to dispose the old engine handle *before* building
    // the new one, so a build that threw left `meta.handle` undefined: every
    // later prompt reported `session.not_found` ("cannot prompt unknown or
    // closed session") for a session that was still live and still listed.
    const homeDir = await makeTempDir(tempDirs, 'kimi-sdk-model-home-');
    const workDir = await makeTempDir(tempDirs, 'kimi-sdk-model-work-');
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    try {
      const session = await createSessionWithFailingRebuild(harness, workDir);

      await expect(session.setModel('no-such-model')).rejects.toThrow();

      // The prompt is admitted instead of being rejected as an unknown
      // session. `prompt` only resolves once the turn is enqueued — the turn
      // itself then fails at the provider, asynchronously.
      const failure = await session.prompt('hello').then(
        () => undefined,
        (error: unknown) => error as { code?: string },
      );
      expect(failure).toBeUndefined();
    } finally {
      await harness.close();
    }
  });

  it('rejects after the session is closed', async () => {
    const homeDir = await makeTempDir(tempDirs, 'kimi-sdk-model-home-');
    const workDir = await makeTempDir(tempDirs, 'kimi-sdk-model-work-');
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    try {
      await configureLocalProvider(harness);
      const session = await harness.createSession({ id: 'ses_model_closed', workDir });
      await session.close();

      await expect(session.setModel('next-model')).rejects.toMatchObject({
        name: 'KimiError',
        code: 'session.closed',
      } satisfies Partial<KimiError>);
    } finally {
      await harness.close();
    }
  });
});

/**
 * Creates a session whose next `rebuildHandle` is guaranteed to fail. The
 * provider points at a closed port, and `rustSelfContained` makes the engine
 * refuse the host LLM proxy, so an alias that resolves to no native LLM fails
 * the rebuild. `rustSelfContained` is set after the session exists — it would
 * fail `createSession` too.
 */
async function createSessionWithFailingRebuild(
  harness: KimiHarness,
  workDir: string,
): Promise<Session> {
  await harness.setConfig({
    providers: {
      local: { type: 'openai', apiKey: 'sk-test', baseUrl: 'http://127.0.0.1:1/v1' },
    },
    models: {
      'initial-model': { provider: 'local', model: 'initial-model', maxContextSize: 262144 },
    },
    defaultProvider: 'local',
  });
  const session = await harness.createSession({
    id: 'ses_model_rebuild_fail',
    workDir,
    model: 'initial-model',
  });
  await harness.setConfig({ agent: { rustSelfContained: true } });
  return session;
}

async function configureLocalProvider(harness: KimiHarness): Promise<void> {
  await harness.setConfig({
    providers: {
      local: {
        type: 'kimi',
        apiKey: 'sk-test',
      },
    },
    models: {
      'initial-model': {
        provider: 'local',
        model: 'initial-model',
        maxContextSize: 262144,
      },
      'next-model': {
        provider: 'local',
        model: 'next-model',
        maxContextSize: 262144,
      },
    },
    defaultProvider: 'local',
  });
}
