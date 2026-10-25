import type { PermissionMode } from '@moonshot-ai/kimi-code-sdk';

import { t } from '#/i18n';

import {
  HelloWorldStartPermissionPromptComponent,
  type HelloWorldStartPermissionChoice,
} from '../components/dialogs/hello-world-start-permission-prompt';
import {
  HelloWorldModeMarkerComponent,
  type HelloWorldModeMarkerState,
} from '../components/messages/hello-world-markers';
import { getLlmNotSetMessage, getNoActiveSessionMessage } from '../constant/kimi-tui';
import { formatErrorMessage } from '../utils/event-payload';
import { permissionModeDescription, permissionModeDisplayName } from '../utils/permission-mode';
import { nextTranscriptId } from '../utils/transcript-id';
import type { SlashCommandHost } from './dispatch';

export async function handleHelloWorldCommand(host: SlashCommandHost, args: string): Promise<void> {
  if (host.session === undefined) {
    host.showError(getNoActiveSessionMessage());
    return;
  }

  const prompt = args.trim();
  const mode = helloWorldModeSubcommand(prompt);
  if (mode !== undefined) {
    await applyHelloWorldMode(host, mode, `/hello-world ${prompt}`);
    return;
  }

  if (prompt.length === 0) {
    await applyHelloWorldMode(host, !host.state.appState.helloWorldMode, '/hello-world');
    return;
  }

  if (host.state.appState.model.trim().length === 0) {
    host.showError(getLlmNotSetMessage());
    return;
  }

  if (host.state.appState.permissionMode === 'manual') {
    showHelloWorldStartPermissionPrompt(
      host,
      `/hello-world ${prompt}`,
      t('tui.statusMessages.helloWorldTaskNotStarted'),
      (choice) => startHelloWorldWithPermission(host, prompt, choice),
    );
    return;
  }

  await startHelloWorldTask(host, prompt);
}

function showHelloWorldStartPermissionPrompt(
  host: SlashCommandHost,
  commandText: string,
  cancelStatus: string,
  onSelect: (choice: HelloWorldStartPermissionChoice) => Promise<void>,
): void {
  const cancelStart = (): void => {
    host.restoreInputText(commandText);
    host.showStatus(cancelStatus);
  };
  host.mountEditorReplacement(
    new HelloWorldStartPermissionPromptComponent({
      onSelect: (choice) => {
        host.restoreEditor();
        void onSelect(choice);
      },
      onCancel: cancelStart,
    }),
  );
}

async function startHelloWorldWithPermission(
  host: SlashCommandHost,
  prompt: string,
  choice: HelloWorldStartPermissionChoice,
): Promise<void> {
  const previousMode = host.state.appState.permissionMode;
  const switched = choice !== previousMode && (choice === 'auto' || choice === 'yolo');
  if (switched) {
    if (!(await setPermissionForHelloWorld(host, choice))) return;
  }
  const started = await startHelloWorldTask(host, prompt);
  // The permission switch only exists to run this hello-world task. If the
  // task never starts (e.g. setHelloWorldMode failed), restore the previous
  // mode so the session is not left more permissive than before.
  if (!started && switched) {
    await setPermissionForHelloWorld(host, previousMode);
  }
}

async function setPermissionForHelloWorld(
  host: SlashCommandHost,
  mode: PermissionMode,
): Promise<boolean> {
  try {
    await host.requireSession().setPermission(mode);
  } catch (error) {
    host.showError(
      t('tui.messages.helloWorldPermissionFailed', { error: formatErrorMessage(error) }),
    );
    return false;
  }
  host.setAppState({ permissionMode: mode });
  host.showNotice(
    t('tui.statusMessages.permissionModeChanged', { mode: permissionModeDisplayName(mode) }),
  );
  host.showStatus(permissionModeDescription(mode), 'warning');
  return true;
}

async function startHelloWorldTask(host: SlashCommandHost, prompt: string): Promise<boolean> {
  if (!host.state.appState.helloWorldMode && !(await setHelloWorldMode(host, true, 'task'))) {
    return false;
  }
  renderHelloWorldModeMarker(host, 'active');
  host.sendNormalUserInput(prompt);
  return true;
}

async function applyHelloWorldMode(
  host: SlashCommandHost,
  enabled: boolean,
  commandText: string,
): Promise<void> {
  if (enabled && host.state.appState.helloWorldMode) {
    host.showStatus(t('tui.statusMessages.helloWorldModeAlreadyOn'));
    return;
  }
  if (!enabled && !host.state.appState.helloWorldMode) {
    host.showStatus(t('tui.statusMessages.helloWorldModeAlreadyOff'));
    return;
  }
  if (enabled && host.state.appState.permissionMode === 'manual') {
    showHelloWorldStartPermissionPrompt(
      host,
      commandText,
      t('tui.statusMessages.helloWorldModeNotEnabled'),
      async (choice) => {
        if (
          (choice === 'auto' || choice === 'yolo') &&
          !(await setPermissionForHelloWorld(host, choice))
        ) {
          return;
        }
        if (!(await setHelloWorldMode(host, true, 'manual'))) return;
        renderHelloWorldModeMarker(host, 'active');
      },
    );
    return;
  }
  if (!(await setHelloWorldMode(host, enabled, 'manual'))) return;
  renderHelloWorldModeMarker(host, enabled ? 'active' : 'inactive');
}

async function setHelloWorldMode(
  host: SlashCommandHost,
  enabled: boolean,
  trigger: 'manual' | 'task',
): Promise<boolean> {
  const session = host.requireSession();
  try {
    await session.setHelloWorldMode(enabled, trigger);
    // The engine may refuse (a conflicting mode it cannot leave), so confirm
    // the mode actually took before reporting success, like `/tower` does. The
    // read must not *gate* the state write: a failed read is not evidence of
    // success, and reconciling to a value we could not read would strand the
    // UI on a mode the engine may already have left.
    const status = await session.getStatus().catch(() => null);
    // Only a *reported* disagreement is evidence the engine refused. A missing
    // field means this view does not carry the flag, not that the mode is off.
    const reported = status?.helloWorldMode;
    if (reported !== undefined && reported !== enabled) {
      host.setAppState({ helloWorldMode: reported });
      host.state.helloWorldModeEntry = reported ? trigger : undefined;
      host.showError(
        t('tui.messages.helloWorldToggleFailed', {
          action: enabled
            ? t('tui.messages.helloWorldEnable')
            : t('tui.messages.helloWorldDisable'),
          error: t('tui.messages.helloWorldModeDidNotChange'),
        }),
      );
      return false;
    }
  } catch (error) {
    host.showError(
      t('tui.messages.helloWorldToggleFailed', {
        action: enabled ? t('tui.messages.helloWorldEnable') : t('tui.messages.helloWorldDisable'),
        error: formatErrorMessage(error),
      }),
    );
    return false;
  }
  host.setAppState({ helloWorldMode: enabled });
  host.state.helloWorldModeEntry = enabled ? trigger : undefined;
  return true;
}

function helloWorldModeSubcommand(input: string): boolean | undefined {
  const command = input.toLowerCase();
  if (command === 'on') return true;
  if (command === 'off') return false;
  return undefined;
}

function renderHelloWorldModeMarker(host: SlashCommandHost, state: HelloWorldModeMarkerState): void {
  host.appendTranscriptEntry(
    {
      id: nextTranscriptId(),
      kind: 'status',
      turnId: undefined,
      renderMode: 'plain',
      content: state,
    },
    new HelloWorldModeMarkerComponent(state),
  );
}
