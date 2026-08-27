import { DEFAULT_OAUTH_PROVIDER_NAME } from '#/constant/app';
import { t } from '#/i18n';

export {
  DEFAULT_OAUTH_PROVIDER_NAME,
  OAUTH_LOGIN_REQUIRED_CODE,
  PRODUCT_NAME,
} from '#/constant/app';

export function getLlmNotSetMessage(): string {
  return t('tui.chrome.hints.llmNotSet');
}
export function getNoActiveSessionMessage(): string {
  return t('tui.chrome.hints.noActiveSession');
}
export function getCtrlDHint(): string {
  return t('tui.chrome.hints.ctrlDExit');
}
export function getCtrlCHint(): string {
  return t('tui.chrome.hints.ctrlCExit');
}
export const MAIN_AGENT_ID = 'main';
export function getOauthLoginRequiredStartupNotice(): string {
  return t('tui.chrome.hints.oauthLoginExpired');
}
export function getSessionlessStartupNotice(): string {
  return t('tui.chrome.hints.sessionlessStartup');
}
export const TOWER_STATUS_PROMPT =
  'Report the current tower status: call TowerStatus and give a compact summary.';
export const TOWER_TEARDOWN_PROMPT =
  'Tear down the tower: call TowerTeardown and report what it did. It refuses to destroy dirty worktrees unless forced.';
export const EXIT_CONFIRM_WINDOW_MS = 1500;
// Time window for treating two consecutive Esc presses as a double-Esc, which
// opens the undo selector. Kept short (double-click feel) so two deliberate
// presses far apart don't accidentally trigger undo.
export const DOUBLE_ESC_WINDOW_MS = 600;

/** Session picker page size: one backend keyset page and one picker window. */
export const SESSION_LIST_PAGE_SIZE = 50;

export function isManagedUsageProvider(
  providerKey: string | undefined,
): providerKey is typeof DEFAULT_OAUTH_PROVIDER_NAME {
  return providerKey === DEFAULT_OAUTH_PROVIDER_NAME;
}
