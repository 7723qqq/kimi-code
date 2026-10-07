import type { Session } from '@moonshot-ai/kimi-code-sdk';

import { t } from '#/i18n';

import {
  getLlmNotSetMessage,
  TOWER_STATUS_PROMPT,
  TOWER_TEARDOWN_PROMPT,
} from '../constant/kimi-tui';
import { formatErrorMessage } from '../utils/event-payload';
import type { SlashCommandHost } from './dispatch';

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
    host.sendNormalUserInput(TOWER_STATUS_PROMPT);
    return;
  }
  if (sub === 'teardown') {
    host.sendNormalUserInput(TOWER_TEARDOWN_PROMPT);
    return;
  }

  await startTowerWithBase(host, input);
}

async function startTowerWithBase(host: SlashCommandHost, base: string): Promise<void> {
  // `/tower <base>` is manual activation too: it turns tower mode on and pins
  // the branch missions merge back into (the engine validates that it is a
  // local branch). Only the agent can never enter the mode by itself.
  const wasActive = host.state.appState.towerMode;
  // Validate prompt prerequisites before mutating the mode — otherwise a
  // rejected objective (no model configured) would leave tower on with the
  // next ordinary prompt unexpectedly running under the tower injection.
  if (host.state.appState.model.trim().length === 0) {
    host.showError(getLlmNotSetMessage());
    return;
  }
  // The engine's enter is idempotent, so never let the cached state skip the
  // mutation: it may be stale (mode changed elsewhere or an unlanded event).
  if (!(await setTowerMode(host, true, base))) return;
  host.showNotice(
    wasActive
      ? t('tui.messages.towerBaseSet', { base })
      : t('tui.messages.towerModeOnWithBase', { base }),
  );
}

async function applyTowerMode(host: SlashCommandHost, enabled: boolean): Promise<void> {
  const wasActive = host.state.appState.towerMode;
  // The setter is idempotent engine-side, so always reassert — a stale cache
  // must not leave the authoritative mode unchanged.
  if (!(await setTowerMode(host, enabled))) return;
  if (wasActive === enabled) {
    host.showStatus(
      enabled ? t('tui.messages.towerModeAlreadyOn') : t('tui.messages.towerModeAlreadyOff'),
    );
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
    // The engine may silently refuse entry (flag off, feature not assembled
    // until a restart, another session owning the workspace tower) — confirm
    // the mode actually took before reporting success. The read must not
    // *gate* the state write: reconciling here is a correction to the engine's
    // authoritative value, not the only thing that updates the local state.
    const status = await session.getStatus().catch(() => null);
    // Only a *reported* disagreement is evidence the engine refused. A missing
    // field means this view does not carry the flag, not that the mode is off.
    const reported = status?.towerMode;
    if (reported !== undefined && reported !== enabled) {
      host.setAppState({ towerMode: reported });
      host.showError(
        enabled ? t('tui.messages.towerEnableFailed') : t('tui.messages.towerDisableFailed'),
      );
      return false;
    }
  } catch (error) {
    const message = formatErrorMessage(error);
    host.showError(
      enabled
        ? t('tui.messages.towerEnableError', { error: message })
        : t('tui.messages.towerDisableError', { error: message }),
    );
    return false;
  }
  host.setAppState({ towerMode: enabled });
  return true;
}

async function requireSessionEnsured(host: SlashCommandHost): Promise<Session | undefined> {
  if (host.session !== undefined) return host.session;
  // v2 session-less: lazy-create the session, then toggle — the same path
  // the first prompt takes.
  return host.ensureSession();
}
