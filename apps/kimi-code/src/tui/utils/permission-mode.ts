import type { PermissionMode } from '@moonshot-ai/kimi-code-sdk';

import { t } from '#/i18n';

export function permissionModeDisplayName(mode: PermissionMode): string {
  switch (mode) {
    case 'manual':
      return t('tui.permissionMode.manual');
    case 'yolo':
      return t('tui.permissionMode.yolo');
    case 'auto':
      return t('tui.permissionMode.auto');
  }
}

export function permissionModeDescription(mode: PermissionMode): string {
  switch (mode) {
    case 'manual':
      return t('tui.permissionMode.manualDesc');
    case 'yolo':
      return t('tui.permissionMode.yoloDesc');
    case 'auto':
      return t('tui.permissionMode.autoDesc');
  }
}
