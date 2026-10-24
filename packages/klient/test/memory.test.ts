import { describe, expect, it } from 'bun:test';

import { RPCError } from '../src/core/errors.js';
import { createMemoryDispatcher } from '../src/transports/memory/dispatcher.js';
import { createKlient } from '../src/transports/memory/index.js';
import { defineKlientConformance } from './helpers/conformance.js';
import { cleanupEngine, makeEngine } from './helpers/engine.js';

defineKlientConformance('memory', async () => {
  const { homeDir, app } = await makeEngine();
  const klient = createKlient({ scope: app });
  return {
    klient,
    app,
    cleanup: async () => {
      await klient.close();
      await cleanupEngine({ homeDir, app });
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
    await cleanupEngine({ homeDir, app });
  });

  it('reads non-function members as properties', async () => {
    const { homeDir, app } = await makeEngine();
    const dispatcher = createMemoryDispatcher(app);
    await expect(dispatcher.call({}, 'bootstrapService', 'platform', [])).resolves.toBe(
      process.platform,
    );
    await cleanupEngine({ homeDir, app });
  });

  // A26/F4: a `workspaceId` scope used to materialize the workspace instance
  // through `IWorkspaceInstanceManager` and then answer every service from the
  // ROOT app scope — the instance was dropped and the caller got root data or
  // `REQUEST_INVALID`, depending on the service. Refusing outright is the
  // documented contract: an engine `WorkspaceInstance` is not a `ScopeLike`.
  it('refuses a workspace-scoped call instead of answering from the root scope', async () => {
    const { homeDir, app } = await makeEngine();
    const dispatcher = createMemoryDispatcher(app);
    try {
      await expect(
        dispatcher.call({ workspaceId: 'ws_x' }, 'workspaceService', 'list', []),
      ).rejects.toMatchObject({
        name: 'RPCError',
        code: 40001,
        message: 'workspace scope is not supported by the memory transport',
      });

      // The rejection is a scope verdict, not an unknown-method one: an
      // agent-scope-only service must report "not supported" as well.
      await expect(
        dispatcher.call({ workspaceId: 'ws_x' }, 'agentSkillService', 'list', []),
      ).rejects.toMatchObject({ code: 40001 });

      // A subscription under a workspace scope fails through `onError`, the
      // same shape the memory transport already uses for scope failures.
      const errors: Error[] = [];
      const sub = dispatcher.listen({ workspaceId: 'ws_x' }, { kind: 'stream', name: 'events' },
        () => undefined, (error) => errors.push(error));
      await new Promise((resolve) => setTimeout(resolve, 50));
      sub.dispose();
      expect(errors).toHaveLength(1);
      expect(errors[0]?.message).toContain('workspace scope is not supported');

      // The workspace was never materialized, so no instance lingers either.
      const { IWorkspaceInstanceManager } = await import('@moonshot-ai/agent-core-v2');
      expect(app.accessor.get(IWorkspaceInstanceManager).get('ws_x')).toBeUndefined();
    } finally {
      await cleanupEngine({ homeDir, app });
    }
  });

  it('rejects session/agent scopes for now', async () => {
    const { homeDir, app } = await makeEngine();
    const dispatcher = createMemoryDispatcher(app);
    await expect(
      dispatcher.call({ sessionId: 's1' }, 'sessionIndex', 'list', [{}]),
    ).rejects.toBeInstanceOf(RPCError);
    await cleanupEngine({ homeDir, app });
  });

  it('delivers wire-cloned payloads (no live object identity)', async () => {
    const { homeDir, app } = await makeEngine();
    const klient = createKlient({ scope: app });
    const list = await klient.global.workspaces.list();
    // Mutating the result must not affect what a second call returns.
    (list as unknown[]).push({ id: 'polluted' });
    const again = await klient.global.workspaces.list();
    expect(again.some((w) => w.id === 'polluted')).toBe(false);
    await cleanupEngine({ homeDir, app });
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
      await cleanupEngine({ homeDir, app });
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
      await cleanupEngine({ homeDir, app });
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
      await cleanupEngine({ homeDir, app });
    }
  });
});
