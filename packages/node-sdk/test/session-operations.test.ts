import { describe, expect, it, mock } from 'bun:test';

import type { SDKRpcClientBase } from '#/rpc';
import { Session } from '#/session';
import type { OperationRecord } from '#/types';

const operation: OperationRecord = {
  version: 1,
  id: 'op-1',
  parents: [],
  viewId: 'view-1',
  kind: 'capture',
  at: '2026-01-01T00:00:00.000Z',
  description: 'Write',
  nonce: 'nonce-1',
};

function makeSession() {
  const rpc = {
    listOperations: mock(async () => [operation]),
    undoOperation: mock(async () => operation),
    redoOperation: mock(async () => operation),
    restoreOperation: mock(async () => operation),
  } as unknown as SDKRpcClientBase;
  const session = new Session({ id: 'ses_operations', workDir: '/tmp/work', rpc });
  return { session, rpc };
}

describe('Session operation methods', () => {
  it('lists operations with the optional limit', async () => {
    const { session, rpc } = makeSession();
    await expect(session.listOperations(25)).resolves.toEqual([operation]);
    expect(rpc.listOperations).toHaveBeenCalledWith({ sessionId: 'ses_operations', limit: 25 });
  });

  it('forwards undo and redo', async () => {
    const { session, rpc } = makeSession();
    await expect(session.undoOperation()).resolves.toEqual(operation);
    await expect(session.redoOperation()).resolves.toEqual(operation);
    expect(rpc.undoOperation).toHaveBeenCalledWith({ sessionId: 'ses_operations' });
    expect(rpc.redoOperation).toHaveBeenCalledWith({ sessionId: 'ses_operations' });
  });

  it('forwards an arbitrary restore target', async () => {
    const { session, rpc } = makeSession();
    await expect(session.restoreOperation('op-1')).resolves.toEqual(operation);
    expect(rpc.restoreOperation).toHaveBeenCalledWith({
      sessionId: 'ses_operations',
      targetId: 'op-1',
    });
  });
});
