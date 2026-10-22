import { describe, expect, it, mock } from 'bun:test';

import type { SDKRpcClientBase } from '#/rpc';
import { Session } from '#/session';

function makeSession() {
  const rpc = {
    createGoal: mock(async () => ({ goalId: 'g1' })),
    getGoal: mock(async () => ({ goal: null })),
    pauseGoal: mock(async () => ({ goalId: 'g1' })),
    resumeGoal: mock(async () => ({ goalId: 'g1' })),
    cancelGoal: mock(async () => ({ goalId: 'g1' })),
    getCronTasks: mock(async () => ({ tasks: [] })),
    clearSessionHandlers: mock(),
  } as unknown as SDKRpcClientBase;
  const session = new Session({ id: 'ses_goal', workDir: '/tmp/work', rpc });
  return { session, rpc };
}

describe('Session goal methods', () => {
  it('createGoal forwards the supported payload with sessionId', async () => {
    const { session, rpc } = makeSession();
    await session.createGoal({
      objective: 'Ship feature X',
      replace: true,
    });
    expect(rpc.createGoal).toHaveBeenCalledWith({
      sessionId: 'ses_goal',
      objective: 'Ship feature X',
      replace: true,
    });
  });

  it('getGoal forwards sessionId', async () => {
    const { session, rpc } = makeSession();
    await session.getGoal();
    expect(rpc.getGoal).toHaveBeenCalledWith({ sessionId: 'ses_goal' });
  });

  it('pauseGoal forwards sessionId', async () => {
    const { session, rpc } = makeSession();
    await session.pauseGoal();
    expect(rpc.pauseGoal).toHaveBeenCalledWith({ sessionId: 'ses_goal' });
  });

  it('resumeGoal forwards sessionId', async () => {
    const { session, rpc } = makeSession();
    await session.resumeGoal();
    expect(rpc.resumeGoal).toHaveBeenCalledWith({ sessionId: 'ses_goal' });
  });

  it('cancelGoal forwards sessionId', async () => {
    const { session, rpc } = makeSession();
    await session.cancelGoal();
    expect(rpc.cancelGoal).toHaveBeenCalledWith({ sessionId: 'ses_goal' });
  });

  it('getCronTasks forwards sessionId and returns the task list', async () => {
    const { session, rpc } = makeSession();
    const result = await session.getCronTasks();
    expect(rpc.getCronTasks).toHaveBeenCalledWith({ sessionId: 'ses_goal' });
    expect(result).toEqual({ tasks: [] });
  });

  it('does not expose a public clearGoal or updateGoal method', () => {
    const { session } = makeSession();
    expect((session as unknown as { clearGoal?: unknown }).clearGoal).toBeUndefined();
    expect((session as unknown as { updateGoal?: unknown }).updateGoal).toBeUndefined();
  });

  it('keeps the goal metadata key reserved for lifecycle methods', async () => {
    const { session } = makeSession();

    await expect(session.updateMetadata({ goal: { status: 'complete' } })).rejects.toMatchObject({
      code: 'goal.metadata_reserved',
    });
  });
});
