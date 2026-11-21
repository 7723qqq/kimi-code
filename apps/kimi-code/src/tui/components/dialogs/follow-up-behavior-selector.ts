import { FollowUpBehaviorSchema, type FollowUpBehavior } from '../../config';
import { ChoicePickerComponent, type ChoiceOption } from './choice-picker';
import { t } from '#/i18n';

function followUpBehaviorOptions(ctrlEnterRecognized: boolean): readonly (ChoiceOption & { readonly value: FollowUpBehavior })[] {
  return [
    {
      value: 'queue',
      label: t('tui.dialogs.followUpBehaviorSelector.queue'),
      description: `Enter queues follow-ups until Kimi finishes.${ctrlEnterRecognized ? ' Ctrl-Enter steers one.' : ''}`,
    },
    {
      value: 'steer',
      label: t('tui.dialogs.followUpBehaviorSelector.steer'),
      description: `Enter steers follow-ups into the current turn. ${ctrlEnterRecognized ? 'Ctrl-Enter' : 'Ctrl-Q'} queues one.`,
    },
  ];
}

export interface FollowUpBehaviorSelectorOptions {
  readonly currentValue: FollowUpBehavior;
  readonly ctrlEnterRecognized: boolean;
  readonly onSelect: (value: FollowUpBehavior) => void;
  readonly onCancel: () => void;
}

export class FollowUpBehaviorSelectorComponent extends ChoicePickerComponent {
  constructor(opts: FollowUpBehaviorSelectorOptions) {
    super({
      title: t('tui.dialogs.followUpBehaviorSelector.title'),
      options: followUpBehaviorOptions(opts.ctrlEnterRecognized),
      currentValue: opts.currentValue,
      onSelect: (value) => {
        const parsed = FollowUpBehaviorSchema.safeParse(value);
        if (parsed.success) opts.onSelect(parsed.data);
      },
      onCancel: opts.onCancel,
    });
  }
}
