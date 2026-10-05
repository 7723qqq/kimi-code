import { isKimiError, KIMI_ERROR_INFO, type KimiErrorCode, type KimiErrorInfo } from '@moonshot-ai/kimi-code-sdk';
import { chalkStderr } from 'chalk';

import { STARTUP_ERROR_COLOR } from '#/constant/startup-error';
import { t } from '#/i18n';

export interface StartupErrorFormatOptions {
  readonly errorStyle?: (text: string) => string;
  readonly operation?: string;
}

function formatUnknownErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function formatStartupError(
  error: unknown,
  options: StartupErrorFormatOptions = {},
): string {
  const errorStyle = options.errorStyle ?? chalkStderr.hex(STARTUP_ERROR_COLOR);

  if (!isKimiError(error)) {
    const operation = options.operation ?? t('startup.operations.startShell');
    return `${errorStyle(
      t('startup.error.failedTo', {
        operation,
        message: formatUnknownErrorMessage(error),
      }),
    )}\n`;
  }

  // `isKimiError` above guarantees a code; a code this build does not know
  // (errors crossing a process or engine generation) falls back to the raw code.
  const code = (error as { readonly code: KimiErrorCode }).code;
  const info: KimiErrorInfo | undefined = KIMI_ERROR_INFO[code];
  const lines = [
    errorStyle(t('startup.error.title', { title: info?.title ?? code })),
    '',
    errorStyle(t('startup.error.messageLabel')),
    errorStyle((error as { readonly message: string }).message),
  ];

  return `${lines.join('\n')}\n`;
}
