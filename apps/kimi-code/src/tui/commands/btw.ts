import { t } from '#/i18n';

import { getLlmNotSetMessage } from '../constant/kimi-tui';
import { formatErrorMessage } from '../utils/event-payload';
import type { InlineSkillActivation } from '../types';
import type { SlashCommandHost } from './dispatch';

export async function handleBtwCommand(
  host: SlashCommandHost,
  args: string,
  activations: readonly InlineSkillActivation[],
): Promise<void> {
  const prompt = args.trim();
  const session = host.session;
  if (host.state.appState.model.trim().length === 0 || session === undefined) {
    host.showError(getLlmNotSetMessage());
    return;
  }
  host.btwPanelController.closeOrCancel();

  try {
    const agentId = await session.startBtw();
    host.btwPanelController.open(
      agentId,
      prompt,
      activations.length > 0 ? activations : undefined,
    );
  } catch (error) {
    host.showError(t('tui.messages.btwStartFailed', { error: formatErrorMessage(error) }));
  }
}
