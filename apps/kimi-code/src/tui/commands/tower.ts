import type { Session } from '@moonshot-ai/kimi-code-sdk';

import { TOWER_TEARDOWN_PROMPT } from '../constant/kimi-tui';
import { formatErrorMessage } from '../utils/event-payload';
import type { SlashCommandHost } from './dispatch';
import { t } from '#/i18n';

export async function handleTowerCommand(host: SlashCommandHost, args: string): Promise<void> {
  const input = args.trim();
  const sub = input.toLowerCase();

  if (sub === 'on') {
    await applyTowerMode(host, true);
    return;
  }
  if (sub === 'off') {
    await applyTowerMode(host, false);
    return;
  }
  if (sub === '' || sub === 'status') {
    const session = await requireSessionEnsured(host);
    if (session === undefined) return;
    try {
      const [title, ...rest] = (await session.getTowerStatus()).split('\n');
      host.showNotice(title ?? t('tui.statusMessages.towerStatusTitle'), rest.length > 0 ? rest.join('\n') : undefined);
    } catch (error) {
      host.showError(t('tui.statusMessages.towerStatusFailed', { error: formatErrorMessage(error) }));
    }
    return;
  }
  if (sub === 'teardown') {
    host.sendNormalUserInput(TOWER_TEARDOWN_PROMPT);
    return;
  }

  await startTowerWithBase(host, input);
}

async function startTowerWithBase(host: SlashCommandHost, base: string): Promise<void> {
  const wasActive = host.state.appState.towerMode;
  if (!(await setTowerMode(host, true, base))) return;
  host.showNotice(wasActive ? `Tower base: ${base}` : t('tui.messages.towerModeOnWithBase', { base: base }));
}

async function applyTowerMode(host: SlashCommandHost, enabled: boolean): Promise<void> {
  const wasActive = host.state.appState.towerMode;
  if (!(await setTowerMode(host, enabled))) return;
  if (wasActive === enabled) {
    host.showStatus(`Tower mode is already ${enabled ? 'on' : 'off'}.`);
    return;
  }
  host.showNotice(enabled ? t('tui.messages.towerModeOn') : t('tui.messages.towerModeOff'));
}

async function setTowerMode(
  host: SlashCommandHost,
  enabled: boolean,
  base?: string,
): Promise<boolean> {
  const session = await requireSessionEnsured(host);
  if (session === undefined) return false;
  try {
    await session.setTowerMode(enabled, base);
    const status = await session.getStatus();
    const effective = status.towerMode ?? false;
    if (effective !== enabled) {
      host.setAppState({ towerMode: effective });
      host.showError(
        enabled
          ? t('tui.messages.towerEnableFailed')
          : t('tui.messages.towerDisableFailed'),
      );
      return false;
    }
  } catch (error) {
    host.showError(
      `Failed to ${enabled ? 'enable' : 'disable'} tower mode: ${formatErrorMessage(error)}`,
    );
    return false;
  }
  host.setAppState({ towerMode: enabled });
  return true;
}

async function requireSessionEnsured(host: SlashCommandHost): Promise<Session | undefined> {
  if (host.session !== undefined) return host.session;
  return host.ensureSession();
}
