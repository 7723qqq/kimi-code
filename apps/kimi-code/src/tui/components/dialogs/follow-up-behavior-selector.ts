import { t } from '#/i18n';

import { FollowUpBehaviorSchema, type FollowUpBehavior } from '../../config';
import { ChoicePickerComponent, type ChoiceOption } from './choice-picker';

function followUpBehaviorOptions(
  ctrlEnterRecognized: boolean,
): readonly (ChoiceOption & { readonly value: FollowUpBehavior })[] {
  return [
    {
      value: 'queue',
      label: t('tui.dialogs.followUpBehaviorSelector.queue'),
      description: t(
        ctrlEnterRecognized
          ? 'tui.dialogs.followUpBehaviorSelector.queueDescCtrlEnter'
          : 'tui.dialogs.followUpBehaviorSelector.queueDesc',
      ),
    },
    {
      value: 'steer',
      label: t('tui.dialogs.followUpBehaviorSelector.steer'),
      description: t(
        ctrlEnterRecognized
          ? 'tui.dialogs.followUpBehaviorSelector.steerDescCtrlEnter'
          : 'tui.dialogs.followUpBehaviorSelector.steerDescCtrlQ',
      ),
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
