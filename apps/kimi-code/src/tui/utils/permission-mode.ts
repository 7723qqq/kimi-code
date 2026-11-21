import type { PermissionMode } from '@moonshot-ai/kimi-code-sdk';
import { t } from '#/i18n';

export const PERMISSION_MODE_DISPLAY_NAMES: Readonly<Record<PermissionMode, string>> = {
  manual: t('tui.permissionMode.manual'),
  yolo: t('tui.permissionMode.yolo'),
  auto: t('tui.permissionMode.auto'),
};

export const PERMISSION_MODE_DESCRIPTIONS: Readonly<Record<PermissionMode, string>> = {
  manual: t('tui.permissionMode.manualDesc'),
  yolo: t('tui.permissionMode.yoloDesc'),
  auto: 'Everything runs and is decided automatically; only plans in Plan mode wait for your review.',
};
