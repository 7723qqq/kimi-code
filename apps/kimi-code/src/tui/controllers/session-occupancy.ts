import type { KimiHarness, Session } from '@moonshot-ai/kimi-code-sdk';

import { formatErrorMessage } from '../utils/event-payload';
import { occupiedHolderClientId } from '../utils/session-lock-errors';

import { ChoicePickerComponent } from '../components/dialogs/choice-picker';

type TrackProperties = Parameters<KimiHarness['track']>[1];

export interface SessionOccupancyHost {
  track(event: string, properties?: TrackProperties): void;
  showError(message: string): void;
  mountEditorReplacement(panel: ChoicePickerComponent): void;
  restoreEditor(): void;
}

export interface SessionOccupancyPrompt {
  readonly session: Session;
  readonly error: unknown;
  /** The rejected request was already a Retry, so offer takeover instead. */
  readonly retried: boolean;
  readonly retry: () => void;
  readonly restore: () => void;
}

const OCCUPIED_PROMPT_TITLE = 'Session in use';

const OCCUPIED_PROMPT_OPTIONS = [
  { value: 'retry', label: 'Retry', description: 'send again now' },
  { value: 'cancel', label: 'Cancel', description: 'get your message back' },
] as const;

const TAKEOVER_PROMPT_TITLE = 'Session still in use';

const TAKEOVER_PROMPT_OPTIONS = [
  { value: 'cancel', label: 'Cancel', description: 'get your message back' },
  {
    value: 'takeover',
    label: 'Take over',
    tone: 'danger' as const,
    description: 'send your message anyway',
  },
] as const;

const TAKEOVER_NOTICE =
  'If another Kimi Code process is still running, taking over may mix up the history.';

export function showSessionOccupancyPrompt(
  host: SessionOccupancyHost,
  prompt: SessionOccupancyPrompt,
  openerClient: string,
): void {
  if (prompt.retried) {
    showSessionTakeover(host, prompt, openerClient);
    return;
  }
  showSessionOccupied(host, prompt, openerClient);
}

function showSessionOccupied(
  host: SessionOccupancyHost,
  { error, retry, restore }: SessionOccupancyPrompt,
  openerClient: string,
): void {
  const holderClient = occupiedHolderClientId(error);
  host.track('occupied_prompt_shown', {
    holder_client: holderClient,
    opener_client: openerClient,
  });
  const cancel = (): void => {
    host.track('occupied_choice', { choice: 'cancel', holder_client: holderClient });
    restore();
  };
  host.mountEditorReplacement(
    new ChoicePickerComponent({
      title: OCCUPIED_PROMPT_TITLE,
      notice: formatErrorMessage(error),
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
        retry();
      },
      onCancel: cancel,
    }),
  );
}

function showSessionTakeover(
  host: SessionOccupancyHost,
  { session, error, retry, restore }: SessionOccupancyPrompt,
  openerClient: string,
): void {
  const holderClient = occupiedHolderClientId(error);
  host.track('occupied_prompt_shown', {
    holder_client: holderClient,
    opener_client: openerClient,
  });
  const cancel = (): void => {
    host.track('occupied_choice', { choice: 'cancel', holder_client: holderClient });
    restore();
  };
  host.mountEditorReplacement(
    new ChoicePickerComponent({
      title: TAKEOVER_PROMPT_TITLE,
      notice: TAKEOVER_NOTICE,
      noticeTone: 'warning',
      options: TAKEOVER_PROMPT_OPTIONS.map((option) => ({ ...option })),
      spaceSelect: false,
      onSelect: (action) => {
        if (action !== 'takeover') {
          cancel();
          return;
        }
        host.track('occupied_choice', { choice: 'takeover', holder_client: holderClient });
        host.restoreEditor();
        void session.takeOverLock().then(retry, (takeoverError: unknown) => {
          host.showError(`Failed to take over the session: ${formatErrorMessage(takeoverError)}`);
          restore();
        });
      },
      onCancel: cancel,
    }),
  );
}
