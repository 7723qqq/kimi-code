import type { KimiHarness } from '@moonshot-ai/kimi-code-sdk';

import { formatErrorMessage } from '../utils/event-payload';
import { occupiedHolderClientId } from '../utils/session-lock-errors';

import { ChoicePickerComponent } from '../components/dialogs/choice-picker';

type TrackProperties = Parameters<KimiHarness['track']>[1];

export interface SessionOccupancyHost {
  track(event: string, properties?: TrackProperties): void;
  mountEditorReplacement(panel: ChoicePickerComponent): void;
  restoreEditor(): void;
}

export interface SessionOccupancyPrompt {
  readonly error: unknown;
  readonly retry: () => void;
  readonly restore: () => void;
}

const OCCUPIED_PROMPT_TITLE = 'Session in use';

const OCCUPIED_PROMPT_OPTIONS = [
  { value: 'retry', label: 'Retry', description: 'send again now' },
  { value: 'cancel', label: 'Cancel', description: 'get your message back' },
] as const;

export function showSessionOccupancyPrompt(
  host: SessionOccupancyHost,
  prompt: SessionOccupancyPrompt,
  openerClient: string,
): void {
  const holderClient = occupiedHolderClientId(prompt.error);
  host.track('occupied_prompt_shown', {
    holder_client: holderClient,
    opener_client: openerClient,
  });
  const cancel = (): void => {
    host.track('occupied_choice', { choice: 'cancel', holder_client: holderClient });
    prompt.restore();
  };
  host.mountEditorReplacement(
    new ChoicePickerComponent({
      title: OCCUPIED_PROMPT_TITLE,
      notice: formatErrorMessage(prompt.error),
      noticeTone: 'warning',
      options: OCCUPIED_PROMPT_OPTIONS.map((option) => ({ ...option })),
      spaceSelect: false,
      onSelect: (action) => {
        if (action !== 'retry') {
          cancel();
          return;
        }
        host.track('occupied_choice', { choice: 'retry', holder_client: holderClient });
        host.restoreEditor();
        prompt.retry();
      },
      onCancel: cancel,
    }),
  );
}
