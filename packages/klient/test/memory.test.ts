import { rm } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { RPCError } from '../src/core/errors.js';
import { createMemoryDispatcher } from '../src/transports/memory/dispatcher.js';
import { createKlient } from '../src/transports/memory/index.js';
import { defineKlientConformance } from './helpers/conformance.js';
import { makeEngine } from './helpers/engine.js';

defineKlientConformance('memory', async () => {
  const { homeDir, app } = await makeEngine();
  const klient = createKlient({ scope: app });
  return {
    klient,
    app,
    cleanup: async () => {
      await klient.close();
      app.dispose();
      await rm(homeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
    },
  };
});

describe('memory dispatcher specifics', () => {
  it('rejects unknown services and methods with RPCError(40001)', async () => {
    const { homeDir, app } = await makeEngine();
    const dispatcher = createMemoryDispatcher(app);
    await expect(dispatcher.call({}, 'noSuchService', 'get', [])).rejects.toMatchObject({
      name: 'RPCError',
      code: 40001,
    });
    await expect(dispatcher.call({}, 'sessionIndex', 'noSuchMethod', [])).rejects.toMatchObject({
      name: 'RPCError',
      code: 40001,
    });
    app.dispose();
    await rm(homeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
  });

  it('reads non-function members as properties', async () => {
    const { homeDir, app } = await makeEngine();
    const dispatcher = createMemoryDispatcher(app);
    await expect(dispatcher.call({}, 'bootstrapService', 'platform', [])).resolves.toBe(
      process.platform,
    );
    app.dispose();
    await rm(homeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
  });

  it('rejects session/agent scopes for now', async () => {
    const { homeDir, app } = await makeEngine();
    const dispatcher = createMemoryDispatcher(app);
    await expect(
      dispatcher.call({ sessionId: 's1' }, 'sessionIndex', 'list', [{}]),
    ).rejects.toBeInstanceOf(RPCError);
    app.dispose();
    await rm(homeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
  });

  it('delivers wire-cloned payloads (no live object identity)', async () => {
    const { homeDir, app } = await makeEngine();
    const klient = createKlient({ scope: app });
    const list = await klient.global.workspaces.list();
    // Mutating the result must not affect what a second call returns.
    (list as unknown[]).push({ id: 'polluted' });
    const again = await klient.global.workspaces.list();
    expect(again.some((w) => w.id === 'polluted')).toBe(false);
    app.dispose();
    await rm(homeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
  });

  it('does not respond to interactions owned by another session', async () => {
    const { homeDir, app } = await makeEngine();
    const klient = createKlient({ scope: app });
    const dispatcher = createMemoryDispatcher(app);
    const first = await klient.global.sessions.create({ workDir: process.cwd() });
    const second = await klient.global.sessions.create({ workDir: process.cwd() });
    try {
      const parked = (await dispatcher.call(
        { sessionId: first.id },
        'sessionInteractionService',
        'enqueue',
        [
          {
            kind: 'approval',
            payload: {
              toolName: 'Bash',
              action: 'run',
              display: { kind: 'command', command: 'ls' },
            },
          },
        ],
      )) as { id: string };

      // A respond for an id owned by another session must be rejected, not
      // silently accepted: the caller has to be able to tell "approved" from
      // "nothing happened". It used to resolve successfully and leave the
      // interaction pending.
      await expect(
        dispatcher.call({ sessionId: second.id }, 'sessionInteractionService', 'respond', [
          parked.id,
          { decision: 'approved' },
        ]),
      ).rejects.toThrow(/not found/i);

      const pendingAfterCross = (await dispatcher.call(
        { sessionId: first.id },
        'sessionInteractionService',
        'listPending',
        ['approval'],
      )) as readonly { id: string }[];
      expect(pendingAfterCross.map((i) => i.id)).toEqual([parked.id]);

      await dispatcher.call({ sessionId: first.id }, 'sessionInteractionService', 'respond', [
        parked.id,
        { decision: 'approved' },
      ]);
      const pendingAfterOwn = (await dispatcher.call(
        { sessionId: first.id },
        'sessionInteractionService',
        'listPending',
        ['approval'],
      )) as readonly { id: string }[];
      expect(pendingAfterOwn).toEqual([]);
    } finally {
      await klient.close();
      app.dispose();
      await rm(homeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
    }
  });

  it('rejects responding to an id that never existed', async () => {
    const { homeDir, app } = await makeEngine();
    const dispatcher = createMemoryDispatcher(app);
    const klient = createKlient({ scope: app });
    const session = await klient.global.sessions.create({ workDir: process.cwd() });
    try {
      await expect(
        dispatcher.call({ sessionId: session.id }, 'sessionInteractionService', 'respond', [
          'no-such-interaction',
          { decision: 'approved' },
        ]),
      ).rejects.toMatchObject({ name: 'RPCError', code: 40404 });
    } finally {
      await klient.close();
      app.dispose();
      await rm(homeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
    }
  });

  it('rejects a second respond to an already-resolved interaction with 40902', async () => {
    const { homeDir, app } = await makeEngine();
    const dispatcher = createMemoryDispatcher(app);
    const klient = createKlient({ scope: app });
    const session = await klient.global.sessions.create({ workDir: process.cwd() });
    try {
      const parked = (await dispatcher.call(
        { sessionId: session.id },
        'sessionInteractionService',
        'enqueue',
        [
          {
            kind: 'approval',
            payload: {
              toolName: 'Bash',
              action: 'run',
              display: { kind: 'command', command: 'ls' },
            },
          },
        ],
      )) as { id: string };

      await dispatcher.call({ sessionId: session.id }, 'sessionInteractionService', 'respond', [
        parked.id,
        { decision: 'approved' },
      ]);

      // The second respond must surface a conflict, not silently succeed: it
      // used to resolve and leave the caller unable to tell "approved" from
      // "nothing happened".
      await expect(
        dispatcher.call({ sessionId: session.id }, 'sessionInteractionService', 'respond', [
          parked.id,
          { decision: 'approved' },
        ]),
      ).rejects.toMatchObject({ name: 'RPCError', code: 40902 });
    } finally {
      await klient.close();
      app.dispose();
      await rm(homeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
    }
  });
});
