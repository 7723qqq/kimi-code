import { NO_ACTIVE_SESSION_MESSAGE } from '../constant/kimi-tui';
import { ChoicePickerComponent } from '../components/dialogs/choice-picker';
import type { SlashCommandHost } from './dispatch';
import { slashBusyMessage, slashCommandBusyReason } from './resolve';
import { t } from '#/i18n';

type AddDirChoice = 'session' | 'remember' | 'cancel';

export async function handleAddDirCommand(host: SlashCommandHost, args: string): Promise<void> {
  const input = args.trim();
  let session = host.session;

  if (input.length === 0 || input.toLowerCase() === 'list') {
    const additionalDirs = session?.summary?.additionalDirs ?? host.state.appState.additionalDirs;
    if (additionalDirs.length === 0) {
      host.showStatus(t('tui.statusMessages.addDirNoAdditionalDirs'));
      return;
    }
    host.showStatus(formatAdditionalDirsStatus(additionalDirs));
    return;
  }

  if (session === undefined) {
    session = await host.ensureSession();
    if (session === undefined) return;
    const busyReason = slashCommandBusyReason({
      isStreaming: host.state.appState.streamingPhase !== 'idle',
      isCompacting: host.state.appState.isCompacting,
    });
    if (busyReason !== undefined) {
      host.showError(slashBusyMessage('add-dir', busyReason));
      return;
    }
  }

  host.mountEditorReplacement(
    new ChoicePickerComponent({
      title: t('tui.statusMessages.addDirTitle', { path: input }),
      hint: t('tui.statusMessages.addDirHint'),
      options: [
        {
          value: 'session',
          label: t('tui.statusMessages.addDirYesSession'),
        },
        {
          value: 'remember',
          label: t('tui.statusMessages.addDirYesRemember'),
        },
        {
          value: 'cancel',
          label: t('tui.statusMessages.addDirNo'),
        },
      ],
      onSelect: (value) => {
        void handleAddDirChoice(host, session.id, input, value as AddDirChoice);
      },
      onCancel: () => {
        host.restoreEditor();
        host.showStatus(t('tui.statusMessages.addDirDidNotAdd', { path: input }));
      },
    }),
  );
}

function formatAdditionalDirsStatus(additionalDirs: readonly string[]): string {
  return [t('tui.statusMessages.addDirListHeader'), ...additionalDirs.map((dir) => `  ${dir}`)].join('\n');
}

async function handleAddDirChoice(
  host: SlashCommandHost,
  sessionId: string,
  path: string,
  choice: AddDirChoice,
): Promise<void> {
  host.restoreEditor();

  if (choice === 'cancel') {
    host.showStatus(t('tui.statusMessages.addDirDidNotAdd', { path: path }));
    return;
  }

  const session = host.session;
  if (session === undefined || session.id !== sessionId) {
    host.showError(NO_ACTIVE_SESSION_MESSAGE);
    return;
  }

  try {
    const result = await session.addAdditionalDir(path, { persist: choice === 'remember' });
    host.setAppState({ additionalDirs: result.additionalDirs });
    host.refreshSlashCommandAutocomplete();
    host.showStatus(
      choice === 'remember'
        ? `Added workspace directory:\n  ${path}\n  Remembered in the workspace registry`
        : `Added workspace directory:\n  ${path}\n  For this session only`,
      'success',
    );
  } catch (error) {
    host.showError(error instanceof Error ? error.message : String(error));
  }
}
