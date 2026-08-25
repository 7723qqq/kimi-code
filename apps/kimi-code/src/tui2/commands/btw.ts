/**
 * `/btw` slash command — start a background "by the way" side-agent with the
 * given prompt, opening it in the BTW panel.
 *
 * Status: REAL (tui2). Self-contained; no v1 re-export.
 */
import { t } from '#/i18n';

import { getLlmNotSetMessage } from '../constant/kimi-tui';
import { formatErrorMessage } from '../utils/event-payload';
import type { SlashCommandHost } from './dispatch';

export async function handleBtwCommand(host: SlashCommandHost, args: string): Promise<void> {
  const prompt = args.trim();
  const session = host.session;
  if (host.state.appState.model.trim().length === 0 || session === undefined) {
    host.showError(getLlmNotSetMessage());
    return;
  }
  host.btwPanelController.closeOrCancel();

  try {
    const agentId = await session.startBtw();
    host.btwPanelController.open(agentId, prompt);
  } catch (error) {
    host.showError(t('tui.messages.btwStartFailed', { error: formatErrorMessage(error) }));
  }
}
