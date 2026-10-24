import type { KimiHarness, Session } from '@moonshot-ai/kimi-code-sdk';

import { t } from '#/i18n';

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

/**
 * Copy resolves per call rather than at module load: a `t()` captured in a
 * module constant would freeze the locale active at first import, so a
 * mid-session language switch would leave these prompts untranslated.
 */
function occupiedPromptOptions(): readonly {
  value: 'retry' | 'cancel';
  label: string;
  description: string;
}[] {
  return [
    {
      value: 'retry',
      label: t('tui.sessionOccupancy.retryLabel'),
      description: t('tui.sessionOccupancy.retryDescription'),
    },
    {
      value: 'cancel',
      label: t('tui.sessionOccupancy.cancelLabel'),
      description: t('tui.sessionOccupancy.cancelDescription'),
    },
  ];
}

function takeoverPromptOptions(): readonly {
  value: 'takeover' | 'cancel';
  label: string;
  description: string;
  tone?: 'danger';
}[] {
  return [
    {
      value: 'cancel',
      label: t('tui.sessionOccupancy.cancelLabel'),
      description: t('tui.sessionOccupancy.cancelDescription'),
    },
    {
      value: 'takeover',
      label: t('tui.sessionOccupancy.takeoverLabel'),
      tone: 'danger',
      description: t('tui.sessionOccupancy.takeoverDescription'),
    },
  ];
}

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
      title: t('tui.sessionOccupancy.occupiedTitle'),
      notice: formatErrorMessage(error),
      noticeTone: 'warning',
      options: occupiedPromptOptions().map((option) => ({ ...option })),
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
      title: t('tui.sessionOccupancy.takeoverTitle'),
      notice: t('tui.sessionOccupancy.takeoverNotice'),
      noticeTone: 'warning',
      options: takeoverPromptOptions().map((option) => ({ ...option })),
      spaceSelect: false,
      onSelect: (action) => {
        if (action !== 'takeover') {
          cancel();
          return;
        }
        host.track('occupied_choice', { choice: 'takeover', holder_client: holderClient });
        host.restoreEditor();
        void session.takeOverLock().then(retry, (takeoverError: unknown) => {
          host.showError(
            t('tui.sessionOccupancy.takeoverFailed', {
              error: formatErrorMessage(takeoverError),
            }),
          );
          restore();
        });
      },
      onCancel: cancel,
    }),
  );
}
