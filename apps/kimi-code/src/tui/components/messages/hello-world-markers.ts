import { truncateToWidth, type Component } from '@moonshot-ai/pi-tui';

import { t } from '#/i18n';
import { STATUS_BULLET } from '#/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';

export type HelloWorldModeMarkerState = 'active' | 'inactive' | 'ended';

export class HelloWorldModeMarkerComponent implements Component {
  constructor(private readonly state: HelloWorldModeMarkerState) {}

  invalidate(): void {}

  render(width: number): string[] {
    const safeWidth = Math.max(0, width);
    if (safeWidth <= 0) return [''];

    const token = this.state === 'inactive' ? 'textDim' : 'success';
    const marker = currentTheme.boldFg(token, STATUS_BULLET);
    const label = currentTheme.boldFg(token, helloWorldMarkerLabel(this.state));
    return ['', truncateToWidth(marker + label, safeWidth, '…')];
  }
}

/** Marks a hello-world run stage change; the stage id is protocol data, shown as-is. */
export class HelloWorldStageMarkerComponent implements Component {
  constructor(private readonly stage: string) {}

  invalidate(): void {}

  render(width: number): string[] {
    const safeWidth = Math.max(0, width);
    if (safeWidth <= 0) return [''];

    const marker = currentTheme.boldFg('success', STATUS_BULLET);
    const label = currentTheme.boldFg(
      'success',
      t('tui.messages.helloWorldMarkers.stage', { stage: this.stage }),
    );
    return ['', truncateToWidth(marker + label, safeWidth, '…')];
  }
}

function helloWorldMarkerLabel(state: HelloWorldModeMarkerState): string {
  switch (state) {
    case 'active':
      return t('tui.messages.helloWorldMarkers.activated');
    case 'inactive':
      return t('tui.messages.helloWorldMarkers.deactivated');
    case 'ended':
      return t('tui.messages.helloWorldMarkers.ended');
  }
}
