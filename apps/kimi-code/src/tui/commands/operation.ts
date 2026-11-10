import { t } from '#/i18n';

import { formatErrorMessage } from '../utils/event-payload';
import type { SlashCommandHost } from './dispatch';

export async function handleOperationCommand(host: SlashCommandHost, args: string): Promise<void> {
  const input = args.trim();
  const parts = input === '' ? ['list'] : input.split(/\s+/);
  const action = parts[0] ?? 'list';
  const valid =
    ((action === 'list' || action === 'undo' || action === 'redo') && parts.length === 1) ||
    (action === 'restore' && parts.length === 2);
  if (!valid) {
    host.showError(t('tui.statusMessages.operationUsage'));
    return;
  }
  const session = host.session ?? (await host.ensureSession());
  if (session === undefined) return;
  try {
    if (action === 'list') {
      const operations = await session.listOperations();
      if (operations.length === 0) {
        host.showStatus(t('tui.statusMessages.operationEmpty'));
        return;
      }
      host.showNotice(
        t('tui.statusMessages.operationListTitle', { count: operations.length }),
        operations
          .map((operation) => `${operation.id} ${operation.kind} ${operation.description}`)
          .join('\n'),
      );
      return;
    }
    const operation =
      action === 'undo'
        ? await session.undoOperation()
        : action === 'redo'
          ? await session.redoOperation()
          : await session.restoreOperation(parts[1] ?? '');
    host.showNotice(operation.description, operation.id);
  } catch (error) {
    host.showError(
      t('tui.statusMessages.operationFailed', { message: formatErrorMessage(error) }),
    );
  }
}
