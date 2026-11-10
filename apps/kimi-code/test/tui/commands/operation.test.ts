import { describe, expect, it, mock } from 'bun:test';

import type { OperationRecord, Session } from '@moonshot-ai/kimi-code-sdk';

import type { SlashCommandHost } from '#/tui/commands/dispatch';
import { handleOperationCommand } from '#/tui/commands/index';

const operation: OperationRecord = {
  version: 1,
  id: '0123456789abcdef',
  parents: [],
  viewId: 'view-1',
  kind: 'capture',
  at: '2026-01-01T00:00:00.000Z',
  description: 'Write',
  nonce: 'nonce-1',
};

function makeHost() {
  const session = {
    listOperations: mock(async () => [operation]),
    undoOperation: mock(async () => ({ ...operation, kind: 'undo', description: 'Undo operation' })),
    redoOperation: mock(async () => ({ ...operation, kind: 'redo', description: 'Redo operation' })),
    restoreOperation: mock(async () => ({
      ...operation,
      kind: 'restore',
      description: 'Restore operation',
    })),
  };
  const host = {
    session: session as unknown as Session,
    ensureSession: mock(async () => session as unknown as Session),
    showError: mock(),
    showStatus: mock(),
    showNotice: mock(),
  } as unknown as SlashCommandHost;
  return { host, session };
}

describe('handleOperationCommand', () => {
  it('lists operations newest first with their full ids', async () => {
    const { host, session } = makeHost();

    await handleOperationCommand(host, '');

    expect(session.listOperations).toHaveBeenCalledWith();
    expect(host.showNotice).toHaveBeenCalledWith(
      'Operations (1)',
      '0123456789abcdef capture Write',
    );
  });

  it('reports an empty operation log', async () => {
    const { host, session } = makeHost();
    session.listOperations.mockResolvedValue([]);

    await handleOperationCommand(host, 'list');

    expect(host.showStatus).toHaveBeenCalledWith('No operations recorded.');
    expect(host.showNotice).not.toHaveBeenCalled();
  });

  it.each([
    ['undo', 'undoOperation', 'Undo operation'],
    ['redo', 'redoOperation', 'Redo operation'],
  ] as const)('runs %s and shows the appended operation', async (args, method, description) => {
    const { host, session } = makeHost();

    await handleOperationCommand(host, args);

    expect(session[method]).toHaveBeenCalledTimes(1);
    expect(host.showNotice).toHaveBeenCalledWith(description, operation.id);
  });

  it('restores an explicit operation id', async () => {
    const { host, session } = makeHost();

    await handleOperationCommand(host, `restore ${operation.id}`);

    expect(session.restoreOperation).toHaveBeenCalledWith(operation.id);
    expect(host.showNotice).toHaveBeenCalledWith('Restore operation', operation.id);
  });

  it.each(['restore', 'restore one two', 'unknown'])('rejects invalid arguments: %s', async (args) => {
    const { host, session } = makeHost();

    await handleOperationCommand(host, args);

    expect(host.showError).toHaveBeenCalledWith(
      'Usage: /operation [list] | undo | redo | restore <operation-id>.',
    );
    expect(session.listOperations).not.toHaveBeenCalled();
    expect(session.undoOperation).not.toHaveBeenCalled();
    expect(session.redoOperation).not.toHaveBeenCalled();
    expect(session.restoreOperation).not.toHaveBeenCalled();
  });

  it('surfaces service failures', async () => {
    const { host, session } = makeHost();
    session.undoOperation.mockRejectedValue(new Error('view mismatch'));

    await handleOperationCommand(host, 'undo');

    expect(host.showError).toHaveBeenCalledWith('Operation failed: view mismatch');
  });
});
