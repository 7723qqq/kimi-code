import { t } from '#/i18n';

import { formatErrorPayload } from './event-payload';

interface ErrorPayloadLike {
  readonly code?: string;
  readonly message?: string;
  readonly details?: Record<string, unknown>;
}

function camelCaseCode(code: string): string {
  return code
    .split(/[._]/)
    .map((part, index) => (index === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join('');
}

function lookup(key: string): string | undefined {
  const value = t(key);
  return value === key ? undefined : value;
}

export function localizedErrorTitle(code: string): string | undefined {
  return lookup(`errorCodes.${camelCaseCode(code)}`);
}

export function localizedErrorAction(code: string): string | undefined {
  return lookup(`errorCodes.${camelCaseCode(code)}Action`);
}

export function formatLocalizedError(error: ErrorPayloadLike | undefined): string {
  if (error === undefined) return '';
  const { code, message } = error;
  if (code !== undefined) {
    const title = localizedErrorTitle(code);
    if (title !== undefined) {
      const lines = [`[${code}] ${title}`];
      const action = localizedErrorAction(code);
      if (action !== undefined) lines.push(action);
      if (message !== undefined && message.length > 0 && message !== title) lines.push(message);
      return lines.join('\n');
    }
  }
  return formatErrorPayload(error);
}
