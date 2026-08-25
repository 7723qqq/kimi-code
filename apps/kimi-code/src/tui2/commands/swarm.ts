/**
 * `/swarm` slash command — toggle swarm mode and start swarm tasks, with
 * permission prompts for manual mode.
 *
 * Status: REAL (tui2). Self-contained; no v1 re-export.
 */
import type { PermissionMode } from '@moonshot-ai/kimi-code-sdk';

import { t } from '#/i18n';

import {
  SwarmStartPermissionPrompt,
  type SwarmStartPermissionChoice,
} from '../components/dialogs/swarm-start-permission-prompt';
import type { SwarmModeMarkerState } from '../components/messages/swarm-markers';
import { getLlmNotSetMessage, getNoActiveSessionMessage } from '../constant/kimi-tui';
import {
  asReplacement,
  mountEditorReplacement,
  restoreEditor,
} from '../utils/editor-replacement';
import { formatErrorMessage } from '../utils/event-payload';
import { nextTranscriptId } from '../utils/transcript-id';
import type { SlashCommandHost } from './dispatch';

export async function handleSwarmCommand(host: SlashCommandHost, args: string): Promise<void> {
  if (host.session === undefined) {
    host.showError(getNoActiveSessionMessage());
    return;
  }

  const prompt = args.trim();
  const mode = swarmModeSubcommand(prompt);
  if (mode !== undefined) {
    await applySwarmMode(host, mode, `/swarm ${prompt}`);
    return;
  }

  if (prompt.length === 0) {
    await applySwarmMode(host, !host.state.appState.swarmMode, '/swarm');
    return;
  }

  if (host.state.appState.model.trim().length === 0) {
    host.showError(getLlmNotSetMessage());
    return;
  }

  if (host.state.appState.permissionMode === 'manual') {
    showSwarmStartPermissionPrompt(
      host,
      `/swarm ${prompt}`,
      t('tui.statusMessages.swarmTaskNotStarted'),
      (choice) => startSwarmWithPermission(host, prompt, choice),
    );
    return;
  }

  await startSwarmTask(host, prompt);
}

function showSwarmStartPermissionPrompt(
  host: SlashCommandHost,
  commandText: string,
  cancelStatus: string,
  onSelect: (choice: SwarmStartPermissionChoice) => Promise<void>,
): void {
  const cancelStart = (): void => {
    host.restoreInputText(commandText);
    host.showStatus(cancelStatus);
  };
  // tui2: render from store state; the choice resolves through the
  // host's pickSwarmStartPermission (which reads the saved prompt from
  // the store).
  if (host.store !== undefined) {
    host.store.setState('swarmStartContext', { prompt: commandText })
    host.store.setState('activeDialog', 'swarm-start-permission-prompt')
  } else {
    mountEditorReplacement(
      host,
      asReplacement(SwarmStartPermissionPrompt),
      {
        onSelect: (choice: SwarmStartPermissionChoice) => {
          restoreEditor(host);
          void onSelect(choice);
        },
        onCancel: cancelStart,
      },
    )
  }
}

/** Resolve the open swarm-start dialog (called by the host when the
 *  user picks a permission in the swarm-start-permission-prompt dialog).
 *  Reads the saved prompt from the store and runs the original
 *  swarm-start flow. */
export async function resolveSwarmStartPermissionChoice(
  host: SlashCommandHost,
  choice: SwarmStartPermissionChoice,
): Promise<void> {
  const store = host.store
  if (store === undefined) return
  const context = store.state.swarmStartContext
  store.setState('activeDialog', null)
  store.setState('swarmStartContext', undefined)
  if (context === undefined) return
  if (choice === 'auto' || choice === 'yolo') {
    if (!(await setPermissionForSwarm(host, choice))) return
  }
  await startSwarmTask(host, context.prompt)
}

async function startSwarmWithPermission(
  host: SlashCommandHost,
  prompt: string,
  choice: SwarmStartPermissionChoice,
): Promise<void> {
  if (choice === 'auto' || choice === 'yolo') {
    if (!(await setPermissionForSwarm(host, choice))) return;
  }
  await startSwarmTask(host, prompt);
}

async function setPermissionForSwarm(
  host: SlashCommandHost,
  mode: PermissionMode,
): Promise<boolean> {
  try {
    await host.requireSession().setPermission(mode);
  } catch (error) {
    host.showError(t('tui.messages.swarmPermissionFailed', { error: formatErrorMessage(error) }));
    return false;
  }
  host.setAppState({ permissionMode: mode });
  return true;
}

async function startSwarmTask(host: SlashCommandHost, prompt: string): Promise<void> {
  if (!host.state.appState.swarmMode && !(await setSwarmMode(host, true, 'task'))) {
    return;
  }
  renderSwarmModeMarker(host, 'active');
  host.sendNormalUserInput(prompt);
}

async function applySwarmMode(
  host: SlashCommandHost,
  enabled: boolean,
  commandText: string,
): Promise<void> {
  if (enabled && host.state.appState.swarmMode) {
    host.showStatus(t('tui.statusMessages.swarmModeAlreadyOn'));
    return;
  }
  if (!enabled && !host.state.appState.swarmMode) {
    host.showStatus(t('tui.statusMessages.swarmModeAlreadyOff'));
    return;
  }
  if (enabled && host.state.appState.permissionMode === 'manual') {
    showSwarmStartPermissionPrompt(
      host,
      commandText,
      t('tui.statusMessages.swarmModeNotEnabled'),
      async (choice) => {
        if (
          (choice === 'auto' || choice === 'yolo') &&
          !(await setPermissionForSwarm(host, choice))
        ) {
          return;
        }
        if (!(await setSwarmMode(host, true, 'manual'))) return;
        renderSwarmModeMarker(host, 'active');
      },
    );
    return;
  }
  if (!(await setSwarmMode(host, enabled, 'manual'))) return;
  renderSwarmModeMarker(host, enabled ? 'active' : 'inactive');
}

async function setSwarmMode(
  host: SlashCommandHost,
  enabled: boolean,
  trigger: 'manual' | 'task',
): Promise<boolean> {
  try {
    await host.requireSession().setSwarmMode(enabled, trigger);
  } catch (error) {
    host.showError(
      t('tui.messages.swarmToggleFailed', {
        action: enabled ? t('tui.messages.swarmEnable') : t('tui.messages.swarmDisable'),
        error: formatErrorMessage(error),
      }),
    );
    return false;
  }
  host.setAppState({ swarmMode: enabled });
  host.store?.setState('swarmModeEntry', enabled ? trigger : undefined);
  return true;
}

function swarmModeSubcommand(input: string): boolean | undefined {
  const command = input.toLowerCase();
  if (command === 'on') return true;
  if (command === 'off') return false;
  return undefined;
}

function renderSwarmModeMarker(host: SlashCommandHost, state: SwarmModeMarkerState): void {
  host.appendTranscriptEntry({
    id: nextTranscriptId(),
    kind: 'status',
    renderMode: 'plain',
    content: '',
    swarmData: { state },
  });
}
