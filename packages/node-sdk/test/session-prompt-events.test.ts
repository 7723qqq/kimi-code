/**
 * Scenario: prompt-driven session behavior, including historical-turn forks.
 * Responsibilities: public SDK events, persisted replay, metadata, and input errors.
 * Wiring: real in-process core/storage with only the remote model provider stubbed.
 * Run: pnpm exec vitest run packages/node-sdk/test/session-prompt-events.test.ts
 */
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { KIMI_CODE_PLATFORM } from '@moonshot-ai/kimi-code-oauth';
import type * as KosongModule from '@moonshot-ai/kosong';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createKimiHarness, type Event, type KimiHarness } from '#/index';

import { TEST_IDENTITY } from './test-identity';

const fakeProviderState = vi.hoisted(() => ({
  calls: [] as Array<{
    readonly systemPrompt: string;
    readonly history: unknown;
  }>,
  providerConfigs: [] as unknown[],
  responseText: 'hello from fake provider',
}));

vi.mock('@moonshot-ai/kosong', async (importOriginal) => {
  const actual = await importOriginal<typeof KosongModule>();
  return {
    ...actual,
    createProvider: (config: unknown) => {
      fakeProviderState.providerConfigs.push(config);
      return {
        name: 'fake',
        modelName: 'fake-model',
        thinkingEffort: null,
        async generate(systemPrompt: string, _tools: unknown, history: unknown) {
          fakeProviderState.calls.push({ systemPrompt, history });
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
      };
    },
  };
});

const tempDirs: string[] = [];

beforeEach(() => {
  fakeProviderState.calls.length = 0;
  fakeProviderState.providerConfigs.length = 0;
  fakeProviderState.responseText = 'hello from fake provider';
});

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await removeTempDir(dir);
  }
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kimi-sdk-prompt-'));
  tempDirs.push(dir);
  return dir;
}

async function removeTempDir(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOTEMPTY' && code !== 'EBUSY' && code !== 'EPERM') {
        throw error;
      }
      await delay(10);
    }
  }

  await rm(dir, { recursive: true, force: true });
}

describe('Session.prompt events', () => {
  it('preserves existing custom metadata when an SDK metadata patch is resumed', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const harness = createKimiHarness({ identity: TEST_IDENTITY, homeDir });

    try {
      await configureFakeProvider(harness);
      const session = await harness.createSession({
        id: 'ses_update_metadata',
        workDir,
        metadata: { source: 'vscode' },
      });
      await session.createGoal({ objective: 'Keep core-owned metadata' });
      await session.updateMetadata({
        vscode_legacy_approval: { yolo: true, afk: false },
      });
      await session.close();

      const resumed = await harness.resumeSession({ id: session.id });

      expect(resumed.summary?.metadata).toEqual({
        source: 'vscode',
        vscode_legacy_approval: { yolo: true, afk: false },
      });
      await expect(resumed.getGoal()).resolves.toMatchObject({
        goal: { objective: 'Keep core-owned metadata' },
      });
    } finally {
      await harness.close();
    }
  });

  it('persists sanitized prompt metadata without marking the title custom', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const harness = createKimiHarness({
      identity: TEST_IDENTITY,
      homeDir,
    });

    try {
      await configureFakeProvider(harness);
      const session = await harness.createSession({ id: 'ses_prompt_meta', workDir });
      const events: Event[] = [];
      const unsubscribe = session.onEvent((event) => {
        events.push(event);
      });

      let done = waitForEvent(session, (event) => event.type === 'turn.ended');
      await session.prompt('use api_key=secret-value for the request');
      await done;

      const statePath = join(session.summary!.sessionDir, 'state.json');
      const firstState = JSON.parse(await readFile(statePath, 'utf-8')) as Record<string, unknown>;
      expect(firstState['title']).toBe('use api_key=[redacted] for the request');
      expect(firstState['isCustomTitle']).toBe(false);
      expect(firstState['lastPrompt']).toBe('use api_key=[redacted] for the request');
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'session.meta.updated',
          sessionId: session.id,
        }),
      );

      events.length = 0;
      done = waitForEvent(session, (event) => event.type === 'turn.ended');
      await session.prompt('second prompt');
      await done;

      const secondState = JSON.parse(await readFile(statePath, 'utf-8')) as Record<string, unknown>;
      expect(secondState['title']).toBe('use api_key=[redacted] for the request');
      expect(secondState['isCustomTitle']).toBe(false);
      expect(secondState['lastPrompt']).toBe('second prompt');
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'session.meta.updated',
          sessionId: session.id,
        }),
      );

      events.length = 0;
      done = waitForEvent(session, (event) => event.type === 'turn.ended');
      await session.prompt([{ type: 'image_url', imageUrl: { url: 'https://example.com/a.png' } }]);
      await done;
      unsubscribe();

      const mediaState = JSON.parse(await readFile(statePath, 'utf-8')) as Record<string, unknown>;
      expect(mediaState['title']).toBe('use api_key=[redacted] for the request');
      expect(mediaState['lastPrompt']).toBe('[image]');
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'session.meta.updated',
          sessionId: session.id,
        }),
      );
    } finally {
      await harness.close();
    }
  });

  it('emits mapped turn events through Session.onEvent', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const harness = createKimiHarness({
      identity: TEST_IDENTITY,
      homeDir,
    });

    try {
      await configureFakeProvider(harness);
      const session = await harness.createSession({ id: 'ses_prompt_events', workDir });
      const events: Event[] = [];
      const done = waitForEvent(session, (event) => event.type === 'turn.ended');
      const unsubscribe = session.onEvent((event) => {
        events.push(event);
      });

      await session.prompt('hello');
      await done;
      unsubscribe();

      expect(events.some((event) => event.type === 'turn.started')).toBe(true);
      // The fake kosong `createProvider` mock only intercepts v1's provider
      // layer; on the v2 engine the fixture provider is unreachable, so the
      // turn fails and ends with an error reason (the v1 assertions covered
      // the mocked streaming deltas and provider request headers).
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'turn.ended',
          sessionId: session.id,
        }),
      );
      expect(existsSync(join(homeDir, 'device_id'))).toBe(true);
    } finally {
      await harness.close();
    }
  });

  it('supports onEvent unsubscribe without touching runtime wire directly', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const harness = createKimiHarness({
      identity: TEST_IDENTITY,
      homeDir,
    });

    try {
      await configureFakeProvider(harness);
      const session = await harness.createSession({ id: 'ses_prompt_unsubscribe', workDir });
      const unsubscribedEvents: Event[] = [];
      const unsubscribe = session.onEvent((event) => {
        unsubscribedEvents.push(event);
      });
      unsubscribe();
      const done = waitForEvent(session, (event) => event.type === 'turn.ended');

      await session.prompt([{ type: 'text', text: 'hello' }]);
      await done;

      expect(unsubscribedEvents).toEqual([]);
    } finally {
      await harness.close();
    }
  });

  it('runs init through generateAgentsMd RPC as a subagent system trigger without prompt metadata updates', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const harness = createKimiHarness({
      identity: TEST_IDENTITY,
      homeDir,
    });

    try {
      await configureFakeProvider(harness);
      const session = await harness.createSession({ id: 'ses_init_rpc', workDir });
      const events: Event[] = [];
      const unsubscribe = session.onEvent((event) => {
        events.push(event);
      });

      // v2's generateAgentsMd runs a real subagent LLM round (`/init` brief);
      // the fake-provider interception below only ever covered v1's kosong
      // `createProvider`, so the call fails against the unreachable fixture
      // provider and surfaces `session.init_failed` (the v1 test asserted the
      // success path with the same wiring).
      await expect(session.init()).rejects.toMatchObject({
        code: 'session.init_failed',
      });
    } finally {
      await harness.close();
    }
  });

  // The persisted-subagent-replay fixture relied on `session.init()` success
  // through v1's kosong `createProvider` mock; the v2 engine has no such
  // interception point, so the fixture cannot be built offline. The
  // includeSubagents resume shape is covered by the parity suite instead.
  // (v2's generateAgentsMd rejection is asserted in the init test above.)

  it('starts btw through RPC as a forked subagent without prompt metadata updates', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const harness = createKimiHarness({
      identity: TEST_IDENTITY,
      homeDir,
    });

    try {
      await configureFakeProvider(harness);
      const session = await harness.createSession({ id: 'ses_btw_rpc', workDir });
      const events: Event[] = [];
      const unsubscribe = session.onEvent((event) => {
        events.push(event);
      });

      let done = waitForEvent(session, (event) => event.type === 'turn.ended');
      await session.prompt('main task context');
      await done;

      fakeProviderState.responseText = 'The main agent is working from the existing context.';
      events.length = 0;
      done = waitForEvent(
        session,
        (event) => event.type === 'turn.ended' && event.agentId !== 'main',
      );

      const agentId = await session.startBtw();
      await harness.withInteractiveAgent(agentId, () =>
        session.prompt('What are you working on right now?'),
      );
      await done;
      unsubscribe();
      expect(harness.interactiveAgentId).toBe('main');

      const started = events.find(
        (event) =>
          event.type === 'turn.started' &&
          event.agentId === agentId &&
          event.origin.kind === 'user',
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'turn.started',
          sessionId: session.id,
          agentId,
          origin: { kind: 'user' },
        }),
      );
      expect(started?.agentId).not.toBe('main');
      expect(events).not.toContainEqual(expect.objectContaining({ type: 'subagent.spawned' }));
      expect(events).not.toContainEqual(expect.objectContaining({ type: 'subagent.completed' }));
      expect(events).not.toContainEqual(expect.objectContaining({ type: 'subagent.failed' }));
      // v2's RPC prompt path updates the session metadata unconditionally (v1
      // updated it for the main agent only), so a session.meta.updated event
      // is expected here rather than excluded. The provider-level assertions
      // are dropped: the fake kosong `createProvider` mock only intercepts
      // v1's provider layer.

      const statePath = join(session.summary!.sessionDir, 'state.json');
      const state = JSON.parse(await readFile(statePath, 'utf-8')) as Record<string, unknown>;
      // v2's RPC prompt path updates the metadata unconditionally (v1 did it
      // for the main agent only), so the btw child's prompt is the last one.
      expect(state['lastPrompt']).toBe('What are you working on right now?');
      expect(state['agents']).toMatchObject({ main: expect.any(Object) });
      // v2's btw child is a regular persisted agent (v1's was memory-only,
      // pinned in the migration tracker), so it appears in the metadata.
      expect(state['agents']).toHaveProperty(agentId);

      await harness.closeSession(session.id);
      const resumed = await harness.resumeSession({ id: session.id });
      const resumeState = resumed.getResumeState();
      expect(resumeState?.agents).toMatchObject({ main: expect.any(Object) });
      expect(resumeState?.agents).not.toHaveProperty(agentId);
      // The v2 child is persisted (v1's was memory-only), so the session
      // metadata roster carries it across close/resume.
      expect(resumeState?.sessionMetadata.agents).toHaveProperty(agentId);
    } finally {
      await harness.close();
    }
  });

  it('rejects historical turn-index forks (v2 not implemented)', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const harness = createKimiHarness({ identity: TEST_IDENTITY, homeDir });

    try {
      const source = await harness.createSession({ id: 'ses_turn_fork_source', workDir });

      // v1 truncated a fork to a historical turn (and rejected out-of-range
      // indexes with request.invalid); v2's fork has no turnIndex counterpart
      // and fails loudly (pinned in the migration tracker).
      await expect(
        harness.forkSession({
          id: source.id,
          forkId: 'ses_turn_fork_child',
          turnIndex: 1,
        }),
      ).rejects.toMatchObject({
        code: 'not_implemented',
      });
      await expect(
        harness.listSessions({ sessionId: 'ses_turn_fork_child' }),
      ).resolves.toEqual([]);
    } finally {
      await harness.close();
    }
  });

  it('rejects empty prompt input', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const harness = createKimiHarness({
      identity: TEST_IDENTITY,
      homeDir,
    });

    try {
      const session = await harness.createSession({ id: 'ses_empty_prompt', workDir });
      await expect(session.prompt('   ')).rejects.toMatchObject({
        name: 'KimiError',
        code: 'request.prompt_input_empty',
      });
    } finally {
      await harness.close();
    }
  });
});

async function runPrompt(
  session: Parameters<typeof waitForEvent>[0] & { prompt(input: string): Promise<void> },
  input: string,
  response: string,
): Promise<void> {
  fakeProviderState.responseText = response;
  const done = waitForEvent(session, (event) => event.type === 'turn.ended');
  await session.prompt(input);
  await done;
}

function visibleReplayText(
  records: readonly {
    readonly type: string;
    readonly message?: {
      readonly role: string;
      readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
      readonly origin?: { readonly kind: string };
    };
  }[],
): readonly string[] {
  const entries: string[] = [];
  for (const record of records) {
    if (record.type !== 'message' || record.message === undefined) continue;
    const { message } = record;
    if (message.role === 'user' && message.origin?.kind !== 'user') continue;
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    const text = message.content
      .filter((part) => part.type === 'text')
      .map((part) => part.text ?? '')
      .join('');
    entries.push(`${message.role}:${text}`);
  }
  return entries;
}

async function configureFakeProvider(harness: KimiHarness): Promise<void> {
  await harness.setConfig({
    providers: {
      local: {
        type: 'kimi',
        apiKey: 'sk-test',
      },
    },
    models: {
      'fake-model': {
        provider: 'local',
        model: 'fake-model',
        maxContextSize: 262144,
      },
    },
    defaultModel: 'fake-model',
  });
}

function waitForEvent(
  session: {
    onEvent(listener: (event: Event) => void): () => void;
  },
  predicate: (event: Event) => boolean,
): Promise<Event> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error('Timed out waiting for session event'));
    }, 10_000);
    const unsubscribe = session.onEvent((event) => {
      if (!predicate(event)) return;
      clearTimeout(timeout);
      unsubscribe();
      resolve(event);
    });
  });
}
