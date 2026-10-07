import type { RemoteControlStatus } from '@moonshot-ai/remote-control';
import chalk from 'chalk';

import { t } from '#/i18n';

import { darkColors } from '../../../tui/theme/colors';
import { supportsHyperlinks, toTerminalHyperlink } from '../../../utils/terminal-hyperlink';
import { getVersion } from '../../version';
import { buildOpenableUrl, splitTokenFragment } from './access-urls';

export {
  acquireRemoteControlLock,
  buildRemoteControlUrl,
  filterForwardRequestHeaders,
  formatRemoteControlAlreadyRunning,
  inspectRemoteControlLock,
  parseRawHttpRequest,
  remoteControlLockPath,
  RemoteControlAlreadyRunningError,
  REMOTE_CONTROL_RELAY_ORIGIN,
  REMOTE_CONTROL_RELAY_URL_ENV,
  resolveRemoteControlRelayOrigin,
  rewriteRemoteControlResponse,
  startRemoteControl,
} from '@moonshot-ai/remote-control';
export type {
  ParsedRawHttpRequest,
  RemoteControlHandle,
  RemoteControlLock,
  RemoteControlLockInfo,
  RemoteControlOptions,
  RemoteControlStatus,
} from '@moonshot-ai/remote-control';

export interface RemoteControlOutputOptions {
  readonly url: string;
  readonly localOrigin: string;
  readonly localServerToken: string;
  readonly deviceName: string;
  readonly qrCode: string;
  readonly pngPath: string;
}

export function formatRemoteControlOutput(options: RemoteControlOutputOptions): string {
  const title = (text: string): string => chalk.bold.hex(darkColors.primary)(text);
  const label = (text: string): string => chalk.bold.hex(darkColors.textDim)(text);
  const accent = (text: string): string => chalk.hex(darkColors.accent)(text);
  const dim = (text: string): string => chalk.hex(darkColors.textDim)(text);
  const muted = (text: string): string => chalk.hex(darkColors.textMuted)(text);
  const status = (text: string): string => chalk.hex(darkColors.success)(text);
  const link = (url: string): string =>
    supportsHyperlinks() ? toTerminalHyperlink(accent(url), url) : accent(url);
  const docs = toTerminalHyperlink(
    t('tui.statusMessages.rcDocsLabel'),
    'https://kimi.com/code/docs/remote-control',
  );
  const feedback = toTerminalHyperlink(
    t('tui.statusMessages.rcFeedbackLabel'),
    'https://kimi.com/code/feedback',
  );
  const [localBase, localFrag] = splitTokenFragment(
    buildOpenableUrl(options.localOrigin, options.localServerToken),
  );
  return [
    '',
    `  ${title(t('tui.statusMessages.rcReadyTitle'))}  ${muted(getVersion())}`,
    `  ${muted(t('tui.statusMessages.rcReadySubtitle'))}`,
    '',
    `  ${label('1.')} ${t('tui.statusMessages.rcStepScan', { url: link(options.url) })}`,
    `  ${label('2.')} ${t('tui.statusMessages.rcStepLogin')}`,
    `  ${label('3.')} ${t('tui.statusMessages.rcStepChat')}`,
    '',
    `  ${status('✓')} ${muted(t('tui.statusMessages.rcConnectedWaiting', { host: new URL(options.url).host }))}`,
    `  ${label(t('tui.statusMessages.rcDeviceLabel'))}${muted(options.deviceName)}`,
    `  ${status('⚠')} ${muted(t('tui.statusMessages.rcLinkWarning'))}`,
    '',
    options.qrCode.trimEnd().replaceAll(/^/gm, '    '),
    `  ${label(t('tui.statusMessages.rcQrPngLabel'))}${options.pngPath} ${muted(t('tui.statusMessages.rcQrPngHint'))}`,
    `  ${label(t('tui.statusMessages.rcLocalUiLabel'))}${accent(localBase)}${dim(localFrag)} ${muted(t('tui.statusMessages.rcLanHint'))}`,
    '',
    `  ${docs} ${muted('·')} ${feedback}`,
    `  ${label(t('tui.statusMessages.rcLogsLabel'))}${muted(t('tui.statusMessages.rcLogsOff'))} ${muted('·')} ${label(t('tui.statusMessages.rcStopLabel'))}${muted('Ctrl+C')}`,
    '',
  ].join('\n');
}

export function formatRemoteControlStatus(status: RemoteControlStatus): string {
  const label = (text: string): string => chalk.bold.hex(darkColors.textDim)(text);
  const value = (text: string): string => chalk.hex(darkColors.success)(text);
  switch (status) {
    case 'relay_connected':
      return `  ${value('✓')} ${label(t('tui.statusMessages.rcStatusRelayConnected'))}\n`;
    case 'relay_disconnected':
      return `  ${value('!')} ${label(t('tui.statusMessages.rcStatusRelayDisconnected'))}\n`;
    case 'device_connected':
      return `  ${value('✓')} ${label(t('tui.statusMessages.rcStatusDeviceConnected'))}\n`;
    case 'device_disconnected':
      return `  ${value('→')} ${label(t('tui.statusMessages.rcStatusDeviceDisconnected'))}\n`;
  }
}
