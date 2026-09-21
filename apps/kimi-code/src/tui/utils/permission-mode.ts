import type { PermissionMode } from '@moonshot-ai/kimi-code-sdk';

import { t } from '#/i18n';

/// v2's permission-mode labels, read through i18n at call time so a locale
/// switch takes effect (the frozen constants these replace were evaluated
/// once at import). The keys live with the settings selector that shares
/// them: `tui.dialogs.permissionSelector.*`.
export function permissionModeDisplayName(mode: PermissionMode): string {
  switch (mode) {
    case 'manual':
      return t('tui.dialogs.permissionSelector.manual');
    case 'yolo':
      return t('tui.dialogs.permissionSelector.yolo');
    case 'auto':
      return t('tui.dialogs.permissionSelector.auto');
  }
}

/// The one-line explanation shown next to each mode (same key family).
export function permissionModeDescription(mode: PermissionMode): string {
  switch (mode) {
    case 'manual':
      return t('tui.dialogs.permissionSelector.manualDesc');
    case 'yolo':
      return t('tui.dialogs.permissionSelector.yoloDesc');
    case 'auto':
      return t('tui.dialogs.permissionSelector.autoDesc');
  }
}
